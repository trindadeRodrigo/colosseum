import { randomUUID } from 'node:crypto';
import { familyIdOf } from '@colosseum/basket';
import { baskets, legs, orders, proposals, users, vaultSnapshots, vaults } from '@colosseum/db';
import {
  type BasketProposal,
  type BasketSheet,
  ChainError,
  DISCLAIMER,
  OrderDetail,
  PortfolioResponse,
  type Principal,
  VaultPlan,
  YieldObservation,
} from '@colosseum/schemas';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { joinVault, plansOf, rememberVault } from '../../orders/plan-join';
import { basketIdOf, basketIdOfLinked } from '../../orders/prepare';
import { bearingPlanInputs } from '../../plan-inputs';
import mockYields from '../../testing/fixtures/mock-yields.json';
import { orderFlow, walletOf } from '../../testing/flow';
import {
  type HomeChain,
  type Person,
  type PersonKind,
  person,
  planFixture,
  signIn,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import { PersonalizeResponse } from './baskets';

// The goal join on the server (PORT-1, orders/plan-join.ts), through HTTP on the mock chain and the
// real database: a vault is in the cache, joined to the plan it was opened for, from the moment the
// step that opens it is confirmed, and the portfolio answers it with that plan. Every test makes its
// own people and reads only their rows: other sessions write to this database at the same time.

vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
/** A stored plan per chain, and what was stored: the sheet and the card the portfolio answers. */
let plans: Record<HomeChain, string>;
let fixtures: Record<HomeChain, BasketProposal>;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('test');
  data = await testDb();
  undo.push(() => data.cleanUp());
  fixtures = { solana: planFixture('solana'), robinhood: planFixture('robinhood') };
  plans = {
    solana: await data.storePlan(fixtures.solana),
    robinhood: await data.storePlan(fixtures.robinhood),
  };
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const someone = async (kind: PersonKind = 'solana') => data.track(await person(issuer, kind));

const { post, get, fund, order, build, land, report, read, legOf, first, settleAll, legUrl } =
  orderFlow({ app: () => app, registry: () => registry, plans: () => plans });

/** The person's rows in the vault cache. */
const cached = (who: Person) =>
  data.db
    .select()
    .from(vaults)
    .where(inArray(vaults.owner, [who.solana, who.evm]));

/** The plans the person holds: their `baskets` rows. */
const held = async (who: Pick<Person, 'sub'>) =>
  (
    await data.db
      .select({ basket: baskets })
      .from(baskets)
      .innerJoin(users, eq(users.id, baskets.userId))
      .where(eq(users.privyId, who.sub))
  ).map((r) => r.basket);

/** Takes the join away again, as if it had been missed: the vault stays in the cache, with no plan. */
async function unjoin(who: Person) {
  const ids = (await cached(who)).flatMap((v) => (v.basketId ? [v.basketId] : []));
  await data.db
    .update(vaults)
    .set({ basketId: null })
    .where(inArray(vaults.owner, [who.solana, who.evm]));
  if (ids.length) await data.db.delete(baskets).where(inArray(baskets.id, ids));
}

async function portfolio(who: Person, on: FastifyInstance = app) {
  const res = await get(who, '/v1/portfolio', on);
  expect(res.statusCode, res.body).toBe(200);
  return {
    body: res.body,
    vaults: PortfolioResponse.parse(res.json()).chains.flatMap((c) => c.vaults),
  };
}

const opening = (o: OrderDetail) => {
  const leg = o.legs.find((l) => l.kind === 'create_vault');
  if (!leg) throw new Error('this order opens no vault');
  return leg;
};

/**
 * An app whose chains misbehave while a switch is on: the read of a wallet's vaults throws or shows
 * nothing, or a transaction that landed is still said to be pending.
 */
async function flaky(now?: () => Date) {
  const on = { throws: false, empty: false, pending: false };
  const of = (entry: ChainEntry): ChainEntry => ({
    ...entry,
    adapter: {
      ...entry.adapter,
      getVaults: async (owner) => {
        if (on.throws) throw new ChainError('Unavailable', 'the node did not answer');
        return on.empty ? [] : entry.adapter.getVaults(owner);
      },
      track: async (txId, validUntil) =>
        on.pending ? { status: 'pending', explorerUrl: '' } : entry.adapter.track(txId, validUntil),
    },
  });
  const made = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    ...(now ? { now } : {}),
    wrap: (inner) => ({
      ...inner,
      get: (chain) => of(inner.get(chain)),
      active: () => inner.active().map(of),
    }),
  });
  return { ...made, on };
}

describe('a vault is joined to its plan when the step that opens it is confirmed', () => {
  it('on each chain: the vault is in the cache with its plan before any portfolio read, and the portfolio answers the plan', async () => {
    for (const chain of CHAINS) {
      const a = await someone(chain);
      await fund(a);
      const placed = await order(a, { amountUsd: 100 });
      expect((await settleAll(a, placed)).status).toBe('done');

      // Nobody has read the portfolio: the join is the order routes' doing.
      const rows = await cached(a);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        chainId: chain,
        owner: walletOf(a),
        onchainBasketId: basketIdOf(plans[chain]),
        // Nobody has valued it yet.
        valueUsd: null,
        provenance: 'mock',
      });
      expect(row?.targets).toEqual([
        { asset: `${chain}:spy`, weightBps: 5000 },
        { asset: `${chain}:nvda`, weightBps: 3000 },
        { asset: `${chain}:gold`, weightBps: 2000 },
      ]);
      const plansHeld = await held(a);
      expect(plansHeld).toHaveLength(1);
      const [plan] = plansHeld;
      expect(plan).toMatchObject({
        id: row?.basketId,
        kind: 'personal',
        proposalId: plans[chain],
        familyId: null,
      });
      // The plan's time is the order's: the goal's date counts from it.
      expect(plan?.createdAt.toISOString()).toBe(placed.createdAt);

      const mine = await portfolio(a);
      expect(mine.vaults).toHaveLength(1);
      const [vault] = mine.vaults;
      // `basketId` stays the plan's number on the chain; the person's plan is `planId`.
      expect([vault?.basketId, vault?.planId]).toEqual([basketIdOf(plans[chain]), plan?.id]);
      expect(vault?.plan).toEqual({
        kind: 'personal',
        placedAt: placed.createdAt,
        proposalId: plans[chain],
        sheet: fixtures[chain].sheet,
        card: fixtures[chain].card,
        verdict: null,
      });
      expect(VaultPlan.safeParse(vault?.plan).success).toBe(true);
      expect(mine.body).not.toMatch(/"provenance":"(live|sandbox)"/);

      // The read values the vault and leaves the join as it was.
      const [after] = await cached(a);
      expect(after?.valueUsd).not.toBeNull();
      expect(after?.basketId).toBe(plan?.id);
      expect(await held(a)).toHaveLength(1);
    }
  });

  it('a second buy into the same vault writes no second plan', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 100 });
    await settleAll(a, placed);
    const [plan] = await held(a);

    const again = await order(a, { amountUsd: 50 });
    expect(again.legs.map((l) => l.kind)).toEqual(['deposit', 'swap', 'swap', 'swap']);
    await settleAll(a, again);
    // Both orders read again, and the portfolio twice: still the one plan, placed with the first.
    await read(a, placed);
    await read(a, again);
    await portfolio(a);
    const mine = await portfolio(a);
    expect((await held(a)).map((p) => p.id)).toEqual([plan?.id]);
    expect(mine.vaults.map((v) => [v.planId, v.plan?.placedAt])).toEqual([
      [plan?.id, placed.createdAt],
    ]);
  });

  it('once the vault is joined, answering its order reads the chain for nothing', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 100 });
    await settleAll(a, placed);
    expect(await held(a)).toHaveLength(1);
    const reads = vi.spyOn(registry.get('solana').adapter, 'getVaults');
    try {
      // One look in the database says the join is there.
      expect((await read(a, placed)).status).toBe('done');
      expect(reads).not.toHaveBeenCalled();
      // With the join gone the same read asks the chain, and makes it again.
      await unjoin(a);
      await read(a, placed);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(await held(a)).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  });

  it('a join missed at the report leaves the report answering confirmed, and the portfolio read makes it', async () => {
    // The chain's read of the wallet's vaults throws, or does not show the new vault yet. On Robinhood
    // Chain the step that opens the vault is the order's last, so no later route of the order runs.
    for (const how of ['throws', 'empty'] as const) {
      const sick = await flaky();
      try {
        const a = await someone('robinhood');
        await fund(a, sick.app);
        const placed = await order(a, { amountUsd: 100 }, sick.app);
        const create = opening(placed);
        await settleAll(a, placed, sick.app, (leg) => leg.id === create.id);
        await build(a, placed, create.id, sick.app);
        const txId = await land(a, placed, create.id, sick.app);
        sick.on[how] = true;
        const done = await report(a, placed, create.id, { txId }, sick.app);
        sick.on[how] = false;
        expect([legOf(done, create.id).status, done.status]).toEqual(['confirmed', 'done']);
        expect(await cached(a)).toEqual([]);
        expect(await held(a)).toEqual([]);

        const mine = await portfolio(a, sick.app);
        const [plan] = await held(a);
        expect(plan).toMatchObject({ kind: 'personal', proposalId: plans.robinhood });
        expect(plan?.createdAt.toISOString()).toBe(placed.createdAt);
        expect(mine.vaults.map((v) => [v.planId, v.plan?.sheet])).toEqual([
          [plan?.id, fixtures.robinhood.sheet],
        ]);
        expect((await cached(a)).map((v) => v.basketId)).toEqual([plan?.id]);
      } finally {
        await sick.app.close();
      }
    }
  });

  it('a join missed at the report is made by the next read of the order', async () => {
    const sick = await flaky();
    try {
      const a = await someone();
      await fund(a, sick.app);
      const placed = await order(a, { amountUsd: 100 }, sick.app);
      const create = opening(placed);
      await build(a, placed, create.id, sick.app);
      const txId = await land(a, placed, create.id, sick.app);
      sick.on.throws = true;
      const sent = await report(a, placed, create.id, { txId }, sick.app);
      sick.on.throws = false;
      expect(legOf(sent, create.id).status).toBe('confirmed');
      expect(await cached(a)).toEqual([]);

      await read(a, placed, sick.app);
      const [plan] = await held(a);
      expect(plan?.proposalId).toBe(plans.solana);
      expect((await cached(a)).map((v) => v.basketId)).toEqual([plan?.id]);
    } finally {
      await sick.app.close();
    }
  });

  it('an order past its time reads no chain for the join, which is then the portfolio read’s to make', async () => {
    let clock = Date.now();
    const timed = await flaky(() => new Date(clock));
    try {
      const a = await someone('robinhood');
      await fund(a, timed.app);
      const placed = await order(a, { amountUsd: 100 }, timed.app);
      const create = opening(placed);
      await settleAll(a, placed, timed.app, (leg) => leg.id === create.id);
      await build(a, placed, create.id, timed.app);
      const txId = await land(a, placed, create.id, timed.app);
      timed.on.throws = true;
      const done = await report(a, placed, create.id, { txId }, timed.app);
      timed.on.throws = false;
      expect(done.status).toBe('done');

      // A step landed, so the order stayed open for a day. That day is over.
      clock += 25 * 60 * 60 * 1000;
      const reads = vi.spyOn(timed.registry.get('robinhood').adapter, 'getVaults');
      try {
        expect((await read(a, placed, timed.app)).status).toBe('done');
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
      }
      expect(await cached(a)).toEqual([]);
      expect((await portfolio(a, timed.app)).vaults.map((v) => v.plan?.proposalId)).toEqual([
        plans.robinhood,
      ]);
    } finally {
      await timed.app.close();
    }
  });

  it('a step that settles on a later read or build of the order is joined there', async () => {
    // The report finds the transaction still pending, so the step is left sent. The next route that
    // tracks it finds it confirmed: the read of the order, or the build of the step after it.
    for (const via of ['read', 'build'] as const) {
      const sick = await flaky();
      try {
        const a = await someone();
        await fund(a, sick.app);
        const placed = await order(a, { amountUsd: 100 }, sick.app);
        const create = opening(placed);
        await build(a, placed, create.id, sick.app);
        const txId = await land(a, placed, create.id, sick.app);
        sick.on.pending = true;
        const waiting = await report(a, placed, create.id, { txId }, sick.app);
        sick.on.pending = false;
        expect(legOf(waiting, create.id).status).toBe('sent');
        expect(await cached(a)).toEqual([]);

        if (via === 'read')
          expect(legOf(await read(a, placed, sick.app), create.id).status).toBe('confirmed');
        else await build(a, placed, first(placed, 1).id, sick.app);
        const [plan] = await held(a);
        expect([via, plan?.proposalId]).toEqual([via, plans.solana]);
        expect((await cached(a)).map((v) => v.basketId)).toEqual([plan?.id]);
      } finally {
        await sick.app.close();
      }
    }
  });

  it('a cancel answers the order too, and makes a join that was missed', async () => {
    let clock = Date.now();
    const timed = await flaky(() => new Date(clock));
    try {
      const a = await someone();
      await fund(a, timed.app);
      const placed = await order(a, { amountUsd: 100 }, timed.app);
      const create = opening(placed);
      await build(a, placed, create.id, timed.app);
      await report(
        a,
        placed,
        create.id,
        { txId: await land(a, placed, create.id, timed.app) },
        timed.app,
      );
      const swap = first(placed, 1);
      await build(a, placed, swap.id, timed.app);
      // As if every join so far had been missed: no row in the cache, no plan.
      await unjoin(a);
      await data.db.delete(vaults).where(eq(vaults.owner, a.solana));

      // The swap's transaction was never sent and its time runs out: now it can be cancelled.
      clock += 2 * 60 * 1000;
      const cancelled = await post(a, legUrl(placed, swap.id, 'cancel'), undefined, timed.app);
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const [plan] = await held(a);
      expect(plan?.proposalId).toBe(plans.solana);
      expect((await cached(a)).map((v) => v.basketId)).toEqual([plan?.id]);
    } finally {
      await timed.app.close();
    }
  });
});

describe('the portfolio read joins what the confirm missed', () => {
  it('joins the vault to the order that opened it, not to a later one, and once', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 100 });
    await settleAll(a, placed);
    // A later buy into the same vault: newer, and it opened nothing.
    await settleAll(a, await order(a, { amountUsd: 50 }));
    await unjoin(a);
    expect(await held(a)).toEqual([]);

    const mine = await portfolio(a);
    const [plan] = await held(a);
    expect(plan?.createdAt.toISOString()).toBe(placed.createdAt);
    expect(mine.vaults.map((v) => [v.planId, v.plan?.placedAt, v.plan?.card])).toEqual([
      [plan?.id, placed.createdAt, fixtures.solana.card],
    ]);
    // Read again: the same plan, and no other row.
    expect((await portfolio(a)).vaults.map((v) => v.planId)).toEqual([plan?.id]);
    expect(await held(a)).toHaveLength(1);
  });

  it('takes the newest of two orders that each opened the vault of one number', async () => {
    // A chain that started again (the mock does, with the server) opens the same vault a second time:
    // the same owner and number, so the same address and the same row of the cache.
    const a = await someone();
    await fund(a);
    const before = await order(a, { amountUsd: 100 });
    await settleAll(a, before);
    const restarted = await testApp({ issuer: issuer.issuer, db: data.db });
    try {
      await fund(a, restarted.app);
      const placed = await order(a, { amountUsd: 100 }, restarted.app);
      expect(opening(placed).kind).toBe('create_vault');
      await settleAll(a, placed, restarted.app);
      expect(await held(a)).toHaveLength(1);
      await unjoin(a);
      const mine = await portfolio(a, restarted.app);
      expect(mine.vaults.map((v) => v.plan?.placedAt)).toEqual([placed.createdAt]);
      expect(await held(a)).toHaveLength(1);
    } finally {
      await restarted.app.close();
    }
  });

  it('works out the number of an order that was stored without it, at the confirm and at the read', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 100 });
    // As an order made before `orders.basket_id` was kept.
    await data.db.update(orders).set({ basketId: null }).where(eq(orders.id, placed.id));
    await settleAll(a, placed);
    const [atConfirm] = await held(a);
    expect(atConfirm?.proposalId).toBe(plans.solana);
    expect((await cached(a)).map((v) => v.basketId)).toEqual([atConfirm?.id]);

    await unjoin(a);
    const mine = await portfolio(a);
    const [atRead] = await held(a);
    expect(atRead?.proposalId).toBe(plans.solana);
    expect(mine.vaults.map((v) => v.planId)).toEqual([atRead?.id]);
  });

  it('two joins of one vault at the same moment leave one plan', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 100 });
    await settleAll(a, placed);
    const [vault] = await cached(a);
    if (!vault) throw new Error('no vault');

    await unjoin(a);
    const join = () =>
      joinVault(data.db, {
        chain: 'solana',
        address: vault.address,
        privyId: a.sub,
        plan: { kind: 'personal', proposalId: plans.solana },
        placedAt: new Date(placed.createdAt),
      });
    const ids = await Promise.all(Array.from({ length: 8 }, join));
    const [plan] = await held(a);
    expect(await held(a)).toHaveLength(1);
    expect(new Set(ids)).toEqual(new Set([plan?.id]));
    expect((await cached(a)).map((v) => v.basketId)).toEqual([plan?.id]);

    // And through the route: several reads of the portfolio at once.
    await unjoin(a);
    const reads = await Promise.all(Array.from({ length: 4 }, () => portfolio(a)));
    const [again] = await held(a);
    expect(await held(a)).toHaveLength(1);
    expect(reads.map((r) => r.vaults.map((v) => v.planId))).toEqual(
      Array.from({ length: 4 }, () => [again?.id]),
    );
  });

  it('joins each vault to the order of its own number, where the person holds two plans', async () => {
    const a = await someone();
    await fund(a);
    const other = planFixture('solana', { spy: 6000, gold: 4000 });
    const second = await data.storePlan(other);
    const one = await order(a, { amountUsd: 100 });
    await settleAll(a, one);
    const two = await order(a, { amountUsd: 100, proposalId: second });
    await settleAll(a, two);
    expect(await held(a)).toHaveLength(2);
    // The newer order as one stored before the number was kept: the read works its number out, and
    // must not take it for the older vault's.
    await data.db.update(orders).set({ basketId: null }).where(eq(orders.id, two.id));
    await unjoin(a);

    const mine = await portfolio(a);
    expect(await held(a)).toHaveLength(2);
    expect(
      Object.fromEntries(
        mine.vaults.map((v) => [v.basketId, [v.plan?.proposalId, v.plan?.placedAt]]),
      ),
    ).toEqual({
      [basketIdOf(plans.solana)]: [plans.solana, one.createdAt],
      [basketIdOf(second)]: [second, two.createdAt],
    });
    expect(mine.vaults.find((v) => v.basketId === basketIdOf(second))?.plan?.sheet).toEqual(
      other.sheet,
    );
  });

  it('answers the verdict of an income plan, and no goal at all for a stored plan that no longer reads', async () => {
    const verdict = {
      met: false,
      gapUsdMonthly: 12.5,
      ways: [{ change: 'a longer term', closesGap: true }],
    };
    const income = { ...planFixture('solana'), verdict };
    const id = await data.storePlan(income);
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 100, proposalId: id });
    await settleAll(a, placed);
    const [plan] = await held(a);
    expect((await portfolio(a)).vaults.map((v) => v.plan)).toEqual([
      {
        kind: 'personal',
        placedAt: placed.createdAt,
        proposalId: id,
        sheet: income.sheet,
        card: income.card,
        verdict,
      },
    ]);

    // The stored plan's sheet as an older engine might have left it: a goal nobody takes today.
    await data.db
      .update(proposals)
      .set({ proposal: sql`jsonb_set(${proposals.proposal}, '{sheet,goal}', '"retire"')` })
      .where(eq(proposals.id, id));
    const after = await portfolio(a);
    expect(after.vaults.map((v) => [v.planId, v.plan])).toEqual([
      [plan?.id, { kind: 'personal', placedAt: placed.createdAt, proposalId: id }],
    ]);
  });

  it('answers the portfolio all the same when a vault cannot be joined', async () => {
    const a = await someone();
    await fund(a);
    const { adapter, mock } = registry.get('solana');
    if (!mock) throw new Error('not on the mock');
    await mock.send(
      await adapter.buildCreateVault({
        owner: a.solana,
        basketId: '43',
        targets: [{ asset: 'solana:spy', weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: '1000000',
        slippageBps: 50,
      }),
    );
    // An order row no route would store: it names the vault's number and a plan id that is no id.
    const orderId = randomUUID();
    await data.db.insert(orders).values({
      id: orderId,
      type: 'buy',
      ownerSolana: a.solana,
      summary: 'a stored order that cannot be read',
      request: { type: 'buy', owner: { solana: a.solana }, amountUsd: 1, proposalId: 'not-an-id' },
      basketId: '43',
      preparedBy: 'app',
      status: 'done',
      expiresAt: new Date(),
      disclaimer: DISCLAIMER.en,
    });
    await data.db.insert(legs).values({
      orderId,
      chainId: 'solana',
      seq: 0,
      kind: 'create_vault',
      signer: 'owner',
      description: 'Open the vault',
      trades: [],
      status: 'confirmed',
      trigger: 'manual',
      provenance: 'mock',
    });
    const mine = await portfolio(a);
    expect(mine.vaults.map((v) => [v.basketId, v.planId ?? null])).toEqual([['43', null]]);
    expect(await held(a)).toEqual([]);
  });

  it('joins a vault only for a person who holds its owner’s wallet', async () => {
    const a = await someone();
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const [vault] = await registry.get('solana').adapter.getVaults(a.solana);
    if (!vault) throw new Error('no vault');
    await unjoin(a);
    // The read is handed a vault of a wallet the signed-in person does not hold.
    const stranger = await someone();
    const principal: Principal = {
      kind: 'user',
      userId: stranger.sub,
      wallets: [{ family: 'solana', address: stranger.solana, kind: 'external' }],
      ip: '127.0.0.1',
    };
    const quiet = { warn: () => {}, error: () => {} };
    expect(await plansOf(data.db, 'solana', [vault], principal, quiet)).toEqual(new Map());
    expect(await held(stranger)).toEqual([]);
    expect((await cached(a)).map((v) => v.basketId)).toEqual([null]);
  });

  it('leaves a vault the cache already has as it is when it is remembered again', async () => {
    const a = await someone();
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    await portfolio(a);
    const [before] = await cached(a);
    const [state] = await registry.get('solana').adapter.getVaults(a.solana);
    if (!before || !state) throw new Error('no vault');
    await rememberVault(
      data.db,
      { ...state, acceptedVersion: 7, autoFollow: true, observedAt: '2031-01-01T00:00:00.000Z' },
      'sandbox',
    );
    expect(await cached(a)).toEqual([before]);
    expect([before.valueUsd === null, before.provenance, before.basketId === null]).toEqual([
      false,
      'mock',
      false,
    ]);
  });

  it('joins nothing for a vault that is not in the cache, or whose stored plan is gone', async () => {
    const a = await someone();
    const nowhere = await joinVault(data.db, {
      chain: 'solana',
      address: a.solana,
      privyId: a.sub,
      plan: { kind: 'personal', proposalId: plans.solana },
      placedAt: new Date(),
    });
    expect(nowhere).toBeNull();

    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const [vault] = await cached(a);
    if (!vault) throw new Error('no vault');
    await unjoin(a);
    const gone = await joinVault(data.db, {
      chain: 'solana',
      address: vault.address,
      privyId: a.sub,
      plan: { kind: 'personal', proposalId: randomUUID() },
      placedAt: new Date(),
    });
    expect(gone).toBeNull();
    expect(await held(a)).toEqual([]);
    expect((await cached(a)).map((v) => v.basketId)).toEqual([null]);
  });
});

describe('a plan is answered to its own person only', () => {
  it('is not in another person’s portfolio, and a vault joined to another person’s plan is answered with none', async () => {
    const a = await someone();
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const [plan] = await held(a);
    if (!plan) throw new Error('no plan');

    // Somebody else, with wallets of their own.
    const stranger = await someone();
    const theirs = await portfolio(stranger);
    expect(theirs.vaults).toEqual([]);
    expect(theirs.body).not.toContain(plan.id);

    // Another sign-in that holds the same wallet: the vault is the wallet's, the plan is not theirs.
    const sub = `did:privy:test-${randomUUID()}`;
    const twin: Person = data.track({
      ...a,
      sub,
      headers: await signIn(issuer, sub, [
        { family: 'solana', address: a.solana, client: 'phantom' },
      ]),
    });
    const seen = await portfolio(twin);
    expect(seen.vaults).toHaveLength(1);
    expect(seen.vaults[0]).toMatchObject({ owner: a.solana, basketId: basketIdOf(plans.solana) });
    expect(seen.vaults[0]).not.toHaveProperty('planId');
    expect(seen.vaults[0]).not.toHaveProperty('plan');
    expect(seen.body).not.toContain(plan.id);
    expect(seen.body).not.toContain(plans.solana);
    // Reading it made them no plan, and left the owner's.
    expect(await held(twin)).toEqual([]);
    expect((await portfolio(a)).vaults.map((v) => v.planId)).toEqual([plan.id]);
  });

  it('answers a vault made straight on the chain, with no order, with neither field', async () => {
    const a = await someone();
    await fund(a);
    const { adapter, mock } = registry.get('solana');
    if (!mock) throw new Error('not on the mock');
    await mock.send(
      await adapter.buildCreateVault({
        owner: a.solana,
        basketId: '42',
        targets: [
          { asset: 'solana:spy', weightBps: 6000 },
          { asset: 'solana:gold', weightBps: 4000 },
        ],
        autoFollow: false,
        depositRaw: '1000000',
        slippageBps: 50,
      }),
    );
    const alone = await portfolio(a);
    expect(alone.vaults.map((v) => v.basketId)).toEqual(['42']);
    expect(alone.vaults[0]).not.toHaveProperty('planId');
    expect(alone.vaults[0]).not.toHaveProperty('plan');
    expect((await cached(a)).map((v) => v.basketId)).toEqual([null]);
    expect(await held(a)).toEqual([]);

    // Beside a vault an order opened: that one has its plan, this one still none.
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const both = await portfolio(a);
    const [plan] = await held(a);
    expect(await held(a)).toHaveLength(1);
    expect(Object.fromEntries(both.vaults.map((v) => [v.basketId, v.planId ?? null]))).toEqual({
      '42': null,
      [basketIdOf(plans.solana)]: plan?.id,
    });
  });
});

describe('the test harness takes a joined vault away again', () => {
  it('deletes the snapshots, then the vault, then the plan, then the person', async () => {
    // A harness of its own, so its clean-up can be run here and what it leaves looked at.
    const own = await testDb();
    const a = own.track(await person(issuer, 'solana'));
    try {
      await fund(a);
      await settleAll(a, await order(a, { amountUsd: 100 }));
      const [vault] = await cached(a);
      if (!vault?.basketId) throw new Error('the vault is not joined');
      // A snapshot as the worker writes one: it names the vault by its address, and the plan.
      await data.db.insert(vaultSnapshots).values({
        chainId: 'solana',
        address: vault.address,
        observedAt: new Date(),
        owner: a.solana,
        basketId: vault.basketId,
        onchainBasketId: vault.onchainBasketId,
        acceptedVersion: vault.acceptedVersion,
        autoFollow: vault.autoFollow,
        valueUsd: '0.00',
        cash: vault.balances.cash,
        positions: [],
        lossUsedBps: 0,
        prices: [],
        provenance: 'mock',
        source: 'chain-mock',
        method: 'a row written by a test',
      });
    } finally {
      await own.cleanUp();
    }
    const snapshots = await data.db
      .select({ id: vaultSnapshots.id })
      .from(vaultSnapshots)
      .where(eq(vaultSnapshots.owner, a.solana));
    const row = await data.db.select().from(users).where(eq(users.privyId, a.sub));
    expect([snapshots, await cached(a), await held(a), row]).toEqual([[], [], [], []]);
    // The stored plan was this file's, not that harness's: it stays.
    expect(
      await data.db
        .select({ id: proposals.id })
        .from(proposals)
        .where(eq(proposals.id, plans.solana)),
    ).toHaveLength(1);
  });
});

describe('the two other kinds of plan', () => {
  it('a buy of a shared portfolio is a plan that follows it: its family, and no sheet', async () => {
    const creator = await someone();
    const id = randomUUID().replaceAll('-', '');
    const slug = `t-${id.slice(0, 16)}`;
    // A name folds to letters, so the run's id is spelled in them.
    const letters = id.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a').slice(0, 12);
    data.trackFamily(familyIdOf(slug));
    await fund(creator);
    const publish = await post(creator, '/v1/orders', {
      type: 'publish',
      creator: { solana: creator.solana },
      family: slug,
      name: `Test ${letters}`,
      copy: 'Three test tokens.',
      recipes: [
        {
          chain: 'solana',
          components: [
            { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
            { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
            { kind: 'asset', asset: 'solana:tsla', weightBps: 3000 },
          ],
        },
      ],
    });
    expect(publish.statusCode, publish.body).toBe(200);
    await settleAll(creator, OrderDetail.parse(publish.json()));
    // A publish opens no vault and is nobody's plan.
    expect(await held(creator)).toEqual([]);

    const buyer = await someone();
    await fund(buyer);
    const res = await post(buyer, '/v1/orders', {
      type: 'buy',
      owner: buyer.owner,
      amountUsd: 100,
      family: slug,
    });
    expect(res.statusCode, res.body).toBe(200);
    const placed = OrderDetail.parse(res.json());
    await settleAll(buyer, placed);

    const [plan] = await held(buyer);
    expect(await held(buyer)).toHaveLength(1);
    expect(plan).toMatchObject({ kind: 'follow', familyId: familyIdOf(slug), proposalId: null });
    expect((await cached(buyer)).map((v) => [v.onchainBasketId, v.basketId])).toEqual([
      [basketIdOf(familyIdOf(slug)), plan?.id],
    ]);
    const mine = await portfolio(buyer);
    expect(mine.vaults.map((v) => [v.planId, v.plan])).toEqual([
      [plan?.id, { kind: 'follow', placedAt: placed.createdAt, familyId: familyIdOf(slug) }],
    ]);

    // Missed at the confirm, the read finds the family from the order all the same.
    await unjoin(buyer);
    const again = await portfolio(buyer);
    expect(again.vaults.map((v) => v.plan?.familyId)).toEqual([familyIdOf(slug)]);
  });

  it('a plan made from a link is each buyer’s own plan, on the vault numbered from the plan and the buyer', async () => {
    const withMockYield: PlanInputs = async (q) => ({
      ...(await bearingPlanInputs(q)),
      yields: YieldObservation.array()
        .parse(mockYields)
        .filter((y) => q.assets.some((x) => x.id === y.assetId)),
    });
    const linked = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      env: { AGENT_SURFACE: 'on' },
      planInputs: withMockYield,
    });
    try {
      const sheet: BasketSheet = {
        basketType: 'standard',
        goal: 'protect',
        // An amount no other test file proposes: the same sheet at the same moment is one plan.
        amountUsd: 2_717,
        horizonMonths: 18,
        risk: 'low',
        themes: [],
        country: 'BR',
        chains: ['solana'],
        rules: { useHoldings: false, glide: true },
        language: 'en',
      };
      const made = await post(null, '/v1/baskets/propose', { sheet }, linked.app);
      expect(made.statusCode, made.body).toBe(200);
      const { id, proposal } = PersonalizeResponse.parse(made.json());
      data.trackPlan(id);

      const seen: (string | undefined)[] = [];
      for (const buyer of [await someone(), await someone()]) {
        await fund(buyer, linked.app, 3_000);
        const placed = await order(buyer, { proposalId: id, amountUsd: 2_717 }, linked.app);
        // The older order, which kept no number: worked out from the plan and the buyer.
        if (seen.length === 1)
          await data.db.update(orders).set({ basketId: null }).where(eq(orders.id, placed.id));
        await settleAll(buyer, placed, linked.app);
        const [plan] = await held(buyer);
        expect(await held(buyer)).toHaveLength(1);
        expect(plan).toMatchObject({ kind: 'personal', proposalId: id });
        expect((await cached(buyer)).map((v) => [v.onchainBasketId, v.basketId])).toEqual([
          [basketIdOfLinked(id, buyer.sub), plan?.id],
        ]);
        const mine = await portfolio(buyer, linked.app);
        expect(mine.vaults.map((v) => [v.planId, v.plan?.sheet, v.plan?.card])).toEqual([
          [plan?.id, proposal.sheet, proposal.card],
        ]);
        // And at the read, where the number is worked out the same way.
        await unjoin(buyer);
        const again = await portfolio(buyer, linked.app);
        expect(again.vaults.map((v) => v.plan?.proposalId)).toEqual([id]);
        seen.push((await held(buyer))[0]?.id);
      }
      // One plan made from a link, two buyers, two plans of their own.
      expect(new Set(seen).size).toBe(2);
    } finally {
      await linked.app.close();
    }
  });
});
