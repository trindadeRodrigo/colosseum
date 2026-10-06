import {
  type BasketSheet,
  OrderError,
  PortfolioResponse,
  YieldObservation,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { bearingPlanInputs } from '../../plan-inputs';
import mockYields from '../../testing/fixtures/mock-yields.json';
import { orderFlow } from '../../testing/flow';
import { person, type TestIssuer, testApp, testDb, testIssuer } from '../../testing/harness';
import { LinkedPlanResponse, PersonalizeResponse, PersonPlansResponse } from './baskets';

// A plan and its goal, read back from the server: GET /v1/baskets/{id} for the person who made it, and
// GET /v1/me/plans, which the portfolio joins a vault to its goal by. A plan is one person's: nobody
// else reads it, signed in or not. A plan made from a link keeps its own rule (propose.test.ts).

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
const undo: (() => Promise<unknown>)[] = [];
const withMockYield: PlanInputs = async (q) => ({
  ...(await bearingPlanInputs(q)),
  yields: YieldObservation.array()
    .parse(mockYields)
    .filter((y) => q.assets.some((a) => a.id === y.assetId)),
});

beforeAll(async () => {
  issuer = await testIssuer('plans-read');
  data = await testDb();
  undo.push(() => data.cleanUp());
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

const { post, get, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => ({ solana: '', robinhood: '' }),
});

const sheet = (over: Partial<BasketSheet> = {}): BasketSheet => ({
  basketType: 'standard',
  goal: 'protect',
  amountUsd: 4_100,
  horizonMonths: 18,
  risk: 'low',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
  ...over,
});
const someone = async () => data.track(await person(issuer, 'solana'));
type Person = Awaited<ReturnType<typeof someone>>;
const make = async (who: Person, amountUsd: number) => {
  const res = await post(who, '/v1/baskets/personalize', { sheet: sheet({ amountUsd }) });
  expect(res.statusCode, res.body).toBe(200);
  return PersonalizeResponse.parse(res.json());
};
const plansOf = async (who: Person, on?: FastifyInstance) => {
  const res = await get(who, '/v1/me/plans', on);
  expect(res.statusCode, res.body).toBe(200);
  return PersonPlansResponse.parse(res.json()).plans;
};

describe('a plan read back by its id', () => {
  it('is answered to the person who made it, whole, and marked as their own', async () => {
    const who = await someone();
    const { id, proposal } = await make(who, 4_101);
    const read = await get(who, `/v1/baskets/${id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(LinkedPlanResponse.parse(read.json())).toEqual({ id, proposal, fromLink: false });
  });

  it('is never answered to another person, or to nobody: the same 404 as an id that names nothing', async () => {
    const [who, other] = [await someone(), await someone()];
    const { id } = await make(who, 4_102);
    const answers = [
      await get(other, `/v1/baskets/${id}`),
      await get(null, `/v1/baskets/${id}`),
      await get(who, `/v1/baskets/${crypto.randomUUID()}`),
    ];
    expect(answers.map((a) => a.statusCode)).toEqual([404, 404, 404]);
    expect(new Set(answers.map((a) => OrderError.parse(a.json()).error)).size).toBe(1);
    // a token that is not one reads nothing either
    const forged = await app.inject({
      url: `/v1/baskets/${id}`,
      headers: { authorization: 'Bearer not-a-token', 'privy-id-token': 'nor-this' },
    });
    expect([401, 404]).toContain(forged.statusCode);
  });

  it('is the owner’s to read with the agent surface off, where a plan from a link is not served', async () => {
    const who = await someone();
    const { id } = await make(who, 4_103);
    const linked = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 4_104 }) })).json(),
    );
    const off = await testApp({ issuer: issuer.issuer, db: data.db, planInputs: withMockYield });
    try {
      expect((await get(who, `/v1/baskets/${id}`, off.app)).statusCode).toBe(200);
      expect((await get(who, `/v1/baskets/${linked.id}`, off.app)).statusCode).toBe(404);
    } finally {
      await off.app.close();
    }
    // on, a plan from a link is anybody's to read, signed in or not, and says it is one
    for (const reader of [null, who]) {
      const read = await get(reader, `/v1/baskets/${linked.id}`);
      expect(LinkedPlanResponse.parse(read.json())).toEqual({
        id: linked.id,
        proposal: linked.proposal,
        fromLink: true,
      });
    }
  });
});

describe('a person’s plans', () => {
  it('need a sign-in', async () => {
    expect((await get(null, '/v1/me/plans')).statusCode).toBe(401);
  });

  it('list a plan with its goal before anything is bought, and nobody else’s', async () => {
    const [who, other] = [await someone(), await someone()];
    const { id, proposal } = await make(who, 4_105);
    await make(other, 4_106);
    const plans = await plansOf(who);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id,
      fromLink: false,
      chain: 'solana',
      sheet: proposal.sheet,
      card: proposal.card,
      bought: false,
      orders: [],
      vault: null,
    });
    expect(Date.parse(plans[0]?.createdAt ?? '')).not.toBeNaN();
    expect((await plansOf(other)).map((p) => p.sheet.amountUsd)).toEqual([4_106]);
  });

  it('join a bought plan to its buys and to the vault the portfolio shows', async () => {
    const who = await someone();
    const { id } = await make(who, 4_107);
    await fund(who, undefined, 9_000);
    const placed = await order(who, { proposalId: id, amountUsd: 4_107 });
    // ordered, and nothing on chain yet
    const before = (await plansOf(who))[0];
    expect(before?.orders).toHaveLength(1);
    expect(before?.orders[0]).toMatchObject({
      id: placed.id,
      amountUsd: 4_107,
      status: placed.status,
      deposited: false,
    });
    expect(before?.bought).toBe(false);
    await settleAll(who, placed);
    const after = (await plansOf(who))[0];
    expect(after).toMatchObject({ id, bought: true });
    expect(after?.orders[0]).toMatchObject({ id: placed.id, deposited: true });
    const vaults =
      PortfolioResponse.parse((await get(who, '/v1/portfolio')).json()).chains[0]?.vaults ?? [];
    expect(vaults).toHaveLength(1);
    expect(after?.vault).toEqual({ chain: 'solana', basketId: vaults[0]?.basketId });
  });

  it('list a plan from a link once the person bought it, newest first, and never a stranger’s plan they bought', async () => {
    const [who, stranger] = [await someone(), await someone()];
    const own = await make(who, 4_108);
    const linked = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 4_109 }) })).json(),
    );
    // a link not bought is not the person's
    expect((await plansOf(who)).map((p) => p.id)).toEqual([own.id]);
    await fund(who, undefined, 20_000);
    await order(who, { proposalId: linked.id, amountUsd: 4_109 });
    const listed = await plansOf(who);
    expect(listed.map((p) => [p.id, p.fromLink])).toEqual([
      [linked.id, true],
      [own.id, false],
    ]);
    // a buy can name any stored plan by its id; a stranger's goal is still not read back through it
    const theirs = await make(stranger, 4_110);
    const res = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 4_110,
      proposalId: theirs.id,
    });
    if (res.statusCode === 200)
      expect((await plansOf(who)).map((p) => p.id)).not.toContain(theirs.id);
    // and the stranger's own list shows the plan with no buy of theirs
    expect((await plansOf(stranger)).find((p) => p.id === theirs.id)?.orders).toEqual([]);
  });
});
