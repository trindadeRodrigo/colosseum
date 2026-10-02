import { createHash } from 'node:crypto';
import { createMockAdapter, type MockControl } from '@colosseum/chain-mock';
import {
  type Address,
  type ChainAdapter,
  type ChainConfig,
  ChainId,
  type ChainMode,
  chainFamily,
  chainProvenance,
  envKey,
  type Flags,
  type Provenance,
} from '@colosseum/schemas';
import { Refusal } from './errors';

// One adapter per chain, chosen by the chain's mode. `mock` runs on packages/chain-mock. `live` and
// `readonly` have no adapter wired here yet, and say so at start: nothing falls back to the mock.

/**
 * WORKAROUND, to move into packages/schemas (reported in the API-1 hand-over): two things the order
 * layer needs from a chain that ChainAdapter v0 does not have. A leg may only settle on the transaction
 * that was built for it, and signed bytes are only relayed when they are bytes this server built.
 */
export type TxProbe = {
  /** The message hash of signed bytes, computed as the adapter that built them does. */
  messageHashOf(signedTx: string): string;
  /** Broadcasts. Called only after `messageHashOf` matched an attempt this server built. */
  relay(signedTx: string, messageHash: string): Promise<{ txId: string; validUntil?: string }>;
  /** True when the transaction with this id carries the message with this hash, and no other. */
  carries(txId: string, messageHash: string): Promise<boolean>;
};

export type ChainEntry = {
  chain: ChainId;
  mode: Exclude<ChainMode, 'off'>;
  /** The label on every figure read from this chain as it runs now. */
  provenance: Provenance;
  config: ChainConfig;
  adapter: ChainAdapter;
  probe: TxProbe;
  /** Who a cash approval names, where the chain needs one. `vault` is null before the vault exists. */
  approveSpender(vault: Address | null): Address;
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

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * WORKAROUND: the id chain-mock gives the transaction with this message hash. A copy of `mockTxId` in
 * packages/chain-mock/src/ids.ts, which the package does not export. The end-to-end test fails if the
 * two ever differ.
 */
function mockTxId(chain: ChainId, messageHash: string): string {
  const hex = sha256Hex(`mock:${chain}:tx:${messageHash}`);
  if (chainFamily(chain) !== 'solana') return `0x${hex}`;
  let n = BigInt(`0x${hex}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (let i = 0; i < hex.length && hex.startsWith('00', i); i += 2) out = `1${out}`;
  return out;
}

function mockProbe(chain: ChainId, mock: MockControl): TxProbe {
  return {
    // The mock has no signatures: the "signed" bytes are the payload, and its hash is the message hash.
    messageHashOf: (signedTx) => sha256Hex(signedTx),
    relay: (_signedTx, messageHash) => mock.send({ messageHash }),
    carries: async (txId, messageHash) => txId === mockTxId(chain, messageHash),
  };
}

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
      probe: mockProbe(chain, adapter.mock),
      approveSpender: () => adapter.mock.addresses.factory,
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
