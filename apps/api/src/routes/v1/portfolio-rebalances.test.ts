import { randomUUID } from 'node:crypto';
import { familyIdOf } from '@colosseum/basket';
import { mockAddress } from '@colosseum/chain-mock';
import { legAttempts, legs, orders, vaults } from '@colosseum/db';
import {
  type ChainId,
  DISCLAIMER,
  OrderDetail,
  PortfolioRebalancesResponse,
} from '@colosseum/schemas';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../orders/chains';
import { basketIdOf } from '../../orders/prepare';
import { KEEPER_LOOKBACK_DAYS, KEEPER_METHOD } from '../../portfolio/rebalances-snapshots';
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
  type PartSeed,
  type SnapshotSeed,
  seedSnapshot,
  seedVault,
  vaultAddress,
} from '../../testing/portfolio-world';

// GET /v1/portfolio/rebalances (PORT-2) through HTTP on the mock chains and the real database: real
// orders taken through their steps as the web does it, and made-up snapshots at the vaults they
// opened. Every test makes its own people and reads only their rows: other sessions write to this
// database at the same time.

vi.setConfig({ testTimeout: 90_000 });

const MINUTE = 60_000;
const DAY = 86_400_000;

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
/** A stored plan per chain: spy 5000, nvda 3000, gold 2000, nothing kept in cash. */
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

const { post, get, fund, order, build, land, report, read, legOf, first, settleAll, attemptsOf } =
  orderFlow({ app: () => app, registry: () => registry, plans: () => plans });

const mockOf = (chain: HomeChain, reg: ChainRegistry = registry) => {
  const { mock } = reg.get(chain);
  if (!mock) throw new Error('not on the mock');
  return mock;
};

/** The route's answer for a person, parsed with the contract's own schema. */
async function rebalances(who: Person, query = '', on: FastifyInstance = app) {
  const res = await get(who, `/v1/portfolio/rebalances${query}`, on);
  expect(res.statusCode, res.body).toBe(200);
  return PortfolioRebalancesResponse.parse(res.json());
}
type Answer = Awaited<ReturnType<typeof rebalances>>;
type Entry = Answer['chains'][number]['entries'][number];
const entriesOn = (answer: Answer, chain: ChainId = 'solana') =>
  answer.chains.find((c) => c.chain === chain)?.entries ?? [];
/** The person's entries on their own chain. */
const listed = async (who: Person, query = '', on?: FastifyInstance) =>
  entriesOn(await rebalances(who, query, on), chainOf(who));
/** The entries of one order, as the list has them. */
const of = (entries: Entry[], o: { id: string }) => entries.filter((e) => e.orderId === o.id);
/** The one trade of an entry. */
const trade = (entry: Entry | undefined) => {
  const [only, ...more] = entry?.trades ?? [];
  if (!only || more.length) throw new Error('not an entry of one trade');
  return only;
};

/** The address of the one vault the cache names for the person's wallet on their chain. */
async function vaultOf(who: Person): Promise<string> {
  const rows = await data.db
    .select({ address: vaults.address })
    .from(vaults)
    .where(eq(vaults.owner, walletOf(who)));
  if (rows.length !== 1 || !rows[0]) throw new Error(`${rows.length} vaults in the cache`);
  return rows[0].address;
}

/** The attempt rows of an order's steps, as they were stored. */
const stored = (o: OrderDetail) =>
  data.db
    .select()
    .from(legAttempts)
    .where(
      inArray(
        legAttempts.legId,
        o.legs.map((l) => l.id),
      ),
    );

/** When the last of an order's steps settled, as its row has it: the server's own clock, not a test's. */
async function settledAt(o: { id: string }): Promise<Date> {
  const rows = await data.db
    .select({ updatedAt: legs.updatedAt })
    .from(legs)
    .where(eq(legs.orderId, o.id));
  return new Date(Math.max(...rows.map((r) => r.updatedAt.getTime())));
}

/** A whole second some hours before now. */
const hoursAgo = (hours: number) =>
  new Date(Math.floor((Date.now() - hours * 60 * MINUTE) / 1000) * 1000);
const plus = (time: Date, minutes: number) => new Date(time.getTime() + minutes * MINUTE);

/**
 * An app of its own whose clock a test moves. A step is built at the clock's time, on a mock chain
 * that follows it, while the row of a step that settles is written at the server's own time: a clock
 * that starts hours ago keeps the two apart. `wrap` makes its chains misbehave.
 */
async function clocked(start: Date, wrap?: (inner: ChainRegistry) => ChainRegistry) {
  let now = start.getTime();
  const made = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    now: () => new Date(now),
    ...(wrap ? { wrap } : {}),
  });
  undo.push(() => made.app.close());
  return {
    ...made,
    now: () => new Date(now),
    /** Moves the clock on and answers its new time. */
    forward(minutes: number) {
      now += minutes * MINUTE;
      return new Date(now);
    },
  };
}

/** A made-up snapshot of a person's vault on their chain. */
const snap = (
  who: Person,
  address: string,
  observedAt: Date,
  parts?: SnapshotSeed['parts'],
  more: Partial<SnapshotSeed> = {},
) =>
  seedSnapshot(data.db, {
    chain: chainOf(who),
    address,
    owner: walletOf(who),
    observedAt,
    ...(parts ? { parts } : {}),
    ...more,
  });
type Row = Awaited<ReturnType<typeof snap>>;
const positionOf = (row: Row, asset: string) => {
  const found = row.positions.find((p) => p.asset === asset);
  if (!found) throw new Error(`${asset} is not in the snapshot`);
  return found;
};
const priceOf = (row: Row, asset: string) => {
  const found = row.prices.find((p) => p.asset === asset);
  if (!found) throw new Error(`${asset} has no price in the snapshot`);
  return found;
};
/** A position against its target in a made-up snapshot, as the route answers it. */
const driftIn = (row: Row, asset: string) => {
  const { weightBps, targetBps, driftBps } = positionOf(row, asset);
  return { observedAt: row.observedAt.toISOString(), weightBps, targetBps, driftBps };
};
/** Unix seconds, as a vault keeps the time of the keeper's last trade on an asset. */
const seconds = (time: Date) => Math.floor(time.getTime() / 1000);

describe('the steps of the person’s own that traded', () => {
  it('lists each step that carries a trade with its trades, its quote, its transaction and its stamp, on each chain', async () => {
    for (const chain of ['solana', 'robinhood'] as const) {
      const a = await someone(chain);
      // Nothing yet: the chain has its entry all the same.
      expect(await rebalances(a)).toEqual({
        chains: [
          {
            chain,
            name: chain === 'solana' ? 'Solana' : 'Robinhood Chain',
            provenance: 'mock',
            entries: [],
          },
        ],
        unavailable: [],
        disclaimer: DISCLAIMER.en,
      });

      await fund(a);
      const done = await settleAll(a, await order(a, { amountUsd: 100 }));
      const vault = await vaultOf(a);
      const attempts = await stored(done);
      const answer = await rebalances(a);
      expect(answer.chains.map((c) => [c.chain, c.provenance])).toEqual([[chain, 'mock']]);
      expect(answer.disclaimer).toBe(DISCLAIMER.en);

      // Solana opens the vault with the cash and then trades one asset a step: the three swaps are
      // listed and the step that opens the vault, which trades nothing, is not. Robinhood Chain
      // approves, then opens and buys in one step: that step is listed and the approval is not.
      const trading = done.legs.filter((l) => l.trades.length > 0).reverse();
      expect(trading.map((l) => l.kind)).toEqual(
        chain === 'solana' ? ['swap', 'swap', 'swap'] : ['create_vault'],
      );
      expect(done.legs.filter((l) => l.trades.length === 0).map((l) => l.kind)).toEqual(
        chain === 'solana' ? ['create_vault'] : ['approve'],
      );
      const entries = entriesOn(answer, chain);
      expect(entries).toEqual(
        trading.map((leg) => {
          const attempt = attempts.find((x) => x.legId === leg.id);
          if (!attempt) throw new Error('no attempt');
          return {
            chain,
            vault,
            at: attempt.builtAt.toISOString(),
            by: 'owner',
            derived: false,
            kind: leg.kind,
            why: 'manual',
            outcome: 'confirmed',
            trades: leg.trades.map((t, i) => ({
              sell: `${chain}:usdc`,
              buy: t.buy,
              asset: t.buy,
              amountInRaw: t.amountInRaw,
              expected: leg.expected[i],
            })),
            orderId: done.id,
            txId: leg.txId,
            explorerUrl: `mock://${chain}/tx/${leg.txId}`,
            source: 'chain-mock',
            method: 'mock state transition',
            fetchedAt: attempt.fetchedAt.toISOString(),
            provenance: 'mock',
          };
        }),
      );
      // The quote of each trade, with its cost against the reference.
      const quotes = entries.flatMap((e) => e.trades.map((t) => t.expected));
      expect(quotes).toHaveLength(3);
      for (const quote of quotes)
        expect(quote).toMatchObject({ costBps: 10, inRaw: expect.stringMatching(/^[1-9]\d*$/) });
      expect(entries.every((e) => e.txId && e.provenance === 'mock')).toBe(true);
      // No snapshot of the vault was ever kept: no price beside a trade, and no drift on either side.
      for (const t of entries.flatMap((e) => e.trades))
        for (const key of ['reference', 'before', 'after']) expect(t).not.toHaveProperty(key);

      // More money into the same vault. On Solana the deposit trades nothing and is not listed, and
      // its three swaps are; on Robinhood Chain the trades ride in the deposit, which is listed.
      const again = await settleAll(a, await order(a, { amountUsd: 50 }));
      expect(again.legs.map((l) => [l.kind, l.trades.length])).toEqual(
        chain === 'solana'
          ? [
              ['deposit', 0],
              ['swap', 1],
              ['swap', 1],
              ['swap', 1],
            ]
          : [
              ['approve', 0],
              ['deposit', 3],
            ],
      );
      const after = await listed(a);
      expect(of(after, again).map((e) => [e.kind, e.trades.length, e.vault])).toEqual(
        chain === 'solana'
          ? [
              ['swap', 1, vault],
              ['swap', 1, vault],
              ['swap', 1, vault],
            ]
          : [['deposit', 3, vault]],
      );
      // Newest first: the second order's steps, then the first one's as they were.
      expect(after.slice(of(after, again).length)).toEqual(entries);
    }
  });

  it('lists an attempt that reverted beside the one that was built again, and an attempt that never landed not at all', async () => {
    // One clock time for every step, so the times around a step are known: its build is at the
    // clock's time, hours ago, and its row is written when it settles, now.
    const then = await clocked(hoursAgo(3));
    const built = then.now();
    const a = await someone();
    await fund(a, then.app);
    const opened = await settleAll(a, await order(a, { amountUsd: 100 }, then.app), then.app);
    const vault = await vaultOf(a);

    const placed = await order(a, { amountUsd: 50 }, then.app);
    const [deposit, swap, next] = [first(placed, 0), first(placed, 1), first(placed, 2)];
    await build(a, placed, deposit.id, then.app);
    await report(
      a,
      placed,
      deposit.id,
      { txId: await land(a, placed, deposit.id, then.app) },
      then.app,
    );
    await build(a, placed, swap.id, then.app);
    mockOf('solana', then.registry).revertNext({
      code: 'ReceivedTooLittle',
      message: 'price moved',
    });
    const reverted = await land(a, placed, swap.id, then.app);
    const failed = await report(a, placed, swap.id, { txId: reverted }, then.app);
    expect(legOf(failed, swap.id).status).toBe('failed');

    // The reverted attempt is the step's latest build: it is listed as failed, with its own
    // transaction and the quote it was built with.
    let mine = of(await listed(a, '', then.app), placed);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: 'swap',
      outcome: 'failed',
      by: 'owner',
      txId: reverted,
      explorerUrl: `mock://solana/tx/${reverted}`,
      vault,
      at: built.toISOString(),
    });
    expect(trade(mine[0]).expected).toEqual(legOf(failed, swap.id).expected[0]);

    // Built again and confirmed: two entries for the one step, each with its own transaction. The
    // quote the step holds is now the second build's, so the reverted attempt is listed without one.
    await build(a, placed, swap.id, then.app);
    const landed = await land(a, placed, swap.id, then.app);
    const retried = await report(a, placed, swap.id, { txId: landed }, then.app);
    expect(attemptsOf(retried, swap.id)).toEqual([
      [1, 'failed'],
      [2, 'confirmed'],
    ]);
    // The step after it is built and never sent, then sent and never landed: neither is listed.
    await build(a, placed, next.id, then.app);
    expect(of(await listed(a, '', then.app), placed)).toHaveLength(2);
    mockOf('solana', then.registry).dropNext();
    const waiting = await report(
      a,
      placed,
      next.id,
      { txId: await land(a, placed, next.id, then.app) },
      then.app,
    );
    expect(legOf(waiting, next.id).status).toBe('sent');

    mine = of(await listed(a, '', then.app), placed);
    expect(mine.map((e) => [e.outcome, e.txId, e.kind])).toEqual([
      ['confirmed', landed, 'swap'],
      ['failed', reverted, 'swap'],
    ]);
    expect(trade(mine[0]).expected).toEqual(legOf(retried, swap.id).expected[0]);
    expect(trade(mine[1])).not.toHaveProperty('expected');
    expect(trade(mine[1])).toMatchObject({
      sell: 'solana:usdc',
      buy: 'solana:spy',
      asset: 'solana:spy',
      amountInRaw: swap.trades[0]?.amountInRaw,
    });

    // Every step here was built at the one clock time. They are answered together by order, the
    // later step of an order first, and the later attempt of a step first.
    const all = await listed(a, '', then.app);
    expect(new Set(all.map((e) => e.at))).toEqual(new Set([built.toISOString()]));
    const byOrder = [opened, placed].sort((x, y) => (x.id < y.id ? 1 : -1));
    expect(all.map((e) => [e.orderId, e.outcome, trade(e).asset])).toEqual(
      byOrder.flatMap((o) =>
        o.id === opened.id
          ? [
              [o.id, 'confirmed', 'solana:gold'],
              [o.id, 'confirmed', 'solana:nvda'],
              [o.id, 'confirmed', 'solana:spy'],
            ]
          : [
              [o.id, 'confirmed', 'solana:spy'],
              [o.id, 'failed', 'solana:spy'],
            ],
      ),
    );

    // The drift after a step is read from the oldest snapshot at or after it settled. The attempt
    // the step ended on settled when its row was last written, which is now. The reverted attempt
    // has no such time of its own: it is read from its build on. A snapshot read at the very
    // moment of the build counts on both sides of it: at or before, and at or after.
    const settled = await settledAt(placed);
    await snap(a, vault, plus(built, -10), { spy: { weightBps: 4500, targetBps: 5000 } });
    const atBuild = await snap(a, vault, built, { spy: { weightBps: 4600, targetBps: 5000 } });
    const late = await snap(a, vault, plus(settled, 10), { spy: 5000 });
    await snap(a, vault, plus(settled, 20), { spy: { weightBps: 5100, targetBps: 5000 } });
    mine = of(await listed(a, '', then.app), placed);
    expect(mine.map((e) => [e.outcome, trade(e).before, trade(e).after])).toEqual([
      ['confirmed', driftIn(atBuild, 'solana:spy'), driftIn(late, 'solana:spy')],
      ['failed', driftIn(atBuild, 'solana:spy'), driftIn(atBuild, 'solana:spy')],
    ]);
  });

  it('gives a quote to the step’s latest build only: an older attempt that lands after the step was built again has none', async () => {
    // A node that says a transaction can no longer land while it still can: the step is built
    // again, and then the first transaction lands after all.
    const sick = { gone: false };
    const lying = (entry: ChainEntry): ChainEntry => ({
      ...entry,
      adapter: {
        ...entry.adapter,
        fate: async (attempt) =>
          sick.gone ? { state: 'gone' as const } : entry.adapter.fate(attempt),
      },
    });
    const then = await clocked(hoursAgo(3), (inner) => ({
      ...inner,
      get: (chain) => lying(inner.get(chain)),
      active: () => inner.active().map(lying),
    }));
    const a = await someone();
    await fund(a, then.app);
    await settleAll(a, await order(a, { amountUsd: 100 }, then.app), then.app);
    const vault = await vaultOf(a);

    const built = then.forward(60);
    const placed = await order(a, { amountUsd: 50 }, then.app);
    const [deposit, swap] = [first(placed, 0), first(placed, 1)];
    await build(a, placed, deposit.id, then.app);
    await report(
      a,
      placed,
      deposit.id,
      { txId: await land(a, placed, deposit.id, then.app) },
      then.app,
    );
    const one = await build(a, placed, swap.id, then.app);
    const firstQuote = legOf(await read(a, placed, then.app), swap.id).expected[0];
    // The price moves, so the second build is quoted another amount than the first.
    const mock = mockOf('solana', then.registry);
    mock.setPrice('solana:spy', '80');
    sick.gone = true;
    then.forward(0.5);
    await build(a, placed, swap.id, then.app);
    sick.gone = false;
    const txId = (await mock.send({ messageHash: one.attempt.messageHash })).txId;
    const done = await report(a, placed, swap.id, { txId }, then.app);
    // The step settled on its first attempt, and the quote it holds is its second build's.
    expect(attemptsOf(done, swap.id)).toEqual([
      [1, 'confirmed'],
      [2, 'expired'],
    ]);
    const leg = legOf(done, swap.id);
    expect([leg.status, leg.attempt, leg.txId]).toEqual(['confirmed', 1, txId]);
    expect(leg.expected[0]?.outRaw).not.toBe(firstQuote?.outRaw);

    // A snapshot after the first build and long before the step settled, and one after it settled.
    await snap(a, vault, plus(built, 10), { spy: { weightBps: 4700, targetBps: 5000 } });
    const late = await snap(a, vault, plus(await settledAt(placed), 10), { spy: 5000 });
    const mine = of(await listed(a, '', then.app), placed);
    expect(mine.map((e) => [e.outcome, e.txId, e.at])).toEqual([
      ['confirmed', txId, built.toISOString()],
    ]);
    // No quote: the one kept is another build's. And the step settled when its row says, not when
    // this attempt was built.
    expect(trade(mine[0])).not.toHaveProperty('expected');
    expect(trade(mine[0]).after).toEqual(driftIn(late, 'solana:spy'));
  });

  it('reads a quote stored as one figure, as a row written before a step held one a trade', async () => {
    for (const chain of ['solana', 'robinhood'] as const) {
      const a = await someone(chain);
      await fund(a);
      const done = await settleAll(a, await order(a, { amountUsd: 100 }));
      const leg = done.legs.filter((l) => l.trades.length > 0).at(-1);
      const figure = leg?.expected[0];
      if (!leg || !figure) throw new Error('no step that trades');
      await data.db
        .update(legs)
        .set({ expected: figure as never })
        .where(eq(legs.id, leg.id));
      const [entry] = await listed(a);
      expect(entry?.txId).toBe(leg.txId);
      // One figure is the figure of a step with one trade, and of no trade of a step with three.
      expect(entry?.trades.map((t) => t.expected)).toEqual(
        chain === 'solana' ? [figure] : [undefined, undefined, undefined],
      );
    }
  });

  it('says why a step was made and which asset its trade is about, as the step’s row has them', async () => {
    const a = await someone();
    await fund(a);
    const done = await settleAll(a, await order(a, { amountUsd: 100 }));
    const leg = done.legs.filter((l) => l.trades.length > 0).at(-1);
    if (!leg) throw new Error('no step that trades');
    // As a step of a rebalance order will be stored: an asset sold for cash, because of drift.
    const sale = { sell: 'solana:gold', buy: 'solana:usdc', amountInRaw: '5' };
    await data.db
      .update(legs)
      .set({ trigger: 'drift', trades: [sale] })
      .where(eq(legs.id, leg.id));
    const [entry, ...others] = await listed(a);
    expect(entry).toMatchObject({ txId: leg.txId, kind: 'swap', why: 'drift' });
    // The asset is the side that is not the chain's cash, whichever side that is.
    expect(trade(entry)).toMatchObject({ ...sale, asset: 'solana:gold' });
    expect(others.map((e) => [e.why, trade(e).sell, trade(e).asset])).toEqual([
      ['manual', 'solana:usdc', 'solana:nvda'],
      ['manual', 'solana:usdc', 'solana:spy'],
    ]);
  });
});

describe('the price and the drift beside a trade, from the snapshots nearest the step', () => {
  it('reads the reference and the drift before from the newest snapshot at or before the build, and the drift after from the oldest at or after the step settled', async () => {
    const then = await clocked(hoursAgo(3));
    const a = await someone();
    await fund(a, then.app);
    // The first buy opens the vault, an hour before the second and before any snapshot of it.
    const opened = await settleAll(a, await order(a, { amountUsd: 100 }, then.app), then.app);
    const vault = await vaultOf(a);
    const built = then.forward(60);
    const added = await settleAll(a, await order(a, { amountUsd: 50 }, then.app), then.app);
    const settled = await settledAt(added);
    // The step settled by the server's own clock, long after the test's clock built it.
    expect(settled.getTime() - built.getTime()).toBeGreaterThan(90 * MINUTE);

    await snap(a, vault, plus(built, -20), { spy: { weightBps: 4000, targetBps: 5000 } });
    // The newest at or before the build: spy off its target, nvda with no price, gold not held.
    const before = await snap(a, vault, built, {
      spy: { weightBps: 4500, targetBps: 5000 },
      nvda: { weightBps: 3000, priced: false },
    });
    // After the build and before the step settled: neither side reads it.
    await snap(a, vault, plus(built, 30), { spy: { weightBps: 4700, targetBps: 5000 } });
    // The same wallet's vault read under another label, nearer the step on both sides: not ours.
    for (const at of [plus(built, -1), plus(settled, 1)])
      await snap(
        a,
        vault,
        at,
        { spy: { weightBps: 1000, targetBps: 5000 } },
        { provenance: 'sandbox' },
      );

    const assets = (entries: Entry[]) => entries.map((e) => trade(e).asset);
    let mine = await listed(a, '', then.app);
    expect([assets(of(mine, added)), assets(of(mine, opened))]).toEqual([
      ['solana:gold', 'solana:nvda', 'solana:spy'],
      ['solana:gold', 'solana:nvda', 'solana:spy'],
    ]);
    const [gold, nvda, spy] = of(mine, added).map(trade);
    // The price is the snapshot's own, with its source, time and method.
    expect(spy?.reference).toEqual(priceOf(before, 'solana:spy'));
    expect(spy?.reference).toMatchObject({
      usdPerToken: '100',
      source: 'chain-mock',
      method: 'the mock shelf price, as a test wrote it',
      fetchedAt: built.toISOString(),
      provenance: 'mock',
    });
    expect(spy?.before).toEqual({
      observedAt: built.toISOString(),
      weightBps: 4500,
      targetBps: 5000,
      driftBps: -500,
    });
    // A position with no price weighs nothing there, and has no reference.
    expect(nvda?.before).toEqual({
      observedAt: built.toISOString(),
      weightBps: 0,
      targetBps: 3000,
      driftBps: -3000,
    });
    expect(nvda).not.toHaveProperty('reference');
    // An asset that snapshot does not list has neither, though an older snapshot lists it.
    expect(gold).not.toHaveProperty('reference');
    expect(gold).not.toHaveProperty('before');
    // The first buy was built before every snapshot.
    for (const t of of(mine, opened).map(trade)) {
      expect(t).not.toHaveProperty('reference');
      expect(t).not.toHaveProperty('before');
    }
    // No snapshot follows any step yet.
    for (const t of mine.map(trade)) expect(t).not.toHaveProperty('after');

    const after = await snap(a, vault, plus(settled, 10), {
      spy: 5000,
      nvda: 3000,
      gold: { weightBps: 1900, targetBps: 2000 },
    });
    await snap(a, vault, plus(settled, 20));
    mine = await listed(a, '', then.app);
    expect(of(mine, added).map((e) => trade(e).after)).toEqual([
      {
        observedAt: after.observedAt.toISOString(),
        weightBps: 1900,
        targetBps: 2000,
        driftBps: -100,
      },
      { observedAt: after.observedAt.toISOString(), weightBps: 3000, targetBps: 3000, driftBps: 0 },
      { observedAt: after.observedAt.toISOString(), weightBps: 5000, targetBps: 5000, driftBps: 0 },
    ]);
    // What was read before the step is as it was.
    expect(trade(of(mine, added)[2]).before).toEqual(driftIn(before, 'solana:spy'));
    // The first buy settled a moment before the second: the same snapshot follows it.
    expect(of(mine, opened).map((e) => trade(e).after)).toEqual(
      ['solana:gold', 'solana:nvda', 'solana:spy'].map((asset) => driftIn(after, asset)),
    );

    // A vault the cache no longer names as this wallet's under this chain's label is not known:
    // the steps are listed with no vault, and nothing is read from the snapshots for them.
    await data.db.update(vaults).set({ provenance: 'sandbox' }).where(eq(vaults.owner, a.solana));
    mine = await listed(a, '', then.app);
    expect(mine).toHaveLength(6);
    for (const entry of mine) {
      expect(entry.vault).toBeNull();
      for (const key of ['reference', 'before', 'after'])
        expect(trade(entry)).not.toHaveProperty(key);
    }
    // Asked for by its address, the vault has no step of the owner's to show.
    expect(await listed(a, `?address=${vault}`, then.app)).toEqual([]);
  });
});

describe('the vault of a step', () => {
  it('works out the number of a buy that was stored without it', async () => {
    const a = await someone();
    await fund(a);
    const placed = await settleAll(a, await order(a, { amountUsd: 100 }));
    const vault = await vaultOf(a);
    // As an order made before `orders.basket_id` was kept.
    await data.db.update(orders).set({ basketId: null }).where(eq(orders.id, placed.id));
    const mine = await listed(a);
    expect(mine.map((e) => e.vault)).toEqual([vault, vault, vault]);
    expect(await listed(a, `?address=${vault}`)).toEqual(mine);
  });

  it('names no vault for an order of a kind that names no single vault', async () => {
    const a = await someone();
    await fund(a);
    const placed = await settleAll(a, await order(a, { amountUsd: 100 }));
    const vault = await vaultOf(a);
    // As a rebalance order will be stored once one is made (it answers 501 today): it names the
    // vaults it is for as a list, and none of its steps says which of them it trades in.
    await data.db
      .update(orders)
      .set({ type: 'rebalance', request: { type: 'rebalance', vaults: [vault], reason: 'drift' } })
      .where(eq(orders.id, placed.id));
    const mine = await listed(a);
    expect(mine.map((e) => [e.orderId, e.kind, e.vault])).toEqual(
      Array.from({ length: 3 }, () => [placed.id, 'swap', null]),
    );
    expect(await listed(a, `?address=${vault}`)).toEqual([]);
  });

  it('names no vault where the cache holds two of that wallet with the number', async () => {
    const a = await someone();
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const vault = await vaultOf(a);
    expect((await listed(a)).map((e) => e.vault)).toEqual([vault, vault, vault]);
    // As a test network deployed again leaves it: the same wallet and number at another address.
    const other = await seedVault(data.db, {
      chain: 'solana',
      owner: a.solana,
      onchainBasketId: basketIdOf(plans.solana),
    });
    expect((await listed(a)).map((e) => e.vault)).toEqual([null, null, null]);
    for (const address of [vault, other])
      expect(await listed(a, `?address=${address}`)).toEqual([]);
  });

  it('is the vault of the wallet that bought, where two wallets of one person hold vaults of one number', async () => {
    // One person signed in with two Solana wallets buys the same stored plan with each: two vaults
    // of one number, each under the wallet that opened it.
    const base = await person(issuer, 'solana');
    const other = mockAddress('solana', `api-test:${randomUUID()}`);
    const headers = await signIn(issuer, base.sub, [
      { family: 'solana', address: base.solana, client: 'phantom' },
      { family: 'solana', address: other, client: 'phantom' },
    ]);
    const one = data.track({ ...base, headers });
    const two = data.track({ ...base, headers, solana: other, owner: { solana: other } });
    await fund(one);
    const [first, second] = [
      await settleAll(one, await order(one, { amountUsd: 100 })),
      await settleAll(two, await order(two, { amountUsd: 100 })),
    ];
    const [hers, alsoHers] = [await vaultOf(one), await vaultOf(two)];
    expect(hers).not.toBe(alsoHers);

    // Both wallets are hers: one list, each step with the vault of the wallet that signed it.
    const mine = await listed(one);
    expect(mine.map((e) => [e.orderId, e.vault])).toEqual([
      ...Array.from({ length: 3 }, () => [second.id, alsoHers]),
      ...Array.from({ length: 3 }, () => [first.id, hers]),
    ]);
    expect((await listed(one, `?address=${alsoHers}`)).map((e) => e.orderId)).toEqual(
      Array.from({ length: 3 }, () => second.id),
    );
  });
});

describe('a version adopted, and a publish', () => {
  /** A name and a slug nobody else has: a name folds to letters, so the run's id is spelled in them. */
  function fresh() {
    const id = randomUUID().replaceAll('-', '');
    const letters = id.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a').slice(0, 12);
    const slug = `t-${id.slice(0, 16)}`;
    data.trackFamily(familyIdOf(slug));
    return { slug, name: `Test ${letters}`, copy: 'Three test tokens.' };
  }

  it('lists the step of a follow order that adopts a version, with no trade, and nothing of a publish', async () => {
    const creator = await someone();
    const text = fresh();
    await fund(creator);
    const publishing = await post(creator, '/v1/orders', {
      type: 'publish',
      creator: { solana: creator.solana },
      family: text.slug,
      name: text.name,
      copy: text.copy,
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
    expect(publishing.statusCode, publishing.body).toBe(200);
    const published = await settleAll(creator, OrderDetail.parse(publishing.json()));
    expect([published.type, published.status]).toEqual(['publish', 'done']);

    const follower = await someone();
    await fund(follower);
    const bought = await settleAll(follower, await order(follower, { amountUsd: 100 }));
    const vault = await vaultOf(follower);
    const following = await post(follower, '/v1/orders', {
      type: 'follow',
      vault,
      family: text.slug,
      autoFollow: true,
    });
    expect(following.statusCode, following.body).toBe(200);
    const placed = OrderDetail.parse(following.json());
    expect(placed.legs.map((l) => [l.kind, l.trades.length])).toEqual([
      ['accept_version', 0],
      ['set_auto_follow', 0],
    ]);
    const done = await settleAll(follower, placed);
    const accept = first(done, 0);
    const [attempt] = (await stored(done)).filter((x) => x.legId === accept.id);

    // The step that adopts the version is listed, newest; the switch of auto-follow is not.
    const mine = await listed(follower);
    expect(mine.map((e) => [e.kind, e.orderId])).toEqual([
      ['accept_version', placed.id],
      ['swap', bought.id],
      ['swap', bought.id],
      ['swap', bought.id],
    ]);
    expect(mine[0]).toEqual({
      chain: 'solana',
      vault,
      at: attempt?.builtAt.toISOString(),
      by: 'owner',
      derived: false,
      kind: 'accept_version',
      why: 'manual',
      outcome: 'confirmed',
      trades: [],
      orderId: placed.id,
      txId: accept.txId,
      explorerUrl: `mock://solana/tx/${accept.txId}`,
      source: 'chain-mock',
      method: 'mock state transition',
      fetchedAt: attempt?.fetchedAt.toISOString(),
      provenance: 'mock',
    });
    // By the vault's address the follow's step is found with the buy's, since the order names it.
    expect((await listed(follower, `?address=${vault}`)).map((e) => e.kind)).toEqual([
      'accept_version',
      'swap',
      'swap',
      'swap',
    ]);
    // A vault the order names that the cache does not hold as theirs is no vault of the entry.
    await data.db
      .update(vaults)
      .set({ provenance: 'sandbox' })
      .where(eq(vaults.owner, follower.solana));
    expect((await listed(follower)).map((e) => [e.kind, e.vault])).toEqual([
      ['accept_version', null],
      ['swap', null],
      ['swap', null],
      ['swap', null],
    ]);

    // The creator's publish reached the chain and is no rebalance: nothing of it is listed, also
    // were its step to carry a trade.
    expect(await listed(creator)).toEqual([]);
    await data.db
      .update(legs)
      .set({ trades: [{ sell: 'solana:usdc', buy: 'solana:spy', amountInRaw: '1' }] })
      .where(eq(legs.orderId, published.id));
    expect(await listed(creator)).toEqual([]);
  });
});

describe('the keeper’s trades, worked out from the snapshots', () => {
  /** A person with a vault the cache names and no order: only snapshots speak of it. */
  async function withVault() {
    const who = await someone();
    const vault = await seedVault(data.db, { chain: 'solana', owner: who.solana });
    return { who, vault };
  }
  const now = () => new Date(Math.floor(Date.now() / 1000) * 1000);

  it('lists one entry for the asset whose last keeper time changed between two snapshots, with what the vault held in each', async () => {
    const { who, vault } = await withVault();
    const at = now();
    const [long, traded] = [seconds(plus(at, -600)), seconds(plus(at, -15))];
    // Three reads ten minutes apart. The keeper last traded spy and nvda ten hours ago, and never
    // traded gold. Between the second read and the third it bought spy.
    const parts = (spy: PartSeed): SnapshotSeed['parts'] => ({
      spy,
      nvda: { weightBps: 3000, lastKeeperAt: long },
      gold: 2000,
    });
    const under: PartSeed = { weightBps: 4800, targetBps: 5000, lastKeeperAt: long };
    await snap(who, vault, plus(at, -30), parts(under));
    const earlier = await snap(who, vault, plus(at, -20), parts(under), {
      source: 'the earlier read',
    });
    const later = await snap(
      who,
      vault,
      plus(at, -10),
      parts({ weightBps: 5000, targetBps: 5000, lastKeeperAt: traded }),
      { source: 'the later read' },
    );

    const mine = await listed(who);
    expect(mine).toEqual([
      {
        chain: 'solana',
        vault,
        // The chain's time of the trade, not the time of either read.
        at: new Date(traded * 1000).toISOString(),
        by: 'keeper',
        derived: true,
        kind: 'keeper_leg',
        why: null,
        outcome: 'confirmed',
        trades: [
          {
            // More of the asset: cash sold, the asset bought.
            sell: 'solana:usdc',
            buy: 'solana:spy',
            asset: 'solana:spy',
            rawBefore: '480000000',
            rawAfter: '500000000',
            reference: priceOf(earlier, 'solana:spy'),
            before: {
              observedAt: plus(at, -20).toISOString(),
              weightBps: 4800,
              targetBps: 5000,
              driftBps: -200,
            },
            after: {
              observedAt: plus(at, -10).toISOString(),
              weightBps: 5000,
              targetBps: 5000,
              driftBps: 0,
            },
          },
        ],
        orderId: null,
        txId: null,
        explorerUrl: null,
        source: 'the later read',
        method: KEEPER_METHOD,
        fetchedAt: plus(at, -10).toISOString(),
        provenance: 'mock',
      },
    ]);
    expect([positionOf(earlier, 'solana:spy').raw, positionOf(later, 'solana:spy').raw]).toEqual([
      '480000000',
      '500000000',
    ]);
    // The sentence says how the entry was made, and that no record of the trade stands behind it.
    const method = mine[0]?.method ?? '';
    expect(method).toMatch(/worked out from two snapshots of the vault/);
    expect(method).toMatch(/last keeper time on the asset changed/);
    expect(method).toMatch(/not read from a record of the trade/);
    expect(method).toMatch(/no transaction id, no quote and no reason/);
    expect(method).not.toMatch(/[—!]/);
  });

  it('says which way the amount went: less of the asset is a sale, and as much is listed as a purchase', async () => {
    const { who, vault } = await withVault();
    const at = now();
    const keeperAt = (minutes: number) => seconds(plus(at, minutes));
    const long = keeperAt(-600);
    const [sold, kept, bought] = [keeperAt(-18), keeperAt(-15), keeperAt(-12)];
    const earlier = await snap(who, vault, plus(at, -20), {
      spy: { weightBps: 5200, targetBps: 5000, lastKeeperAt: long },
      nvda: { weightBps: 3000, lastKeeperAt: long },
      gold: { weightBps: 1500, targetBps: 1800, lastKeeperAt: long },
    });
    const later = await snap(who, vault, plus(at, -10), {
      spy: { weightBps: 5000, targetBps: 5000, lastKeeperAt: sold },
      nvda: { weightBps: 3000, lastKeeperAt: kept },
      gold: { weightBps: 1800, targetBps: 1800, lastKeeperAt: bought },
    });
    const raw = (row: Row, slug: string) => positionOf(row, `solana:${slug}`).raw;
    expect(BigInt(raw(later, 'spy'))).toBeLessThan(BigInt(raw(earlier, 'spy')));
    expect(raw(later, 'nvda')).toBe(raw(earlier, 'nvda'));

    const mine = await listed(who);
    // Newest first by the chain's time of each trade.
    expect(mine.map((e) => [e.at, trade(e).sell, trade(e).buy, trade(e).asset])).toEqual([
      [new Date(bought * 1000).toISOString(), 'solana:usdc', 'solana:gold', 'solana:gold'],
      [new Date(kept * 1000).toISOString(), 'solana:usdc', 'solana:nvda', 'solana:nvda'],
      [new Date(sold * 1000).toISOString(), 'solana:spy', 'solana:usdc', 'solana:spy'],
    ]);
    expect(mine.map((e) => [trade(e).rawBefore, trade(e).rawAfter])).toEqual(
      ['gold', 'nvda', 'spy'].map((slug) => [raw(earlier, slug), raw(later, slug)]),
    );
    expect(trade(mine[2]).before).toEqual(driftIn(earlier, 'solana:spy'));
    expect(trade(mine[2]).after).toEqual(driftIn(later, 'solana:spy'));
    // Cut to fewer than there are, the newest stay.
    for (const limit of [1, 2])
      expect((await listed(who, `?limit=${limit}`)).map((e) => trade(e).asset)).toEqual(
        ['solana:gold', 'solana:nvda'].slice(0, limit),
      );
  });

  it('lists nothing where the keeper time did not change, went back, went away or is not there', async () => {
    const { who, vault } = await withVault();
    const at = now();
    const [older, old] = [seconds(plus(at, -900)), seconds(plus(at, -600))];
    await snap(who, vault, plus(at, -20), {
      spy: { weightBps: 4000, lastKeeperAt: old },
      nvda: { weightBps: 2000, lastKeeperAt: old },
      tsla: { weightBps: 1000, lastKeeperAt: old },
      gold: 2000,
    });
    // Every amount changes, as a deposit of the owner's changes them: an amount is not the sign.
    await snap(who, vault, plus(at, -10), {
      // The same time: no trade of the keeper's.
      spy: { weightBps: 4400, lastKeeperAt: old },
      // An earlier time than before: not a later trade.
      nvda: { weightBps: 2200, lastKeeperAt: older },
      // No time any more.
      tsla: { weightBps: 1100, lastKeeperAt: null },
      // Never one.
      gold: 2200,
    });
    expect(await listed(who)).toEqual([]);
  });

  it('counts a first keeper time only when it is later than the snapshot before it', async () => {
    const { who, vault } = await withVault();
    const at = now();
    const [stale, fresh] = [seconds(plus(at, -600)), seconds(plus(at, -15))];
    // The earlier read: spy and nvda with no keeper time, tsla and gold not held at all.
    const earlier = await snap(who, vault, plus(at, -20), { spy: 4000, nvda: 3000 });
    const later = await snap(who, vault, plus(at, -10), {
      // A first time after the earlier read: the keeper traded it since.
      spy: { weightBps: 4200, lastKeeperAt: fresh },
      // A first time from before the earlier read: a time that came back, with no trade behind it.
      nvda: { weightBps: 3000, lastKeeperAt: stale },
      // Not held before, and traded since: the keeper bought an asset new to the vault.
      tsla: { weightBps: 1000, lastKeeperAt: fresh },
      // Not held before, with an old time: no trade either.
      gold: { weightBps: 500, lastKeeperAt: stale },
    });

    const mine = await listed(who);
    expect(mine.map((e) => trade(e).asset)).toEqual(['solana:spy', 'solana:tsla']);
    expect(mine.every((e) => e.at === new Date(fresh * 1000).toISOString())).toBe(true);
    expect(trade(mine[0])).toEqual({
      sell: 'solana:usdc',
      buy: 'solana:spy',
      asset: 'solana:spy',
      rawBefore: positionOf(earlier, 'solana:spy').raw,
      rawAfter: positionOf(later, 'solana:spy').raw,
      reference: priceOf(earlier, 'solana:spy'),
      before: driftIn(earlier, 'solana:spy'),
      after: driftIn(later, 'solana:spy'),
    });
    // The earlier snapshot does not list the asset: the vault held none, and it has no drift and
    // no price there.
    expect(trade(mine[1])).toEqual({
      sell: 'solana:usdc',
      buy: 'solana:tsla',
      asset: 'solana:tsla',
      rawBefore: '0',
      rawAfter: positionOf(later, 'solana:tsla').raw,
      after: driftIn(later, 'solana:tsla'),
    });
  });

  it('looks only among the snapshots of the last thirty days: both snapshots of a pair are in them', async () => {
    expect(KEEPER_LOOKBACK_DAYS).toBe(30);
    const { who, vault } = await withVault();
    const at = now();
    const ago = (days: number, minutes = 0) =>
      new Date(at.getTime() - days * DAY - minutes * MINUTE);
    const read = (observedAt: Date, keeperAt: Date) =>
      snap(who, vault, observedAt, { spy: { weightBps: 5000, lastKeeperAt: seconds(keeperAt) } });
    await read(ago(31), ago(32));
    // Both older than thirty days.
    await read(ago(30, 60), ago(30, 90));
    // The later one inside the thirty days and the earlier one not: it has nothing to be held to.
    await read(ago(29, 23 * 60), ago(30, 30));
    // Inside, with no change.
    await read(ago(29), ago(30, 30));
    // Inside, with a change.
    const traded = ago(28, 30);
    await read(ago(28), traded);

    const mine = await listed(who);
    expect(mine.map((e) => e.at)).toEqual([traded.toISOString()]);
    expect(trade(mine[0]).before?.observedAt).toBe(ago(29).toISOString());

    // The thirty days count back from the server's clock, as a route's time always does: a server
    // whose clock stands ten days ago looks forty days back from today, and finds all three.
    const past = await clocked(ago(10));
    expect((await listed(who, '', past.app)).map((e) => e.at)).toEqual(
      [traded, ago(30, 30), ago(30, 90)].map((time) => time.toISOString()),
    );
  });

  it('finds the trades in a vault the worker alone found, which the cache does not name', async () => {
    const who = await someone();
    // No row in the cache: the vault is known by its snapshots of the last week.
    const vault = vaultAddress('solana');
    const at = now();
    const [old, traded] = [seconds(plus(at, -600)), seconds(plus(at, -15))];
    await snap(who, vault, plus(at, -20), { spy: { weightBps: 5000, lastKeeperAt: old } });
    await snap(who, vault, plus(at, -10), { spy: { weightBps: 5000, lastKeeperAt: traded } });
    for (const query of ['', `?address=${vault}`])
      expect((await listed(who, query)).map((e) => [e.by, e.vault, trade(e).asset])).toEqual([
        ['keeper', vault, 'solana:spy'],
      ]);
  });

  it('reads a pair on the chain’s own rows: the same address read at the same moments on another chain is another vault', async () => {
    const who = await someone('robinhood');
    const vault = await seedVault(data.db, { chain: 'robinhood', owner: who.evm });
    const at = now();
    const [old, traded] = [seconds(plus(at, -600)), seconds(plus(at, -15))];
    const reads = [
      { minutes: -20, lastKeeperAt: old, weightBps: 4800 },
      { minutes: -10, lastKeeperAt: traded, weightBps: 5000 },
    ];
    for (const { minutes, lastKeeperAt, weightBps } of reads) {
      await snap(who, vault, plus(at, minutes), {
        spy: { weightBps, targetBps: 5000, lastKeeperAt },
      });
      // An EVM address is the same on every EVM chain. The same wallet's vault at that address on
      // Base, which this server does not run, read at the very same moment.
      await seedSnapshot(data.db, {
        chain: 'base',
        address: vault,
        owner: who.evm,
        observedAt: plus(at, minutes),
        parts: { nvda: { weightBps: 3000, lastKeeperAt } },
      });
    }
    const mine = await listed(who);
    expect(mine.map((e) => [e.chain, e.vault, trade(e).asset, trade(e).before?.weightBps])).toEqual(
      [['robinhood', vault, 'robinhood:spy', 4800]],
    );
    expect(JSON.stringify(await rebalances(who))).not.toContain('base:');
  });

  it('answers fifty entries a chain unless more are asked for', async () => {
    const { who, vault } = await withVault();
    const at = now();
    // Twelve reads ten minutes apart, and between each two the keeper traded all five assets.
    const slugs = ['spy', 'nvda', 'tsla', 'gold', 'yield'];
    for (let read = 12; read >= 1; read -= 1) {
      const observedAt = plus(at, -10 * read);
      const lastKeeperAt = seconds(plus(observedAt, -1));
      await snap(
        who,
        vault,
        observedAt,
        Object.fromEntries(slugs.map((slug) => [slug, { weightBps: 1000, lastKeeperAt }])),
      );
    }
    const all = await listed(who, '?limit=200');
    expect(all).toHaveLength(55);
    const mine = await listed(who);
    expect(mine).toHaveLength(50);
    expect(mine).toEqual(all.slice(0, 50));
  });

  it('never works a trade out of rows read under another label, or of another person’s vault', async () => {
    const { who, vault } = await withVault();
    const at = now();
    const [old, traded] = [seconds(plus(at, -600)), seconds(plus(at, -15))];
    // The same wallet's vault, read from a test network: the same address under another label.
    for (const [minutes, lastKeeperAt] of [
      [-20, old],
      [-10, traded],
    ] as const)
      await snap(
        who,
        vault,
        plus(at, minutes),
        { spy: { weightBps: 5000, lastKeeperAt } },
        { provenance: 'sandbox' },
      );
    expect(await listed(who)).toEqual([]);

    // Under the chain's own label the same two reads are a trade, for the vault's owner and nobody else.
    await snap(who, vault, plus(at, -21), { spy: { weightBps: 5000, lastKeeperAt: old } });
    await snap(who, vault, plus(at, -11), { spy: { weightBps: 5000, lastKeeperAt: traded } });
    expect((await listed(who)).map((e) => [e.by, e.vault, e.provenance])).toEqual([
      ['keeper', vault, 'mock'],
    ]);
    const stranger = await someone();
    for (const query of ['', `?address=${vault}`, '?chain=solana', '?limit=200'])
      expect(await listed(stranger, query)).toEqual([]);
  });
});

describe('the whole list: newest first, cut, and narrowed', () => {
  it('puts the owner’s steps and the keeper’s trades in one list, newest first, and cuts it to the limit', async () => {
    const then = await clocked(hoursAgo(5));
    const start = then.now();
    const a = await someone();
    await fund(a, then.app);
    const opened = await settleAll(a, await order(a, { amountUsd: 100 }, then.app), then.app);
    const vault = await vaultOf(a);
    // An hour later the owner adds money. Between the two the keeper trades gold, and it traded
    // nvda at the very second the first buy's steps were built.
    const again = then.forward(60);
    const added = await settleAll(a, await order(a, { amountUsd: 50 }, then.app), then.app);
    const [long, same, between] = [plus(start, -600), start, plus(start, 30)].map(seconds);
    await snap(a, vault, plus(start, -5), {
      spy: 5000,
      nvda: { weightBps: 3000, lastKeeperAt: long },
      gold: { weightBps: 1900, targetBps: 2000, lastKeeperAt: long },
    });
    await snap(a, vault, plus(start, 5), {
      spy: 5000,
      nvda: { weightBps: 3000, lastKeeperAt: same },
      gold: { weightBps: 1900, targetBps: 2000, lastKeeperAt: long },
    });
    await snap(a, vault, plus(start, 35), {
      spy: 5000,
      nvda: { weightBps: 3000, lastKeeperAt: same },
      gold: { weightBps: 2000, targetBps: 2000, lastKeeperAt: between },
    });

    const whole = [
      ['owner', again.toISOString(), added.id, 'solana:gold'],
      ['owner', again.toISOString(), added.id, 'solana:nvda'],
      ['owner', again.toISOString(), added.id, 'solana:spy'],
      ['keeper', plus(start, 30).toISOString(), null, 'solana:gold'],
      // At one time, an owner's step is ahead of a keeper's trade.
      ['owner', start.toISOString(), opened.id, 'solana:gold'],
      ['owner', start.toISOString(), opened.id, 'solana:nvda'],
      ['owner', start.toISOString(), opened.id, 'solana:spy'],
      ['keeper', start.toISOString(), null, 'solana:nvda'],
    ];
    const shape = (entries: Entry[]) => entries.map((e) => [e.by, e.at, e.orderId, trade(e).asset]);
    const mine = await listed(a, '', then.app);
    expect(shape(mine)).toEqual(whole);
    expect(mine.every((e) => e.vault === vault)).toBe(true);
    const times = mine.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((x, y) => y - x));

    // The limit cuts the list from its newest end, whatever kinds lie on either side of the cut.
    for (const limit of [1, 3, 4, 5, 7, 8, 200])
      expect(shape(await listed(a, `?limit=${limit}`, then.app))).toEqual(whole.slice(0, limit));
    // Fifty unless asked: here that is all of it.
    expect(mine).toHaveLength(8);
    // Outside its bounds a limit is refused, not cut to the nearest.
    for (const limit of ['0', '201', '-1', '2.5', 'ten', '']) {
      const res = await get(a, `/v1/portfolio/rebalances?limit=${limit}`, then.app);
      expect([limit, res.statusCode]).toEqual([limit, 400]);
    }
  });

  it('narrows to one vault by its address, and to nothing by an address that is not a vault of theirs', async () => {
    const a = await someone();
    await fund(a);
    const one = await settleAll(a, await order(a, { amountUsd: 100 }));
    const first = await vaultOf(a);
    // A second plan of the person's: a second vault, of another number.
    const other = await data.storePlan(planFixture('solana', { spy: 6000, gold: 4000 }));
    const two = await settleAll(a, await order(a, { amountUsd: 100, proposalId: other }));
    const cached = await data.db
      .select({ address: vaults.address })
      .from(vaults)
      .where(eq(vaults.owner, a.solana));
    const second = cached.map((v) => v.address).find((address) => address !== first);
    if (cached.length !== 2 || !second) throw new Error('two vaults were expected');
    // The keeper traded in each.
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const [old, traded] = [seconds(plus(at, -600)), seconds(plus(at, -15))];
    for (const vault of [first, second]) {
      await snap(a, vault, plus(at, -20), { spy: { weightBps: 5000, lastKeeperAt: old } });
      await snap(a, vault, plus(at, -10), { spy: { weightBps: 5000, lastKeeperAt: traded } });
    }

    const all = await listed(a);
    expect(all).toHaveLength(7);
    const shape = (entries: Entry[]) => entries.map((e) => [e.by, e.orderId, e.vault]);
    // The steps were built a moment ago, and the keeper's trades are a quarter of an hour old.
    expect(shape(await listed(a, `?address=${first}`))).toEqual([
      ['owner', one.id, first],
      ['owner', one.id, first],
      ['owner', one.id, first],
      ['keeper', null, first],
    ]);
    expect(shape(await listed(a, `?address=${second}`))).toEqual([
      ['owner', two.id, second],
      ['owner', two.id, second],
      ['keeper', null, second],
    ]);
    // An address nobody has, and the vault of another person: nothing, and no error that tells one
    // from the other.
    const b = await someone();
    await fund(b);
    await settleAll(b, await order(b, { amountUsd: 100 }));
    const theirs = await vaultOf(b);
    for (const address of [vaultAddress('solana'), theirs, 'not-an-address']) {
      const answer = await rebalances(a, `?address=${address}`);
      expect(answer.chains).toEqual([
        { chain: 'solana', name: 'Solana', provenance: 'mock', entries: [] },
      ]);
    }
  });

  it('reads an address in the chain’s own form: an EVM address in any case, and nothing for text that is no address there', async () => {
    const a = await someone('robinhood');
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 100 }));
    const vault = await vaultOf(a);
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    await snap(a, vault, plus(at, -20), {
      spy: { weightBps: 5000, lastKeeperAt: seconds(plus(at, -600)) },
    });
    await snap(a, vault, plus(at, -10), {
      spy: { weightBps: 5000, lastKeeperAt: seconds(plus(at, -15)) },
    });
    const both = [
      ['owner', vault],
      ['keeper', vault],
    ];
    const shape = (entries: Entry[]) => entries.map((e) => [e.by, e.vault]);
    expect(shape(await listed(a))).toEqual(both);
    // As a wallet shows it, in upper case: the same vault, and both kinds of entry are found.
    const upper = `0x${vault.slice(2).toUpperCase()}`;
    expect(upper).not.toBe(vault);
    expect(shape(await listed(a, `?address=${upper}`))).toEqual(both);
    // A Solana address, and text that is no address at all, name no vault on an EVM chain.
    for (const address of [vaultAddress('solana'), 'not-an-address', `${vault}00`])
      expect(await listed(a, `?address=${address}`)).toEqual([]);
  });

  it('answers each chain of the person with its own steps, and one chain when one is named', async () => {
    // Wallets of both families: every order names both, and a step is on one chain.
    const both = await someone('passkey');
    const [sol, rh] = [
      { ...both, chain: 'solana' as const },
      { ...both, chain: 'robinhood' as const },
    ];
    for (const who of [sol, rh]) await fund(who);
    const onSolana = await settleAll(sol, await order(sol, { amountUsd: 100 }));
    const onRobinhood = await settleAll(rh, await order(rh, { amountUsd: 100 }));
    expect([onSolana.owner, onRobinhood.owner]).toEqual([both.owner, both.owner]);

    const shape = (answer: Answer) =>
      answer.chains.map((c) => [c.chain, c.provenance, c.entries.map((e) => [e.orderId, e.kind])]);
    const solana = ['solana', 'mock', Array.from({ length: 3 }, () => [onSolana.id, 'swap'])];
    const robinhood = ['robinhood', 'mock', [[onRobinhood.id, 'create_vault']]];
    expect(shape(await rebalances(both))).toEqual([solana, robinhood]);
    expect(shape(await rebalances(both, '?chain=solana'))).toEqual([solana]);
    expect(shape(await rebalances(both, '?chain=robinhood'))).toEqual([robinhood]);
    // A chain the person holds no wallet for narrows the answer to nothing.
    const onlySolana = await someone('solana');
    expect(await rebalances(onlySolana, '?chain=robinhood')).toEqual({
      chains: [],
      unavailable: [],
      disclaimer: DISCLAIMER.en,
    });
    expect((await get(both, '/v1/portfolio/rebalances?chain=nowhere')).statusCode).toBe(400);

    // A chain of the person's that is switched off is said, never answered as an empty list.
    const off = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      env: { CHAIN_MODE_ROBINHOOD: 'off' },
    });
    try {
      const unavailable = [
        {
          chain: 'robinhood',
          name: 'Robinhood Chain',
          code: 'CHAIN_UNAVAILABLE',
          error: 'Robinhood Chain is switched off on this server',
          retryable: false,
        },
      ];
      const answer = await rebalances(both, '', off.app);
      expect(shape(answer)).toEqual([solana]);
      expect(answer.unavailable).toEqual(unavailable);
      expect(await rebalances(both, '?chain=robinhood', off.app)).toEqual({
        chains: [],
        unavailable,
        disclaimer: DISCLAIMER.en,
      });
    } finally {
      await off.app.close();
    }
  });
});

describe('whose rows are answered', () => {
  it('refuses a call with no sign-in', async () => {
    const res = await get(null, '/v1/portfolio/rebalances');
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/entries/);
  });

  it('answers a second person nothing of the first one’s, by any query the route takes', async () => {
    const a = await someone();
    await fund(a);
    const placed = await settleAll(a, await order(a, { amountUsd: 100 }));
    const vault = await vaultOf(a);
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    await snap(a, vault, plus(at, -20), {
      spy: { weightBps: 5000, lastKeeperAt: seconds(plus(at, -600)) },
    });
    await snap(a, vault, plus(at, -10), {
      spy: { weightBps: 5000, lastKeeperAt: seconds(plus(at, -15)) },
    });
    const hers = await listed(a);
    expect(hers.map((e) => e.by)).toEqual(['owner', 'owner', 'owner', 'keeper']);

    const b = await someone();
    const secrets = [vault, placed.id, a.solana, ...hers.flatMap((e) => (e.txId ? [e.txId] : []))];
    for (const query of [
      '',
      `?address=${vault}`,
      '?chain=solana',
      '?limit=200',
      `?address=${vault}&chain=solana&limit=200`,
    ]) {
      const res = await get(b, `/v1/portfolio/rebalances${query}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(PortfolioRebalancesResponse.parse(res.json()).chains).toEqual([
        { chain: 'solana', name: 'Solana', provenance: 'mock', entries: [] },
      ]);
      for (const secret of secrets) expect(res.body).not.toContain(secret);
    }
    // And her own list is as it was.
    expect(await listed(a)).toEqual(hers);
  });

  it('answers no attempt stored under another label than the chain’s own here', async () => {
    const a = await someone();
    await fund(a);
    const placed = await settleAll(a, await order(a, { amountUsd: 100 }));
    const mine = await listed(a);
    expect(mine.map((e) => trade(e).asset)).toEqual(['solana:gold', 'solana:nvda', 'solana:spy']);
    // As the same wallet's step sent on a test network, kept in the same database.
    const nvda = placed.legs.find((l) => l.trades[0]?.buy === 'solana:nvda');
    if (!nvda) throw new Error('no such step');
    await data.db
      .update(legAttempts)
      .set({ provenance: 'sandbox' })
      .where(eq(legAttempts.legId, nvda.id));
    const after = await rebalances(a);
    expect(entriesOn(after).map((e) => trade(e).asset)).toEqual(['solana:gold', 'solana:spy']);
    expect(JSON.stringify(after)).not.toMatch(/"provenance":"(live|sandbox)"/);
  });
});
