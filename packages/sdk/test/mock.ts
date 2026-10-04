import { createHash } from 'node:crypto';
import {
  createMockAdapter,
  type MockAdapter,
  mockAddress,
  mockRecipeId,
} from '@colosseum/chain-mock';
import {
  type BasketTx,
  type BuiltTx,
  type ChainId,
  chainFamily,
  evmCallPreimage,
  type Recipe,
  stampTx,
} from '@colosseum/schemas';
import { deploymentsOf } from '../src/guard/deployment';
import type { ApprovedTrade, Loaded, MockDeployment } from '../src/guard/types';

// The mock chain for the guard's and the executor's tests: transactions built by packages/chain-mock
// itself, and a way to change one field of one, as a server that lies would.

export const usd = (dollars: number) => (BigInt(dollars) * 1_000_000n).toString();
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export type MockWorld = {
  chain: ChainId;
  adapter: MockAdapter;
  deployment: Loaded<MockDeployment>;
  owner: string;
  stranger: string;
  /** Lands a built transaction, as a wallet that signed and sent it. */
  send(tx: BuiltTx): Promise<void>;
};

export function mockWorld(chain: ChainId): MockWorld {
  const adapter = createMockAdapter({ chain });
  const owner = mockAddress(chain, 'sdk owner');
  const stranger = mockAddress(chain, 'sdk stranger');
  for (const who of [owner, stranger])
    adapter.mock.fund(who, {
      gasRaw: '1000000000000000000',
      assets: { [adapter.mock.cash]: usd(100_000) },
    });
  return {
    chain,
    adapter,
    // The mock's own committed file (packages/sdk/deployments/mock.json), as the web reads it.
    deployment: deploymentsOf('mock')[chain] as Loaded<MockDeployment>,
    owner,
    stranger,
    send: async (tx) => {
      await adapter.mock.send(tx);
    },
  };
}

/** A shared portfolio of the mock's assets, as its creator publishes it. */
export function recipeOf(w: MockWorld, familyId: string, weights: Record<string, number>): Recipe {
  return {
    schemaVersion: 1,
    familyId,
    chain: w.chain,
    onchainId: null,
    creator: w.stranger,
    kind: 'community',
    version: 1,
    effectiveAt: 0,
    components: Object.entries(weights).map(([slug, weightBps]) => ({
      kind: 'asset',
      asset: `${w.chain}:${slug}`,
      weightBps,
    })),
    metaHash: sha(`sdk family ${familyId}`),
    maxFeeBps: 0,
    flags: 0,
  };
}
export const recipeIdOf = (w: MockWorld, familyId: string) =>
  mockRecipeId(w.chain, w.stranger, familyId);

/** A built transaction as the API hands it out for a leg. */
export const stamped = (tx: BuiltTx, legId = 'leg-1', attemptId = 'attempt-1'): BasketTx =>
  stampTx(tx, { legId, attemptId });

/** The trades of a transaction as a step holds them: what the bytes sell, and the least they accept. */
export const tradesOfTx = (tx: BuiltTx): ApprovedTrade[] =>
  tx.preview.minimums.map((m) => ({ ...m }));

type Message = {
  mock: true;
  chain: string;
  signer: string;
  to?: string;
  op: { kind: string; a: Record<string, unknown> };
  mins: string[];
};

/** The operation inside a mock transaction. */
export function messageOf(tx: BuiltTx): Message {
  const bytes =
    chainFamily(tx.chainId) === 'solana'
      ? Buffer.from(tx.payload, 'base64').subarray(65)
      : Buffer.from(tx.payload.slice(2), 'hex');
  return JSON.parse(bytes.toString());
}

/**
 * The same transaction with its operation changed, and a message hash that is the hash of the new
 * bytes: what a server that built something else would hand out. The mock itself never built it.
 */
export function tampered<T extends BuiltTx>(tx: T, change: (message: Message) => void): T {
  const message = messageOf(tx);
  change(message);
  const bytes = Buffer.from(JSON.stringify(message));
  if (chainFamily(tx.chainId) === 'solana')
    return {
      ...tx,
      payload: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), bytes]).toString('base64'),
      messageHash: sha(bytes),
    };
  const payload = `0x${bytes.toString('hex')}`;
  const evm = tx.evm ?? { to: '', value: '0', chainId: 0 };
  return {
    ...tx,
    payload,
    messageHash: sha(evmCallPreimage({ ...evm, signer: tx.signer, data: payload })),
  };
}
