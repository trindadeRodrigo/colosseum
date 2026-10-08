import { mockAssets } from '@colosseum/chain-mock';
import { proposals, users } from '@colosseum/db';
import { parseStockAttributes } from '@colosseum/engine/personal';
import {
  type BasketSheet,
  type ChainId,
  OrderError,
  type RegimeLiquidityProvider,
  YieldObservation,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { loadProposal } from '../../orders/store';
import { bearingPlanInputs } from '../../plan-inputs';
import mockStocks from '../../testing/fixtures/mock-stocks.json';
import mockYields from '../../testing/fixtures/mock-yields.json';
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
  // The mock chain's dollar-yield token has no stored reading, and the engine never counts a missing
  // yield as zero: the test hands it one, from a fixture labelled mock. And the attributes of the
  // mock's stand-in stocks on Solana, from a fixture labelled mock too (gate THEME-MATCHED): a plan
  // reads them only where its sheet names a filter.
  const withMockYield: PlanInputs = async (q) => ({
    ...(await bearingPlanInputs(q)),
    yields: YieldObservation.array()
      .parse(mockYields)
      .filter((y) => q.assets.some((a) => a.id === y.assetId)),
    ...(q.chain === 'solana'
      ? { stocks: parseStockAttributes(mockStocks, 'mock-stocks.json') }
      : {}),
  });
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    planInputs: withMockYield,
  }));
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
  it('makes a theme sleeve from the curated list of the person’s chain (gates SLEEVES, THEMES)', async () => {
    const who = await someone('solana');
    const asked = sheet({
      goal: 'grow',
      risk: 'high',
      amountUsd: 10_000,
      sleeves: [
        { kind: 'goal', shareBps: 5000 },
        { kind: 'theme', shareBps: 5000, theme: 'ai' },
      ],
    });
    const res = await post(who, PATH, { sheet: asked });
    expect(res.statusCode, res.body).toBe(200);
    const { proposal } = PersonalizeResponse.parse(res.json());
    // The mock lists two of the seven names on Solana: both are held for the theme, and the five it
    // does not list are left out with why.
    const themed = proposal.lines.filter((l) =>
      l.reasons.some((r) => r.rule === 'THEME_SLEEVE' && r.params.theme === 'AI'),
    );
    expect(themed.map((l) => l.assetId).sort()).toEqual(
      mockAssets('solana')
        .filter((a) => a.symbol === 'NVDAx' || a.symbol === 'TSLAx')
        .map((a) => a.id)
        .sort(),
    );
    const out = new Map(proposal.removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)]));
    for (const symbol of ['AAPLx', 'AMZNx', 'GOOGLx', 'METAx', 'MSFTx'])
      expect(out.get(symbol), symbol).toEqual(['NOT_ON_CHAIN']);
  });

  it('fills a theme sleeve by a filter over the stock attributes of the person’s chain (gate THEME-MATCHED)', async () => {
    const who = await someone('solana');
    const semis = 'matched-industry-semiconductors-semiconductor-equipment';
    const utilities = 'matched-sector-utilities';
    const asked = sheet({
      goal: 'grow',
      risk: 'high',
      amountUsd: 10_000,
      sleeves: [
        { kind: 'goal', shareBps: 4000 },
        { kind: 'theme', shareBps: 3000, theme: semis },
        { kind: 'theme', shareBps: 3000, theme: utilities },
      ],
    });
    const res = await post(who, PATH, { sheet: asked });
    expect(res.statusCode, res.body).toBe(200);
    const { id, proposal } = PersonalizeResponse.parse(res.json());
    expect(proposal.sheet.sleeves).toEqual(asked.sleeves);
    // Two stocks carry the industry and the mock lists one of them on Solana: it is held, and its
    // line says it is matched, by what and from which attributes, never that it is on a curated list.
    // The fixture writes the industry two ways, which the filter holds equal: the sleeve is said by
    // the value as the first stock by symbol writes it (AVGOx, with "and"), and each stock's own
    // fact as its own row does.
    const nvda = mockAssets('solana').find((a) => a.symbol === 'NVDAx');
    const matched = proposal.lines.filter((l) =>
      l.reasons.some((r) => r.rule === 'THEME_MATCHED_SLEEVE'),
    );
    expect(matched.map((l) => l.assetId)).toEqual([nvda?.id]);
    expect(matched[0]?.reasons.map((r) => r.text)).toEqual(
      expect.arrayContaining([
        'You set 30% of the plan for names matched by industry: Semiconductors and Semiconductor Equipment. Matched from the sourced attributes of each, not a curated theme: equal shares of the ones you can hold on Solana and that can be sold at this size, each up to its limit.',
        'NVDAx is matched by industry: Semiconductors and Semiconductor Equipment (attributes version 1, read 2026-10-06), not from a curated theme: NVIDIA Corporation: its industry is Semiconductors & Semiconductor Equipment.',
      ]),
    );
    const said = [
      ...proposal.lines.flatMap((l) => l.reasons),
      ...proposal.removed.flatMap((r) => r.reasons),
    ];
    expect(said.some((r) => r.rule === 'THEME_SLEEVE' || r.rule === 'THEME_MEMBER')).toBe(false);
    const out = new Map(proposal.removed.map((r) => [r.ref, r.reasons.map((x) => x.text)]));
    expect(out.get('AVGOx')).toEqual(['AVGOx is left out: Solana does not list it.']);
    // No stock carries the other value: that sleeve holds no name, flagged, and the plan says so.
    expect(proposal.flags).toContain(`theme_no_match:${utilities}`);
    expect(proposal.flags).not.toContain(`theme_no_match:${semis}`);
    expect(out.get(utilities)).toEqual([
      'There is no stock for utilities on Solana at the moment. We will be adding more soon.',
    ]);
    expect(said.some((r) => r.rule === 'OVERFLOW_THEME_NO_MATCH')).toBe(true);
    // Stored as it was answered, so a buy names it.
    expect(await loadProposal(data.db, id)).toEqual(proposal);
  });

  it('keeps the currency, the sleeves and the restore choice, as sent and as stored', async () => {
    const who = await someone('solana');
    const asked = sheet({
      currency: 'USD',
      sleeves: [{ kind: 'goal', shareBps: 10_000 }],
      restoreSplit: true,
    });
    const res = await post(who, PATH, { sheet: asked });
    expect(res.statusCode, res.body).toBe(200);
    const { id, proposal } = PersonalizeResponse.parse(res.json());
    expect(proposal.sheet).toEqual(asked);
    expect((await loadProposal(data.db, id))?.sheet).toEqual(asked);
    // Shares that do not add up are refused before the engine runs.
    const bad = await post(who, PATH, {
      sheet: { ...asked, sleeves: [{ kind: 'safe_yield', shareBps: 4000 }] },
    });
    expect(bad.statusCode).toBe(400);
    // A split into goal and safe yield is built (ENG-3 slice 2).
    const split = await post(who, PATH, {
      sheet: {
        ...asked,
        sleeves: [
          { kind: 'goal', shareBps: 6000 },
          { kind: 'safe_yield', shareBps: 4000 },
        ],
      },
    });
    expect(split.statusCode, split.body).toBe(200);
    // The split is in the shared shape since slice 4, answered and stored, so each sleeve of a stored
    // plan can be rebalanced against its own targets.
    const made = PersonalizeResponse.parse(split.json());
    expect(made.proposal.split?.map((x) => [x.kind, x.shareBps])).toEqual([
      ['goal', 6000],
      ['safe_yield', 4000],
    ]);
    expect((await loadProposal(data.db, made.id))?.split).toEqual(made.proposal.split);
    // Plans are in US dollars for now (gate USD-ONLY): a goal in reais is refused with its own code,
    // and nothing is stored.
    const reais = await post(who, PATH, { sheet: { ...asked, currency: 'BRL' } });
    expect(reais.statusCode).toBe(422);
    expect(OrderError.parse(reais.json())).toMatchObject({
      error: 'Plans are in US dollars for now',
      code: 'CURRENCY_UNSUPPORTED',
    });
    // Dated withdrawals are applied: the plan is made, and its sheet says them back.
    const obligations = [{ month: '2027-06', amount: 3000, currency: 'USD' }];
    const withdrawing = await post(who, PATH, { sheet: { ...asked, obligations } });
    expect(withdrawing.statusCode, withdrawing.body).toBe(200);
    expect(PersonalizeResponse.parse(withdrawing.json()).proposal.sheet.obligations).toEqual(
      obligations,
    );
    // A withdrawal in reais is refused the same way (gate USD-ONLY).
    const inReais = await post(who, PATH, {
      sheet: { ...asked, obligations: [{ month: '2027-06', amount: 3000, currency: 'BRL' }] },
    });
    expect(inReais.statusCode, inReais.body).toBe(422);
    expect(OrderError.parse(inReais.json()).code).toBe('CURRENCY_UNSUPPORTED');
    // A theme sleeve is built (ENG-3 slice 4). This plan is to protect, so it holds no stock: the
    // theme's names are left out with why, and its share is held in dollar yield and cash.
    const theme = {
      sleeves: [
        { kind: 'theme' as const, shareBps: 5000, theme: 'ai' },
        { kind: 'safe_yield' as const, shareBps: 5000 },
      ],
    };
    const themed = await post(who, PATH, { sheet: { ...asked, ...theme } });
    expect(themed.statusCode, themed.body).toBe(200);
    const plan = PersonalizeResponse.parse(themed.json()).proposal;
    expect(plan.sheet.sleeves).toEqual(theme.sleeves);
    expect(plan.flags).toContain('theme_empty:ai');
    const cls = classOf('solana');
    expect(plan.lines.every((l) => cls.get(l.assetId) !== 'stock')).toBe(true);
  });

  it('makes a plan to protect with no stock token, stores it, and a buy buys it on the same chain', async () => {
    const who = await someone('solana');
    const asked = sheet();
    const res = await post(who, PATH, { sheet: asked });
    expect(res.statusCode, res.body).toBe(200);
    const { id, proposal, rollUp } = PersonalizeResponse.parse(res.json());
    // The roll-up beside it, from the same shelf and time: one issuer and one chain on the mock, the
    // lines below by class, and no exit measured or quoted: null, never zero.
    expect(rollUp).toEqual({
      byIssuer: [{ key: 'mock', bps: 10_000 }],
      byChain: [{ key: 'solana', bps: 10_000 }],
      byClass: [
        { key: 'cash', bps: 5000 },
        { key: 'dollar_yield', bps: 4000 },
        { key: 'gold', bps: 1000 },
      ],
      flags: ['exit_not_measured', 'exit_quote_missing', 'issuer_concentration'],
      exit: { quotedBps: null, quotedAt: null, measuredWorstBps: null, measuredShareBps: 0 },
    });

    // What build-plan.ts holds an answer to: the goal, the amount and the chain that were sent.
    expect(proposal.sheet).toEqual(asked);
    const cls = classOf('solana');
    expect(proposal.lines.length).toBeGreaterThan(1);
    for (const line of proposal.lines) {
      expect(line.chain).toBe('solana');
      expect(['stock', 'etf', 'crypto']).not.toContain(cls.get(line.assetId));
      expect(line.reasons.length).toBeGreaterThan(0);
    }
    // The mock's yield token is a rate leg: 40% of the plan at most (gate SOLVER-PARAMS). Its one
    // issuer holds at most 50% of dollar yield, gold and cash (gate SOLVER-CAPS), so gold (PAXG, gate
    // GOLD-PAXG) takes the 10% left, and the rest stays in cash.
    expect(proposal.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['solana:yield', 4000],
      ['solana:gold', 1000],
      ['solana:usdc', 5000],
    ]);
    expect(proposal.recipes.map((r) => [r.chain, r.amountUsd])).toEqual([['solana', 50_000]]);
    // Nothing is measured on the mock: the line's ceiling is its tier's, and the plan says so.
    expect(proposal.flags).toEqual(
      expect.arrayContaining(['ceiling_from_tier:solana:yield', 'shelf_provenance:mock']),
    );
    // The same sheet with a goal to grow holds stocks from the same shelf: the rule is the goal's. At
    // medium risk: at low, gold and dollar yield take all the half the mock's one issuer may hold.
    const grow = await post(who, PATH, { sheet: { ...asked, goal: 'grow', risk: 'medium' } });
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
    expect(buys).toEqual(['solana:yield', 'solana:gold']);
    // 40% of the deposit buys dollar yield and 10% gold; the cash share stays in the vault.
    expect(bought.depositRaw).toBe(String(50_000 * 10 ** 6));
    expect(bought.legs.flatMap((l) => l.trades.map((t) => t.amountInRaw))).toEqual([
      String(20_000 * 10 ** 6),
      String(5_000 * 10 ** 6),
    ]);
  });

  it('answers the candidates of gate THREE-PLANS, each stored with its id, none marked, and a buy buys one', async () => {
    const who = await someone('solana');
    const months = Array.from({ length: 24 }, (_, m) => {
      const at = new Date(Date.UTC(2027, m, 1)).toISOString().slice(0, 7);
      return { month: at, amount: 1_500, currency: 'USD' };
    });
    const asked = sheet({ goal: 'income', horizonMonths: 36, obligations: months });
    const res = await post(who, PATH, { sheet: asked });
    expect(res.statusCode, res.body).toBe(200);
    const answer = PersonalizeResponse.parse(res.json());
    const shown = answer.candidates.map((c) => c.candidate);
    // In the fixed order, each once, with what is not shown said; nothing selects one.
    expect(shown).toEqual(['cover', 'spread', 'carry'].filter((id) => shown.some((s) => s === id)));
    expect(shown.length + answer.candidatesNotShown.length).toBe(3);
    expect(res.body).not.toMatch(/"(selected|recommended|isDefault|default)"/);
    // No odds, no percentile, no chance.
    expect(res.body).not.toMatch(/probab|percentil|\bchances?\b|\bodds\b|likel(y|ihood)/i);
    // Each candidate its own stored plan; Carry, the plan the table makes, shares the plan's row.
    const ids = answer.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const carry = answer.candidates.find((c) => c.candidate === 'carry');
    if (carry) expect(carry.id).toBe(answer.id);
    for (const c of answer.candidates) {
      expect(c.proposal.sheet).toEqual(asked);
      expect(await loadProposal(data.db, c.id)).toEqual(c.proposal);
      expect(c.status?.base.monthsWithWithdrawal).toBe(24);
      expect(c.scorecard.openFxUsd).toBeUndefined();
    }
    // Each is a plan a buy can name.
    const first = answer.candidates[0];
    if (!first) throw new Error('no candidate');
    await fund(who, undefined, 60_000);
    const bought = await order(who, { proposalId: first.id, amountUsd: 50_000 });
    expect(bought.legs.length).toBeGreaterThan(0);
  });

  it('holds PAXG for gold on Solana and GLD on Robinhood Chain when nothing chosen fills it (gate GOLD-PAXG)', async () => {
    for (const [kind, chain, gold, bps] of [
      ['solana', 'solana', 'PAXG', 1000],
      ['robinhood', 'robinhood', 'GLD', 1000],
    ] as const) {
      const who = await someone(kind);
      // The mock's one issuer holds at most 50% of dollar yield, gold and cash at any risk (gate
      // SOLVER-CAPS). On both chains the yield token has a MOCK reading and takes its 40%, so gold
      // takes the 10% left.
      const res = await post(who, PATH, { sheet: sheet({ chains: [chain], risk: 'high' }) });
      expect(res.statusCode, res.body).toBe(200);
      const { proposal } = PersonalizeResponse.parse(res.json());
      const line = proposal.lines.find((l) => l.assetId === `${chain}:gold`);
      expect(line?.weightBps, chain).toBe(bps);
      expect(line?.reasons.map((r) => r.text)).toContain(
        `${gold}: where a goal to protect starts when you choose no shared portfolio.`,
      );
      // Nothing is left out: the yield token has its reading on both chains.
      expect(proposal.removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)])).toEqual([]);
    }
  });

  it('holds dollar yield in a plan on Robinhood Chain on the mock, from its MOCK reading', async () => {
    const who = await someone('robinhood');
    const res = await post(who, PATH, { sheet: sheet({ chains: ['robinhood'] }) });
    expect(res.statusCode, res.body).toBe(200);
    const { proposal } = PersonalizeResponse.parse(res.json());
    expect(proposal.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['robinhood:yield', 4000],
      ['robinhood:gold', 1000],
      ['robinhood:usdc', 5000],
    ]);
    // the reading the line stands on is labelled MOCK, as the Solana one is
    const readings = proposal.observations.filter((o) => o.kind === 'yield');
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.every((o) => o.provenance === 'mock')).toBe(true);
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

  it('refuses a sheet for another chain than the current one, and stores nothing', async () => {
    const who = await someone('solana');
    const res = await post(who, PATH, { sheet: sheet({ chains: ['robinhood'] }) });
    expect(res.statusCode, res.body).toBe(422);
    const body = OrderError.parse(res.json());
    expect(body.error).toBe('your current chain is Solana, and this sheet names Robinhood Chain');
    expect(body.fix).toBe(
      'Make the plan for Solana: send chains ["solana"], or switch the current chain with PUT /v1/me/chain.',
    );
    expect(await plansOf(who.sub)).toEqual([]);
    // A person who picked Robinhood Chain is refused Solana the same way.
    const picked = await someone('passkey');
    expect((await put(picked, '/v1/me/chain', { chain: 'robinhood' })).statusCode).toBe(200);
    const other = await post(picked, PATH, { sheet: sheet() });
    expect(other.statusCode, other.body).toBe(422);
    expect(await plansOf(picked.sub)).toEqual([]);
    // Switched to Solana, the same sheet makes a plan there (CHAIN-SWITCH).
    expect((await put(picked, '/v1/me/chain', { chain: 'solana' })).statusCode).toBe(200);
    const made = await post(picked, PATH, { sheet: sheet() });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().proposal.recipes.map((r: { chain: string }) => r.chain)).toEqual(['solana']);
    // The plan, and beside it its other candidates (gate THREE-PLANS), each a stored row.
    expect((await plansOf(picked.sub)).length).toBeGreaterThanOrEqual(1);
  });

  // Gate COUNTRY-REMOVED (Rodrigo, Oct 6): this test held that ZZ, QQ, EU, SU and UK were refused
  // with 422. The plan reads no country: a sheet with none, or any two capitals, is answered.
  it('answers a sheet with no country, or any two capitals, with a plan', async () => {
    const who = await someone('solana');
    const { country: _, ...none } = sheet();
    for (const body of [none, sheet({ country: 'ZZ' }), sheet({ country: 'UK' })]) {
      const res = await post(who, PATH, { sheet: body });
      expect(res.statusCode, res.body).toBe(200);
    }
  });

  it('answers 409 to a person with no chain yet, and 401 to nobody', async () => {
    const fresh = await someone('passkey');
    const res = await post(fresh, PATH, { sheet: sheet() });
    expect(res.statusCode, res.body).toBe(409);
    expect(OrderError.parse(res.json()).fix).toBe(
      'Pick Solana or Robinhood Chain with PUT /v1/me/chain. You can switch later.',
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
    const inputs: PlanInputs = async ({ chain, assets }) =>
      chain === 'solana'
        ? {
            liquidity: { provider: measured(20_000), source: 'Bearing test curves' },
            // The mock's yield token needs a reading to be held at all (ENG-3 slice 1).
            yields: YieldObservation.array()
              .parse(mockYields)
              .filter((y) => assets.some((a) => a.id === y.assetId)),
          }
        : {};
    const own = await testApp({ issuer: issuer.issuer, db: data.db, planInputs: inputs });
    undo.push(() => own.app.close());
    const who = await someone('solana');
    const res = await post(who, PATH, { sheet: sheet({ goal: 'grow', risk: 'medium' }) }, own.app);
    expect(res.statusCode, res.body).toBe(200);
    const { proposal, rollUp } = PersonalizeResponse.parse(res.json());
    // The tier would let SPY take $50,000; a quarter of the $20,000 measured is $5,000.
    expect(proposal.lines.find((l) => l.assetId === 'solana:spy')?.amountUsd).toBe(5_000);
    expect(proposal.flags).not.toContain('ceiling_from_tier:solana:spy');
    expect(proposal.flags).toContain('ceiling_from_tier:solana:yield');
    // The roll-up reads the same measurement: $5,000 of SPY costs $5 to sell, over the $27,500 of SPY
    // and cash it covers (cash costs nothing to leave; the yield token, a rate leg held to 40%, and
    // the 5% of gold, within the issuer's 50% of dollar yield, gold and cash, are the unmeasured
    // rest), 1.82 bps on 55% of the plan.
    expect(rollUp.exit).toEqual({
      quotedBps: null,
      quotedAt: null,
      measuredWorstBps: 1.82,
      measuredShareBps: 5500,
    });
    expect(rollUp.flags).toContain('exit_partly_measured');
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
