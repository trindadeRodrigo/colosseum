import { randomUUID } from 'node:crypto';
import { familyIdOf } from '@colosseum/basket';
import { baskets, legs, orders, proposals, users, vaultSnapshots, vaults } from '@colosseum/db';
import {
  type BasketProposal,
  type BasketSheet,
  ChainError,
  type ChainId,
  DISCLAIMER,
  type ObservationRef,
  OrderDetail,
  OrderError,
  PortfolioResponse,
  type Principal,
  VaultPlan,
  type VaultState,
  YieldObservation,
} from '@colosseum/schemas';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import {
  type JoinedPlan,
  type JoinLog,
  joinMissed,
  joinVault,
  plansOf,
  rememberVault,
} from '../../orders/plan-join';
import { basketIdOf, basketIdOfLinked } from '../../orders/prepare';
import { loadProposal, loadReadablePlan } from '../../orders/store';
import { bearingPlanInputs } from '../../plan-inputs';
import mockYields from '../../testing/fixtures/mock-yields.json';
import { chainOf, orderFlow, walletOf } from '../../testing/flow';
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

// The goal join on the server (PORT-1, orders/plan-join.ts), on the mock chain and the real database.
// The orders are taken through their routes over HTTP, and a vault is in the cache, joined to the plan
// it was opened for, from the moment the step that opens it is confirmed. What the join then holds is
// read from the tables and with `plansOf`, which the portfolio section's routes will serve (PORT-2): no
// route answers it yet. `GET /v1/portfolio` is read for the one thing it does to the join, which is to
// make one the confirm missed; its own answer is not changed by it. Every test makes its own people and
// reads only their rows: other sessions write to this database at the same time.

vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
/**
 * A stored plan per chain that names no person and is not from a link: anybody holding its id buys it
 * (`loadBuyablePlan`), and nobody is answered what it says (`loadReadablePlan`). The tests share these
 * two, so neither is ever made a person's: a plan that names a person is bought by that person alone.
 */
let plans: Record<HomeChain, string>;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('test');
  data = await testDb();
  undo.push(() => data.cleanUp());
  plans = {
    solana: await data.storePlan(planFixture('solana')),
    robinhood: await data.storePlan(planFixture('robinhood')),
  };
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const someone = async (kind: PersonKind = 'solana') => data.track(await person(issuer, kind));

/**
 * The figures the engine makes a plan with, for the tests that make one through the API. The mock
 * chain's dollar-yield token has no stored reading, and the engine never counts a missing yield as
 * zero: it is handed one from a fixture labelled mock, which the plan then names in its observations.
 */
const withMockYield: PlanInputs = async (q) => ({
  ...(await bearingPlanInputs(q)),
  yields: YieldObservation.array()
    .parse(mockYields)
    .filter((y) => q.assets.some((x) => x.id === y.assetId)),
});

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

/** Makes a stored plan's row name this person, whose user row is made where there is none. */
async function nameMaker(planId: string, who: Pick<Person, 'sub'>) {
  await data.db
    .insert(users)
    .values({ privyId: who.sub })
    .onConflictDoNothing({ target: users.privyId });
  const [user] = await data.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.privyId, who.sub));
  if (!user) throw new Error('the person has no user row');
  await data.db.update(proposals).set({ userId: user.id }).where(eq(proposals.id, planId));
}

/**
 * A stored plan that is this person's own, as `POST /v1/baskets/personalize` stores one: its row names
 * their user row. What a plan says (its sheet, card, verdict and observations) is answered to the
 * person who made it and to nobody else, so a test that expects the join to answer a goal buys one of
 * these. Each call stores a plan of its own: the shared `plans` stay nobody's.
 */
async function ownPlan(who: Person, fixture: BasketProposal = planFixture(chainOf(who))) {
  const id = await data.storePlan(fixture);
  await nameMaker(id, who);
  return { id, fixture };
}

/** Whom a stored plan's row names, and whether it was made from a link. */
const namedBy = async (planId: string) =>
  (
    await data.db
      .select({ userId: proposals.userId, fromLink: proposals.fromLink })
      .from(proposals)
      .where(eq(proposals.id, planId))
  )[0];

/** Takes the join away again, as if it had been missed: the vault stays in the cache, with no plan. */
async function unjoin(who: Person) {
  const ids = (await cached(who)).flatMap((v) => (v.basketId ? [v.basketId] : []));
  await data.db
    .update(vaults)
    .set({ basketId: null })
    .where(inArray(vaults.owner, [who.solana, who.evm]));
  if (ids.length) await data.db.delete(baskets).where(inArray(baskets.id, ids));
}

/**
 * A person's vaults as GET /v1/portfolio reads them, each with what the join holds for it beside it.
 * The route's read makes a join the confirm missed and changes nothing in its own answer, which names a
 * vault's stored plan itself (`planId`, API-ADD-MONEY). What the join holds is read as the portfolio
 * section's routes will read it, with `plansOf`, for the same person: `joinId`, the person's `baskets`
 * row, and `plan`. A vault the join answers nothing for has neither. `body` is everything said to the
 * person: the route's answer, then the joined plans.
 */
async function portfolio(who: Person, on: FastifyInstance = app) {
  const res = await get(who, '/v1/portfolio', on);
  expect(res.statusCode, res.body).toBe(200);
  const answered = PortfolioResponse.parse(res.json()).chains.flatMap((c) => c.vaults);
  const joined = new Map<string, JoinedPlan>();
  for (const chain of new Set(answered.map((v) => v.chain))) {
    const addresses = answered.filter((v) => v.chain === chain).map((v) => v.address);
    for (const [address, plan] of await plansOf(data.db, chain, addresses, who.sub))
      joined.set(address, plan);
  }
  const vaults = answered.map((v) => ({
    ...v,
    ...(joined.get(v.address) as Partial<JoinedPlan>),
  }));
  return { body: `${res.body}\n${JSON.stringify([...joined.values()])}`, vaults };
}

/**
 * The person is answered that they hold the plan and none of what it says: by the join the confirm
 * made, and by the one the portfolio's read makes once that is taken away.
 */
async function heldWithNoGoal(
  who: Person,
  only: Pick<VaultPlan, 'kind' | 'placedAt' | 'proposalId'>,
  on?: FastifyInstance,
) {
  for (const missed of [false, true]) {
    if (missed) await unjoin(who);
    const seen = await portfolio(who, on);
    expect(seen.vaults.map((v) => v.plan)).toEqual([only]);
    for (const key of ['sheet', 'card', 'verdict', 'observations'])
      expect([key, seen.body.includes(`"${key}"`)]).toEqual([key, false]);
  }
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

/**
 * The database with one query that fails while the switch is on: the look for the vaults that hold no
 * plan yet (`joinMissed`), told by what it selects, a vault's address and nothing else. It fails as a
 * query the database did not take does, when it is awaited. Every other query is the real database's.
 */
function failingLook() {
  const on = { fails: false, failed: 0 };
  const db = new Proxy(data.db, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== 'select') return typeof value === 'function' ? value.bind(target) : value;
      return (fields?: Record<string, unknown>) => {
        const theLook =
          fields !== undefined &&
          Object.keys(fields).length === 1 &&
          fields.address === vaults.address;
        if (!on.fails || !theLook)
          return fields === undefined ? target.select() : target.select(fields as never);
        on.failed += 1;
        const refused = () => Promise.reject(new Error('the database did not answer'));
        return { from: () => ({ where: refused }) };
      };
    },
  });
  return { db, on };
}

/** The person as a sign-in hands them to the join: their id, and their one wallet of that family. */
const principalOf = (who: Person, family: 'solana' | 'evm'): Principal => ({
  kind: 'user',
  userId: who.sub,
  wallets: [{ family, address: family === 'solana' ? who.solana : who.evm, kind: 'external' }],
  ip: '127.0.0.1',
});

/** A log that keeps what it is told, for a test that counts what went wrong. */
function keptLog() {
  const said: { level: 'warn' | 'error'; fields: object; message: string }[] = [];
  const log: JoinLog = {
    warn: (fields, message) => void said.push({ level: 'warn', fields, message }),
    error: (fields, message) => void said.push({ level: 'error', fields, message }),
  };
  return { log, said };
}

describe('a vault is joined to its plan when the step that opens it is confirmed', () => {
  it('on each chain: the vault is in the cache with its plan before any portfolio read, and the join answers the plan', async () => {
    for (const chain of CHAINS) {
      const a = await someone(chain);
      // A plan of the person's own: what it says is answered to the person who made it.
      const own = await ownPlan(a);
      await fund(a);
      const placed = await order(a, { amountUsd: 100, proposalId: own.id });
      expect((await settleAll(a, placed)).status).toBe('done');

      // Nobody has read the portfolio: the join is the order routes' doing.
      const rows = await cached(a);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        chainId: chain,
        owner: walletOf(a),
        onchainBasketId: basketIdOf(own.id),
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
        proposalId: own.id,
        familyId: null,
      });
      // The plan's time is the order's: the goal's date counts from it.
      expect(plan?.createdAt.toISOString()).toBe(placed.createdAt);

      const mine = await portfolio(a);
      expect(mine.vaults).toHaveLength(1);
      const [vault] = mine.vaults;
      // Three ids, each its own: `basketId` stays the plan's number on the chain, `joinId` is the
      // person's `baskets` row, and the route's own `planId` is the stored plan, which is the one
      // the join names.
      expect([vault?.basketId, vault?.joinId]).toEqual([basketIdOf(own.id), plan?.id]);
      expect(vault?.planId).toBe(own.id);
      expect(vault?.plan).toEqual({
        kind: 'personal',
        placedAt: placed.createdAt,
        proposalId: own.id,
        sheet: own.fixture.sheet,
        card: own.fixture.card,
        verdict: null,
        // The fixture was made from no reading, and says so: the list is there, with nothing in it.
        observations: [],
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
    expect(mine.vaults.map((v) => [v.joinId, v.plan?.placedAt])).toEqual([
      [plan?.id, placed.createdAt],
    ]);
  });

  it('only the step that opens the vault makes the join at an order’s routes: a later buy into the vault joins nothing', async () => {
    const a = await someone();
    const own = await ownPlan(a);
    await fund(a);
    const placed = await order(a, { amountUsd: 100, proposalId: own.id });
    await settleAll(a, placed);
    const [vault] = await cached(a);
    if (!vault) throw new Error('no vault');
    // As if the join had been missed when the vault was opened. The order that opened it is not
    // asked again from here on: its own routes would make the join.
    await unjoin(a);

    // Two later buys into that vault, each with a step that deposits and none that opens a vault: the
    // plan bought again, and money added to the vault by its address (add money). Each is taken
    // through the build and the report of every step, and then read.
    const laterBuys = [
      () => order(a, { amountUsd: 50, proposalId: own.id }),
      async () => {
        const res = await post(a, '/v1/orders', {
          type: 'buy',
          owner: a.owner,
          amountUsd: 50,
          vault: { chain: 'solana', address: vault.address },
        });
        expect(res.statusCode, res.body).toBe(200);
        return OrderDetail.parse(res.json());
      },
    ];
    for (const buy of laterBuys) {
      const later = await buy();
      expect(Date.parse(later.createdAt)).toBeGreaterThan(Date.parse(placed.createdAt));
      expect(later.legs.map((l) => l.kind)).toEqual(['deposit', 'swap', 'swap', 'swap']);
      expect(later.basketId).toBe(vault.onchainBasketId);
      expect((await settleAll(a, later)).status).toBe('done');
      expect((await read(a, later)).status).toBe('done');
      // Its deposit is confirmed, and none of its routes joined the vault: a deposit opens nothing,
      // and its order's time is not when the plan was placed.
      expect(await held(a)).toEqual([]);
      expect((await cached(a)).map((v) => v.basketId)).toEqual([null]);
    }

    // The portfolio's read makes the join, from the order that opened the vault: the plan is placed
    // at that order's time, not at a later buy's.
    const mine = await portfolio(a);
    const plansHeld = await held(a);
    expect(plansHeld.map((p) => [p.proposalId, p.createdAt.toISOString()])).toEqual([
      [own.id, placed.createdAt],
    ]);
    expect(mine.vaults.map((v) => [v.joinId, v.plan?.placedAt])).toEqual([
      [plansHeld[0]?.id, placed.createdAt],
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
        const own = await ownPlan(a);
        await fund(a, sick.app);
        const placed = await order(a, { amountUsd: 100, proposalId: own.id }, sick.app);
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
        expect(plan).toMatchObject({ kind: 'personal', proposalId: own.id });
        expect(plan?.createdAt.toISOString()).toBe(placed.createdAt);
        expect(mine.vaults.map((v) => [v.joinId, v.plan?.sheet])).toEqual([
          [plan?.id, own.fixture.sheet],
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

  /**
   * A buy whose step that opens the vault landed and whose report found the transaction still pending:
   * the step is left `sent`, nothing is in the cache, and the next route that tracks the order is the
   * one that finds it confirmed.
   */
  async function landedUnseen(sick: Awaited<ReturnType<typeof flaky>>) {
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
    expect(await held(a)).toEqual([]);
    return { a, placed, create };
  }

  it('a step that settles on a later read or build of the order, or as its buy is finished, is joined there', async () => {
    // The routes that track a step that was sent: the read of the order, the build of the step after
    // it, and `continue`, which finishes a buy with the cash in its vault.
    for (const via of ['read', 'build', 'continue'] as const) {
      const sick = await flaky();
      try {
        const { a, placed, create } = await landedUnseen(sick);
        if (via === 'read')
          expect(legOf(await read(a, placed, sick.app), create.id).status).toBe('confirmed');
        else if (via === 'build') await build(a, placed, first(placed, 1).id, sick.app);
        else {
          const res = await post(a, `/v1/orders/${placed.id}/continue`, undefined, sick.app);
          expect(res.statusCode, res.body).toBe(200);
          // The order of the swaps left, which itself opens no vault and is nobody's plan.
          expect(OrderDetail.parse(res.json()).continues).toBe(placed.id);
        }
        // The vault is in the cache, the person holds one plan, and the vault names it.
        const plansHeld = await held(a);
        expect([via, plansHeld.map((p) => p.proposalId)]).toEqual([via, [plans.solana]]);
        expect((await cached(a)).map((v) => v.basketId)).toEqual([plansHeld[0]?.id]);
        expect(plansHeld[0]?.createdAt.toISOString()).toBe(placed.createdAt);
      } finally {
        await sick.app.close();
      }
    }
  });

  it('a build that is refused still joins the step it found settled, and the refusal is the build’s own', async () => {
    const sick = await flaky();
    try {
      const { a, placed, create } = await landedUnseen(sick);
      // The price of the first asset moves past the minimum the order stated. The build of its swap
      // tracks the step that was sent, finds it confirmed, and is then refused.
      const swap = first(placed, 1);
      const asset = swap.trades[0]?.buy ?? '';
      const { adapter, mock } = sick.registry.get('solana');
      const [price] = await adapter.getPrices([asset]);
      if (!mock || !price) throw new Error('no mock price to move');
      mock.setPrice(asset, (Number(price.usdPerToken) * 1.05).toFixed(6));
      const res = await post(a, legUrl(placed, swap.id, 'build'), undefined, sick.app);
      expect(res.statusCode, res.body).toBe(409);
      expect(OrderError.parse(res.json())).toMatchObject({ code: 'PRICE_MOVED' });
      const after = await data.db.select().from(legs).where(eq(legs.orderId, placed.id));
      expect(after.find((l) => l.id === create.id)?.status).toBe('confirmed');
      expect(after.find((l) => l.id === swap.id)?.status).toBe('planned');

      // No other route of the order was asked: the refused build made the join.
      const plansHeld = await held(a);
      expect(plansHeld.map((p) => p.proposalId)).toEqual([plans.solana]);
      expect((await cached(a)).map((v) => v.basketId)).toEqual([plansHeld[0]?.id]);
      expect(plansHeld[0]?.createdAt.toISOString()).toBe(placed.createdAt);
    } finally {
      await sick.app.close();
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
    const own = await ownPlan(a);
    await fund(a);
    const placed = await order(a, { amountUsd: 100, proposalId: own.id });
    await settleAll(a, placed);
    // A later buy into the same vault: newer, and it opened nothing.
    await settleAll(a, await order(a, { amountUsd: 50, proposalId: own.id }));
    await unjoin(a);
    expect(await held(a)).toEqual([]);

    const mine = await portfolio(a);
    const [plan] = await held(a);
    expect(plan?.createdAt.toISOString()).toBe(placed.createdAt);
    expect(mine.vaults.map((v) => [v.joinId, v.plan?.placedAt, v.plan?.card])).toEqual([
      [plan?.id, placed.createdAt, own.fixture.card],
    ]);
    // Read again: the same plan, and no other row.
    expect((await portfolio(a)).vaults.map((v) => v.joinId)).toEqual([plan?.id]);
    expect(await held(a)).toHaveLength(1);
  });

  it('takes the person’s own order, not a later order of another person for the same plan', async () => {
    // Two people who buy one stored plan hold vaults of one number, each under their own wallet. The
    // other person's order is the newer of the two.
    const a = await someone();
    await fund(a);
    const mine = await order(a, { amountUsd: 100 });
    await settleAll(a, mine);
    const b = await someone();
    await fund(b);
    const theirs = await order(b, { amountUsd: 100 });
    await settleAll(b, theirs);
    expect(Date.parse(theirs.createdAt)).toBeGreaterThan(Date.parse(mine.createdAt));
    expect([...(await cached(a)), ...(await cached(b))].map((v) => v.onchainBasketId)).toEqual([
      basketIdOf(plans.solana),
      basketIdOf(plans.solana),
    ]);

    await unjoin(a);
    const seen = await portfolio(a);
    expect(seen.vaults.map((v) => v.plan?.placedAt)).toEqual([mine.createdAt]);
    expect((await held(a)).map((p) => p.createdAt.toISOString())).toEqual([mine.createdAt]);
    // The other person's plan is as it was.
    expect((await held(b)).map((p) => p.createdAt.toISOString())).toEqual([theirs.createdAt]);
  });

  it('takes the order whose step that opens the vault confirmed, not a newer one that opened nothing', async () => {
    const a = await someone();
    await fund(a);
    // Two orders made before either is settled: each plans the step that opens the vault.
    const one = await order(a, { amountUsd: 100 });
    const two = await order(a, { amountUsd: 100 });
    expect([opening(one).kind, opening(two).kind]).toEqual(['create_vault', 'create_vault']);
    expect(Date.parse(two.createdAt)).toBeGreaterThan(Date.parse(one.createdAt));
    // Only the first is taken through its steps: the second one's step never leaves `planned`.
    await settleAll(a, one);
    expect(opening(await read(a, two)).status).toBe('planned');

    await unjoin(a);
    const mine = await portfolio(a);
    expect(mine.vaults.map((v) => v.plan?.placedAt)).toEqual([one.createdAt]);
    expect((await held(a)).map((p) => p.createdAt.toISOString())).toEqual([one.createdAt]);
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
    expect(mine.vaults.map((v) => v.joinId)).toEqual([atRead?.id]);
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
    expect(reads.map((r) => r.vaults.map((v) => v.joinId))).toEqual(
      Array.from({ length: 4 }, () => [again?.id]),
    );
  });

  it('joins each vault to the order of its own number, where the person holds two plans', async () => {
    const a = await someone();
    await fund(a);
    // The second plan is the person's own, so its vault is answered with what the plan says.
    const { id: second, fixture: other } = await ownPlan(
      a,
      planFixture('solana', { spy: 6000, gold: 4000 }),
    );
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

  it('answers the verdict of an income plan with what its figures came from, and no goal at all for a stored plan that no longer reads', async () => {
    const verdict = {
      met: false,
      gapUsdMonthly: 12.5,
      ways: [{ change: 'a longer term', closesGap: true }],
    };
    // What the plan's figures were worked out from, as the engine stores it: where, how and when.
    const reading: ObservationRef = {
      id: 'yield solana:yield',
      kind: 'yield',
      source: 'apps/api/src/testing/fixtures/mock-yields.json',
      method: 'mock_value_written_by_hand_not_a_reading',
      fetchedAt: '2026-10-05T00:00:00.000Z',
      provenance: 'mock',
    };
    const a = await someone();
    const { id, fixture: income } = await ownPlan(a, {
      ...planFixture('solana'),
      verdict,
      observations: [reading],
    });
    await fund(a);
    const placed = await order(a, { amountUsd: 100, proposalId: id });
    await settleAll(a, placed);
    const [plan] = await held(a);
    const whole = {
      kind: 'personal',
      placedAt: placed.createdAt,
      proposalId: id,
      sheet: income.sheet,
      card: income.card,
      verdict,
      observations: [reading],
    };
    expect((await portfolio(a)).vaults.map((v) => v.plan)).toEqual([whole]);

    // Each of the four as an older engine might have left it, one at a time: a goal nobody takes
    // today, a term that is no number, a verdict that does not say whether the income is met, a
    // reading that names no source. A goal is not answered in part, and no figure without its sources:
    // the vault keeps its plan, and the plan says only what it is.
    const broken = [
      sql`jsonb_set(${proposals.proposal}, '{sheet,goal}', '"retire"')`,
      sql`jsonb_set(${proposals.proposal}, '{card,termMonths}', '"sixty"')`,
      sql`jsonb_set(${proposals.proposal}, '{verdict,met}', '"perhaps"')`,
      sql`jsonb_set(${proposals.proposal}, '{observations,0,source}', '""')`,
    ];
    for (const proposal of broken) {
      await data.db.update(proposals).set({ proposal }).where(eq(proposals.id, id));
      const after = await portfolio(a);
      expect(after.vaults.map((v) => [v.joinId, v.plan])).toEqual([
        [plan?.id, { kind: 'personal', placedAt: placed.createdAt, proposalId: id }],
      ]);
      // Stored as it was again, the whole goal is back: it was that one part that took it away.
      await data.db.update(proposals).set({ proposal: income }).where(eq(proposals.id, id));
      expect((await portfolio(a)).vaults.map((v) => v.plan)).toEqual([whole]);
    }
  });

  it('answers no goal for a stored plan that no longer reads whole, though each of the four still reads', async () => {
    const a = await someone();
    const own = await ownPlan(a);
    await fund(a);
    const placed = await order(a, { amountUsd: 100, proposalId: own.id });
    await settleAll(a, placed);
    const only = { kind: 'personal' as const, placedAt: placed.createdAt, proposalId: own.id };
    const whole = {
      ...only,
      sheet: own.fixture.sheet,
      card: own.fixture.card,
      verdict: null,
      observations: [],
    };
    expect((await portfolio(a)).vaults.map((v) => v.plan)).toEqual([whole]);
    expect((await loadReadablePlan(data.db, own.id, a.sub))?.proposal.sheet).toEqual(
      own.fixture.sheet,
    );

    // The plan's lines no longer add up to 10,000, as a plan an older engine stored might not: one
    // basis point is gone from the first. Its sheet, its card and its observations are as they
    // were, so each of the four still reads alone.
    const stored = await loadProposal(data.db, own.id);
    expect(stored?.lines.map((line) => line.weightBps)).toEqual([5000, 3000, 2000]);
    await data.db
      .update(proposals)
      .set({ proposal: sql`jsonb_set(${proposals.proposal}, '{lines,0,weightBps}', '4999')` })
      .where(eq(proposals.id, own.id));
    // The plan's own read refuses it to the person who made it, and the join says no more than that
    // read would: the vault is held, at the confirm's join and at the read's, and no goal is answered.
    await expect(loadReadablePlan(data.db, own.id, a.sub)).rejects.toMatchObject({ status: 409 });
    await heldWithNoGoal(a, only);

    // Stored as it was again, the whole goal is back.
    await data.db.update(proposals).set({ proposal: own.fixture }).where(eq(proposals.id, own.id));
    expect((await portfolio(a)).vaults.map((v) => v.plan)).toEqual([whole]);
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
    expect(mine.vaults.map((v) => [v.basketId, v.joinId ?? null])).toEqual([['43', null]]);
    expect(await held(a)).toEqual([]);
  });

  it('answers the portfolio all the same when the look for the vaults that hold no plan fails, and logs it once', async () => {
    const broken = failingLook();
    const made = await testApp({ issuer: issuer.issuer, db: broken.db });
    try {
      const a = await someone();
      await fund(a, made.app);
      const placed = await order(a, { amountUsd: 100 }, made.app);
      await settleAll(a, placed, made.app);
      const [vault] = await made.registry.get('solana').adapter.getVaults(a.solana);
      if (!vault) throw new Error('no vault');
      await unjoin(a);
      broken.on.fails = true;

      // Asked as the portfolio's read asks it: it resolves, says once what went wrong, and joins
      // nothing.
      const { log, said } = keptLog();
      await expect(
        joinMissed(broken.db, 'solana', [vault], principalOf(a, 'solana'), log),
      ).resolves.toBeUndefined();
      expect(broken.on.failed).toBe(1);
      expect(said.map((line) => line.level)).toEqual(['error']);
      expect(said[0]?.fields).toMatchObject({ chain: 'solana', err: expect.any(Error) });
      expect(await held(a)).toEqual([]);

      // Through the route: the chain was read and is answered, and none is said to be unavailable.
      const res = await get(a, '/v1/portfolio', made.app);
      expect(res.statusCode, res.body).toBe(200);
      const answer = PortfolioResponse.parse(res.json());
      expect(broken.on.failed).toBe(2);
      expect(answer.unavailable).toEqual([]);
      expect(answer.chains.map((c) => [c.chain, c.vaults.map((v) => v.address)])).toEqual([
        ['solana', [vault.address]],
      ]);
      expect(await held(a)).toEqual([]);
      expect((await cached(a)).map((v) => v.basketId)).toEqual([null]);

      // The next read tries again: with the database answering, the join is made.
      broken.on.fails = false;
      const mine = await portfolio(a, made.app);
      const plansHeld = await held(a);
      expect(plansHeld).toHaveLength(1);
      expect(mine.vaults.map((v) => [v.joinId, v.plan?.placedAt])).toEqual([
        [plansHeld[0]?.id, placed.createdAt],
      ]);
      expect(broken.on.failed).toBe(2);
    } finally {
      await made.app.close();
    }
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
    await joinMissed(data.db, 'solana', [vault], principal, quiet);
    expect(await plansOf(data.db, 'solana', [vault.address], stranger.sub)).toEqual(new Map());
    expect(await held(stranger)).toEqual([]);
    expect((await cached(a)).map((v) => v.basketId)).toEqual([null]);
  });

  it('answers a vault’s plan on the vault’s own chain only: its address asked on another chain has none', async () => {
    const a = await someone('robinhood');
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const [vault] = await cached(a);
    const [plan] = await held(a);
    if (!vault || !plan) throw new Error('no joined vault');
    expect([vault.chainId, vault.basketId]).toEqual(['robinhood', plan.id]);
    const askedOn = async (chain: ChainId) =>
      [...(await plansOf(data.db, chain, [vault.address], a.sub))].map(([address, joined]) => [
        address,
        joined.joinId,
      ]);
    expect(await askedOn('robinhood')).toEqual([[vault.address, plan.id]]);
    // Base is an EVM chain too, so the address is one a vault there could have. It names no vault of
    // Base's in the cache, and the Robinhood Chain vault's plan is not answered for it.
    expect(await askedOn('base')).toEqual([]);
    expect(await askedOn('solana')).toEqual([]);
  });

  it('joins a vault from the orders of its own chain only: one on Base is not joined from a Robinhood Chain order', async () => {
    const a = await someone('robinhood');
    await fund(a);
    const placed = await order(a, { amountUsd: 100 });
    await settleAll(a, placed);
    const [state] = await registry.get('robinhood').adapter.getVaults(a.evm);
    const [plan] = await held(a);
    if (!state || !plan) throw new Error('no joined vault');
    expect((await cached(a)).map((v) => [v.chainId, v.basketId])).toEqual([['robinhood', plan.id]]);

    // A vault on Base as the cache would hold one. It is made up: no chain here opened it, and the
    // person has no order on Base. Its owner and its plan number are the Robinhood Chain vault's, and
    // so is its address, as two EVM chains can give one address to the same owner and number.
    const onBase: VaultState = {
      ...state,
      chain: 'base',
      cash: { ...state.cash, asset: 'base:usdc' },
      positions: [],
    };
    await rememberVault(data.db, onBase, 'mock');
    const cachedOn = async (chain: ChainId) => (await cached(a)).find((v) => v.chainId === chain);
    expect(await cachedOn('base')).toMatchObject({
      address: state.address,
      owner: a.evm,
      onchainBasketId: state.basketId,
      basketId: null,
    });

    // The catch-up for Base finds the vault with no plan and no order of its chain: nothing goes
    // wrong, and nothing is joined. The Robinhood Chain order does not stand in for one.
    const { log, said } = keptLog();
    await joinMissed(data.db, 'base', [onBase], principalOf(a, 'evm'), log);
    expect(said).toEqual([]);
    expect((await cachedOn('base'))?.basketId).toBeNull();
    expect((await held(a)).map((p) => p.id)).toEqual([plan.id]);

    // The same catch-up on the order's own chain does join: with the Robinhood Chain vault's join
    // taken away, it is made again from that order, and the vault on Base still has none.
    await unjoin(a);
    await joinMissed(data.db, 'robinhood', [state], principalOf(a, 'evm'), log);
    expect(said).toEqual([]);
    const plansHeld = await held(a);
    expect(plansHeld.map((p) => p.createdAt.toISOString())).toEqual([placed.createdAt]);
    expect((await cachedOn('robinhood'))?.basketId).toBe(plansHeld[0]?.id);
    expect((await cachedOn('base'))?.basketId).toBeNull();
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
  it('is answered to nobody else who names the vault, and a vault joined to another person’s plan is answered with none', async () => {
    const a = await someone();
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const [plan] = await held(a);
    const [vault] = await cached(a);
    if (!plan || !vault) throw new Error('no plan');

    // Somebody else, with wallets of their own, who has learnt the vault's address. The join answers
    // the plan by address to the person whose plan it is, and nothing to anybody else who asks.
    const stranger = await someone();
    const asked = (who: Person) => plansOf(data.db, 'solana', [vault.address], who.sub);
    expect([...(await asked(a))].map(([address, joined]) => [address, joined.joinId])).toEqual([
      [vault.address, plan.id],
    ]);
    expect(await asked(stranger)).toEqual(new Map());
    // Their own portfolio has no vault, and its read made them no plan.
    const theirs = await portfolio(stranger);
    expect(theirs.vaults).toEqual([]);
    expect(theirs.body).not.toContain(plan.id);
    expect(await held(stranger)).toEqual([]);

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
    expect(seen.vaults[0]).not.toHaveProperty('joinId');
    expect(seen.vaults[0]).not.toHaveProperty('plan');
    expect(seen.body).not.toContain(plan.id);
    expect(seen.body).not.toContain(plans.solana);
    // Reading it made them no plan, and left the owner's.
    expect(await held(twin)).toEqual([]);
    expect((await portfolio(a)).vaults.map((v) => v.joinId)).toEqual([plan.id]);
  });

  it('a vault made straight on the chain, with no order, is joined to nothing and answered no plan', async () => {
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
    expect(alone.vaults[0]).not.toHaveProperty('joinId');
    expect(alone.vaults[0]).not.toHaveProperty('plan');
    expect((await cached(a)).map((v) => v.basketId)).toEqual([null]);
    expect(await held(a)).toEqual([]);

    // Beside a vault an order opened: that one has its plan, this one still none.
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const both = await portfolio(a);
    const [plan] = await held(a);
    expect(await held(a)).toHaveLength(1);
    expect(Object.fromEntries(both.vaults.map((v) => [v.basketId, v.joinId ?? null]))).toEqual({
      '42': null,
      [basketIdOf(plans.solana)]: plan?.id,
    });
  });

  it('a plan that names no person, bought by its id alone, is held with none of what it says', async () => {
    // Stored with no person and not from a link, as a plan stored before plans named their person.
    // Its id still buys it for anybody (`loadBuyablePlan`) and reads it back to nobody
    // (`loadReadablePlan`), and the join answers a goal by the second.
    const id = await data.storePlan(planFixture('solana'));
    expect(await namedBy(id)).toEqual({ userId: null, fromLink: false });
    const b = await someone();
    await fund(b);
    const theirs = await order(b, { proposalId: id, amountUsd: 100 });
    expect((await settleAll(b, theirs)).status).toBe('done');
    const [holding] = await held(b);
    expect(holding).toMatchObject({ kind: 'personal', proposalId: id });

    // B is answered that they hold it, and none of what the plan says: not at the confirm's join,
    // and not at the read's.
    await heldWithNoGoal(b, { kind: 'personal', placedAt: theirs.createdAt, proposalId: id });
  });

  it('a plan another person made in the app is not bought by its id, and a vault opened for one before that is answered none of what it says', async () => {
    const made = await testApp({ issuer: issuer.issuer, db: data.db, planInputs: withMockYield });
    try {
      // A makes a plan in the app: stored as the route stores it, naming A's user row.
      const a = await someone();
      const sheet: BasketSheet = {
        basketType: 'standard',
        goal: 'protect',
        // An amount no other test file sends: the same sheet at the same moment is one plan.
        amountUsd: 3_863,
        horizonMonths: 37,
        risk: 'low',
        themes: [],
        country: 'BR',
        chains: ['solana'],
        rules: { useHoldings: false, glide: true },
        language: 'en',
      };
      const res = await post(a, '/v1/baskets/personalize', { sheet }, made.app);
      expect(res.statusCode, res.body).toBe(200);
      const { id } = PersonalizeResponse.parse(res.json());
      const stored = await loadProposal(data.db, id);
      if (!stored) throw new Error('the plan was not stored');
      expect(stored.observations.length).toBeGreaterThan(0);
      const [maker] = await data.db.select().from(users).where(eq(users.privyId, a.sub));
      expect(await namedBy(id)).toEqual({ userId: maker?.id, fromLink: false });

      // B has the id and nothing else. Today it buys nothing: the order is refused, as an id that
      // names no plan is (`loadBuyablePlan`).
      const b = await someone();
      await fund(b, made.app);
      const refused = await post(
        b,
        '/v1/orders',
        { type: 'buy', owner: b.owner, amountUsd: 100, proposalId: id },
        made.app,
      );
      expect(refused.statusCode, refused.body).toBe(404);

      // A buy made before plans could not be bought by their id may have opened a vault for such a
      // plan, and that vault is still its buyer's. No route makes one now, so it is made in the
      // database: the plan's row names nobody while B buys it, and A again once the vault is open.
      // The clean-up finds a person's plans by their row, so this one is remembered by its id first.
      data.trackPlan(id);
      await data.db.update(proposals).set({ userId: null }).where(eq(proposals.id, id));
      const theirs = await order(b, { proposalId: id, amountUsd: 100 }, made.app);
      expect((await settleAll(b, theirs, made.app)).status).toBe('done');
      await nameMaker(id, a);
      expect(await namedBy(id)).toEqual({ userId: maker?.id, fromLink: false });
      const [holding] = await held(b);
      expect(holding).toMatchObject({ kind: 'personal', proposalId: id });

      // B is answered that they hold it, and none of what A's plan says: not at the confirm's join,
      // and not at the read's.
      const only = { kind: 'personal' as const, placedAt: theirs.createdAt, proposalId: id };
      await heldWithNoGoal(b, only, made.app);

      // A's own vault of that plan carries all four, as they were stored.
      await fund(a, made.app);
      const mine = await order(a, { proposalId: id, amountUsd: 100 }, made.app);
      await settleAll(a, mine, made.app);
      expect((await portfolio(a, made.app)).vaults.map((v) => v.plan)).toEqual([
        {
          kind: 'personal',
          placedAt: mine.createdAt,
          proposalId: id,
          sheet: stored.sheet,
          card: stored.card,
          verdict: null,
          observations: stored.observations,
        },
      ]);
      // And B's answer is the same with A's vault there.
      expect((await portfolio(b, made.app)).vaults.map((v) => v.plan)).toEqual([only]);
    } finally {
      await made.app.close();
    }
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
    expect(mine.vaults.map((v) => [v.joinId, v.plan])).toEqual([
      [plan?.id, { kind: 'follow', placedAt: placed.createdAt, familyId: familyIdOf(slug) }],
    ]);

    // Missed at the confirm, the read finds the family from the order all the same.
    await unjoin(buyer);
    const again = await portfolio(buyer);
    expect(again.vaults.map((v) => v.plan?.familyId)).toEqual([familyIdOf(slug)]);
  });

  it('a plan made from a link is each buyer’s own plan, on the vault numbered from the plan and the buyer', async () => {
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
      // What the engine read to make it is stored with the plan: here the mock yield, labelled so.
      const stored = await loadProposal(data.db, id);
      expect(stored?.observations).toEqual(proposal.observations);
      expect(stored?.observations.map((o) => [o.kind, o.source, o.provenance])).toContainEqual([
        'yield',
        'apps/api/src/testing/fixtures/mock-yields.json',
        'mock',
      ]);

      const seen: (string | undefined)[] = [];
      const [early, late] = [await someone(), await someone()];
      for (const buyer of [early, late]) {
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
        expect(mine.vaults.map((v) => [v.joinId, v.plan?.sheet, v.plan?.card])).toEqual([
          [plan?.id, proposal.sheet, proposal.card],
        ]);
        // The card's figures travel with where they came from: the stored plan's own observations,
        // each with its source, its time, its method and its label.
        expect(mine.vaults.map((v) => v.plan?.observations)).toEqual([stored?.observations]);
        // And at the read, where the number is worked out the same way.
        await unjoin(buyer);
        const again = await portfolio(buyer, linked.app);
        expect(again.vaults.map((v) => v.plan?.proposalId)).toEqual([id]);
        seen.push((await held(buyer))[0]?.id);
      }
      // One plan made from a link, two buyers, two plans of their own.
      expect(new Set(seen).size).toBe(2);

      // A plan made from a link is anybody's who holds its id, whoever its row names. No route stores
      // one with a person today: as if one did, the other buyer is still answered what the plan says.
      const [named] = await data.db.select().from(users).where(eq(users.privyId, early.sub));
      if (!named) throw new Error('the first buyer has no user row');
      await data.db.update(proposals).set({ userId: named.id }).where(eq(proposals.id, id));
      const other = await portfolio(late, linked.app);
      expect(other.vaults.map((v) => [v.plan?.sheet, v.plan?.observations])).toEqual([
        [proposal.sheet, stored?.observations],
      ]);
    } finally {
      await linked.app.close();
    }
  });
});
