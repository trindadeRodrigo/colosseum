import type { ChainId, Shelf } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sizeSleeves } from './exposure';
import { candidates, compose } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  aiList,
  editShelf,
  expectedSleeves,
  fixtureLiquidity,
  fixtureYields,
  launchShelf,
  NOW,
  roomyYield,
  usdBrl,
  violations,
} from './testing';
import {
  type ComposeContext,
  type HeldPosition,
  HoldableClass,
  PersonalParameters,
  PersonalSheet,
  SLEEVES,
} from './types';
import { buildWorld, monthAfter } from './world';

// Generated people, generated parameter tables, generated shelves. For any valid sheet the plan keeps
// the vault's target rules and every ceiling and cap, holds nothing excluded or ineligible, and is
// the same plan every time. `violations` in ./testing.ts is the measure: it reads the plan, the shelf
// and the table, and never the engine's own working.

const RUNS = 150;
/** A loaded machine runs these many times slower; the default five seconds is too tight. */
const PATIENCE = 60_000;
const launch = launchShelf();
const SLUGS = launch.families.map((f) => f.meta.slug);
const TOKENS = launch.assets.filter((a) => a.cls !== 'cash');
const TICKERS = [...new Set(TOKENS.map((a) => a.underlying))];
const CHAINS: ChainId[] = ['solana', 'robinhood', 'base'];
const GOALS = ['grow', 'income', 'protect'] as const;
const RISKS = ['low', 'medium', 'high'] as const;
const bps = fc.integer({ min: 0, max: 10_000 });
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
/** Drops the keys that are undefined, as a form does with a field left empty. */
const filled = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

const cannotHold = fc
  .record({
    classes: maybe(fc.uniqueArray(fc.constantFrom(...HoldableClass.options), { maxLength: 3 })),
    underlyings: maybe(
      fc.uniqueArray(fc.constantFrom(...TICKERS, 'nvda', 'ZZZ'), { maxLength: 4 }),
    ),
    assets: maybe(fc.uniqueArray(fc.constantFrom(...TOKENS.map((a) => a.id)), { maxLength: 4 })),
  })
  .map(filled);

/** A person on one chain: a plan lives on the chain of the wallet they signed in with. */
const personOn = (chain: ChainId): fc.Arbitrary<PersonalSheet> =>
  fc
    .record({
      goal: fc.constantFrom(...GOALS),
      amountUsd: fc.oneof(
        fc.integer({ min: 10, max: 1_000_000 }),
        fc.integer({ min: 1000, max: 100_000_000 }).map((cents) => cents / 100),
        fc.constantFrom(10, 999.99, 10_000, 50_000, 1_000_000),
      ),
      horizonMonths: fc.oneof(
        fc.integer({ min: 1, max: 480 }),
        fc.constantFrom(1, 6, 12, 24, 36, 60),
      ),
      risk: fc.constantFrom(...RISKS),
      themes: fc.uniqueArray(fc.constantFrom(...SLUGS, 'no-such-portfolio'), { maxLength: 3 }),
      country: fc.constantFrom('BR', 'US', 'DE'),
      chains: fc.constant([chain]),
      incomeTargetUsdMonthly: maybe(fc.integer({ min: 1, max: 5000 })),
      rules: fc.record({ useHoldings: fc.boolean(), glide: fc.boolean() }),
      language: fc.constantFrom('en' as const, 'pt' as const),
      keepShare: maybe(fc.double({ min: 0, max: 1, noNaN: true })),
      mayNeedInMonths: maybe(fc.integer({ min: 1, max: 480 })),
      cannotHold: maybe(cannotHold),
    })
    .map(({ keepShare, mayNeedInMonths, cannotHold: no, ...rest }) => {
      const mustKeepUsd =
        keepShare === undefined ? undefined : Math.floor(rest.amountUsd * keepShare);
      const limits = filled({ mustKeepUsd, mayNeedInMonths, cannotHold: no });
      return PersonalSheet.parse(
        filled({
          basketType: 'standard' as const,
          ...rest,
          limits: Object.keys(limits).length ? limits : undefined,
        }),
      );
    });

/** A dated withdrawal, from two months back to a year and more ahead, in dollars or reais. */
const withdrawal = fc.record({
  month: fc.integer({ min: -2, max: 14 }).map((m) => monthAfter(NOW, m)),
  amount: fc.oneof(fc.integer({ min: 1, max: 200_000 }), fc.constantFrom(500, 3000, 25_000)),
  currency: fc.constantFrom('USD', 'BRL'),
});

/** A theme a sheet may name: the one with a list (on Solana), and one with none anywhere. */
const THEME_SLUGS = ['ai', 'no-such-theme'];

/**
 * The same, and sometimes split (gate SLEEVES), in a currency, with withdrawals: a goal sleeve, a
 * safe-yield sleeve and up to two theme sleeves, or the whole plan in any one of them. What must not
 * be lost is held to what the sleeves outside the themes hold, as the sheet requires.
 */
const splitOn = (chain: ChainId): fc.Arbitrary<PersonalSheet> =>
  fc
    .tuple(
      personOn(chain),
      maybe(
        fc.record({
          weights: fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 4, maxLength: 4 }),
          slugs: fc.shuffledSubarray(THEME_SLUGS, { minLength: 2, maxLength: 2 }),
        }),
      ),
      maybe(fc.constantFrom('USD', 'BRL')),
      maybe(fc.array(withdrawal, { maxLength: 6 })),
    )
    .map(([sheet, cut, currency, obligations]) => {
      // Four weights for the goal, the safe yield and two themes: the shares of 10,000 they give.
      const weights = cut && cut.weights.some((x) => x > 0) ? cut.weights : undefined;
      const total = weights ? weights.reduce((n, x) => n + x, 0) : 0;
      const shares = weights ? weights.map((x) => Math.floor((x * 10_000) / total)) : [];
      if (weights) {
        const first = shares.findIndex((x) => x > 0);
        shares[first] = (shares[first] ?? 0) + 10_000 - shares.reduce((n, x) => n + x, 0);
      }
      const [goal = 0, safe = 0, themeA = 0, themeB = 0] = shares;
      const sleeves = weights
        ? [
            ...(goal > 0 ? [{ kind: 'goal' as const, shareBps: goal }] : []),
            ...(safe > 0 ? [{ kind: 'safe_yield' as const, shareBps: safe }] : []),
            ...[themeA, themeB].flatMap((shareBps, i) =>
              shareBps > 0
                ? [{ kind: 'theme' as const, shareBps, theme: cut?.slugs[i] ?? 'ai' }]
                : [],
            ),
          ]
        : undefined;
      const outside = 10_000 - themeA - themeB;
      const keep = sheet.limits?.mustKeepUsd;
      const most = Math.floor((Math.round(sheet.amountUsd * 100) * outside) / 10_000) / 100;
      const limits =
        sheet.limits && keep !== undefined && keep > most
          ? { ...sheet.limits, mustKeepUsd: most }
          : sheet.limits;
      return PersonalSheet.parse(filled({ ...sheet, limits, currency, obligations, sleeves }));
    });

const sleeveRow = fc.tuple(bps, bps, bps).map(([growth, dollarYield, gold]) => {
  const growthBps = growth;
  const dollarYieldBps = Math.min(dollarYield, 10_000 - growthBps);
  const goldBps = Math.min(gold, 10_000 - growthBps - dollarYieldBps);
  return { growthBps, dollarYieldBps, goldBps };
});
const byRisk = <T>(arb: fc.Arbitrary<T>) => fc.record({ low: arb, medium: arb, high: arb });
const dollars = fc.oneof(
  fc.integer({ min: 0, max: 2_000_000 }),
  fc.double({ min: 0, max: 60_000, noNaN: true }),
);

/** A parameter table Rodrigo could set: any sizes, any floors in any order, any caps. */
const table: fc.Arbitrary<PersonalParameters> = fc
  .record({
    rows: fc.array(sleeveRow, { minLength: 9, maxLength: 9 }),
    glideFloor: fc.array(
      fc.record({ monthsLeft: fc.integer({ min: 0, max: 480 }), dollarYieldBps: bps }),
      {
        maxLength: 5,
      },
    ),
    cashFloor: fc.array(fc.record({ monthsLeft: fc.integer({ min: 0, max: 480 }), cashBps: bps }), {
      maxLength: 4,
    }),
    capPerStockBps: byRisk(bps),
    capPerIssuerBps: byRisk(bps),
    tierCeilingUsd: fc.record({ A: dollars, B: dollars, C: dollars }),
    shareOfDepth: fc.double({ min: 0.01, max: 1, noNaN: true }),
    minLineBps: fc.integer({ min: 0, max: 600 }),
    minLineUsd: fc.integer({ min: 0, max: 200 }),
    maxLinesPerChain: fc.integer({ min: 1, max: 16 }),
    holdingMinBps: fc.integer({ min: 0, max: 2000 }),
    fallBps: bps,
    atEndMinBps: bps,
    wayStepUsd: fc.constantFrom(1, 100, 2500),
    defaultTheme: fc.record({
      grow: fc.constantFrom(...SLUGS, null, 'no-such-portfolio'),
      income: fc.constantFrom(...SLUGS, null),
      protect: fc.constantFrom(...SLUGS, null),
    }),
    defaultUnderlying: fc.record({
      growth: fc.constantFrom('SPY', 'NVDA', 'JitoSOL', 'ZZZ'),
      gold: fc.shuffledSubarray(['PAXG', 'GLD', 'SLV', 'ZZZ'], { minLength: 1 }),
    }),
    // The banded fill's numbers (gate SOLVER-PARAMS), any of them.
    yieldBand: fc.double({ min: 0, max: 0.05, noNaN: true }),
    capPerAssetBps: fc.record({
      bySymbol: fc.record({ syrupUSDC: bps }, { requiredKeys: [] }),
      byLegType: fc.record({ rate: bps, credit: bps, basis: bps, market_deposit: bps }),
    }),
    issuerCapBps: bps,
    creditShareBps: fc.record({ none: bps, limited: bps, accept: bps }),
    defaultCreditTolerance: fc.constantFrom('none' as const, 'limited' as const, 'accept' as const),
  })
  .map(({ rows, ...rest }) =>
    PersonalParameters.parse({
      ...PERSONAL_PARAMS,
      ...rest,
      version: 'generated',
      sleeves: Object.fromEntries(
        GOALS.flatMap((goal, g) =>
          RISKS.map((risk, r) => [`${goal}:${risk}`, rows[g * RISKS.length + r]]),
        ),
      ),
    }),
  );

const holdings: fc.Arbitrary<HeldPosition[]> = fc.array(
  fc.oneof(
    fc.record({
      underlying: fc.constantFrom(...TICKERS),
      valueUsd: fc.integer({ min: 0, max: 300_000 }),
    }),
    fc.record({
      asset: fc.constantFrom(...TOKENS.map((a) => a.id)),
      valueUsd: fc.integer({ min: 0, max: 9000 }),
    }),
  ),
  { maxLength: 4 },
);

/** The world a plan is made in: who cannot hold what, what was measured, which yields were read. */
const world = fc.record({
  blocked: fc.uniqueArray(fc.constantFrom(...TOKENS.map((a) => a.id)), { maxLength: 25 }),
  measured: fc.array(
    fc.tuple(fc.constantFrom(...TOKENS.map((a) => a.id)), fc.integer({ min: 0, max: 5_000_000 })),
    { maxLength: 12 },
  ),
  samples: fc.integer({ min: 0, max: 60 }),
  // Times of the week a token's measurement leaves out.
  notMeasured: fc.array(
    fc.tuple(
      fc.constantFrom(...TOKENS.map((a) => a.id)),
      fc.subarray(['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'] as const),
    ),
    { maxLength: 4 },
  ),
  read: fc.subarray(fixtureYields().map((y) => y.assetId)),
  holdings,
  params: fc.oneof(fc.constant(PERSONAL_PARAMS), table),
});
type World = typeof world extends fc.Arbitrary<infer T> ? T : never;

/** The shelf and the context of a generated world. Built here, so a failure prints the world small. */
function made(raw: World): { shelf: Shelf; context: ComposeContext } {
  return {
    shelf: editShelf(launch, (a) =>
      raw.blocked.includes(a.id) ? { ...a, blockedCountries: ['US'] } : a,
    ),
    context: {
      now: NOW,
      holdings: raw.holdings,
      yields: fixtureYields().filter((y) => raw.read.includes(y.assetId)),
      liquidity: fixtureLiquidity(
        Object.fromEntries(raw.measured),
        raw.samples,
        undefined,
        Object.fromEntries(raw.notMeasured.map(([id, gaps]) => [id, [...gaps]])),
      ),
      params: raw.params,
      // Every world can convert reais: a withdrawal in reais needs the rate, and an unused one only
      // changes the hash.
      fx: [usdBrl()],
      // The theme lists as content/themes holds them: the Solana AI list.
      themes: [aiList()],
    },
  };
}

describe.each(CHAINS)('for any valid sheet, on %s alone', (chain) => {
  const person = personOn(chain);
  const anyone = splitOn(chain);

  it(
    'the plan keeps the vault’s target rules, every ceiling and cap, and holds nothing ruled out',
    () => {
      fc.assert(
        fc.property(anyone, world, (sheet, raw) => {
          const { shelf, context } = made(raw);
          const plan = compose(sheet, shelf, context);
          expect(violations(plan, shelf, context)).toEqual([]);
        }),
        { numRuns: RUNS * 2 },
      );
    },
    PATIENCE,
  );

  it(
    "each candidate keeps the same rules, inside the person's limits, and comes in the fixed order",
    () => {
      fc.assert(
        fc.property(anyone, world, (sheet, raw) => {
          const { shelf, context } = made(raw);
          const answer = candidates(sheet, shelf, context);
          expect(answer.shown.length).toBeGreaterThan(0);
          expect([...answer.shown, ...answer.notShown].map((c) => c.id).sort()).toEqual([
            'carry',
            'cover',
            'spread',
          ]);
          const order = answer.shown.map((c) => c.id);
          expect(order).toEqual(
            ['cover', 'spread', 'carry'].filter((id) => order.some((o) => o === id)),
          );
          for (const { id, plan } of answer.shown)
            expect(violations(plan, shelf, context), id).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    },
    PATIENCE,
  );

  it(
    'the plan is the same every time, in whatever order the shelf is listed',
    () => {
      fc.assert(
        fc.property(anyone, world, fc.integer({ min: 1, max: 50 }), (sheet, raw, seed) => {
          const { shelf, context } = made(raw);
          const plan = compose(sheet, shelf, context);
          expect(compose(sheet, shelf, context)).toEqual(plan);
          const order = (id: string) =>
            [...id].reduce((n, ch) => (n * seed + ch.charCodeAt(0)) % 9973, seed);
          // The tokens, the portfolios, each portfolio's recipes and each recipe's parts.
          const shuffled: Shelf = {
            ...shelf,
            assets: [...shelf.assets].sort((a, b) => order(a.id) - order(b.id)),
            families: [...shelf.families]
              .sort((a, b) => order(a.meta.slug) - order(b.meta.slug))
              .map((f) => ({
                ...f,
                recipes: [...f.recipes]
                  .sort((a, b) => order(a.chain) - order(b.chain))
                  .map((r) => ({
                    ...r,
                    components: [...r.components].sort(
                      (a, b) =>
                        order(a.kind === 'asset' ? a.asset : a.family) -
                        order(b.kind === 'asset' ? b.asset : b.family),
                    ),
                  })),
              })),
          };
          expect(compose(sheet, shuffled, context)).toEqual(plan);
        }),
        { numRuns: RUNS },
      );
    },
    PATIENCE,
  );

  it(
    'the sleeves are what the table says, and a nearer date never gives less cash or less in cash and dollar yield',
    () => {
      fc.assert(
        fc.property(
          person,
          world,
          fc.integer({ min: 1, max: 480 }),
          fc.integer({ min: 1, max: 480 }),
          (sheet, raw, a, b) => {
            const { shelf, context } = made(raw);
            // What the table asks, worked out apart from the engine, and what the engine sizes.
            const asked = (horizonMonths: number) =>
              expectedSleeves({ ...sheet, horizonMonths }, raw.params);
            const sized = (horizonMonths: number) =>
              sizeSleeves(buildWorld({ ...sheet, horizonMonths }, shelf, context)).sized;
            const [near, far] = [asked(Math.min(a, b)), asked(Math.max(a, b))];
            expect(sized(Math.min(a, b))).toEqual(near);
            expect(sized(Math.max(a, b))).toEqual(far);
            for (const sleeves of [near, far]) {
              expect(SLEEVES.reduce((n, sleeve) => n + sleeves[sleeve], 0)).toBe(10_000);
              for (const sleeve of SLEEVES) expect(sleeves[sleeve]).toBeGreaterThanOrEqual(0);
            }
            expect(near.cash).toBeGreaterThanOrEqual(far.cash);
            expect(near.cash + near.dollarYield).toBeGreaterThanOrEqual(far.cash + far.dollarYield);
            expect(near.growth).toBeLessThanOrEqual(far.growth);
            expect(near.gold).toBeLessThanOrEqual(far.gold);
          },
        ),
        { numRuns: RUNS * 2 },
      );
    },
    PATIENCE,
  );

  it(
    'the plan never holds less in cash and dollar yield than the table asks, so than its date asks',
    () => {
      // Placement only ever moves money out of stocks, crypto and gold: what finds no token goes to
      // dollar yield, then to cash. With the property above, a plan for a nearer date holds at least
      // what a farther date is sized for. It does not always hold more than the farther plan itself:
      // that one may hold extra in dollar yield because its stocks found no room.
      fc.assert(
        fc.property(person, world, (sheet, raw) => {
          const { shelf, context } = made(raw);
          const plan = compose(sheet, shelf, context);
          const sized = expectedSleeves(sheet, raw.params);
          const kept = (sleeve: 'cash' | 'dollarYield') =>
            plan.sleeves.find((x) => x.sleeve === sleeve)?.amountUsd ?? 0;
          const asked = (sheet.amountUsd * (sized.cash + sized.dollarYield)) / 10_000;
          // Two sleeves, each a whole number of cents.
          expect(kept('cash') + kept('dollarYield')).toBeGreaterThanOrEqual(asked - 0.02);
        }),
        { numRuns: RUNS * 2 },
      );
    },
    PATIENCE,
  );
});

// A plan that is all cash keeps every rule above. This is the other half: where there is room, a plan
// holds what the table asks, sleeve by sleeve. Room is a table with no cap or ceiling in the way, on
// a chain that lists what each sleeve starts from, for a person who holds nothing and rules nothing
// out. What the table asks is worked out by `expectedSleeves`, apart from the engine.
describe.each(['solana', 'robinhood'] as const)('where there is room, on %s', (chain) => {
  // Sleeves and floors in whole percents, so no part of a sleeve is under the least a line can be.
  const percent = fc.integer({ min: 0, max: 100 }).map((points) => points * 100);
  const wholeRow = fc.tuple(percent, percent, percent).map(([growth, dollarYield, gold]) => {
    const growthBps = growth;
    const dollarYieldBps = Math.min(dollarYield, 10_000 - growthBps);
    const goldBps = Math.min(gold, 10_000 - growthBps - dollarYieldBps);
    return { growthBps, dollarYieldBps, goldBps };
  });
  const roomy = fc
    .record({
      rows: fc.array(wholeRow, { minLength: 9, maxLength: 9 }),
      glideFloor: fc.array(
        fc.record({ monthsLeft: fc.integer({ min: 0, max: 480 }), dollarYieldBps: percent }),
        { maxLength: 5 },
      ),
      cashFloor: fc.array(
        fc.record({ monthsLeft: fc.integer({ min: 0, max: 480 }), cashBps: percent }),
        { maxLength: 4 },
      ),
    })
    .map(({ rows, ...floors }) =>
      PersonalParameters.parse({
        ...roomyYield(),
        ...floors,
        version: 'generated, with room',
        sleeves: Object.fromEntries(
          GOALS.flatMap((goal, g) =>
            RISKS.map((risk, r) => [`${goal}:${risk}`, rows[g * RISKS.length + r]]),
          ),
        ),
        capPerStockBps: { low: 10_000, medium: 10_000, high: 10_000 },
        capPerIssuerBps: { low: 10_000, medium: 10_000, high: 10_000 },
        tierCeilingUsd: { A: 10_000_000, B: 10_000_000, C: 10_000_000 },
        minLineBps: 1,
        minLineUsd: 0,
        maxLinesPerChain: 16,
      }),
    );
  const someone = fc
    .record({
      goal: fc.constantFrom(...GOALS),
      // Whole hundreds of dollars: a basis point is then a whole number of cents.
      amountUsd: fc.integer({ min: 1, max: 10_000 }).map((hundreds) => hundreds * 100),
      horizonMonths: fc.integer({ min: 1, max: 480 }),
      risk: fc.constantFrom(...RISKS),
      glide: fc.boolean(),
      keepShare: maybe(fc.integer({ min: 0, max: 100 })),
      mayNeedInMonths: maybe(fc.integer({ min: 1, max: 480 })),
      language: fc.constantFrom('en' as const, 'pt' as const),
    })
    .map(({ glide, keepShare, mayNeedInMonths, ...rest }) => {
      const mustKeepUsd = keepShare === undefined ? undefined : (rest.amountUsd * keepShare) / 100;
      const limits = filled({ mustKeepUsd, mayNeedInMonths });
      return PersonalSheet.parse(
        filled({
          basketType: 'standard' as const,
          ...rest,
          themes: [],
          country: 'BR',
          chains: [chain],
          rules: { useHoldings: true, glide },
          limits: Object.keys(limits).length ? limits : undefined,
        }),
      );
    });

  it(
    'a plan holds what the table asks, sleeve by sleeve',
    () => {
      fc.assert(
        fc.property(someone, roomy, (sheet, params) => {
          const context: ComposeContext = { now: NOW, yields: fixtureYields(), params };
          const plan = compose(sheet, launch, context);
          expect(violations(plan, launch, context)).toEqual([]);
          const asked = expectedSleeves(sheet, params);
          // An income plan holds only what pays: its stocks and gold are held in dollar yield. A
          // plan to protect holds no stocks: those are held in dollar yield, and its gold stays.
          const expected =
            sheet.goal === 'income'
              ? {
                  growth: 0,
                  dollarYield: asked.growth + asked.dollarYield + asked.gold,
                  gold: 0,
                  cash: asked.cash,
                }
              : sheet.goal === 'protect'
                ? { ...asked, growth: 0, dollarYield: asked.growth + asked.dollarYield }
                : asked;
          expect(Object.fromEntries(plan.sleeves.map((x) => [x.sleeve, x.weightBps]))).toEqual(
            expected,
          );
          for (const x of plan.sleeves)
            expect(x.amountUsd).toBeCloseTo((sheet.amountUsd * expected[x.sleeve]) / 10_000, 2);
        }),
        { numRuns: RUNS * 2 },
      );
    },
    PATIENCE,
  );
});
