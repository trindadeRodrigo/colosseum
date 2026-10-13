import type { Leg, Order } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import type { ChainRegistry } from './chains';
import { continueBuy } from './continue';
import { Refusal } from './errors';
import type { StoredOrder } from './store';

// What finishing a buy refuses, by its code: the web acts on the code, never on the sentence
// (`OrderErrorCode` in packages/schemas). The route's own refusals (another order finishes it, a step
// can still land, the order is busy) are in routes/v1/order-terms.test.ts, on the database.

const leg = (over: Partial<Leg>): Leg => ({
  id: crypto.randomUUID(),
  orderId: 'order-1',
  chain: 'solana',
  seq: 0,
  kind: 'swap',
  signer: 'owner',
  description: 'Buy SPY',
  trades: [{ sell: 'solana:usdc', buy: 'solana:spy', amountInRaw: '600' }],
  expected: [],
  status: 'planned',
  attempt: 0,
  txId: null,
  explorerUrl: null,
  validUntil: null,
  error: null,
  trigger: 'manual',
  provenance: 'mock',
  ...over,
});
const deposit = (status: Leg['status'], chain: Leg['chain'] = 'solana') =>
  leg({ kind: 'create_vault', trades: [], cashRaw: '1000', status, chain });

const stored = (legs: Leg[], over: Partial<Order> = {}): StoredOrder => ({
  order: {
    id: 'order-1',
    type: 'buy',
    owner: { solana: 'owner-sol', evm: '0xowner' },
    summary: 'a buy',
    basketId: '77',
    legs: legs.map((l, seq) => ({ ...l, seq })),
    warnings: [],
    needsConsent: [],
    fees: [],
    preparedBy: 'app',
    status: 'open',
    approvalUrl: '/orders/order-1',
    expiresAt: 0,
    createdAt: '2026-10-06T00:00:00.000Z',
    disclaimer: 'd',
    ...over,
  },
  request: { type: 'buy', owner: { solana: 'owner-sol' }, amountUsd: 10, proposalId: 'p' },
  attempts: [],
});

/** A registry of one chain whose vault holds `cashRaw` of cash. */
const chains = (cashRaw: string) =>
  ({
    get: (chain: string) => ({
      chain,
      mode: 'mock',
      provenance: 'mock',
      config: { name: chain === 'solana' ? 'Solana' : 'Robinhood Chain' },
      adapter: {
        listAssets: async () => [{ id: 'solana:usdc', cls: 'cash', symbol: 'USDC' }],
        getVaults: async () => [{ basketId: '77', cash: { raw: cashRaw } }],
        quote: async () => ({ outRaw: '5000', costBps: 10 }),
      },
    }),
  }) as unknown as ChainRegistry;

const refusal = async (order: StoredOrder, cashRaw = '1000') => {
  const outcome = await continueBuy(order, {
    chains: chains(cashRaw),
    now: '2026-10-06T00:00:00.000Z',
  }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(outcome).toBeInstanceOf(Refusal);
  return outcome as Refusal;
};

describe('what finishing a buy refuses, by its code', () => {
  it.each([
    ['the deposit has not landed', [deposit('planned'), leg({})], 'DEPOSIT_NOT_LANDED'],
    ['nothing is left', [deposit('confirmed'), leg({ status: 'confirmed' })], 'NOTHING_LEFT'],
    [
      'a chain that trades inside its deposit',
      [deposit('planned', 'robinhood')],
      'CONTINUE_NOT_SUPPORTED',
    ],
  ] as const)('%s', async (_, legs, code) => {
    const refused = await refusal(stored([...legs]));
    expect([refused.status, refused.extra.code]).toEqual([409, code]);
  });

  it('the vault holds less cash than the steps left would spend', async () => {
    const refused = await refusal(stored([deposit('confirmed'), leg({})]), '599');
    expect([refused.status, refused.extra.code]).toEqual([409, 'VAULT_CASH_SHORT']);
    // and with enough, the order is made: a swap, no deposit, naming the order it finishes
    const made = await continueBuy(stored([deposit('confirmed'), leg({})]), {
      chains: chains('600'),
      now: '2026-10-06T00:00:00.000Z',
    });
    expect(made.order).toMatchObject({ continues: 'order-1', basketId: '77' });
    expect(made.order.depositRaw).toBeUndefined();
    expect(made.order.legs.map((l) => l.kind)).toEqual(['swap']);
  });

  it('an order this route does not finish: not a buy, or one with no vault of its own', async () => {
    for (const order of [
      stored([deposit('confirmed'), leg({})], { type: 'follow' }),
      stored([deposit('confirmed'), leg({})], { basketId: undefined }),
    ]) {
      const refused = await refusal(order);
      expect([refused.status, refused.extra.code]).toEqual([409, 'CONTINUE_NOT_SUPPORTED']);
    }
  });
});
