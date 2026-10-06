import { proposals } from '@colosseum/db';
import { type BasketSheet, OrderError, YieldObservation } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
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
const withMockYieldOff: PlanInputs = async () => ({});
const { post, get, fund, order } = orderFlow({
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
      .select({ userId: proposals.userId })
      .from(proposals)
      .where(eq(proposals.id, id));
    expect(row).toEqual({ userId: null });

    const read = await get(null, `/v1/baskets/${id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(LinkedPlanResponse.parse(read.json())).toEqual({ id, proposal });
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

  it('never reads back a plan a person made in the app', async () => {
    const who = data.track(await person(issuer, 'solana'));
    const made = await post(who, '/v1/baskets/personalize', { sheet: sheet({ amountUsd: 7_000 }) });
    expect(made.statusCode, made.body).toBe(200);
    const { id } = PersonalizeResponse.parse(made.json());
    const read = await get(null, `/v1/baskets/${id}`);
    expect(read.statusCode).toBe(404);
    expect(OrderError.parse(read.json()).error).toBe('no plan made from a link has that id');
    // nor an id that names nothing, and a word that is no id is refused as one
    expect((await get(null, `/v1/baskets/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await get(null, '/v1/baskets/not-an-id')).statusCode).toBe(400);
  });

  it('names exactly one chain, and stores nothing it refuses', async () => {
    const before = (await data.db.select({ id: proposals.id }).from(proposals)).length;
    const two = await post(null, '/v1/baskets/propose', {
      sheet: sheet({ chains: ['solana', 'robinhood'] }),
    });
    expect(two.statusCode).toBe(400);
    const bad = await post(null, '/v1/baskets/propose', { sheet: { ...sheet(), amountUsd: -1 } });
    expect(bad.statusCode).toBe(400);
    expect((await data.db.select({ id: proposals.id }).from(proposals)).length).toBe(before);
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
});
