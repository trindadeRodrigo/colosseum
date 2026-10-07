import type { IntentRequest, Leg, Order } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { changedFields, madeEvent, orderKind, stateEvents } from './thread';

// What a plan's thread is told of an order, read from the order as the database has it: no request
// names an event. (The store and the routes are tested on the database: routes/v1/thread.test.ts.)

const ID = '3c1f9a7e-5b2d-4c8e-9f0a-1b2c3d4e5f60';
const leg = (kind: Leg['kind'], status: Leg['status']): Leg => ({
  id: crypto.randomUUID(),
  orderId: ID,
  chain: 'solana',
  seq: 0,
  kind,
  signer: 'owner',
  description: '',
  trades: [],
  expected: [],
  status,
  attempt: 0,
  txId: null,
  explorerUrl: null,
  validUntil: null,
  error: null,
  trigger: 'manual',
  provenance: 'mock',
});
const order = (status: Order['status'], legs: Leg[], over: Partial<Order> = {}): Order => ({
  id: ID,
  type: 'buy',
  owner: { solana: 'owner' },
  summary: '',
  legs,
  warnings: [],
  needsConsent: [],
  fees: [],
  preparedBy: 'app',
  status,
  approvalUrl: `/orders/${ID}`,
  expiresAt: 0,
  createdAt: '2026-10-07T00:00:00.000Z',
  disclaimer: '',
  ...over,
});
const buy: IntentRequest = {
  type: 'buy',
  owner: { solana: 'owner' },
  amountUsd: 900,
  proposalId: ID,
};
const add: IntentRequest = {
  type: 'buy',
  owner: { solana: 'owner' },
  amountUsd: 300,
  vault: { chain: 'solana', address: 'vault' },
};
const withdraw: IntentRequest = { type: 'withdraw', vaults: ['vault'], sellToCash: false };
const types = (o: Order, r: IntentRequest) => stateEvents(o, r).map((e) => e.type);

describe('what the thread is told of an order', () => {
  it('names its kind: a first buy, an add, the rest of a stopped buy, money taken out', () => {
    const plain = order('open', []);
    expect(orderKind(plain, buy)).toBe('buy');
    expect(orderKind(plain, add)).toBe('add');
    expect(orderKind({ ...plain, continues: 'another' }, buy)).toBe('finish');
    expect(orderKind(plain, withdraw)).toBe('withdraw');
    // an order the thread does not tell of: a follow, a publish, a setting
    expect(orderKind(plain, { type: 'settings', vault: 'vault', autoFollow: true })).toBeNull();
  });

  it('says an order was made once a step of it is built, with the dollars it moves in', () => {
    const pressed = [leg('deposit', 'built'), leg('swap', 'planned')];
    expect(madeEvent(order('open', pressed), buy)).toEqual({
      type: 'order_made',
      orderId: ID,
      kind: 'buy',
      amountUsd: 900,
    });
    expect(madeEvent(order('open', pressed), add)).toMatchObject({ kind: 'add', amountUsd: 300 });
    expect(madeEvent(order('open', [leg('swap', 'built')], { continues: 'x' }), buy)).toMatchObject(
      { kind: 'finish', amountUsd: null },
    );
    expect(madeEvent(order('open', [leg('withdraw', 'sent')]), withdraw)).toMatchObject({
      kind: 'withdraw',
      amountUsd: null,
    });
    expect(
      madeEvent(order('open', pressed), { type: 'settings', vault: 'v', autoFollow: true }),
    ).toBeNull();
    // an order a screen made to show its steps, with nothing pressed: not said, however many there are
    for (const request of [buy, add, withdraw])
      expect(
        madeEvent(order('open', [leg('deposit', 'planned'), leg('swap', 'planned')]), request),
      ).toBeNull();
    expect(madeEvent(order('expired', [leg('deposit', 'planned')]), buy)).toBeNull();
  });

  it('follows a buy: nothing until a step is built, then made, the deposit landed, done', () => {
    expect(
      types(order('open', [leg('create_vault', 'planned'), leg('swap', 'planned')]), buy),
    ).toEqual([]);
    expect(
      types(order('open', [leg('create_vault', 'built'), leg('swap', 'planned')]), buy),
    ).toEqual(['order_made']);
    expect(
      types(order('open', [leg('create_vault', 'confirmed'), leg('swap', 'planned')]), buy),
    ).toEqual(['order_made', 'deposit_landed']);
    expect(
      types(order('done', [leg('create_vault', 'confirmed'), leg('swap', 'confirmed')]), buy),
    ).toEqual(['order_made', 'deposit_landed', 'buy_done']);
  });

  it('says a buy stopped only when its cash is in the vault and it can no longer finish as it is', () => {
    // failed or run out of time after the deposit: the cash sits in the vault
    for (const status of ['failed', 'expired'] as const)
      expect(
        types(order(status, [leg('create_vault', 'confirmed'), leg('swap', 'failed')]), buy),
      ).toEqual(['order_made', 'deposit_landed', 'buy_stopped']);
    // run out of time before anything was built: nothing happened, and nothing is said
    expect(
      types(order('expired', [leg('create_vault', 'planned'), leg('swap', 'planned')]), buy),
    ).toEqual([]);
    // an order that finishes another has no deposit: its cash was already there
    expect(types(order('failed', [leg('swap', 'failed')], { continues: 'x' }), buy)).toEqual([
      'order_made',
      'buy_stopped',
    ]);
    expect(types(order('done', [leg('swap', 'confirmed')], { continues: 'x' }), buy)).toEqual([
      'order_made',
      'buy_done',
    ]);
  });

  it('says a withdrawal once it is done, and nothing of an order it does not tell of', () => {
    expect(
      types(order('open', [leg('withdraw', 'planned')], { type: 'withdraw' }), withdraw),
    ).toEqual([]);
    expect(
      types(order('done', [leg('withdraw', 'confirmed')], { type: 'withdraw' }), withdraw),
    ).toEqual(['order_made', 'withdrawal_done']);
    expect(
      types(order('done', [leg('set_auto_follow', 'confirmed')], { type: 'settings' }), {
        type: 'settings',
        vault: 'v',
        autoFollow: true,
      }),
    ).toEqual([]);
  });
});

describe('what a plan built again changed', () => {
  it('is the names of the sheet’s fields that differ, in order, and never a value', () => {
    const before = {
      goal: 'grow',
      amountUsd: 5000,
      risk: 'high',
      themes: ['ai'],
      rules: { glide: true },
    };
    expect(changedFields(before, before)).toEqual([]);
    expect(
      changedFields(before, { ...before, risk: 'low', amountUsd: 7000, rules: { glide: false } }),
    ).toEqual(['amountUsd', 'risk', 'rules']);
    // a field one sheet has and the other does not
    expect(changedFields(before, { ...before, incomeTargetUsdMonthly: 400 })).toEqual([
      'incomeTargetUsdMonthly',
    ]);
    // a name that is not a key is not said
    expect(changedFields(before, { ...before, 'not a key': 1 })).toEqual([]);
  });
});
