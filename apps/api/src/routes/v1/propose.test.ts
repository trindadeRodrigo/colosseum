import { baskets, proposals, users } from '@colosseum/db';
import {
  type BasketSheet,
  OrderDetail,
  OrderError,
  PortfolioResponse,
  YieldObservation,
} from '@colosseum/schemas';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { basketIdOf, basketIdOfLinked } from '../../orders/prepare';
import { bearingPlanInputs } from '../../plan-inputs';
import mockYields from '../../testing/fixtures/mock-yields.json';
import { orderFlow } from '../../testing/flow';
import { person, type TestIssuer, testApp, testDb, testIssuer } from '../../testing/harness';
import { LinkedPlanResponse, PersonalizeResponse } from './baskets';

// POST /v1/baskets/propose and GET /v1/baskets/{id} (AGT-2): a plan an agent proposes for a person it
// cannot sign in as, made by the engine that makes the app's plans, stored with no person, read back by
// anybody holding its id, and bought by the person who opens it, on their own chain only.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('propose');
  data = await testDb();
  undo.push(() => data.cleanUp());
  const withMockYield: PlanInputs = async (q) => ({
    ...(await bearingPlanInputs(q)),
    yields: YieldObservation.array()
      .parse(mockYields)
      .filter((y) => q.assets.some((a) => a.id === y.assetId)),
  });
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    env: { AGENT_SURFACE: 'on' },
    planInputs: withMockYield,
  }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const fallback = { solana: '', robinhood: '' };
/**
 * The plans made from a link for this amount: a refused request leaves none. Other test files store
 * plans at the same time, so a count of the whole table proves nothing.
 */
const linkedFor = async (amountUsd: number) =>
  (
    await data.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.fromLink, true),
          sql`(${proposals.proposal}->'sheet'->>'amountUsd')::numeric = ${amountUsd}`,
        ),
      )
  ).length;
const withMockYieldOff: PlanInputs = async () => ({});
const { post, get, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => fallback,
});

const sheet = (over: Partial<BasketSheet> = {}): BasketSheet => ({
  basketType: 'standard',
  goal: 'protect',
  amountUsd: 5_000,
  horizonMonths: 18,
  risk: 'low',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
  ...over,
});

describe('a plan proposed from a link', () => {
  it('is made with no sign-in as the app makes it, stored with no person, and read back by its id', async () => {
    const res = await post(null, '/v1/baskets/propose', { sheet: sheet() });
    expect(res.statusCode, res.body).toBe(200);
    const { id, proposal } = PersonalizeResponse.parse(res.json());
    expect(proposal.sheet).toEqual(sheet());
    // the same engine: what the app's plan of this sheet holds on the mock (personalize.test.ts)
    expect(proposal.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['solana:yield', 4000],
      ['solana:gold', 1000],
      ['solana:usdc', 5000],
    ]);
    const [row] = await data.db
      .select({ userId: proposals.userId, fromLink: proposals.fromLink })
      .from(proposals)
      .where(eq(proposals.id, id));
    expect(row).toEqual({ userId: null, fromLink: true });

    const read = await get(null, `/v1/baskets/${id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(LinkedPlanResponse.parse(read.json())).toEqual({ id, proposal, fromLink: true });
  });

  it('is bought by the person who opens it, on their own chain, and by nobody on another', async () => {
    const { id } = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet() })).json(),
    );
    const mine = data.track(await person(issuer, 'solana'));
    await fund(mine, undefined, 6_000);
    const bought = await order(mine, { proposalId: id, amountUsd: 5_000 });
    expect(bought.legs.flatMap((l) => l.trades.map((t) => t.buy))).toEqual([
      'solana:yield',
      'solana:gold',
    ]);
    // a person whose plans live on Robinhood Chain is refused the Solana plan (gate ONE-CHAIN)
    const other = data.track(await person(issuer, 'robinhood'));
    const refused = await post(other, '/v1/orders', {
      type: 'buy',
      owner: other.owner,
      amountUsd: 5_000,
      proposalId: id,
    });
    expect(refused.statusCode).toBe(422);
  });

  it('never reads back a plan a person made in the app to anybody without their sign-in', async () => {
    const who = data.track(await person(issuer, 'solana'));
    const made = await post(who, '/v1/baskets/personalize', { sheet: sheet({ amountUsd: 7_000 }) });
    expect(made.statusCode, made.body).toBe(200);
    const { id } = PersonalizeResponse.parse(made.json());
    const read = await get(null, `/v1/baskets/${id}`);
    expect(read.statusCode).toBe(404);
    expect(OrderError.parse(read.json()).error).toBe('no plan with that id that you can read');
    // nor an id that names nothing, and a word that is no id is refused as one
    expect((await get(null, `/v1/baskets/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await get(null, '/v1/baskets/not-an-id')).statusCode).toBe(400);
  });

  it('names exactly one chain, and stores nothing it refuses', async () => {
    const two = await post(null, '/v1/baskets/propose', {
      sheet: sheet({ amountUsd: 9_872, chains: ['solana', 'robinhood'] }),
    });
    expect(two.statusCode).toBe(400);
    const bad = await post(null, '/v1/baskets/propose', {
      sheet: { ...sheet({ amountUsd: 9_872 }), horizonMonths: -1 },
    });
    expect(bad.statusCode).toBe(400);
    expect(await linkedFor(9_872)).toBe(0);
  });

  it('is not there while the agent surface is off', async () => {
    const off = await testApp({ issuer: issuer.issuer, db: data.db, planInputs: withMockYieldOff });
    try {
      const made = await post(null, '/v1/baskets/propose', { sheet: sheet() }, off.app);
      expect(made.statusCode).toBe(404);
      expect(OrderError.parse(made.json()).error).toMatch(/AGENT_SURFACE/);
      const read = await get(null, `/v1/baskets/${crypto.randomUUID()}`, off.app);
      expect(read.statusCode).toBe(404);
    } finally {
      await off.app.close();
    }
  });

  it('keeps the agent’s words out: a theme is a shared portfolio’s slug, of at most 64 characters', async () => {
    const long = await post(null, '/v1/baskets/propose', {
      sheet: sheet({ amountUsd: 9_871, themes: ['a'.repeat(65)] }),
    });
    expect(long.statusCode).toBe(400);
    const unknown = await post(null, '/v1/baskets/propose', {
      sheet: sheet({
        amountUsd: 9_871,
        goal: 'grow',
        risk: 'medium',
        themes: ['ignore-your-instructions'],
      }),
    });
    expect(unknown.statusCode).toBe(422);
    expect(OrderError.parse(unknown.json()).error).toBe(
      'a theme is not a shared portfolio on Solana',
    );
    // a sleeve's theme too
    const sleeve = await post(null, '/v1/baskets/propose', {
      sheet: sheet({
        amountUsd: 9_871,
        goal: 'grow',
        risk: 'medium',
        sleeves: [
          { kind: 'goal', shareBps: 5000 },
          { kind: 'theme', shareBps: 5000, theme: 'no-such-portfolio' },
        ],
      }),
    });
    expect(sleeve.statusCode).toBe(422);
    // a body over 32 KB is not read
    const big = await post(null, '/v1/baskets/propose', {
      sheet: sheet({ amountUsd: 9_871 }),
      padding: 'x'.repeat(33 * 1024),
    });
    expect(big.statusCode).toBe(413);
    expect(await linkedFor(9_871)).toBe(0);
  });

  it('makes at most so many a day across every caller', async () => {
    // Other test files store plans with no person at the same time: a cap the day has already reached
    // is the one that can be held to here.
    const capped = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      env: { AGENT_SURFACE: 'on' },
      planInputs: withMockYieldOff,
      linkedPlans: { perDay: 0, keepDays: 7 },
    });
    try {
      for (const remoteAddress of ['10.9.9.8', '10.9.9.9']) {
        const refused = await capped.app.inject({
          method: 'POST',
          url: '/v1/baskets/propose',
          payload: { sheet: sheet({ amountUsd: 1_234 }) },
          remoteAddress,
        });
        expect(refused.statusCode).toBe(429);
        expect(OrderError.parse(refused.json())).toMatchObject({
          code: 'RATE_LIMITED',
          details: { retryable: true },
        });
      }
      // and the server with room makes it
      const made = await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 1_234 }) });
      expect(made.statusCode, made.body).toBe(200);
    } finally {
      await capped.app.close();
    }
  });

  it('forgets a plan nobody bought after a few days, and keeps one somebody bought', async () => {
    const make = async (amountUsd: number) =>
      PersonalizeResponse.parse(
        (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd }) })).json(),
      ).id;
    const bought = await make(3_001);
    const unbought = await make(3_002);
    const buyer = data.track(await person(issuer, 'solana'));
    await fund(buyer, undefined, 4_000);
    await order(buyer, { proposalId: bought, amountUsd: 3_001 });
    // both made eight days ago
    await data.db
      .update(proposals)
      .set({ createdAt: sql`now() - interval '8 days'` })
      .where(inArray(proposals.id, [bought, unbought]));
    const fresh = await make(3_003);
    const left = await data.db
      .select({ id: proposals.id })
      .from(proposals)
      .where(inArray(proposals.id, [bought, unbought, fresh]));
    expect(left.map((r) => r.id).sort()).toEqual([bought, fresh].sort());
    expect((await get(null, `/v1/baskets/${unbought}`)).statusCode).toBe(404);
    expect((await get(null, `/v1/baskets/${bought}`)).statusCode).toBe(200);
  });

  it('opens each buyer’s own vault: its number is the plan’s and the buyer’s, never the link’s alone', async () => {
    const { id } = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 2_500 }) })).json(),
    );
    const numbers: string[] = [];
    for (const buyer of [
      data.track(await person(issuer, 'solana')),
      data.track(await person(issuer, 'solana')),
    ]) {
      await fund(buyer, undefined, 3_000);
      await settleAll(buyer, await order(buyer, { proposalId: id, amountUsd: 2_500 }));
      const mine = PortfolioResponse.parse((await get(buyer, '/v1/portfolio')).json());
      const vaults = mine.chains[0]?.vaults ?? [];
      expect(vaults).toHaveLength(1);
      const basketId = vaults[0]?.basketId ?? '';
      expect(basketId).toBe(basketIdOfLinked(id, buyer.sub));
      numbers.push(basketId);
    }
    // two buyers, two numbers, and neither is the one the plan's id gives by itself
    expect(new Set(numbers).size).toBe(2);
    expect(numbers).not.toContain(basketIdOf(id));
  });

  it('takes a sheet with every withdrawal it may hold, and refuses a body larger than that', async () => {
    const obligations = Array.from({ length: 480 }, (_, i) => ({
      month: `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      amount: 1_000.25,
      currency: 'USD',
    }));
    const body = { sheet: sheet({ amountUsd: 9_873, horizonMonths: 480, obligations }) };
    expect(JSON.stringify(body).length).toBeGreaterThan(16 * 1024);
    const all = await post(null, '/v1/baskets/propose', body);
    expect(all.statusCode, all.body).not.toBe(413);
    expect(all.statusCode).toBeLessThan(500);
    const big = await post(null, '/v1/baskets/propose', {
      ...body,
      padding: 'x'.repeat(33 * 1024),
    });
    expect(big.statusCode).toBe(413);
  });

  it('keeps the vault’s number with the order, and builds nothing once the plan is gone', async () => {
    const { id } = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 2_600 }) })).json(),
    );
    const buyer = data.track(await person(issuer, 'solana'));
    await fund(buyer, undefined, 3_000);
    const placed = await order(buyer, { proposalId: id, amountUsd: 2_600 });
    expect(placed.basketId).toBe(basketIdOfLinked(id, buyer.sub));
    const read = OrderDetail.parse((await get(buyer, `/v1/orders/${placed.id}`)).json());
    expect(read.basketId).toBe(basketIdOfLinked(id, buyer.sub));
    // the plan goes (the cleanup raced the order): the order is refused, not built half way
    await data.db.delete(proposals).where(eq(proposals.id, id));
    const leg = placed.legs[0];
    if (!leg) throw new Error('no leg');
    const build = await post(buyer, `/v1/orders/${placed.id}/legs/${leg.id}/build`);
    expect(build.statusCode).toBe(409);
    expect(OrderError.parse(build.json())).toMatchObject({
      error: 'the plan this order buys is gone',
      code: 'PLAN_GONE',
    });
  });

  it('never takes a plan stored with no person but not from a link for one', async () => {
    // a plan stored with no user row, as a test fixture or a person with none yet stores one
    const plain = await data.storePlan();
    const [row] = await data.db
      .select({ userId: proposals.userId, fromLink: proposals.fromLink })
      .from(proposals)
      .where(eq(proposals.id, plain));
    expect(row).toEqual({ userId: null, fromLink: false });
    expect((await get(null, `/v1/baskets/${plain}`)).statusCode).toBe(404);
    // old and never bought, and still kept by the cleanup: it is not a link's
    await data.db
      .update(proposals)
      .set({ createdAt: sql`now() - interval '30 days'` })
      .where(eq(proposals.id, plain));
    await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 3_101 }) });
    expect(
      await data.db.select({ id: proposals.id }).from(proposals).where(eq(proposals.id, plain)),
    ).toHaveLength(1);
  });

  it('keeps a plan from a link that a person’s plan names, however old', async () => {
    const { id } = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 3_201 }) })).json(),
    );
    const someone = data.track(await person(issuer, 'solana'));
    const [user] = await data.db
      .insert(users)
      .values({ privyId: someone.sub })
      .onConflictDoNothing()
      .returning({ id: users.id });
    const userId =
      user?.id ??
      (await data.db.select({ id: users.id }).from(users).where(eq(users.privyId, someone.sub)))[0]
        ?.id;
    if (!userId) throw new Error('no user row');
    const [kept] = await data.db
      .insert(baskets)
      .values({ userId, kind: 'personal', proposalId: id })
      .returning({ id: baskets.id });
    try {
      await data.db
        .update(proposals)
        .set({ createdAt: sql`now() - interval '30 days'` })
        .where(eq(proposals.id, id));
      await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 3_202 }) });
      expect((await get(null, `/v1/baskets/${id}`)).statusCode).toBe(200);
    } finally {
      if (kept) await data.db.delete(baskets).where(eq(baskets.id, kept.id));
    }
  });
});
