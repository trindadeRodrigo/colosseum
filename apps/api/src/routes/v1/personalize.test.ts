import { mockAssets } from '@colosseum/chain-mock';
import { proposals, users } from '@colosseum/db';
import {
  type BasketSheet,
  type ChainId,
  OrderError,
  type RegimeLiquidityProvider,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { loadProposal } from '../../orders/store';
import { orderFlow } from '../../testing/flow';
import {
  type PersonKind,
  person,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import { PersonalizeResponse } from './baskets';

// POST /v1/baskets/personalize: a goal and its limits in, a plan made to measure out, stored so that
// POST /v1/orders buys it. The web's side is apps/web/features/goal/build-plan.ts; what it reads is
// held here: `{ id, proposal }`, the proposal in the shared shape, for the goal, amount and chain sent.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('personalize');
  data = await testDb();
  undo.push(() => data.cleanUp());
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const someone = async (kind: PersonKind) => data.track(await person(issuer, kind));
const fallback = { solana: '', robinhood: '' };
const { post, put, fund, order } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => fallback,
});

const sheet = (over: Partial<BasketSheet> = {}): BasketSheet => ({
  basketType: 'standard',
  goal: 'protect',
  amountUsd: 50_000,
  horizonMonths: 18,
  risk: 'low',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
  ...over,
});

const PATH = '/v1/baskets/personalize';
/** The class of each token on the mock's shelf of a chain. */
const classOf = (chain: ChainId) => new Map(mockAssets(chain).map((a) => [a.id, a.cls]));
const plansOf = async (sub: string) => {
  const [user] = await data.db.select({ id: users.id }).from(users).where(eq(users.privyId, sub));
  return user
    ? data.db.select({ id: proposals.id }).from(proposals).where(eq(proposals.userId, user.id))
    : [];
};

describe('POST /v1/baskets/personalize', () => {
  it('makes a plan to protect with no stock token, stores it, and a buy buys it on the same chain', async () => {
    const who = await someone('solana');
    const asked = sheet();
    const res = await post(who, PATH, { sheet: asked });
    expect(res.statusCode, res.body).toBe(200);
    const { id, proposal } = PersonalizeResponse.parse(res.json());

    // What build-plan.ts holds an answer to: the goal, the amount and the chain that were sent.
    expect(proposal.sheet).toEqual(asked);
    const cls = classOf('solana');
    expect(proposal.lines.length).toBeGreaterThan(1);
    for (const line of proposal.lines) {
      expect(line.chain).toBe('solana');
      expect(['stock', 'etf', 'crypto']).not.toContain(cls.get(line.assetId));
      expect(line.reasons.length).toBeGreaterThan(0);
    }
    // The mock lists no GLD, so its gold share is held in dollar yield or cash; one issuer holds at
    // most half at low risk, and the rest stays in cash.
    expect(proposal.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['solana:yield', 5000],
      ['solana:usdc', 5000],
    ]);
    expect(proposal.recipes.map((r) => [r.chain, r.amountUsd])).toEqual([['solana', 50_000]]);
    // Nothing is measured on the mock: the line's ceiling is its tier's, and the plan says so.
    expect(proposal.flags).toEqual(
      expect.arrayContaining(['ceiling_from_tier:solana:yield', 'shelf_provenance:mock']),
    );
    // The same sheet with a goal to grow holds stocks from the same shelf: the rule is the goal's.
    const grow = await post(who, PATH, { sheet: { ...asked, goal: 'grow' } });
    expect(grow.statusCode, grow.body).toBe(200);
    expect(
      PersonalizeResponse.parse(grow.json()).proposal.lines.some((l) =>
        ['stock', 'etf'].includes(cls.get(l.assetId) ?? ''),
      ),
    ).toBe(true);
    expect(proposal.disclaimer.length).toBeGreaterThan(0);

    // Stored, for this person, as it was answered.
    expect(await loadProposal(data.db, id)).toEqual(proposal);
    expect((await plansOf(who.sub)).map((p) => p.id)).toContain(id);

    // The order layer buys it: legs on the person's chain, trades only into what the plan holds.
    await fund(who, undefined, 60_000);
    const bought = await order(who, { proposalId: id, amountUsd: 50_000 });
    expect(new Set(bought.legs.map((l) => l.chain))).toEqual(new Set(['solana']));
    const buys = bought.legs.flatMap((l) => l.trades.map((t) => t.buy));
    expect(buys.length).toBeGreaterThan(0);
    expect(buys).toEqual(['solana:yield']);
    // Half the deposit is bought; the cash share stays in the vault.
    expect(bought.depositRaw).toBe(String(50_000 * 10 ** 6));
    expect(bought.legs.flatMap((l) => l.trades.map((t) => t.amountInRaw))).toEqual([
      String(25_000 * 10 ** 6),
    ]);
  });

  it('makes an income plan with no stock token either, even from a shared portfolio of stocks', async () => {
    const who = await someone('robinhood');
    const stocks = await data.storeFamily('robinhood', [
      { kind: 'asset', asset: 'robinhood:nvda', weightBps: 5000 },
      { kind: 'asset', asset: 'robinhood:tsla', weightBps: 5000 },
    ]);
    for (const goal of ['income', 'protect'] as const) {
      const res = await post(who, PATH, {
        sheet: sheet({
          goal,
          chains: ['robinhood'],
          themes: [stocks.slug],
          ...(goal === 'income' ? { incomeTargetUsdMonthly: 100 } : {}),
        }),
      });
      expect(res.statusCode, res.body).toBe(200);
      const { proposal } = PersonalizeResponse.parse(res.json());
      const cls = classOf('robinhood');
      for (const line of proposal.lines) {
        expect(line.chain, goal).toBe('robinhood');
        expect(['stock', 'etf', 'crypto'], `${goal} ${line.assetId}`).not.toContain(
          cls.get(line.assetId),
        );
      }
      // The shared portfolio holds stocks: it is left out whole, with the reason.
      expect(
        proposal.removed.map((r) => r.ref),
        goal,
      ).toContain(stocks.slug);
      expect(
        proposal.recipes[0]?.components.some((c) => c.kind === 'index'),
        goal,
      ).toBe(false);
    }
  });

  it('makes a plan to grow from a shared portfolio, which a buy opens into its assets', async () => {
    const who = await someone('solana');
    const family = await data.storeFamily('solana', [
      { kind: 'asset', asset: 'solana:spy', weightBps: 6000 },
      { kind: 'asset', asset: 'solana:nvda', weightBps: 4000 },
    ]);
    const res = await post(who, PATH, {
      sheet: sheet({ goal: 'grow', risk: 'high', amountUsd: 2_000, themes: [family.slug] }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const { id, proposal } = PersonalizeResponse.parse(res.json());
    expect(proposal.recipes[0]?.components).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'index', family: family.slug })]),
    );
    expect(proposal.lines.filter((l) => l.viaIndex === family.slug).length).toBe(2);
    await fund(who, undefined, 5_000);
    const bought = await order(who, { proposalId: id, amountUsd: 2_000 });
    expect(bought.legs.flatMap((l) => l.trades.map((t) => t.buy))).toEqual(
      expect.arrayContaining(['solana:spy', 'solana:nvda']),
    );
  });

  it('refuses a sheet for a chain the person’s plans do not live on, and stores nothing', async () => {
    const who = await someone('solana');
    const res = await post(who, PATH, { sheet: sheet({ chains: ['robinhood'] }) });
    expect(res.statusCode, res.body).toBe(422);
    const body = OrderError.parse(res.json());
    expect(body.error).toBe('your plans live on Solana, and this sheet names Robinhood Chain');
    expect(body.fix).toBe('Make the plan for Solana: send chains ["solana"].');
    expect(await plansOf(who.sub)).toEqual([]);
    // A person who picked Robinhood Chain is refused Solana the same way.
    const picked = await someone('passkey');
    expect((await put(picked, '/v1/me/chain', { chain: 'robinhood' })).statusCode).toBe(200);
    const other = await post(picked, PATH, { sheet: sheet() });
    expect(other.statusCode, other.body).toBe(422);
    expect(await plansOf(picked.sub)).toEqual([]);
  });

  it('answers 409 to a person with no chain yet, and 401 to nobody', async () => {
    const fresh = await someone('passkey');
    const res = await post(fresh, PATH, { sheet: sheet() });
    expect(res.statusCode, res.body).toBe(409);
    expect(OrderError.parse(res.json()).fix).toBe(
      'Pick Solana or Robinhood Chain once, with PUT /v1/me/chain.',
    );
    expect((await post(null, PATH, { sheet: sheet() })).statusCode).toBe(401);
  });
});

describe('the engine never runs on a sheet that did not validate', () => {
  it('answers 400 and reads no figure for a plan, for each way a sheet can be wrong', async () => {
    const inputs = vi.fn<PlanInputs>(async () => ({}));
    const own = await testApp({ issuer: issuer.issuer, db: data.db, planInputs: inputs });
    undo.push(() => own.app.close());
    const who = await someone('solana');
    const bad: unknown[] = [
      { ...sheet(), amountUsd: 5 },
      { ...sheet(), chains: ['solana', 'robinhood'] },
      { ...sheet(), chains: [] },
      { ...sheet(), risk: 'reckless' },
      { ...sheet(), goal: undefined },
      { ...sheet(), country: 'Brazil' },
      { ...sheet(), themes: ['a', 'b', 'c', 'd'] },
      { ...sheet(), limits: { mustKeepUsd: 60_000 } },
      { ...sheet(), limits: { cannotHold: { classes: ['cash'] } } },
      'protect my money',
      {},
    ];
    for (const s of bad) {
      const res = await post(who, PATH, { sheet: s }, own.app);
      expect(res.statusCode, JSON.stringify(s)).toBe(400);
    }
    expect(inputs).not.toHaveBeenCalled();
    expect(await plansOf(who.sub)).toEqual([]);
    // The same person with a sheet that validates: the figures are read once, then the plan is made.
    const ok = await post(
      who,
      PATH,
      { sheet: { ...sheet(), limits: { mustKeepUsd: 40_000 } } },
      own.app,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(inputs).toHaveBeenCalledTimes(1);
  });
});

describe('what a line may weigh comes from the measured exit (gate EXIT-SOURCE)', () => {
  /** SPY measured to `capacityUsd` of exit at 1%: a plan may count on a quarter of it. */
  const measured = (capacityUsd: number): RegimeLiquidityProvider => {
    const covers = (id: string) => id === 'solana:spy';
    return {
      methodVersion: 'test-depth-1',
      provenance: 'live',
      covers,
      exitCapacity: (id) =>
        covers(id)
          ? {
              capacityUsd,
              lowerBound: false,
              regime: 'weekend',
              samples: 120,
              dataFrom: '2026-10-01T00:00:00.000Z',
              dataTo: '2026-10-04T00:00:00.000Z',
            }
          : null,
      exitCost: (id, usd) => (covers(id) ? (0.004 * usd) / capacityUsd : null),
      weekendRatio: () => null,
      entry: () => null,
      assess: () => {
        throw new Error('not asked of a plan');
      },
      exitCostIn: () => null,
      entryCostIn: () => null,
      exitCapacityIn: () => null,
      regimes: (id) =>
        covers(id)
          ? {
              measured: ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'],
              missing: [],
            }
          : null,
    };
  };

  it('holds a line to its measured share, names the source, and keeps the tier for the rest, labelled', async () => {
    const inputs: PlanInputs = async ({ chain }) =>
      chain === 'solana'
        ? { liquidity: { provider: measured(20_000), source: 'Bearing test curves' } }
        : {};
    const own = await testApp({ issuer: issuer.issuer, db: data.db, planInputs: inputs });
    undo.push(() => own.app.close());
    const who = await someone('solana');
    const res = await post(who, PATH, { sheet: sheet({ goal: 'grow', risk: 'medium' }) }, own.app);
    expect(res.statusCode, res.body).toBe(200);
    const { proposal } = PersonalizeResponse.parse(res.json());
    // The tier would let SPY take $50,000; a quarter of the $20,000 measured is $5,000.
    expect(proposal.lines.find((l) => l.assetId === 'solana:spy')?.amountUsd).toBe(5_000);
    expect(proposal.flags).not.toContain('ceiling_from_tier:solana:spy');
    expect(proposal.flags).toContain('ceiling_from_tier:solana:yield');
    expect(proposal.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'liquidity',
          source: 'Bearing test curves',
          method: 'test-depth-1',
          fetchedAt: '2026-10-04T00:00:00.000Z',
          provenance: 'live',
        }),
      ]),
    );
  });
});

describe('the plans route is held to the limits of its class', () => {
  it('counts against the build class', async () => {
    const own = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      limits: {
        windowSeconds: 60,
        caller: { anonymous: 1000, signedIn: 1000 },
        class: { standard: null, build: 1, parse: 1000 },
      },
    });
    undo.push(() => own.app.close());
    const who = await someone('solana');
    expect((await post(who, PATH, { sheet: sheet() }, own.app)).statusCode).toBe(200);
    expect((await post(who, PATH, { sheet: sheet() }, own.app)).statusCode).toBe(429);
  });
});
