import {
  createEvmVaultAdapter,
  type EvmRpc,
  type TradeLimits,
  type V4Pools,
} from '@colosseum/chain-evm/vault';
import { createMockAdapter, type MockControl } from '@colosseum/chain-mock';
import {
  createSolanaVaultAdapter,
  type JupiterOptions,
  type VaultWriteRpc,
} from '@colosseum/chain-solana/vault';
import {
  type BasketAsset,
  type ChainAdapter,
  type ChainConfig,
  ChainId,
  type ChainMode,
  chainProvenance,
  envKey,
  type Flags,
  type Provenance,
} from '@colosseum/schemas';
import { Refusal } from './errors';

// One adapter per chain, chosen by the chain's mode. `mock` runs on packages/chain-mock. `live` and
// `readonly` run Solana on its real adapter (packages/chain-solana/src/vault) and Robinhood Chain on the
// EVM adapter (packages/chain-evm/src/vault), on a test network or a local copy only for now: mainnet,
// and Base, say so at start. Nothing falls back to the mock.

export type ChainEntry = {
  chain: ChainId;
  mode: Exclude<ChainMode, 'off'>;
  /** The label on every figure read from this chain as it runs now. */
  provenance: Provenance;
  /**
   * Where this chain's figures are read from, as a figure names its source: the mock, or the kind of
   * node a real adapter asks. Never a URL: an RPC address can carry a key.
   */
  source: string;
  config: ChainConfig;
  /** Builds, reads, and ties signed bytes and landed transactions back to what was built (`TxProbe`). */
  adapter: ChainAdapter;
  /** Set only when the chain runs on the mock. */
  mock?: MockControl;
};

export type ChainRegistry = {
  mode(chain: ChainId): ChainMode;
  /** The chain's name as a person reads it, whether it is on or off. */
  name(chain: ChainId): string;
  /** The chain's adapter. Refuses with CHAIN_UNAVAILABLE when the chain is off. */
  get(chain: ChainId): ChainEntry;
  /** Every chain that is not off. */
  active(): ChainEntry[];
};

/** What the real Solana adapter runs on, from the server's own settings: never from a request. */
export type SolanaInputs = {
  /** Made from the server's RPC URL, which no figure and no message repeats. */
  rpc: VaultWriteRpc;
  /** The assets of the network the chain runs on, with their mints. */
  assets: BasketAsset[];
  /** Jupiter's build endpoint, where the chain's router is Jupiter. */
  jupiter?: JupiterOptions;
};

/** What Robinhood Chain runs on in `live` or `readonly`, from the server's own settings. */
export type EvmInputs = {
  /** Made from the server's RPC URL (`ROBINHOOD_RPC_URL`), which no figure and no message repeats. */
  rpc: EvmRpc;
  /** The assets of the network, with their token contracts and feeds. */
  assets: BasketAsset[];
  /** Each asset's own pool against cash, from the deploy's record: the pool its trades go through. */
  pools: V4Pools;
  /** What an owner's trade is held to: the bound to the feed and each asset's largest trade, from the record. */
  limits: TradeLimits;
  /**
   * True only when these came from a mainnet's own deploy record with the mainnet switch set
   * (`robinhoodFromEnv`). Without it the registry does not run the chain on mainnet.
   */
  mainnet?: boolean;
};

/**
 * The second switch a mainnet needs, beside `CHAIN_NETWORK_ROBINHOOD=mainnet` and the committed deploy
 * record: its value is the words below, exactly. Real money is never one typo, or one inherited
 * variable, away.
 */
export const MAINNET_SWITCH = 'CHAIN_MAINNET_ROBINHOOD';
export const MAINNET_SWITCH_VALUE = 'real-money';
export const mainnetAllowed = (env: Record<string, string | undefined>): boolean =>
  env[MAINNET_SWITCH]?.trim() === MAINNET_SWITCH_VALUE;

export type RegistryOptions = {
  /**
   * Mixed into every transaction the mock builds, so a mock started today never repeats an id that an
   * earlier run stored. New at every start.
   */
  seed: string;
  /** The clock the mock chains follow. Default: the wall clock. */
  now?: () => Date;
  /** For Solana in `live` or `readonly`. */
  solana?: SolanaInputs;
  /** For Robinhood Chain in `live` or `readonly`. */
  robinhood?: EvmInputs;
};

export function createChainRegistry(
  flags: Flags,
  configs: Record<ChainId, ChainConfig>,
  options: RegistryOptions,
): ChainRegistry {
  const now = options.now ?? (() => new Date());
  const entries = new Map<ChainId, ChainEntry>();
  for (const chain of ChainId.options) {
    const mode = flags.chainMode[chain];
    if (mode === 'off') continue;
    if (mode !== 'mock') {
      entries.set(chain, realEntry(chain, mode, configs[chain], flags, options));
      continue;
    }
    const adapter = createMockAdapter({ chain, seed: options.seed, now: now().toISOString() });
    entries.set(chain, {
      chain,
      mode,
      // Never null here: the chain is not off.
      provenance: chainProvenance(configs[chain].network, mode) ?? 'mock',
      source: 'chain-mock',
      config: configs[chain],
      adapter,
      mock: adapter.mock,
    });
  }

  /** The mock's clock only moves when told. Keep it on the registry's clock, so stamps and expiry are real. */
  const sync = (entry: ChainEntry) => {
    if (!entry.mock) return entry;
    const behind = Math.floor(now().getTime() / 1000) - entry.mock.now();
    if (behind > 0) entry.mock.advance(behind);
    return entry;
  };

  return {
    mode: (chain) => flags.chainMode[chain],
    name: (chain) => configs[chain].name,
    get(chain) {
      const entry = entries.get(chain);
      if (!entry)
        throw new Refusal(503, `${configs[chain].name} is switched off on this server`, {
          code: 'CHAIN_UNAVAILABLE',
          details: { retryable: false },
        });
      return sync(entry);
    },
    active: () => [...entries.values()].map(sync),
  };
}

/**
 * A chain on its real adapter: Solana or Robinhood Chain, on a test network or a local copy, labelled
 * `sandbox` on every figure. Robinhood Chain alone may run on mainnet, labelled `live`, and only from
 * its own mainnet deploy record under `MAINNET_SWITCH`.
 */
function realEntry(
  chain: ChainId,
  mode: 'live' | 'readonly',
  config: ChainConfig,
  flags: Flags,
  options: RegistryOptions,
): ChainEntry {
  const key = envKey('CHAIN_MODE', chain);
  if (chain === 'base')
    throw new Error(
      `${key} is ${mode}, and the API has no ${chain} adapter for that yet: set it to mock or off`,
    );
  // Mainnet is Robinhood Chain's alone, and only with inputs that came from its own mainnet record
  // under the switch. Anything else is refused as it always was.
  if (config.network === 'mainnet' && !(chain === 'robinhood' && options.robinhood?.mainnet))
    throw new Error(
      `${key} is ${mode} on mainnet, which this API does not run yet: set ${envKey('CHAIN_NETWORK', chain)} to testnet or local${
        chain === 'robinhood'
          ? `, or commit the mainnet deploy record and set ${MAINNET_SWITCH}`
          : ''
      }`,
    );
  // The other way too: inputs of a mainnet record never run under a test network's name.
  if (chain === 'robinhood' && options.robinhood?.mainnet && config.network !== 'mainnet')
    throw new Error(
      `${key} was given a mainnet deploy record, and ${envKey('CHAIN_NETWORK', chain)} is ${config.network}`,
    );
  if (chain === 'robinhood') {
    if (!options.robinhood)
      throw new Error(
        `${key} is ${mode}, and the API was given no Robinhood Chain RPC or no asset list for ${config.networkName}`,
      );
    return {
      chain,
      mode,
      provenance: chainProvenance(config.network, mode) ?? 'sandbox',
      source: `Robinhood Chain ${config.networkName}, read over JSON-RPC by the EVM vault adapter`,
      config,
      adapter: createEvmVaultAdapter({
        config,
        rpc: options.robinhood.rpc,
        assets: options.robinhood.assets,
        pools: options.robinhood.pools,
        limits: options.robinhood.limits,
        trade: mode,
        autoFollow: flags.autoFollow[chain],
        ...(options.now ? { now: options.now } : {}),
      }),
    };
  }
  if (!options.solana)
    throw new Error(
      `${key} is ${mode}, and the API was given no Solana RPC or no asset list for ${config.networkName}`,
    );
  const provenance = chainProvenance(config.network, mode) ?? 'sandbox';
  const adapter = createSolanaVaultAdapter({
    config,
    rpc: options.solana.rpc,
    assets: options.solana.assets,
    trade: mode,
    autoFollow: flags.autoFollow[chain],
    ...(options.solana.jupiter ? { jupiter: options.solana.jupiter } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    chain,
    mode,
    provenance,
    source: `Solana ${config.networkName}, read over RPC by the vault adapter`,
    config,
    adapter,
  };
}

/** A chain refusal for a step the chain cannot take as it runs now. */
export function assertBuilds(entry: ChainEntry): void {
  if (entry.mode === 'readonly')
    throw new Refusal(503, `${entry.config.name} is read-only on this server`, {
      code: 'CHAIN_UNAVAILABLE',
      details: { retryable: false },
    });
}
