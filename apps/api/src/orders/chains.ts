import { createMockAdapter, type MockControl } from '@colosseum/chain-mock';
import {
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
// `readonly` have no adapter wired here yet, and say so at start: nothing falls back to the mock.

export type ChainEntry = {
  chain: ChainId;
  mode: Exclude<ChainMode, 'off'>;
  /** The label on every figure read from this chain as it runs now. */
  provenance: Provenance;
  config: ChainConfig;
  /** Builds, reads, and ties signed bytes and landed transactions back to what was built (`TxProbe`). */
  adapter: ChainAdapter;
  /** Set only when the chain runs on the mock. */
  mock?: MockControl;
};

export type ChainRegistry = {
  mode(chain: ChainId): ChainMode;
  /** The chain's adapter. Refuses with CHAIN_UNAVAILABLE when the chain is off. */
  get(chain: ChainId): ChainEntry;
  /** Every chain that is not off. */
  active(): ChainEntry[];
};

export type RegistryOptions = {
  /**
   * Mixed into every transaction the mock builds, so a mock started today never repeats an id that an
   * earlier run stored. New at every start.
   */
  seed: string;
  /** The clock the mock chains follow. Default: the wall clock. */
  now?: () => Date;
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
    if (mode !== 'mock')
      throw new Error(
        `${envKey('CHAIN_MODE', chain)} is ${mode}, and the API has no ${chain} adapter for that yet: set it to mock or off`,
      );
    const adapter = createMockAdapter({ chain, seed: options.seed, now: now().toISOString() });
    entries.set(chain, {
      chain,
      mode,
      // Never null here: the chain is not off.
      provenance: chainProvenance(configs[chain].network, mode) ?? 'mock',
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
    get(chain) {
      const entry = entries.get(chain);
      if (!entry)
        throw new Refusal(503, `${configs[chain].name} is switched off on this server`, {
          code: 'CHAIN_UNAVAILABLE',
          fix: 'Leave this chain out of the request.',
          details: { retryable: false },
        });
      return sync(entry);
    },
    active: () => [...entries.values()].map(sync),
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
