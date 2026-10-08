import type { Db } from '@colosseum/db';
import {
  AcceptGoalMixResponse,
  type Address,
  ApplyVaultMixResponse,
  type BasketProposal,
  type BuiltTx,
  type IntentRequest,
  type Order,
  OrderError,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureLiquidity } from '../../../../../packages/engine/src/personal/testing';
import { createChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import { prepareOrder } from '../../orders/prepare';
import { registerAuth } from '../../plugins/auth';
import { person, testIssuer } from '../../testing/harness';
import { type MixStore, registerMixRoutes } from './mix';

// POST /v1/conversations/{chain}/goal/accept and POST /v1/vaults/{chain}/{address}/targets (gate
// ANY-COMPOSITION). The store is in memory and the database is out of reach: a review writes
// nothing, and a confirmed mix writes one plan or one order.

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const issuer = await testIssuer('mix');
  const owner = await person(issuer, 'solana');
  const stranger = await person(issuer, 'solana');
  const evmOnly = await person(issuer, 'robinhood');
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 'mix-route' });
  const plans = new Map<string, BasketProposal>();
  const saved: Array<{ order: Order; request: IntentRequest }> = [];
  const store: MixStore = {
    saveProposal: vi.fn(async (proposal: BasketProposal) => {
      const id = `00000000-0000-4000-8000-${String(plans.size + 1).padStart(12, '0')}`;
      plans.set(id, proposal);
      return id;
    }),
    saveOrder: vi.fn(async (order: Order, request: IntentRequest) => {
      saved.push({ order, request });
    }),
    planOf: vi.fn(async () => ({ goal: 'income' as const, risk: 'low' as const })),
  };
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('the database is out of reach in this test');
      },
    },
  ) as Db;
  const app = Fastify();
  cleanup.push(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app, issuer.issuer);
  app.setErrorHandler((error, _req, reply) =>
    error instanceof Refusal
      ? reply.code(error.status).send(error.body())
      : reply.code(400).send({ error: 'invalid request' }),
  );
  registerMixRoutes(
    app,
    { db, chains, now: () => new Date('2026-10-08T12:00:00.000Z') },
    async () => ({
      liquidity: {
        provider: fixtureLiquidity({ 'solana:nvda': 2000 }),
        source: 'fixture exit table',
      },
    }),
    store,
  );
  const post = (url: string, payload: object, who = owner) =>
    app.inject({ method: 'POST', url, headers: who.headers, payload });
  return { app, chains, owner, stranger, evmOnly, store, plans, saved, post };
}

const ACCEPT = '/v1/conversations/solana/goal/accept';
const goal = (over: object = {}) => ({
  version: 1,
  origin: 'model',
  language: 'en',
  goal: 'grow',
  risk: 'medium',
  amountUsd: 10_000,
  allocations: [
    { assetId: 'solana:usdc', weightBps: 1000 },
    { assetId: 'solana:nvda', weightBps: 4000 },
    { assetId: 'solana:yield', weightBps: 5000 },
  ],
  confirm: false,
  acceptedWarnings: [],
  ...over,
});

describe('POST /v1/conversations/{chain}/goal/accept', () => {
  it('needs a sign-in, and a wallet for the chain', async () => {
    const s = await setup();
    const none = await s.app.inject({ method: 'POST', url: ACCEPT, payload: goal() });
    expect(none.statusCode).toBe(401);
    expect(none.headers['cache-control']).toBe('private, no-store');
    expect((await s.post(ACCEPT, goal(), s.evmOnly)).statusCode).toBe(403);
    expect(s.store.saveProposal).not.toHaveBeenCalled();
  });

  it('answers a review and stores nothing until confirmed with every warning accepted', async () => {
    const s = await setup();
    const review = await s.post(ACCEPT, goal());
    expect(review.statusCode, review.body).toBe(200);
    const body = AcceptGoalMixResponse.parse(review.json());
    expect(body.status).toBe('review');
    expect(body.review.unconfirmed).toEqual(['EXIT_OVER_CAPACITY:solana:nvda']);
    expect(body.review.targets).toEqual([
      { asset: 'solana:nvda', weightBps: 4000 },
      { asset: 'solana:yield', weightBps: 5000 },
    ]);
    // Over its measured exit is a warning, not a refusal: confirmed without accepting it, still a review.
    const unaccepted = AcceptGoalMixResponse.parse(
      (await s.post(ACCEPT, goal({ confirm: true }))).json(),
    );
    expect(unaccepted.status).toBe('review');
    expect(s.store.saveProposal).not.toHaveBeenCalled();
    const stored = await s.post(
      ACCEPT,
      goal({ confirm: true, acceptedWarnings: ['EXIT_OVER_CAPACITY:solana:nvda'] }),
    );
    const done = AcceptGoalMixResponse.parse(stored.json());
    if (done.status !== 'stored') throw new Error(stored.body);
    expect(done.proposal.origin).toBe('model');
    expect(done.proposal.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['solana:usdc', 1000],
      ['solana:nvda', 4000],
      ['solana:yield', 5000],
    ]);
    expect(s.store.saveProposal).toHaveBeenCalledWith(done.proposal, s.owner.sub);
    expect(s.plans.get(done.proposalId)).toEqual(done.proposal);
  });

  it('refuses tampered weights, unlisted assets, cash twice and more than 16 lines', async () => {
    const s = await setup();
    const issues = async (allocations: object[]) => {
      const res = await s.post(ACCEPT, goal({ allocations, confirm: true }));
      expect(res.statusCode, res.body).toBe(422);
      const err = OrderError.parse(res.json());
      expect(err.code).toBe('MIX_NOT_VALID');
      return err.details?.issues;
    };
    expect(
      await issues([
        { assetId: 'solana:nvda', weightBps: 6000 },
        { assetId: 'solana:usdc', weightBps: 4001 },
      ]),
    ).toEqual(['SUM_NOT_10000']);
    expect(
      await issues([
        { assetId: 'robinhood:nvda', weightBps: 5000 },
        { assetId: 'solana:usdc', weightBps: 5000 },
      ]),
    ).toEqual(['NOT_LISTED:robinhood:nvda']);
    expect(
      await issues([
        { assetId: 'solana:usdc', weightBps: 5000 },
        { assetId: 'solana:usdc', weightBps: 5000 },
      ]),
    ).toEqual(['DUPLICATE:solana:usdc']);
    expect(
      await issues(
        Array.from({ length: 17 }, (_, i) => ({
          assetId: `solana:asset-${i}`,
          weightBps: i === 0 ? 2000 : 500,
        })),
      ),
    ).toEqual([
      ...Array.from({ length: 17 }, (_, i) => `NOT_LISTED:solana:asset-${i}`),
      'TOO_MANY_LINES',
    ]);
    // A weight that is not a whole basis point is not even read.
    const half = await s.post(
      ACCEPT,
      goal({
        allocations: [
          { assetId: 'solana:nvda', weightBps: 4999.5 },
          { assetId: 'solana:usdc', weightBps: 5000.5 },
        ],
      }),
    );
    expect(half.statusCode).toBe(400);
    expect(s.store.saveProposal).not.toHaveBeenCalled();
  });

  it('stores stocks in an income plan only once the person accepts the warning', async () => {
    const s = await setup();
    const income = (over: object) =>
      goal({
        goal: 'income',
        amountUsd: 1000,
        allocations: [
          { assetId: 'solana:usdc', weightBps: 2000 },
          { assetId: 'solana:tsla', weightBps: 3000 },
          { assetId: 'solana:yield', weightBps: 5000 },
        ],
        confirm: true,
        ...over,
      });
    const first = AcceptGoalMixResponse.parse((await s.post(ACCEPT, income({}))).json());
    expect(first.status).toBe('review');
    expect(first.review.unconfirmed).toEqual(['NOT_FOR_GOAL:solana:tsla']);
    expect(s.store.saveProposal).not.toHaveBeenCalled();
    const second = AcceptGoalMixResponse.parse(
      (await s.post(ACCEPT, income({ acceptedWarnings: ['NOT_FOR_GOAL:solana:tsla'] }))).json(),
    );
    expect(second.status).toBe('stored');
    if (second.status === 'stored')
      expect(second.proposal.flags).toContain('confirmed:NOT_FOR_GOAL:solana:tsla');
  });

  it('stores a plan the existing buy turns into legs, unchanged', async () => {
    const s = await setup();
    const res = AcceptGoalMixResponse.parse(
      (
        await s.post(
          ACCEPT,
          goal({
            origin: 'person',
            amountUsd: 500,
            confirm: true,
            allocations: [
              { assetId: 'solana:usdc', weightBps: 1000 },
              { assetId: 'solana:spy', weightBps: 5000 },
              { assetId: 'solana:gold', weightBps: 4000 },
            ],
          }),
        )
      ).json(),
    );
    if (res.status !== 'stored') throw new Error('not stored');
    const { order } = await prepareOrder(
      { type: 'buy', owner: s.owner.owner, amountUsd: 500, proposalId: res.proposalId },
      {
        principal: {
          kind: 'user',
          userId: s.owner.sub,
          wallets: [{ family: 'solana', address: s.owner.solana }] as never,
          ip: '127.0.0.1',
        },
        chains: s.chains,
        loadProposal: async (id) => s.plans.get(id) ?? null,
        homeChain: async () => 'solana',
        loadFamilies: async () => [],
        now: '2026-10-08T12:00:00.000Z',
      },
    );
    expect(order.legs.map((l) => [l.kind, l.trades.map((t) => t.buy)])).toEqual([
      ['create_vault', []],
      ['swap', ['solana:spy']],
      ['swap', ['solana:gold']],
    ]);
    expect(order.depositRaw).toBe('500000000');
  });
});

describe('POST /v1/vaults/{chain}/{address}/targets', () => {
  async function withVault() {
    const s = await setup();
    const entry = s.chains.get('solana');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.owner.solana as Address;
    mock.fund(owner, { gasRaw: '100000000000', assets: { 'solana:usdc': '1000000000' } });
    const send = (tx: BuiltTx) => mock.send(tx);
    await send(
      await entry.adapter.buildCreateVault({
        owner,
        basketId: '9',
        targets: [{ asset: 'solana:spy', weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: '1000000000',
        slippageBps: 100,
      }),
    );
    const [vault] = await entry.adapter.getVaults(owner);
    if (!vault) throw new Error('no vault');
    await send(
      await entry.adapter.buildOwnerSwap({
        vault: vault.address,
        trades: [{ sell: 'solana:usdc', buy: 'solana:spy', amountInRaw: '1000000000' }],
        slippageBps: 100,
      }),
    );
    return { ...s, url: `/v1/vaults/solana/${vault.address}/targets`, address: vault.address };
  }
  const targets = (over: object = {}) => ({
    version: 1,
    origin: 'person',
    language: 'en',
    allocations: [
      { assetId: 'solana:usdc', weightBps: 2000 },
      { assetId: 'solana:spy', weightBps: 5000 },
      { assetId: 'solana:tsla', weightBps: 3000 },
    ],
    confirm: false,
    acceptedWarnings: [],
    ...over,
  });

  it('answers a stranger as a vault that is not there, and reads nothing else', async () => {
    const s = await withVault();
    const res = await s.post(s.url, targets(), s.stranger);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(s.store.planOf).not.toHaveBeenCalled();
  });

  it('reviews against the plan the vault was opened for, and orders the targets once confirmed', async () => {
    const s = await withVault();
    const review = ApplyVaultMixResponse.parse((await s.post(s.url, targets())).json());
    expect(review.status).toBe('review');
    // The vault's plan is an income plan (the store says so): a stock in it is a warning.
    expect(review.review.goal).toBe('income');
    expect(review.review.unconfirmed).toEqual([
      'NOT_FOR_GOAL:solana:spy',
      'NOT_FOR_GOAL:solana:tsla',
    ]);
    expect(review.review.amountUsd).toBeCloseTo(999, 0);
    expect(s.store.saveOrder).not.toHaveBeenCalled();
    const res = await s.post(
      s.url,
      targets({ confirm: true, acceptedWarnings: review.review.unconfirmed }),
    );
    const ordered = ApplyVaultMixResponse.parse(res.json());
    if (ordered.status !== 'ordered') throw new Error(res.body);
    expect(ordered.order.type).toBe('rebalance');
    expect(ordered.order.legs.map((l) => l.kind)).toEqual(['set_targets', 'swap', 'swap']);
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]?.request).toEqual({
      type: 'rebalance',
      vaults: [s.address],
      reason: 'manual',
      targets: [
        { asset: 'solana:spy', weightBps: 5000 },
        { asset: 'solana:tsla', weightBps: 3000 },
      ],
      maxSlippageBps: 100,
    });
  });

  it('orders an EVM vault for the wallet as the sign-in names it, whatever its case', async () => {
    const s = await setup();
    const entry = s.chains.get('robinhood');
    const mock = entry.mock;
    if (!mock) throw new Error('the test chain is the mock');
    const owner = s.evmOnly.evm as Address;
    mock.fund(owner, {
      gasRaw: '1000000000000000000',
      assets: { 'robinhood:usdc': '1000000000' },
    });
    await mock.send(
      await entry.adapter.buildApprove({ owner, basketId: '11', amountRaw: '1000000000' }),
    );
    await mock.send(
      await entry.adapter.buildCreateVault({
        owner,
        basketId: '11',
        targets: [{ asset: 'robinhood:spy', weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: '1000000000',
        trades: [{ sell: 'robinhood:usdc', buy: 'robinhood:spy', amountInRaw: '1000000000' }],
        slippageBps: 100,
      }),
    );
    const [vault] = await entry.adapter.getVaults(owner);
    if (!vault) throw new Error('no vault');
    const url = `/v1/vaults/robinhood/0x${vault.address.slice(2).toUpperCase()}/targets`;
    const res = await s.post(
      url,
      targets({
        allocations: [
          { assetId: 'robinhood:usdc', weightBps: 5000 },
          { assetId: 'robinhood:gold', weightBps: 5000 },
        ],
        confirm: true,
        acceptedWarnings: ['NOT_FOR_GOAL:robinhood:gold'],
      }),
      s.evmOnly,
    );
    const ordered = ApplyVaultMixResponse.parse(res.json());
    if (ordered.status !== 'ordered') throw new Error(res.body);
    // EVM trades ride together: the sale of SPY and the purchase of gold are one step.
    expect(ordered.order.legs.map((l) => l.kind)).toEqual(['set_targets', 'swap']);
    expect(ordered.order.owner.evm?.toLowerCase()).toBe(owner.toLowerCase());
  });

  it('refuses all cash for an open vault', async () => {
    const s = await withVault();
    const res = await s.post(
      s.url,
      targets({ allocations: [{ assetId: 'solana:usdc', weightBps: 10_000 }], confirm: true }),
    );
    expect(res.statusCode).toBe(422);
    expect(OrderError.parse(res.json()).details?.issues).toEqual(['ALL_CASH']);
  });
});
