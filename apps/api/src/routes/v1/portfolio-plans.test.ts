import { randomUUID } from 'node:crypto';
import { familyIdOf } from '@colosseum/basket';
import {
  baskets,
  createDb,
  indexFamilies,
  legs,
  orders,
  proposals,
  snapshotRuns,
  users,
  vaults,
} from '@colosseum/db';
import {
  type BasketProposal,
  type ChainId,
  DISCLAIMER,
  type ObservationRef,
  OrderDetail,
  PortfolioPlansResponse,
  TRACK_RULE,
} from '@colosseum/schemas';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../orders/chains';
import { type JoinedPlan, joinVault } from '../../orders/plan-join';
import { basketIdOf } from '../../orders/prepare';
import { dollarsOf, openedForOf, PUT_IN_METHOD } from '../../portfolio/plans';
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
import {
  dropRuns,
  seedRun,
  seedSnapshot,
  seedVault,
  vaultAddress,
} from '../../testing/portfolio-world';

// GET /v1/portfolio/plans (PORT-2), through HTTP on the mock chains and the real database: one entry
// for each vault of the signed-in person, with its plan, the shared portfolio it was opened to follow,
// what was put in, its newest snapshot, its status and the shared portfolio the chain shows it
// following. The orders are real ones, taken through the API. The
// snapshots and the passes of the worker are made up (testing/portfolio-world.ts): the worker is
// another app.
//
// Other sessions write to this database at the same time, so every test makes its own people and
// reads only their rows. One thing here is nobody's: a pass of the worker (`snapshot_runs`) is its
// chain's, and the route answers with the chain's newest. So:
// - This file's clock stands still, a month past the newest run the database holds on the mock chains
//   and never before 2100. The wall clock, and the made-up days of the worker's own tests (2040 to
//   2072), are long before it: no run of another file is the newest, or within a day of it.
// - A run seeded here is dropped when its test ends.
// - A run of this file holds a Postgres advisory lock from its first query to its last. Two runs on
//   one database (two worktrees, a review beside a build) wait for each other, and neither sets its
//   clock by the other's runs. The lock is the session's and goes with its connection, so a run that
//   is killed leaves none behind; a run it leaves in `snapshot_runs` is a month older than the next
//   run's clock.

vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The advisory lock a run of this file holds: any number, as long as no other file takes it. */
const LOCK = 7_016_102;
/** The clock is never before this. */
const FLOOR = Date.UTC(2100, 0, 1);

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
/** A stored plan per chain that names no person: anybody buys it, and nobody is answered its goal. */
let plans: Record<HomeChain, string>;
/** This run's clock. It stands still: `ago` counts back from it. */
let NOW: Date;
/** The runs a test seeded, dropped when it ends. */
const runs: string[] = [];
const undo: (() => Promise<unknown>)[] = [];

// The hook's limit is three minutes, not the usual ten seconds: a second run of this file waits here
// for the first to end.
beforeAll(async () => {
  // Before anything else: the clock below is set by what the database holds once the lock is ours.
  const own = createDb();
  const lock = await own.client.reserve();
  await lock`select pg_advisory_lock(${LOCK})`;
  undo.push(async () => {
    await lock`select pg_advisory_unlock(${LOCK})`;
    lock.release();
    await own.client.end();
  });
  issuer = await testIssuer('test');
  data = await testDb();
  undo.push(() => data.cleanUp());
  const [newest] = await data.db
    .select({ startedAt: max(snapshotRuns.startedAt) })
    .from(snapshotRuns)
    .where(and(inArray(snapshotRuns.chainId, CHAINS), eq(snapshotRuns.provenance, 'mock')));
  const newestRun = newest?.startedAt ? new Date(newest.startedAt).getTime() : 0;
  NOW = new Date(Math.max(FLOOR, newestRun + 30 * DAY));
  // An instant past the year 9999 is not written the way the contract reads one.
  if (NOW.getUTCFullYear() > 9000)
    throw new Error('a run in snapshot_runs is stamped past the year 9000: no clock can follow it');
  plans = {
    solana: await data.storePlan(planFixture('solana')),
    robinhood: await data.storePlan(planFixture('robinhood')),
  };
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db, now: () => NOW }));
  undo.push(() => app.close());
}, 180_000);

afterEach(async () => {
  await dropRuns(data.db, runs.splice(0));
});

afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { get, post, fund, order, build, land, report, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});

const someone = async (kind: PersonKind = 'solana') => data.track(await person(issuer, kind));
const ago = (ms: number) => new Date(NOW.getTime() - ms);

type Answer = PortfolioPlansResponse;
type Entry = Answer['chains'][number]['plans'][number];

/**
 * The route's answer to this person, read by the contract's schema. The schema is the whole of it:
 * the answer holds nothing the schema does not name, and always ends with the disclaimer.
 */
async function plansFor(who: Person | null, query = '', on: FastifyInstance = app) {
  const res = await get(who, `/v1/portfolio/plans${query}`, on);
  expect(res.statusCode, res.body).toBe(200);
  const answer = PortfolioPlansResponse.parse(res.json());
  expect(res.json()).toEqual(answer);
  expect(answer.disclaimer).toBe(DISCLAIMER.en);
  return { answer, body: res.body, plans: answer.chains.flatMap((c) => c.plans) };
}

/** The entry of the vault at this address, which has to be in the answer. */
function entryAt(read: { plans: Entry[] }, address: string): Entry {
  const entry = read.plans.find((p) => p.address === address);
  if (!entry) throw new Error(`the answer has no entry for ${address}`);
  return entry;
}

/** One chain's part of an answer, which has to be there. */
function onChain(answer: Answer, chain: HomeChain) {
  const entry = answer.chains.find((c) => c.chain === chain);
  if (!entry) throw new Error(`the answer has no entry for ${chain}`);
  return entry;
}

/** A pass of the worker that went through on a chain, this long before the clock. */
async function passed(chain: HomeChain, before: number): Promise<string> {
  const finishedAt = ago(before);
  runs.push(await seedRun(data.db, { chain, finishedAt }));
  return finishedAt.toISOString();
}

/** The person's rows in the vault cache. */
const cached = (who: Pick<Person, 'solana' | 'evm'>) =>
  data.db
    .select()
    .from(vaults)
    .where(inArray(vaults.owner, [who.solana, who.evm]));

/** The step of an order that deposits, as the database holds it. */
async function depositStep(orderId: string) {
  const [row] = await data.db
    .select()
    .from(legs)
    .where(and(eq(legs.orderId, orderId), inArray(legs.kind, ['create_vault', 'deposit'])))
    .orderBy(asc(legs.seq))
    .limit(1);
  if (!row) throw new Error('the order has no step that deposits');
  return row;
}

/**
 * A stored plan that is this person's own, as `POST /v1/baskets/personalize` stores one: its row names
 * their user row. What a plan says is answered to the person who made it and to nobody else, so a test
 * that expects a goal buys one of these.
 */
async function ownPlan(who: Person, fixture: BasketProposal = planFixture(chainOf(who))) {
  const id = await data.storePlan(fixture);
  await data.db
    .insert(users)
    .values({ privyId: who.sub })
    .onConflictDoNothing({ target: users.privyId });
  const [user] = await data.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.privyId, who.sub));
  if (!user) throw new Error('the person has no user row');
  await data.db.update(proposals).set({ userId: user.id }).where(eq(proposals.id, id));
  return { id, fixture };
}

/**
 * A buy of a plan taken through every step, and the vault it went into as the cache has it: the goal
 * join wrote the row when the step that opens the vault confirmed.
 */
async function bought(who: Person, amountUsd: number, proposalId?: string) {
  const placed = await order(who, { amountUsd, ...(proposalId ? { proposalId } : {}) });
  expect((await settleAll(who, placed)).status).toBe('done');
  const vault = (await cached(who)).find((v) => v.onchainBasketId === placed.basketId);
  if (!vault) throw new Error('the cache has no vault for this buy');
  return { placed, vault };
}

/**
 * A shared portfolio as the harness stores one: its family's row. Its recipe on `chain` is stored
 * under the id `test:<family id>`.
 */
async function storedFamily(chain: HomeChain) {
  const { slug } = await data.storeFamily(chain, [
    { kind: 'asset', asset: `${chain}:spy`, weightBps: 10_000 },
  ]);
  const [family] = await data.db.select().from(indexFamilies).where(eq(indexFamilies.slug, slug));
  if (!family) throw new Error('the family was not stored');
  return family;
}

/** A made-up snapshot at a vault's own address, owner and number, this long before the clock. */
const snapshotOf = (
  vault: { chainId: ChainId; address: string; owner: string; onchainBasketId: string },
  before: number,
  over: Partial<Parameters<typeof seedSnapshot>[1]> = {},
) =>
  seedSnapshot(data.db, {
    chain: vault.chainId,
    address: vault.address,
    owner: vault.owner,
    onchainBasketId: vault.onchainBasketId,
    observedAt: ago(before),
    ...over,
  });

describe('dollars from raw cash', () => {
  it('are exact, with at least the cents and every digit past them', () => {
    expect(dollarsOf(100_000_000n, 6)).toBe('100.00');
    expect(dollarsOf(100_100_000n, 6)).toBe('100.10');
    expect(dollarsOf(1_234_567n, 6)).toBe('1.234567');
    expect(dollarsOf(1n, 6)).toBe('0.000001');
    expect(dollarsOf(0n, 6)).toBe('0.00');
    expect(dollarsOf(5n, 0)).toBe('5.00');
    expect(dollarsOf(1_500_000_000_000_000_000n, 18)).toBe('1.50');
    // Past what a float holds: every digit is still there.
    expect(dollarsOf(123_456_789_012_345_678_901_234_567n, 6)).toBe('123456789012345678901.234567');
  });
});

describe('what a person put into a vault', () => {
  it.each(CHAINS)(
    'on %s: a buy of the person’s own plan is answered with the plan’s sheet and the deposit to the cent, and a second buy adds to it',
    async (chain) => {
      const a = await someone(chain);
      const own = await ownPlan(a);
      await fund(a);
      const first = await bought(a, 100.1, own.id);
      // On Robinhood Chain the approval holds the cash too, beside the step that opens the vault.
      expect(first.placed.legs.filter((l) => l.cashRaw !== undefined).map((l) => l.kind)).toEqual(
        chain === 'robinhood' ? ['approve', 'create_vault'] : ['create_vault'],
      );
      const opened = await depositStep(first.placed.id);

      const one = await plansFor(a);
      expect(one.plans).toHaveLength(1);
      const [entry] = one.plans;
      expect(entry).toMatchObject({
        chain,
        address: first.vault.address,
        owner: walletOf(a),
        name: null,
        basketId: basketIdOf(own.id),
        provenance: 'mock',
        // A plan made to measure was opened to follow no shared portfolio.
        openedFor: null,
        // Nobody has snapshotted the vault: it is in the cache, and that is all.
        newest: null,
        follows: null,
      });
      expect(entry?.plan).toEqual({
        kind: 'personal',
        placedAt: first.placed.createdAt,
        proposalId: own.id,
        sheet: own.fixture.sheet,
        card: own.fixture.card,
        verdict: null,
        observations: [],
      });
      expect(entry?.plan?.sheet).toMatchObject({
        goal: 'grow',
        amountUsd: 1000,
        horizonMonths: 60,
      });
      expect(entry?.putIn).toEqual({
        usd: '100.10',
        orders: 1,
        deposits: [{ orderId: first.placed.id, at: opened.updatedAt.toISOString(), usd: '100.10' }],
        source: `the person's confirmed deposits in this app's order record on ${chain === 'solana' ? 'Solana' : 'Robinhood Chain'}`,
        method: PUT_IN_METHOD,
        fetchedAt: opened.updatedAt.toISOString(),
        provenance: 'mock',
      });
      // What the figure is, and what is not in it, in its own words.
      for (const said of [
        /the cash of each order whose deposit confirmed/,
        /once an order/,
        /gross: a withdrawal is not taken off/,
        /money that reached the vault any other way is not in it/,
      ])
        expect(entry?.putIn?.method).toMatch(said);

      // More money into the same vault: two orders, their sum, and each deposit by its own order.
      const second = await bought(a, 50.25, own.id);
      expect(second.placed.legs.map((l) => l.kind)).toContain('deposit');
      expect(second.vault.address).toBe(first.vault.address);
      const added = await depositStep(second.placed.id);
      const two = await plansFor(a);
      expect(two.plans).toHaveLength(1);
      const putIn = two.plans[0]?.putIn;
      expect(putIn).toMatchObject({ usd: '150.35', orders: 2 });
      expect(putIn?.deposits).toEqual([
        { orderId: first.placed.id, at: opened.updatedAt.toISOString(), usd: '100.10' },
        { orderId: second.placed.id, at: added.updatedAt.toISOString(), usd: '50.25' },
      ]);
      // Oldest first, and the figure's time is the newest of them: when the server last learned of one.
      expect(added.updatedAt.getTime()).toBeGreaterThan(opened.updatedAt.getTime());
      expect(putIn?.fetchedAt).toBe(added.updatedAt.toISOString());
      // The sum of what is listed, in whole cents.
      const cents = (usd: string) => BigInt(usd.replace('.', ''));
      expect(putIn?.deposits.reduce((sum, d) => sum + cents(d.usd), 0n)).toBe(
        cents(putIn?.usd ?? '0.00'),
      );
    },
  );

  it('counts a deposit only once it is confirmed, and never an approval', async () => {
    for (const chain of CHAINS) {
      const a = await someone(chain);
      await fund(a);
      const { vault } = await bought(a, 100);
      const putIn = async () => entryAt(await plansFor(a), vault.address).putIn;
      expect(await putIn()).toMatchObject({ usd: '100.00', orders: 1 });

      // A second order is made, and every step before its deposit settles: on Robinhood Chain that
      // is the approval, which is confirmed and holds the same cash.
      const add = await order(a, { amountUsd: 40 });
      const deposit = add.legs.find((l) => l.kind === 'deposit');
      if (!deposit) throw new Error('the second buy has no deposit');
      const before = await settleAll(a, add, undefined, (leg) => leg.id === deposit.id);
      expect(before.legs.filter((l) => l.status === 'confirmed').map((l) => l.kind)).toEqual(
        chain === 'robinhood' ? ['approve'] : [],
      );
      expect(await putIn()).toMatchObject({ usd: '100.00', orders: 1 });
      // Built and not landed: still not a deposit.
      await build(a, add, deposit.id);
      expect(await putIn()).toMatchObject({ usd: '100.00', orders: 1 });
      // Landed and reported: now it is.
      await report(a, add, deposit.id, { txId: await land(a, add, deposit.id) });
      expect(await putIn()).toMatchObject({ usd: '140.00', orders: 2 });
    }
  });

  it('counts an order once, by its first step that deposits, whatever other step holds cash', async () => {
    const a = await someone();
    await fund(a);
    const { placed, vault } = await bought(a, 100);
    // A second step that deposits, which no order of the app has: confirmed, with other cash.
    await data.db.insert(legs).values({
      orderId: placed.id,
      chainId: 'solana',
      seq: 99,
      kind: 'deposit',
      signer: 'owner',
      description: 'a step a test wrote',
      cashRaw: '999000000',
      trades: [],
      status: 'confirmed',
      trigger: 'manual',
      provenance: 'mock',
    });
    const opened = await depositStep(placed.id);
    expect(entryAt(await plansFor(a), vault.address).putIn).toMatchObject({
      usd: '100.00',
      orders: 1,
      deposits: [{ orderId: placed.id, at: opened.updatedAt.toISOString(), usd: '100.00' }],
    });
  });

  it('gives each vault its own deposits, never another’s', async () => {
    const a = await someone();
    await fund(a);
    const grow = await ownPlan(a);
    const protect = await ownPlan(a, planFixture('solana', { spy: 6000, gold: 4000 }));
    const one = await bought(a, 100, grow.id);
    const two = await bought(a, 250, protect.id);
    await bought(a, 30, grow.id);
    expect(one.vault.address).not.toBe(two.vault.address);
    const read = await plansFor(a);
    expect(read.plans).toHaveLength(2);
    expect(entryAt(read, one.vault.address)).toMatchObject({
      basketId: basketIdOf(grow.id),
      plan: { proposalId: grow.id },
      putIn: { usd: '130.00', orders: 2 },
    });
    expect(entryAt(read, two.vault.address)).toMatchObject({
      basketId: basketIdOf(protect.id),
      plan: { proposalId: protect.id },
      putIn: { usd: '250.00', orders: 1, deposits: [{ orderId: two.placed.id, usd: '250.00' }] },
    });
  });

  it('keeps apart two vaults of one number under two wallets of one sign-in', async () => {
    // Two wallets that each bought the same stored plan hold vaults of one number.
    const a = await someone();
    const b = await someone();
    await fund(a);
    await fund(b);
    const mine = await bought(a, 100);
    const theirs = await bought(b, 250);
    expect(mine.vault.onchainBasketId).toBe(theirs.vault.onchainBasketId);
    // Each wallet's own sign-in is answered its own deposit.
    expect((await plansFor(a)).plans.map((p) => p.putIn?.usd)).toEqual(['100.00']);
    expect((await plansFor(b)).plans.map((p) => p.putIn?.usd)).toEqual(['250.00']);

    // One sign-in that holds both wallets: two vaults, each with the deposit of its own wallet.
    const sub = `did:privy:test-${randomUUID()}`;
    const both: Person = data.track({
      ...a,
      sub,
      headers: await signIn(issuer, sub, [
        { family: 'solana', address: a.solana, client: 'phantom' },
        { family: 'solana', address: b.solana, client: 'phantom' },
      ]),
    });
    const read = await plansFor(both);
    expect(read.plans).toHaveLength(2);
    expect(entryAt(read, mine.vault.address)).toMatchObject({
      owner: a.solana,
      putIn: { usd: '100.00', orders: 1, deposits: [{ orderId: mine.placed.id }] },
    });
    expect(entryAt(read, theirs.vault.address)).toMatchObject({
      owner: b.solana,
      putIn: { usd: '250.00', orders: 1, deposits: [{ orderId: theirs.placed.id }] },
    });
  });

  it('counts a buy stored before its vault’s number was kept, and no vault for one whose number cannot be worked out', async () => {
    const a = await someone();
    await fund(a);
    const { placed, vault } = await bought(a, 100);
    const putIn = async () => entryAt(await plansFor(a), vault.address).putIn;
    // As an order made before `orders.basket_id` was kept: its number is worked out from its plan.
    await data.db.update(orders).set({ basketId: null }).where(eq(orders.id, placed.id));
    expect(await putIn()).toMatchObject({ usd: '100.00', orders: 1 });
    // And with a request that names no plan either: nothing says which vault it was for.
    await data.db
      .update(orders)
      .set({ request: sql`${orders.request} - 'proposalId'` })
      .where(eq(orders.id, placed.id));
    expect(await putIn()).toBeNull();
  });

  it('counts a chain’s deposits on that chain only, for a person with a vault of one number on each', async () => {
    // A person with a wallet of each family: every order of theirs names both wallets.
    const p = await someone('passkey');
    const onSolana: Person = { ...p, chain: 'solana' };
    const onRobinhood: Person = { ...p, chain: 'robinhood' };
    await fund(onSolana);
    await fund(onRobinhood);
    const here = await bought(onSolana, 100);
    const there = await bought(onRobinhood, 250);
    expect([here.placed.owner, there.placed.owner]).toEqual([p.owner, p.owner]);
    // As a person who bought one shared portfolio on both chains has it: the two vaults have one
    // number. No route makes that with two stored plans, so the second vault and its order are
    // given the first one's number here.
    const number = here.vault.onchainBasketId;
    await data.db.update(orders).set({ basketId: number }).where(eq(orders.id, there.placed.id));
    await data.db
      .update(vaults)
      .set({ onchainBasketId: number })
      .where(eq(vaults.address, there.vault.address));

    const read = await plansFor(p);
    expect(read.plans.map((v) => [v.chain, v.basketId])).toEqual([
      ['solana', number],
      ['robinhood', number],
    ]);
    expect(entryAt(read, here.vault.address).putIn).toMatchObject({
      usd: '100.00',
      orders: 1,
      deposits: [{ orderId: here.placed.id }],
      source: "the person's confirmed deposits in this app's order record on Solana",
    });
    expect(entryAt(read, there.vault.address).putIn).toMatchObject({
      usd: '250.00',
      orders: 1,
      deposits: [{ orderId: there.placed.id }],
      source: "the person's confirmed deposits in this app's order record on Robinhood Chain",
    });
  });

  it('counts only a buy, only a step under the chain’s own label, and only one that holds its cash', async () => {
    const a = await someone();
    await fund(a);
    const { placed, vault } = await bought(a, 100);
    const putIn = async () => entryAt(await plansFor(a), vault.address).putIn;
    const counted = { usd: '100.00', orders: 1 };
    expect(await putIn()).toMatchObject(counted);
    // The same steps as a test network would have recorded them: this server runs the mock.
    await data.db.update(legs).set({ provenance: 'sandbox' }).where(eq(legs.orderId, placed.id));
    expect(await putIn()).toBeNull();
    await data.db.update(legs).set({ provenance: 'mock' }).where(eq(legs.orderId, placed.id));
    expect(await putIn()).toMatchObject(counted);
    // The same order as another type: only a buy puts money in.
    await data.db.update(orders).set({ type: 'rebalance' }).where(eq(orders.id, placed.id));
    expect(await putIn()).toBeNull();
    await data.db.update(orders).set({ type: 'buy' }).where(eq(orders.id, placed.id));
    expect(await putIn()).toMatchObject(counted);
    // A step stored before a step's cash was kept holds none: what it deposited is not known.
    await data.db
      .update(legs)
      .set({ cashRaw: null })
      .where(and(eq(legs.orderId, placed.id), eq(legs.kind, 'create_vault')));
    expect(await putIn()).toBeNull();
  });
});

describe('the newest snapshot and the status', () => {
  it('a vault the worker has not read has no snapshot and no status, and says which line says so', async () => {
    const a = await someone();
    const address = await seedVault(data.db, {
      chain: 'solana',
      owner: a.solana,
      onchainBasketId: '4242',
      name: 'House fund',
    });
    const read = await plansFor(a);
    expect(read.plans).toEqual([
      {
        chain: 'solana',
        address,
        owner: a.solana,
        name: 'House fund',
        basketId: '4242',
        plan: null,
        openedFor: null,
        putIn: null,
        newest: null,
        status: expect.objectContaining({
          status: null,
          rule: TRACK_RULE,
          line: 'never_read',
          observedAt: null,
        }),
        follows: null,
        provenance: 'mock',
      },
    ]);
    expect(TRACK_RULE).toBe('ON-TRACK-V1');
  });

  it('answers the newest snapshot whole, with its age, and On track for one inside the band after a pass that went through', async () => {
    const a = await someone();
    // What the vault is, is the newest snapshot's to say: the cache row here names another number.
    const address = await seedVault(data.db, {
      chain: 'solana',
      owner: a.solana,
      onchainBasketId: '5',
    });
    const vault = { chainId: 'solana' as const, address, owner: a.solana, onchainBasketId: '6' };
    // An older read, which is not the newest.
    await snapshotOf(vault, 30 * MINUTE, { valueUsd: 900, blockOrSlot: '6' });
    const row = await snapshotOf(vault, 10 * MINUTE, { valueUsd: 950, blockOrSlot: '7' });
    const answeredAt = await passed('solana', 5 * MINUTE);

    const read = await plansFor(a);
    expect(onChain(read.answer, 'solana')).toMatchObject({
      chain: 'solana',
      name: 'Solana',
      provenance: 'mock',
      answeredAt,
    });
    const entry = entryAt(read, address);
    expect(entry).toMatchObject({ owner: a.solana, basketId: '6' });
    expect(entry.newest).toEqual({
      observedAt: ago(10 * MINUTE).toISOString(),
      ageSeconds: 600,
      stale: false,
      blockOrSlot: '7',
      valueUsd: '950.00',
      cash: row.cash,
      positions: row.positions,
      lossUsedBps: 0,
      bandBps: 100,
      lossCapBps: null,
      paused: null,
      prices: row.prices,
      source: 'chain-mock',
      method: 'a snapshot a test made up',
      provenance: 'mock',
    });
    // Every price the values stood on, each with where it came from.
    expect(entry.newest?.prices).toHaveLength(3);
    for (const price of entry.newest?.prices ?? [])
      expect(price).toMatchObject({
        source: 'chain-mock',
        fetchedAt: ago(10 * MINUTE).toISOString(),
        provenance: 'mock',
      });
    expect(entry.status).toMatchObject({
      status: 'on_track',
      rule: TRACK_RULE,
      line: 'inside_no_budget',
      observedAt: ago(10 * MINUTE).toISOString(),
    });
    expect(entry.status.text.length).toBeGreaterThan(0);
  });

  it('gives Watch for a drift past the band, Off track for half the loss budget used, and On track under a quarter of it', async () => {
    const a = await someone();
    const seed = async (over: Partial<Parameters<typeof seedSnapshot>[1]>) => {
      const address = vaultAddress('solana');
      await seedSnapshot(data.db, {
        chain: 'solana',
        address,
        owner: a.solana,
        observedAt: ago(10 * MINUTE),
        ...over,
      });
      return address;
    };
    const drifted = await seed({
      parts: {
        spy: { weightBps: 5400, targetBps: 5000 },
        nvda: { weightBps: 2600, targetBps: 3000 },
        gold: 2000,
      },
    });
    const edge = await seed({
      parts: {
        spy: { weightBps: 5100, targetBps: 5000 },
        nvda: { weightBps: 2900, targetBps: 3000 },
        gold: 2000,
      },
    });
    const lost = await seed({ lossCapBps: 100, lossUsedBps: 50 });
    const budgeted = await seed({ lossCapBps: 100, lossUsedBps: 10 });
    await passed('solana', 5 * MINUTE);

    const read = await plansFor(a);
    expect(entryAt(read, drifted).status).toMatchObject({
      status: 'watch',
      rule: TRACK_RULE,
      line: 'outside_band',
    });
    // Exactly at the band is inside it.
    expect(entryAt(read, edge).status).toMatchObject({ status: 'on_track' });
    expect(entryAt(read, lost).status).toMatchObject({
      status: 'off_track',
      rule: TRACK_RULE,
      line: 'loss_half',
    });
    expect(entryAt(read, budgeted).status).toMatchObject({ status: 'on_track', line: 'inside' });
  });

  it('says a snapshot older than an hour is stale, with its age, and the status says Watch', async () => {
    const a = await someone();
    const seed = async (before: number) => {
      const address = vaultAddress('solana');
      await seedSnapshot(data.db, {
        chain: 'solana',
        address,
        owner: a.solana,
        observedAt: ago(before),
      });
      return address;
    };
    const old = await seed(2 * HOUR);
    const hour = await seed(HOUR);
    const justPast = await seed(HOUR + SECOND / 2);
    // A worker whose clock runs ahead of this server's: the age is never below zero.
    const ahead = await seed(-5 * MINUTE);
    await passed('solana', 5 * MINUTE);

    const read = await plansFor(a);
    expect(entryAt(read, old)).toMatchObject({
      newest: { observedAt: ago(2 * HOUR).toISOString(), ageSeconds: 7200, stale: true },
      status: { status: 'watch', rule: TRACK_RULE, line: 'stale' },
    });
    // Exactly an hour is not stale, and half a second past it is: `stale` and the rule's line agree.
    expect(entryAt(read, hour)).toMatchObject({
      newest: { ageSeconds: 3600, stale: false },
      status: { status: 'on_track' },
    });
    expect(entryAt(read, justPast)).toMatchObject({
      newest: { ageSeconds: 3600, stale: true },
      status: { status: 'watch', line: 'stale' },
    });
    expect(entryAt(read, ahead)).toMatchObject({
      newest: { ageSeconds: 0, stale: false },
      status: { status: 'on_track' },
    });
  });

  it('says Off track when the chain has been silent for a day, and not when a pass went through since', async () => {
    const a = await someone();
    const address = await seedVault(data.db, { chain: 'solana', owner: a.solana });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address,
      owner: a.solana,
      observedAt: ago(2 * DAY),
    });
    // The last pass that went through was two days ago too.
    const silentSince = await passed('solana', 2 * DAY);
    const silent = await plansFor(a);
    expect(onChain(silent.answer, 'solana').answeredAt).toBe(silentSince);
    expect(entryAt(silent, address).status).toMatchObject({
      status: 'off_track',
      rule: TRACK_RULE,
      line: 'chain_silent',
    });

    // A pass goes through: the chain answers again, and what is left is an old snapshot.
    const answeredAt = await passed('solana', 5 * MINUTE);
    const answered = await plansFor(a);
    expect(onChain(answered.answer, 'solana').answeredAt).toBe(answeredAt);
    expect(entryAt(answered, address).status).toMatchObject({ status: 'watch', line: 'stale' });
  });

  it('keeps the verdict stored with the plan out of the status', async () => {
    // An income plan whose stored verdict says the income is not met.
    const verdict = {
      met: false,
      gapUsdMonthly: 12.5,
      ways: [{ change: 'a longer term', closesGap: true }],
    };
    const reading: ObservationRef = {
      id: 'yield solana:yield',
      kind: 'yield',
      source: 'apps/api/src/testing/fixtures/mock-yields.json',
      method: 'mock_value_written_by_hand_not_a_reading',
      fetchedAt: '2026-10-05T00:00:00.000Z',
      provenance: 'mock',
    };
    const a = await someone();
    const own = await ownPlan(a, { ...planFixture('solana'), verdict, observations: [reading] });
    await fund(a);
    const { vault } = await bought(a, 100, own.id);
    await snapshotOf(vault, 10 * MINUTE, { basketId: vault.basketId });
    await passed('solana', 5 * MINUTE);

    const entry = entryAt(await plansFor(a), vault.address);
    // The plan is answered with its verdict, as it was stored.
    expect(entry.plan).toMatchObject({ proposalId: own.id, verdict, observations: [reading] });
    // And the status is the rule's own, on what the vault holds now.
    expect(entry.status).toMatchObject({
      status: 'on_track',
      rule: 'ON-TRACK-V1',
      line: 'inside_no_budget',
    });
    expect(entry.putIn).toMatchObject({ usd: '100.00', orders: 1 });
  });

  it('lists a vault the worker alone found, with its status and neither plan nor deposit', async () => {
    const a = await someone();
    const address = vaultAddress('solana');
    await seedSnapshot(data.db, {
      chain: 'solana',
      address,
      owner: a.solana,
      observedAt: ago(10 * MINUTE),
      onchainBasketId: '77',
    });
    // One the worker last read more than a week before the server's clock is no longer looked for.
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: vaultAddress('solana'),
      owner: a.solana,
      observedAt: ago(8 * DAY),
    });
    await passed('solana', 5 * MINUTE);
    const read = await plansFor(a);
    expect(read.plans).toHaveLength(1);
    expect(read.plans[0]).toMatchObject({
      chain: 'solana',
      address,
      owner: a.solana,
      name: null,
      basketId: '77',
      plan: null,
      openedFor: null,
      putIn: null,
      newest: { observedAt: ago(10 * MINUTE).toISOString(), valueUsd: '1000.00' },
      status: { status: 'on_track', rule: TRACK_RULE },
      follows: null,
      provenance: 'mock',
    });
  });

  it('answers what was put into a vault the cache does not have, by the owner and number its snapshot says', async () => {
    const a = await someone();
    await fund(a);
    const { placed, vault } = await bought(a, 100);
    // As a vault whose join was missed and that the worker then found by its owner: no cache row and
    // no plan, and a snapshot that says whose the vault is and which number it has.
    await data.db.delete(vaults).where(eq(vaults.id, vault.id));
    if (vault.basketId) await data.db.delete(baskets).where(eq(baskets.id, vault.basketId));
    await snapshotOf(vault, 10 * MINUTE);
    const read = await plansFor(a);
    expect(read.plans).toHaveLength(1);
    expect(read.plans[0]).toMatchObject({
      address: vault.address,
      owner: a.solana,
      basketId: placed.basketId,
      plan: null,
      putIn: { usd: '100.00', orders: 1, deposits: [{ orderId: placed.id }] },
    });
  });
});

describe('the shared portfolio a vault follows', () => {
  it('is named where the server holds its family on that chain, and is the id and version alone where it does not', async () => {
    const here = await storedFamily('solana');
    const elsewhere = await storedFamily('robinhood');

    const a = await someone();
    const seed = async (before: number, over: Partial<Parameters<typeof seedSnapshot>[1]>) => {
      const address = over.address ?? vaultAddress('solana');
      await seedSnapshot(data.db, {
        chain: 'solana',
        owner: a.solana,
        observedAt: ago(before),
        ...over,
        address,
      });
      return address;
    };
    const named = await seed(10 * MINUTE, {
      recipeOnchainId: `test:${here.familyId}`,
      acceptedVersion: 4,
      autoFollow: true,
    });
    const unknownId = `nowhere:${randomUUID()}`;
    const unknown = await seed(10 * MINUTE, { recipeOnchainId: unknownId, acceptedVersion: 2 });
    // A recipe of that id is stored, on another chain: it is not this vault's.
    const otherChain = await seed(10 * MINUTE, {
      recipeOnchainId: `test:${elsewhere.familyId}`,
      acceptedVersion: 1,
    });
    // It followed one at an older read, and follows none at the newest.
    const left = await seed(30 * MINUTE, { recipeOnchainId: `test:${here.familyId}` });
    await seed(10 * MINUTE, { address: left });
    const unread = await seedVault(data.db, { chain: 'solana', owner: a.solana });

    const read = await plansFor(a);
    expect(entryAt(read, named).follows).toEqual({
      recipeOnchainId: `test:${here.familyId}`,
      acceptedVersion: 4,
      autoFollow: true,
      familyId: here.familyId,
      slug: here.slug,
      name: here.name,
    });
    expect(entryAt(read, unknown).follows).toEqual({
      recipeOnchainId: unknownId,
      acceptedVersion: 2,
      autoFollow: false,
    });
    expect(entryAt(read, otherChain).follows).toEqual({
      recipeOnchainId: `test:${elsewhere.familyId}`,
      acceptedVersion: 1,
      autoFollow: false,
    });
    expect(entryAt(read, left).follows).toBeNull();
    expect(entryAt(read, unread).follows).toBeNull();
  });
});

describe('the shared portfolio a vault was opened to follow', () => {
  /** A shared portfolio published through the API on Solana's mock, by a person of its own. */
  async function published() {
    const creator = await someone();
    const id = randomUUID().replaceAll('-', '');
    const slug = `t-${id.slice(0, 16)}`;
    // A name folds to letters, so the run's id is spelled in them.
    const letters = id.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a').slice(0, 12);
    const name = `Test ${letters}`;
    data.trackFamily(familyIdOf(slug));
    await fund(creator);
    const res = await post(creator, '/v1/orders', {
      type: 'publish',
      creator: { solana: creator.solana },
      family: slug,
      name,
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
    expect(res.statusCode, res.body).toBe(200);
    await settleAll(creator, OrderDetail.parse(res.json()));
    return { familyId: familyIdOf(slug), slug, name };
  }

  /** A vault in the cache, joined to a plan of the person's as the goal join writes one. */
  async function joined(
    who: Person,
    chain: HomeChain,
    plan: Parameters<typeof joinVault>[1]['plan'],
  ) {
    const address = await seedVault(data.db, {
      chain,
      owner: chain === 'solana' ? who.solana : who.evm,
    });
    const planId = await joinVault(data.db, {
      chain,
      address,
      privyId: who.sub,
      plan,
      placedAt: NOW,
    });
    if (!planId) throw new Error('the vault was not joined');
    return { address, planId };
  }

  it('is named from the server’s own row for a vault bought as a follow, though its snapshot shows it following none, and to nobody else', async () => {
    const family = await published();
    const buyer = await someone();
    await fund(buyer);
    const res = await post(buyer, '/v1/orders', {
      type: 'buy',
      owner: buyer.owner,
      amountUsd: 100,
      family: family.slug,
    });
    expect(res.statusCode, res.body).toBe(200);
    const placed = OrderDetail.parse(res.json());
    expect((await settleAll(buyer, placed)).status).toBe('done');
    const [vault] = await cached(buyer);
    if (!vault) throw new Error('the cache has no vault for this buy');
    // As the snapshot worker's mock reads it: the vault is made again there, with no portfolio.
    await snapshotOf(vault, 10 * MINUTE, { basketId: vault.basketId });

    const read = await plansFor(buyer);
    expect(read.plans).toHaveLength(1);
    const [entry] = read.plans;
    expect(entry?.plan).toEqual({
      kind: 'follow',
      placedAt: placed.createdAt,
      familyId: family.familyId,
    });
    // The id, the slug and the name as the server stored them when the portfolio was published.
    expect(entry?.openedFor).toEqual(family);
    expect(entry).toMatchObject({
      address: vault.address,
      newest: { ageSeconds: 600 },
      // What the chain shows is the snapshot's to say, and this one shows no portfolio.
      follows: null,
      putIn: { usd: '100.00', orders: 1, deposits: [{ orderId: placed.id }] },
    });

    // The two can differ. At a newer read the vault follows another shared portfolio the server
    // holds: `follows` names that one, and what the vault was opened for is as it was.
    const other = await storedFamily('solana');
    await snapshotOf(vault, 5 * MINUTE, {
      basketId: vault.basketId,
      recipeOnchainId: `test:${other.familyId}`,
      acceptedVersion: 3,
    });
    const later = entryAt(await plansFor(buyer), vault.address);
    expect(later.openedFor).toEqual(family);
    expect(later.follows).toEqual({
      recipeOnchainId: `test:${other.familyId}`,
      acceptedVersion: 3,
      autoFollow: false,
      familyId: other.familyId,
      slug: other.slug,
      name: other.name,
    });

    // Somebody else, with wallets of their own, is answered nothing of it.
    const secrets = [family.familyId, family.slug, family.name];
    const stranger = await someone();
    for (const query of ['', `?address=${vault.address}`]) {
      const theirs = await plansFor(stranger, query);
      expect([query, theirs.plans]).toEqual([query, []]);
      for (const secret of secrets)
        expect([query, secret, theirs.body.includes(secret)]).toEqual([query, secret, false]);
    }
    // Another sign-in that holds the same wallet is answered the vault and what the chain shows of
    // it. The plan is not theirs, and neither is what it was opened for.
    const sub = `did:privy:test-${randomUUID()}`;
    const twin: Person = data.track({
      ...buyer,
      sub,
      headers: await signIn(issuer, sub, [
        { family: 'solana', address: buyer.solana, client: 'phantom' },
      ]),
    });
    const seen = await plansFor(twin);
    expect(seen.plans).toHaveLength(1);
    expect(seen.plans[0]).toMatchObject({
      address: vault.address,
      plan: null,
      openedFor: null,
      follows: { familyId: other.familyId },
    });
    for (const secret of secrets)
      expect([secret, seen.body.includes(secret)]).toEqual([secret, false]);
  });

  it('is named only for a plan that follows one, each vault with its own', async () => {
    const [one, two] = [await storedFamily('solana'), await storedFamily('solana')];
    const far = await storedFamily('robinhood');
    const a = await someone('passkey');
    const named = ({ familyId, slug, name }: typeof one) => ({ familyId, slug, name });
    const first = await joined(a, 'solana', { kind: 'follow', familyId: one.familyId });
    const second = await joined(a, 'solana', { kind: 'follow', familyId: two.familyId });
    // And on the person's other chain, a vault opened to follow a shared portfolio stored there.
    const there = await joined(a, 'robinhood', { kind: 'follow', familyId: far.familyId });
    const measured = await joined(a, 'solana', { kind: 'personal', proposalId: plans.solana });
    // A row no route writes: a plan made to measure that carries a family's id all the same. It is
    // a plan made to measure, and follows nothing.
    const carrying = await joined(a, 'solana', { kind: 'personal', proposalId: plans.solana });
    await data.db
      .update(baskets)
      .set({ familyId: two.familyId })
      .where(eq(baskets.id, carrying.planId));
    const unjoined = await seedVault(data.db, { chain: 'solana', owner: a.solana });

    const read = await plansFor(a);
    expect(read.plans).toHaveLength(6);
    const of = (address: string) => {
      const { plan, openedFor } = entryAt(read, address);
      return { kind: plan?.kind ?? null, familyId: plan?.familyId ?? null, openedFor };
    };
    expect(of(first.address)).toEqual({
      kind: 'follow',
      familyId: one.familyId,
      openedFor: named(one),
    });
    expect(of(second.address)).toEqual({
      kind: 'follow',
      familyId: two.familyId,
      openedFor: named(two),
    });
    expect(of(there.address)).toEqual({
      kind: 'follow',
      familyId: far.familyId,
      openedFor: named(far),
    });
    expect(of(measured.address)).toEqual({ kind: 'personal', familyId: null, openedFor: null });
    expect(of(carrying.address)).toEqual({
      kind: 'personal',
      familyId: two.familyId,
      openedFor: null,
    });
    expect(of(unjoined)).toEqual({ kind: null, familyId: null, openedFor: null });
  });

  it('is not named where the server holds no row for it, and never guessed', async () => {
    const held = await storedFamily('solana');
    const follow = (familyId?: string): JoinedPlan => ({
      planId: randomUUID(),
      plan: { kind: 'follow', placedAt: NOW.toISOString(), ...(familyId ? { familyId } : {}) },
    });
    // The join's own foreign key keeps a plan's family in the table, so no vault's plan names one
    // that is gone: the plans here are made up, and asked of the real table.
    const gone = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const answered = await openedForOf(
      data.db,
      new Map([
        ['held', follow(held.familyId)],
        ['gone', follow(gone)],
        ['unnamed', follow()],
      ]),
    );
    expect([...answered]).toEqual([
      ['held', { familyId: held.familyId, slug: held.slug, name: held.name }],
    ]);
    expect(await openedForOf(data.db, new Map())).toEqual(new Map());
  });
});

describe('whose plans are answered, and which', () => {
  it('answers a person with wallets of both families on both chains, and narrows to a chain or a vault', async () => {
    const a = await someone('passkey');
    const made = async (chain: HomeChain, owner: string) => {
      const address = await seedVault(data.db, { chain, owner });
      await seedSnapshot(data.db, { chain, address, owner, observedAt: ago(10 * MINUTE) });
      return address;
    };
    const s1 = await made('solana', a.solana);
    const s2 = await made('solana', a.solana);
    const r1 = await made('robinhood', a.evm);
    const shape = (answer: Answer) =>
      answer.chains.map((c) => [c.chain, c.name, c.provenance, c.plans.map((p) => p.address)]);

    // Both chains, in the server's order; a chain's vaults by address.
    const all = await plansFor(a);
    expect(shape(all.answer)).toEqual([
      ['solana', 'Solana', 'mock', [s1, s2].sort()],
      ['robinhood', 'Robinhood Chain', 'mock', [r1]],
    ]);
    expect(all.answer.unavailable).toEqual([]);
    expect(entryAt(all, r1)).toMatchObject({ chain: 'robinhood', owner: a.evm });

    expect(shape((await plansFor(a, '?chain=robinhood')).answer)).toEqual([
      ['robinhood', 'Robinhood Chain', 'mock', [r1]],
    ]);
    // One vault: its chain has it, and the other chain is there with nothing.
    expect(shape((await plansFor(a, `?address=${s2}`)).answer)).toEqual([
      ['solana', 'Solana', 'mock', [s2]],
      ['robinhood', 'Robinhood Chain', 'mock', []],
    ]);
    expect(shape((await plansFor(a, `?chain=robinhood&address=${r1}`)).answer)).toEqual([
      ['robinhood', 'Robinhood Chain', 'mock', [r1]],
    ]);
    // A vault of theirs on another chain than the one named: nothing, and no error.
    expect(shape((await plansFor(a, `?chain=solana&address=${r1}`)).answer)).toEqual([
      ['solana', 'Solana', 'mock', []],
    ]);
    // A chain that is not one of theirs narrows the answer to nothing.
    expect((await plansFor(a, '?chain=base')).answer).toMatchObject({
      chains: [],
      unavailable: [],
    });
    // What is no chain, or no address, is the request's own mistake.
    expect((await get(a, '/v1/portfolio/plans?chain=nowhere')).statusCode).toBe(400);
    expect((await get(a, '/v1/portfolio/plans?address=')).statusCode).toBe(400);
    expect((await get(a, `/v1/portfolio/plans?address=${'x'.repeat(65)}`)).statusCode).toBe(400);
  });

  it('answers a person with no vault an entry for their chain with nothing in it', async () => {
    const a = await someone('robinhood');
    const read = await plansFor(a);
    expect(read.answer.chains.map((c) => [c.chain, c.name, c.provenance, c.plans])).toEqual([
      ['robinhood', 'Robinhood Chain', 'mock', []],
    ]);
  });

  it('never answers another person a vault, a plan or a deposit, by any query the route takes', async () => {
    const a = await someone();
    const own = await ownPlan(a);
    await fund(a);
    const { placed, vault } = await bought(a, 100, own.id);
    await snapshotOf(vault, 10 * MINUTE, { basketId: vault.basketId });
    const mine = entryAt(await plansFor(a), vault.address);
    expect(mine).toMatchObject({
      plan: { proposalId: own.id, sheet: own.fixture.sheet },
      putIn: { usd: '100.00', deposits: [{ orderId: placed.id }] },
      newest: { valueUsd: '1000.00' },
    });

    // Somebody else, with wallets of their own.
    const stranger = await someone();
    for (const query of [
      '',
      '?chain=solana',
      `?address=${vault.address}`,
      `?chain=solana&address=${vault.address}`,
    ]) {
      const theirs = await plansFor(stranger, query);
      expect([query, theirs.plans]).toEqual([query, []]);
      for (const secret of [vault.address, a.solana, placed.id, own.id, vault.basketId ?? ''])
        expect([query, theirs.body.includes(secret)]).toEqual([query, false]);
    }

    // Another sign-in that holds the same wallet: the vault and what the wallet put in are the
    // wallet's, and the plan it was opened for is not theirs to read.
    const sub = `did:privy:test-${randomUUID()}`;
    const twin: Person = data.track({
      ...a,
      sub,
      headers: await signIn(issuer, sub, [
        { family: 'solana', address: a.solana, client: 'phantom' },
      ]),
    });
    const seen = await plansFor(twin);
    expect(seen.plans).toHaveLength(1);
    expect(seen.plans[0]).toMatchObject({
      address: vault.address,
      owner: a.solana,
      plan: null,
      putIn: { usd: '100.00', orders: 1 },
    });
    for (const secret of [own.id, vault.basketId ?? '', '"sheet"', '"card"'])
      expect([secret, seen.body.includes(secret)]).toEqual([secret, false]);
  });

  it('does not answer a vault, a snapshot or a deposit kept under another label', async () => {
    const a = await someone();
    const mock = await seedVault(data.db, { chain: 'solana', owner: a.solana });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: mock,
      owner: a.solana,
      observedAt: ago(10 * MINUTE),
    });
    // The same wallet as a test network would have it read: this server runs the chain on the mock.
    const sandbox = await seedVault(data.db, {
      chain: 'solana',
      owner: a.solana,
      provenance: 'sandbox',
    });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: sandbox,
      owner: a.solana,
      observedAt: ago(5 * MINUTE),
      provenance: 'sandbox',
    });
    // Found by a test network's worker alone: a snapshot and no cache row.
    const alone = vaultAddress('solana');
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: alone,
      owner: a.solana,
      observedAt: ago(5 * MINUTE),
      provenance: 'sandbox',
    });
    for (const query of ['', `?address=${sandbox}`, `?address=${alone}`]) {
      const read = await plansFor(a, query);
      expect([query, read.plans.map((p) => p.address)]).toEqual([query, query ? [] : [mock]]);
      expect(read.body).not.toMatch(/"provenance":"(live|sandbox)"/);
    }
  });

  it('refuses a call with no sign-in', async () => {
    const res = await get(null, '/v1/portfolio/plans');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it('says a chain of the person’s that is switched off, and never shows it as empty', async () => {
    const off = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now: () => NOW,
      env: { CHAIN_MODE_ROBINHOOD: 'off' },
    });
    try {
      const a = await someone('passkey');
      const address = await seedVault(data.db, { chain: 'robinhood', owner: a.evm });
      await seedSnapshot(data.db, {
        chain: 'robinhood',
        address,
        owner: a.evm,
        observedAt: ago(10 * MINUTE),
      });
      const down = {
        chain: 'robinhood',
        name: 'Robinhood Chain',
        code: 'CHAIN_UNAVAILABLE',
        error: 'Robinhood Chain is switched off on this server',
        retryable: false,
      };
      const read = await plansFor(a, '', off.app);
      expect(read.answer.chains.map((c) => c.chain)).toEqual(['solana']);
      expect(read.answer.unavailable).toEqual([down]);
      expect(read.body).not.toContain(address);
      // Asked for by name, it is said the same way; the other chain is not said at all.
      const named = await plansFor(a, '?chain=robinhood', off.app);
      expect(named.answer).toMatchObject({ chains: [], unavailable: [down] });
      expect((await plansFor(a, '?chain=solana', off.app)).answer.unavailable).toEqual([]);
      // On the server that runs it, the same vault is answered.
      expect((await plansFor(a)).plans.map((p) => p.address)).toEqual([address]);
    } finally {
      await off.app.close();
    }
  });

  it('asks no chain anything: the answer is the database’s alone', async () => {
    // A server whose chains refuse every read and every build. Only the list of assets, which an
    // adapter holds in memory, is left: the cash token's decimals come from it.
    const asked: string[] = [];
    const deaf = (entry: ChainEntry): ChainEntry => ({
      ...entry,
      adapter: new Proxy(entry.adapter, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== 'function' || key === 'listAssets') return value;
          return () => {
            asked.push(String(key));
            throw new Error(`the route asked the chain: ${String(key)}`);
          };
        },
      }),
    });
    const quiet = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now: () => NOW,
      wrap: (inner) => ({
        ...inner,
        get: (chain) => deaf(inner.get(chain)),
        active: () => inner.active().map(deaf),
      }),
    });
    try {
      const a = await someone('robinhood');
      const own = await ownPlan(a);
      await fund(a);
      const { vault } = await bought(a, 100, own.id);
      await snapshotOf(vault, 10 * MINUTE, { basketId: vault.basketId });
      const read = await plansFor(a, '', quiet.app);
      expect(entryAt(read, vault.address)).toMatchObject({
        plan: { proposalId: own.id },
        putIn: { usd: '100.00', orders: 1 },
        newest: { ageSeconds: 600 },
      });
      expect(asked).toEqual([]);
    } finally {
      await quiet.app.close();
    }
  });
});
