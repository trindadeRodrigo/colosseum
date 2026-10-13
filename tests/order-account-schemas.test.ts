import {
  DISCLAIMER,
  FundingQuery,
  FundingResponse,
  IntentRequest,
  Leg,
  Order,
  OrderDetail,
  OrderError,
  PersonResponse,
  PickChainRequest,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// The shared types API-2 changed or added: one chain per order (gate ONE-CHAIN), the cash a step
// carries, the step that blocks another on an EVM chain, and the bodies of /v1/me and /v1/funding.

const SOLANA = '11111111111111111111111111111111';
const EVM = '0x00000000000000000000000000000000000000aa';
const ID = '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d';

const leg = (chain: 'solana' | 'robinhood' | 'base', seq: number, more: object = {}) => ({
  id: `${chain}-${seq}`,
  orderId: ID,
  chain,
  seq,
  kind: 'swap',
  signer: 'owner',
  description: 'a step',
  trades: [],
  expected: [],
  status: 'planned',
  attempt: 0,
  txId: null,
  explorerUrl: null,
  validUntil: null,
  error: null,
  trigger: 'manual',
  provenance: 'mock',
  ...more,
});
const order = (type: string, legs: object[]) => ({
  id: ID,
  type,
  owner: { solana: SOLANA, evm: EVM },
  summary: 'an order',
  legs,
  warnings: [],
  needsConsent: [],
  fees: [],
  preparedBy: 'app',
  status: 'open',
  approvalUrl: `/orders/${ID}`,
  expiresAt: 1,
  createdAt: '2026-10-05T15:00:00.000Z',
  disclaimer: DISCLAIMER.en,
});

describe('one chain per order', () => {
  it('only a publish order has legs on more than one chain', () => {
    const two = [leg('solana', 0), leg('robinhood', 0)];
    for (const type of ['buy', 'rebalance', 'follow', 'withdraw', 'settings']) {
      const refused = Order.safeParse(order(type, two));
      expect([type, refused.success]).toEqual([type, false]);
      expect(refused.error?.issues[0]?.message).toBe(
        'only a publish order has legs on more than one chain',
      );
      // Any number of legs on one chain is that kind of order.
      expect(Order.safeParse(order(type, [leg('solana', 0), leg('solana', 1)])).success).toBe(true);
      expect(Order.safeParse(order(type, [])).success).toBe(true);
    }
    // A shared portfolio is published with one recipe per chain: one order, a leg on each.
    expect(Order.safeParse(order('publish', two)).success).toBe(true);
    // Two EVM chains are two chains, though one address serves both.
    expect(Order.safeParse(order('buy', [leg('robinhood', 0), leg('base', 0)])).success).toBe(
      false,
    );
  });

  it('a buy names no chain: the field it once took is refused with a sentence, not ignored', () => {
    const buy = { type: 'buy', owner: { solana: SOLANA }, amountUsd: 10, proposalId: ID };
    expect(IntentRequest.parse(buy)).toEqual(buy);
    for (const chains of [['solana', 'robinhood'], ['solana'], [], 'solana', null]) {
      const refused = IntentRequest.safeParse({ ...buy, chains });
      expect([chains, refused.success]).toEqual([chains, false]);
      expect(refused.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
        [
          'chains',
          'a buy names no chain: an order is on the chain of the wallet, where the plan lives. Leave `chains` out',
        ],
      ]);
    }
    // The other kinds of order never took it, and are as they were.
    const settings = { type: 'settings', vault: SOLANA, autoFollow: false };
    expect(IntentRequest.parse({ ...settings, chains: ['solana'] })).toEqual(settings);
  });

  it('a buy of a shared portfolio may name the one chain of the recipe it follows', () => {
    const buy = { type: 'buy', owner: { evm: EVM }, amountUsd: 10, family: 'core' };
    expect(IntentRequest.parse({ ...buy, chain: 'robinhood' })).toEqual({
      ...buy,
      chain: 'robinhood',
    });
    // one chain, by its id: never a list, and never a wallet family
    for (const chain of [['robinhood'], 'evm', 'Robinhood Chain', null])
      expect([chain, IntentRequest.safeParse({ ...buy, chain }).success]).toEqual([chain, false]);
  });
});

describe('the cash a step carries', () => {
  it('is raw units of the dollar token, on the steps that move it, and absent on the others', () => {
    const deposit = leg('solana', 0, { kind: 'deposit', cashRaw: '1000000000' });
    expect(Leg.parse(deposit).cashRaw).toBe('1000000000');
    expect(Leg.parse(leg('solana', 1)).cashRaw).toBeUndefined();
    // It may be more than the step's trades spend: the rest is the plan's cash share.
    const trades = [{ sell: 'solana:usdc', buy: 'solana:spy', amountInRaw: '950000000' }];
    expect(Leg.safeParse({ ...deposit, trades }).success).toBe(true);
    for (const cashRaw of ['1.5', '-1', 1000, null])
      expect(Leg.safeParse({ ...deposit, cashRaw }).success).toBe(false);
    // An order's answer carries it through.
    const detail = OrderDetail.parse({ ...order('buy', [deposit]), attempts: [] });
    expect(detail.legs[0]?.cashRaw).toBe('1000000000');
  });

  it('is on the approval and on the deposit, so the order says once what it moves', () => {
    const legs = [
      leg('robinhood', 0, { kind: 'approve', cashRaw: '1000000000' }),
      leg('robinhood', 1, { kind: 'create_vault', cashRaw: '1000000000' }),
    ];
    const buy = { ...order('buy', legs), owner: { evm: EVM }, depositRaw: '1000000000' };
    const parsed = Order.parse(buy);
    expect(parsed.depositRaw).toBe('1000000000');
    // The legs add up to twice the deposit: the order's own field is the figure.
    expect(parsed.legs.reduce((n, l) => n + BigInt(l.cashRaw ?? '0'), 0n)).toBe(2_000_000_000n);
    expect(OrderDetail.parse({ ...buy, attempts: [] }).depositRaw).toBe('1000000000');
    // Absent on an order that deposits nothing; raw units when it is there.
    expect(Order.parse(order('rebalance', [leg('solana', 0)])).depositRaw).toBeUndefined();
    for (const depositRaw of ['1.5', '-1', 1000, null])
      expect(Order.safeParse({ ...buy, depositRaw }).success).toBe(false);
  });
});

describe('a refusal that names the step in the way', () => {
  it('carries the order and the step, beside the chain’s code and retryable', () => {
    const blocking = { orderId: ID, legId: 'leg-1' };
    const refusal = { error: 'another order', details: { retryable: true, blocking } };
    expect(OrderError.parse(refusal)).toEqual(refusal);
    expect(
      OrderError.safeParse({ error: 'x', details: { blocking: { orderId: ID } } }).success,
    ).toBe(false);
    // Without it the shape is as it was.
    expect(OrderError.parse({ error: 'x', details: { retryable: false } })).toEqual({
      error: 'x',
      details: { retryable: false },
    });
  });
});

describe('the bodies of /v1/me and /v1/funding', () => {
  it('a pick is one chain and nothing else', () => {
    expect(PickChainRequest.parse({ chain: 'robinhood' })).toEqual({ chain: 'robinhood' });
    for (const body of [{}, { chain: 'evm' }, { chain: 'solana', wallet: SOLANA }, { chain: null }])
      expect(PickChainRequest.safeParse(body).success).toBe(false);
  });

  it('a person has a chain and where it came from, or what they may pick', () => {
    const wallets = [{ family: 'solana', address: SOLANA, kind: 'external' }];
    const person = { userId: 'did:privy:x', wallets, chain: 'solana', chainSource: 'wallet' };
    expect(PersonResponse.safeParse({ ...person, chainOptions: [] }).success).toBe(true);
    const unpicked = { ...person, chain: null, chainSource: null, chainOptions: ['solana'] };
    expect(PersonResponse.safeParse(unpicked).success).toBe(true);
    expect(
      PersonResponse.safeParse({ ...person, chainSource: 'guess', chainOptions: [] }).success,
    ).toBe(false);
    // A wallet in the form of the other family is not a wallet.
    const odd = { ...person, chainOptions: [], wallets: [{ ...wallets[0], address: EVM }] };
    expect(PersonResponse.safeParse(odd).success).toBe(false);
  });

  it('a funding query names a plan and an amount together, or neither', () => {
    expect(FundingQuery.parse({})).toEqual({});
    expect(FundingQuery.parse({ amountUsd: '250.5', proposalId: ID })).toEqual({
      amountUsd: 250.5,
      proposalId: ID,
    });
    for (const query of [
      { amountUsd: '10' },
      { proposalId: ID },
      { amountUsd: '0', proposalId: ID },
      { amountUsd: '1000000.01', proposalId: ID },
      { amountUsd: '10', proposalId: 'a-plan' },
      { family: 'core' },
      { amountUsd: '10', family: 'Not A Slug' },
      { amountUsd: '10', proposalId: ID, family: 'core' },
    ])
      expect([query, FundingQuery.safeParse(query).success]).toEqual([query, false]);
    // A shared portfolio's slug in place of the plan (WEB-4).
    expect(FundingQuery.parse({ amountUsd: '10', family: 'core' })).toEqual({
      amountUsd: 10,
      family: 'core',
    });
    // The chain of the recipe the buy follows goes with the slug, and with nothing else.
    expect(FundingQuery.parse({ amountUsd: '10', family: 'core', chain: 'robinhood' })).toEqual({
      amountUsd: 10,
      family: 'core',
      chain: 'robinhood',
    });
    for (const query of [
      { chain: 'solana' },
      { amountUsd: '10', proposalId: ID, chain: 'solana' },
      { amountUsd: '10', family: 'core', chain: 'evm' },
    ])
      expect([query, FundingQuery.safeParse(query).success]).toEqual([query, false]);
  });

  it('a funding query may name the wallet to read, as an address in the form used here', () => {
    for (const wallet of [SOLANA, EVM]) expect(FundingQuery.parse({ wallet })).toEqual({ wallet });
    expect(FundingQuery.parse({ wallet: EVM, amountUsd: '10', proposalId: ID })).toEqual({
      wallet: EVM,
      amountUsd: 10,
      proposalId: ID,
    });
    for (const wallet of ['', 'a-wallet', EVM.toUpperCase(), `${EVM}0`])
      expect([wallet, FundingQuery.safeParse({ wallet }).success]).toEqual([wallet, false]);
  });

  it('every funding figure carries its source, its time, its method and its label', () => {
    const figure = {
      source: 'chain-mock',
      method: 'a read',
      fetchedAt: '2026-10-05T15:00:00.000Z',
      provenance: 'mock',
      symbol: 'USDC',
      decimals: 6,
      haveRaw: '0',
      needRaw: '10',
      missingRaw: '10',
    };
    const answer = {
      chain: 'solana',
      name: 'Solana',
      mode: 'mock',
      provenance: 'mock',
      wallet: SOLANA,
      cash: { ...figure, asset: 'solana:usdc' },
      gas: { ...figure, symbol: 'SOL', decimals: 9 },
      steps: 4,
      newVault: true,
      ok: false,
    };
    expect(FundingResponse.parse(answer)).toEqual(answer);
    for (const field of ['source', 'method', 'fetchedAt', 'provenance'] as const) {
      const { [field]: _gone, ...rest } = figure;
      expect([field, FundingResponse.safeParse({ ...answer, gas: rest }).success]).toEqual([
        field,
        false,
      ]);
      expect(
        FundingResponse.safeParse({ ...answer, cash: { ...rest, asset: 'solana:usdc' } }).success,
      ).toBe(false);
    }
    expect(FundingResponse.safeParse({ ...answer, provenance: undefined }).success).toBe(false);
  });
});
