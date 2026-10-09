import { orders, proposals, users } from '@colosseum/db';
import { AcceptGoalMixResponse, ApplyVaultMixResponse } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureLiquidity } from '../../../../../packages/engine/src/personal/testing';
import type { ChainRegistry } from '../../orders/chains';
import { loadOrder, loadProposal } from '../../orders/store';
import { orderFlow } from '../../testing/flow';
import { person, type TestIssuer, testApp, testDb, testIssuer } from '../../testing/harness';

// Gate ANY-COMPOSITION, through the whole app and a real Postgres: a confirmed mix stored as a plan,
// bought by its id through the order layer, and a vault's new targets ordered and settled, each read
// back from the database. Runs where a database is (CI); skipped on a machine with none.

const DB = Boolean(process.env.CI || process.env.DATABASE_URL);

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!DB)('a mix, stored and bought, and a vault retargeted, in the database', () => {
  let issuer: TestIssuer;
  let data: Awaited<ReturnType<typeof testDb>>;
  let app: FastifyInstance;
  let registry: ChainRegistry;
  const undo: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    issuer = await testIssuer('mix-db');
    data = await testDb();
    undo.push(() => data.cleanUp());
    ({ app, registry } = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      planInputs: async () => ({
        liquidity: { provider: fixtureLiquidity({}), source: 'fixture exit table' },
      }),
    }));
    undo.push(() => app.close());
  });
  afterAll(async () => {
    for (const step of undo.reverse()) await step();
  });

  const { post, put, fund, order, settleAll, read } = orderFlow({
    app: () => app,
    registry: () => registry,
    plans: () => ({ solana: '', robinhood: '' }),
  });

  it('stores the mix, buys it by its id, then orders and settles new targets for its vault', async () => {
    const who = data.track(await person(issuer, 'solana'));
    expect((await put(who, '/v1/me/chain', { chain: 'solana' })).statusCode).toBe(200);
    await fund(who);

    // A new goal's mix, confirmed: one plan row, the person's, read back as it was answered.
    const accept = {
      version: 1,
      origin: 'model',
      language: 'en',
      goal: 'grow',
      risk: 'medium',
      amountUsd: 100,
      allocations: [
        { assetId: 'solana:usdc', weightBps: 1000 },
        { assetId: 'solana:spy', weightBps: 4500 },
        { assetId: 'solana:yield', weightBps: 4500 },
      ],
      confirm: true,
      acceptedWarnings: [],
    };
    const first = AcceptGoalMixResponse.parse(
      (await post(who, '/v1/conversations/solana/goal/accept', accept)).json(),
    );
    const res = await post(who, '/v1/conversations/solana/goal/accept', {
      ...accept,
      reviewHash: first.review.reviewHash,
      acceptedWarnings: first.review.unconfirmed,
    });
    const stored = AcceptGoalMixResponse.parse(res.json());
    if (stored.status !== 'stored') throw new Error(res.body);
    expect(await loadProposal(data.db, stored.proposalId)).toEqual(stored.proposal);
    const [row] = await data.db
      .select({ user: users.privyId, engine: proposals.engineVersion })
      .from(proposals)
      .innerJoin(users, eq(users.id, proposals.userId))
      .where(eq(proposals.id, stored.proposalId));
    expect(row).toEqual({ user: who.sub, engine: 'mix-1' });
    // Confirmed again, the same plan.
    const again = AcceptGoalMixResponse.parse(
      (
        await post(who, '/v1/conversations/solana/goal/accept', {
          ...accept,
          reviewHash: first.review.reviewHash,
          acceptedWarnings: first.review.unconfirmed,
        })
      ).json(),
    );
    if (again.status !== 'stored') throw new Error('not stored again');
    expect(again.proposalId).toBe(stored.proposalId);
    expect(again.proposal).toEqual(stored.proposal);

    // Above the amount it was reviewed at, the buy is refused; at it, the existing buy takes it.
    const over = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 101,
      proposalId: stored.proposalId,
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().code).toBe('AMOUNT_OVER_REVIEW');

    // The existing buy, by the plan's id: its legs buy the mix's targets, and they settle.
    const bought = await order(who, { proposalId: stored.proposalId, amountUsd: 100 });
    expect(bought.legs.map((l) => [l.kind, l.trades.map((t) => t.buy)])).toEqual([
      ['create_vault', []],
      ['swap', ['solana:spy']],
      ['swap', ['solana:yield']],
    ]);
    expect((await loadOrder(data.db, bought.id))?.request).toMatchObject({
      type: 'buy',
      proposalId: stored.proposalId,
    });
    await settleAll(who, bought);
    const [vault] = await registry.get('solana').adapter.getVaults(who.solana);
    if (!vault) throw new Error('the buy opened no vault');

    // New targets for that vault: reviewed against the plan it was opened for, then ordered.
    const url = `/v1/vaults/solana/${vault.address}/targets`;
    const body = {
      version: 1,
      origin: 'person',
      language: 'en',
      allocations: [
        { assetId: 'solana:usdc', weightBps: 2000 },
        { assetId: 'solana:spy', weightBps: 4000 },
        { assetId: 'solana:gold', weightBps: 4000 },
      ],
      confirm: false,
      acceptedWarnings: [],
    };
    const review = ApplyVaultMixResponse.parse((await post(who, url, body)).json());
    expect(review.review.goal).toBe('grow');
    const placed = await post(who, url, {
      ...body,
      confirm: true,
      reviewHash: review.review.reviewHash,
      acceptedWarnings: review.review.unconfirmed,
    });
    const ordered = ApplyVaultMixResponse.parse(placed.json());
    if (ordered.status !== 'ordered') throw new Error(placed.body);
    const kept = await loadOrder(data.db, ordered.order.id);
    expect(kept?.request).toEqual({
      type: 'rebalance',
      vaults: [vault.address],
      reason: 'manual',
      targets: [
        { asset: 'solana:spy', weightBps: 4000 },
        { asset: 'solana:gold', weightBps: 4000 },
      ],
      maxSlippageBps: 100,
    });
    const [orderRow] = await data.db
      .select({ type: orders.type })
      .from(orders)
      .where(eq(orders.id, ordered.order.id));
    expect(orderRow?.type).toBe('rebalance');
    expect(kept?.order.legs.map((l) => l.kind)).toEqual(ordered.order.legs.map((l) => l.kind));
    expect(kept?.order.legs[0]?.kind).toBe('set_targets');

    // Built, landed and reported through the order routes: the vault holds the new targets.
    await settleAll(who, ordered.order);
    expect((await read(who, ordered.order)).status).toBe('done');
    const after = await registry.get('solana').adapter.getVault(vault.address);
    expect(
      new Map(after?.positions.filter((p) => p.targetBps > 0).map((p) => [p.asset, p.targetBps])),
    ).toEqual(
      new Map([
        ['solana:spy', 4000],
        ['solana:gold', 4000],
      ]),
    );
  });
});
