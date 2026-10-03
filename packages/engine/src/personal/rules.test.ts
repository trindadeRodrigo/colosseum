import { flatten } from '@colosseum/basket';
import { type Recipe, type Shelf, Targets } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import { sleeveOfClass } from './registry';
import {
  ceilingUsd,
  editShelf,
  expectedSleeves,
  fixtureContext,
  fixtureLiquidity,
  fixtureYields,
  launchShelf,
  NOW,
  sheet,
  sleeveBps,
  violations,
} from './testing';
import {
  type ComposeContext,
  PersonalInputError,
  type PersonalParameters,
  type PersonalProposal,
  type PersonalSheet,
} from './types';

// The rules that hold whatever the numbers in the parameter table are. Each is tried on the starting
// table and on tables Rodrigo might set, some of them unkind.

const shelf = launchShelf();
const P = PERSONAL_PARAMS;
const everyRow = (row: { growthBps: number; dollarYieldBps: number; goldBps: number }) =>
  Object.fromEntries(Object.keys(P.sleeves).map((key) => [key, row]));

const TABLES: Record<string, PersonalParameters> = {
  'the starting table': P,
  'income rows with a stock sleeve, as the prototype had': {
    ...P,
    sleeves: {
      ...P.sleeves,
      'income:low': { growthBps: 1000, dollarYieldBps: 8500, goldBps: 500 },
      'income:medium': { growthBps: 2500, dollarYieldBps: 7000, goldBps: 500 },
      'income:high': { growthBps: 4000, dollarYieldBps: 5500, goldBps: 500 },
    },
  },
  'every goal all in stocks, with no floors': {
    ...P,
    sleeves: everyRow({ growthBps: 10_000, dollarYieldBps: 0, goldBps: 0 }),
    glideFloor: [],
    cashFloor: [],
  },
  'tight caps, low ceilings, few lines': {
    ...P,
    capPerStockBps: { low: 300, medium: 500, high: 800 },
    capPerIssuerBps: { low: 1500, medium: 2000, high: 3000 },
    tierCeilingUsd: { A: 5000, B: 1000, C: 200 },
    minLineBps: 200,
    minLineUsd: 50,
    maxLinesPerChain: 3,
  },
  'no caps to speak of, and floors out of order': {
    ...P,
    sleeves: everyRow({ growthBps: 4000, dollarYieldBps: 3000, goldBps: 2000 }),
    capPerStockBps: { low: 10_000, medium: 10_000, high: 10_000 },
    capPerIssuerBps: { low: 10_000, medium: 10_000, high: 10_000 },
    tierCeilingUsd: { A: 1_000_000, B: 1_000_000, C: 1_000_000 },
    glideFloor: [
      { monthsLeft: 60, dollarYieldBps: 3500 },
      { monthsLeft: 6, dollarYieldBps: 9000 },
      { monthsLeft: 24, dollarYieldBps: 5000 },
    ],
    cashFloor: [
      { monthsLeft: 24, cashBps: 300 },
      { monthsLeft: 2, cashBps: 4000 },
    ],
    minLineBps: 1,
    minLineUsd: 0,
    maxLinesPerChain: 16,
  },
};

const CHAINS = ['solana', 'robinhood', 'base'] as const;
const GOALS = ['grow', 'income', 'protect'] as const;
const RISKS = ['low', 'medium', 'high'] as const;
const classOf = (onShelf: Shelf) => new Map(onShelf.assets.map((a) => [a.id, a]));
const assets = classOf(shelf);

/** A plan under a table, held to every rule the oracle knows. */
function plan(
  over: Partial<PersonalSheet>,
  table: PersonalParameters,
  context: Partial<ComposeContext> = {},
) {
  const ctx = fixtureContext({ params: table, ...context });
  const made = compose(sheet(over), shelf, ctx);
  expect(violations(made, shelf, ctx)).toEqual([]);
  return made;
}

describe.each(Object.entries(TABLES))('whatever the numbers: %s', (_name, table) => {
  it('stock tokens never appear in an income plan', () => {
    for (const risk of RISKS)
      for (const themes of [[], ['the-seven'], ['storm-cellar', 'home-team', 'the-500']]) {
        const made = plan({ goal: 'income', risk, themes, amountUsd: 25_000 }, table);
        for (const l of made.lines) {
          const cls = assets.get(l.assetId)?.cls;
          expect(['dollar_yield', 'cash'], `${l.assetId} at ${risk} risk`).toContain(cls);
        }
      }
  });

  it('nothing the person excluded appears', () => {
    const limits = [
      { cannotHold: { classes: ['crypto' as const, 'gold' as const] } },
      { cannotHold: { underlyings: ['NVDA', 'spy', 'GLD'] } },
      { cannotHold: { assets: ['solana:nvdax', 'solana:syrupusdc', 'robinhood:gld'] } },
      { cannotHold: { classes: ['stock' as const, 'etf' as const, 'dollar_yield' as const] } },
    ];
    for (const goal of GOALS)
      for (const limit of limits) {
        const made = plan(
          { goal, themes: ['the-seven', 'home-team', 'storm-cellar'], limits: limit },
          table,
        );
        for (const l of made.lines) {
          const a = assets.get(l.assetId);
          if (!a || a.cls === 'cash') continue;
          expect(limit.cannotHold.classes ?? [], l.assetId).not.toContain(a.cls);
          expect(
            (limit.cannotHold.underlyings ?? []).map((u) => u.toUpperCase()),
            l.assetId,
          ).not.toContain(a.underlying.toUpperCase());
          expect(limit.cannotHold.assets ?? []).not.toContain(a.id);
        }
      }
  });

  it('no line exceeds its ceiling, at any size', () => {
    for (const chain of CHAINS)
      for (const amountUsd of [10, 137.5, 9_999.99, 250_000, 1_000_000])
        for (const goal of GOALS) {
          const ctx = fixtureContext({ params: table });
          const themes = ['the-seven', 'sand-to-server'];
          const made = plan({ goal, amountUsd, themes, chains: [chain] }, table);
          for (const l of made.lines) {
            const a = assets.get(l.assetId);
            expect(l.chain, l.assetId).toBe(chain);
            if (a && a.cls !== 'cash')
              expect(l.amountUsd, l.assetId).toBeLessThanOrEqual(ceilingUsd(a, ctx));
          }
        }
  });

  it('a plan for a near date never holds less in cash and dollar yield than a far date is sized for', () => {
    // The sleeves never shrink as the date nears, and a plan never holds less than its sleeves ask.
    // A far plan can still hold extra in dollar yield, when its stocks found no room. What the
    // sleeves ask is worked out from the table by `expectedSleeves`, apart from the engine.
    for (const goal of GOALS)
      for (const risk of RISKS) {
        let before: { cash: number; kept: number } | null = null;
        for (const horizonMonths of [1, 3, 6, 12, 18, 24, 36, 60, 120, 480]) {
          const person = { goal, risk, horizonMonths, themes: ['the-seven'] };
          const sized = expectedSleeves(sheet(person), table);
          const asked = { cash: sized.cash, kept: sized.cash + sized.dollarYield };
          const made = plan(person, table);
          const where = `${goal} at ${risk} risk, ${horizonMonths} months`;
          expect(sleeveBps(made, shelf, 'cash'), where).toBeGreaterThanOrEqual(asked.cash);
          expect(
            sleeveBps(made, shelf, 'cash') + sleeveBps(made, shelf, 'dollarYield'),
            where,
          ).toBeGreaterThanOrEqual(asked.kept);
          if (before) {
            expect(before.cash, where).toBeGreaterThanOrEqual(asked.cash);
            expect(before.kept, where).toBeGreaterThanOrEqual(asked.kept);
          }
          before = asked;
        }
      }
  });

  it('stocks, crypto and gold show no assumed return, and the dollar loss in the fall', () => {
    for (const goal of GOALS) {
      const made = plan({ goal, amountUsd: 40_000, themes: ['storm-cellar', 'home-team'] }, table);
      let atRisk = 0;
      for (const l of made.lines) {
        const sleeve = sleeveOfClass(assets.get(l.assetId)?.cls ?? 'cash');
        const shown = l.reasons.filter((r) => r.rule === 'NO_RETURN_ASSUMED');
        if (sleeve === 'growth' || sleeve === 'gold') {
          atRisk += l.amountUsd;
          expect(shown, l.assetId).toHaveLength(1);
          expect(shown[0]?.params.fallBps).toBe(table.fallBps);
          expect(Number(shown[0]?.params.lossUsd)).toBeCloseTo(
            (l.amountUsd * table.fallBps) / 10_000,
            1,
          );
        } else expect(shown, l.assetId).toHaveLength(0);
      }
      expect(made.card.expectedReturn.lossInFallUsd).toBeCloseTo(
        (atRisk * table.fallBps) / 10_000,
        1,
      );
      // The range is the dollar-yield lines alone, from their own observations.
      const yields = new Map(fixtureYields().map((y) => [y.assetId, y]));
      const low = made.lines.reduce(
        (n, l) => n + l.amountUsd * (yields.get(l.assetId)?.haircutYield ?? 0),
        0,
      );
      expect(made.card.expectedReturn.lowPct).toBeCloseTo((100 * low) / 40_000, 2);
      // The yield observations on the plan are exactly those the dollar-yield tokens were ranked
      // by: both tokens of this chain whenever anything was held in dollar yield or meant for it,
      // whether or not each ended up with a line, and none otherwise.
      const observed = made.observations.filter((o) => o.kind === 'yield').map((o) => o.id);
      const ranked = made.lines.some(
        (l) =>
          sleeveOfClass(assets.get(l.assetId)?.cls ?? 'cash') === 'dollarYield' ||
          l.reasons.some((r) => ['UNPLACED', 'YIELD_TOO_SMALL'].includes(r.rule)),
      );
      expect(observed).toEqual(ranked ? ['solana:jlusdc', 'solana:syrupusdc'] : []);
    }
  });
});

describe('the floors, on the starting table', () => {
  const sleevesOf = (made: PersonalProposal) =>
    Object.fromEntries(made.sleeves.map((x) => [x.sleeve, x.weightBps]));

  // Two rows that hold a little in stocks and a quarter in gold, so a floor takes all the stocks and
  // then reaches the gold. No row of the starting table does since a plan to protect lost its stocks
  // (gate PROTECT-NO-STOCKS): these are the rows a plan to protect had, given to a goal to grow.
  const MIXED: PersonalParameters = {
    ...P,
    sleeves: {
      ...P.sleeves,
      'grow:low': { growthBps: 2000, dollarYieldBps: 5500, goldBps: 2500 },
      'grow:medium': { growthBps: 3500, dollarYieldBps: 4000, goldBps: 2500 },
    },
  };

  it('the date fills dollar yield from stocks first, and from gold only then', () => {
    // 35% stocks, 40% dollar yield, 25% gold. Six months out dollar yield is 80% at least: all the
    // stocks go, then 5 points of gold; then 10 points of gold to cash.
    const made = plan({ risk: 'medium', horizonMonths: 6 }, MIXED);
    expect(sleevesOf(made)).toEqual({ growth: 0, dollarYield: 8000, gold: 1000, cash: 1000 });
    // A year out: 60% at least, so 20 points of stocks go, and no gold; then 5 points to cash.
    const year = plan({ risk: 'medium', horizonMonths: 12 }, MIXED);
    expect(sleevesOf(year)).toEqual({ growth: 1000, dollarYield: 6000, gold: 2500, cash: 500 });
  });

  it('what must not be lost takes from stocks first, then from gold, and is honoured', () => {
    // 20% stocks, 55% dollar yield, 25% gold. $9,000 of $10,000 must be kept: all the stocks go,
    // then 15 points of gold.
    const made = plan({ risk: 'low', limits: { mustKeepUsd: 9_000 } }, MIXED);
    expect(sleevesOf(made)).toEqual({ growth: 0, dollarYield: 9000, gold: 1000, cash: 0 });
    const all = plan({ risk: 'low', limits: { mustKeepUsd: 10_000 } }, MIXED);
    expect(sleevesOf(all)).toEqual({ growth: 0, dollarYield: 10_000, gold: 0, cash: 0 });
  });

  it('a plan to protect, on the starting table: the date and what must be kept take from its gold', () => {
    // 75% dollar yield and 25% gold. Six months out: 80% at least, then 10% in cash, both from gold.
    const near = plan({ goal: 'protect', horizonMonths: 6 }, P);
    expect(sleevesOf(near)).toEqual({ growth: 0, dollarYield: 8000, gold: 1000, cash: 1000 });
    const kept = plan({ goal: 'protect', limits: { mustKeepUsd: 9_000 } }, P);
    expect(sleevesOf(kept)).toEqual({ growth: 0, dollarYield: 9000, gold: 1000, cash: 0 });
  });
});

describe('a near date, on the starting table', () => {
  it('holds strictly more cash and more in cash and dollar yield together', () => {
    for (const goal of ['grow', 'protect'] as const)
      for (const risk of RISKS) {
        const near = plan({ goal, risk, horizonMonths: 6 }, P);
        const far = plan({ goal, risk, horizonMonths: 120 }, P);
        const kept = (made: PersonalProposal) =>
          sleeveBps(made, shelf, 'cash') + sleeveBps(made, shelf, 'dollarYield');
        expect(sleeveBps(near, shelf, 'cash'), `${goal} ${risk}`).toBeGreaterThan(
          sleeveBps(far, shelf, 'cash'),
        );
        expect(kept(near), `${goal} ${risk}`).toBeGreaterThan(kept(far));
      }
    const income = [6, 120].map((horizonMonths) => plan({ goal: 'income', horizonMonths }, P));
    expect(sleeveBps(income[0] as PersonalProposal, shelf, 'cash')).toBe(1000);
    expect(sleeveBps(income[1] as PersonalProposal, shelf, 'cash')).toBe(0);
  });

  it('says the loss in a fall in the words of the line', () => {
    // $10,000 in gold, the one part of this plan with a price that can fall.
    const made = plan({ goal: 'protect', amountUsd: 50_000, horizonMonths: 18, risk: 'low' }, P);
    expect(made.lines.find((l) => l.assetId === 'solana:gldx')?.reasons.at(-1)?.text).toBe(
      'No return is assumed for this part of your plan. In a 20% fall it would lose $2,000.',
    );
    expect(made.card.expectedReturn.lossInFallUsd).toBe(2000);
  });
});

describe('what compose refuses, and what it says instead of pretending', () => {
  const code = (work: () => unknown) => {
    try {
      work();
    } catch (error) {
      return error instanceof PersonalInputError
        ? error.code
        : `not a PersonalInputError: ${error}`;
    }
    return 'did not throw';
  };

  it('never runs on a sheet that is not valid', () => {
    const bad: Partial<PersonalSheet>[] = [
      { amountUsd: 5 },
      { amountUsd: 2_000_000 },
      { horizonMonths: 0 },
      { country: 'Brazil' },
      { chains: [] },
      { chains: ['solana', 'robinhood'] },
      { themes: ['a', 'b', 'c', 'd'] },
      { limits: { mustKeepUsd: 20_000 } },
      { goal: 'speculate' as never },
    ];
    for (const over of bad)
      expect(
        code(() => compose(sheet(over), shelf, fixtureContext())),
        JSON.stringify(over),
      ).toBe('InvalidSheet');
    expect(code(() => compose(sheet(), shelf, { now: 'yesterday' }))).toBe('InvalidContext');
    expect(
      code(() => compose(sheet(), shelf, fixtureContext({ holdings: [{ valueUsd: 5 }] }))),
    ).toBe('InvalidContext');
    expect(
      code(() => compose(sheet(), shelf, fixtureContext({ params: { ...P, sleeves: {} } }))),
    ).toBe('InvalidParams');
    const over100 = {
      ...P.sleeves,
      'grow:medium': { growthBps: 9000, dollarYieldBps: 2000, goldBps: 0 },
    };
    expect(
      code(() => compose(sheet(), shelf, fixtureContext({ params: { ...P, sleeves: over100 } }))),
    ).toBe('InvalidParams');
    const noCash = { ...shelf, assets: shelf.assets.filter((a) => a.cls !== 'cash') };
    expect(code(() => compose(sheet(), noCash, fixtureContext()))).toBe('InvalidShelf');
  });

  it('leaves out a shared portfolio it does not know, or that has no version on this chain, and says so', () => {
    const made = plan({ themes: ['no-such-portfolio', 'sand-to-server'], chains: ['solana'] }, P);
    expect(made.removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)])).toEqual([
      ['no-such-portfolio', ['THEME_UNKNOWN']],
      ['sand-to-server', ['THEME_NOT_ON_CHAIN']],
    ]);
    // With nothing left to start from, the sleeve starts where the goal starts, and says that what
    // was chosen did not fill it.
    expect(
      made.lines.find((l) => l.assetId === 'solana:spyx')?.reasons.map((r) => r.rule),
    ).toContain('SLEEVE_FILLED');
  });

  it('holds nothing on another chain, even when a recipe names a token of one', () => {
    // A recipe for Solana that lists Robinhood Chain's NVDA in place of its own: a mistake on the
    // shelf. The portfolio is not held whole, and no line leaves the person's chain.
    const mixed: Shelf = {
      ...shelf,
      families: shelf.families.map((f) => ({
        ...f,
        recipes: f.recipes.map((r) =>
          f.meta.slug === 'the-seven' && r.chain === 'solana'
            ? {
                ...r,
                components: r.components.map((c) =>
                  c.kind === 'asset' && c.asset === 'solana:nvdax'
                    ? { ...c, asset: 'robinhood:nvda' }
                    : c,
                ),
              }
            : r,
        ),
      })),
    };
    const ctx = fixtureContext();
    const made = compose(sheet({ themes: ['the-seven'], risk: 'high' }), mixed, ctx);
    expect(violations(made, mixed, ctx)).toEqual([]);
    expect(made.lines.every((l) => l.chain === 'solana')).toBe(true);
    expect(made.recipes[0]?.components.every((c) => c.kind === 'asset')).toBe(true);
    // The Solana token of the same stock is held in its place.
    expect(made.lines.some((l) => l.assetId === 'solana:nvdax')).toBe(true);
  });

  it('holds cash, with a reason, where a chain has no dollar yield: protect on Base alone', () => {
    const made = plan({ goal: 'protect', chains: ['base'] }, P);
    const cash = made.lines.find((l) => l.assetId === 'base:usdc');
    expect(cash?.weightBps).toBeGreaterThanOrEqual(4000);
    expect(cash?.reasons.map((r) => r.rule)).toContain('NO_DOLLAR_YIELD');
    expect(made.flags).toContain('no_dollar_yield');
    // A recipe that leaves room for cash: its targets add up to less than 10,000.
    const [recipe] = made.recipes;
    expect(recipe?.components.reduce((n, c) => n + c.weightBps, 0)).toBeLessThan(10_000);
  });

  it('spills into dollar yield what one issuer may not hold: Solana alone at medium risk', () => {
    const made = plan({ themes: ['the-seven'], chains: ['solana'] }, P);
    expect(sleeveBps(made, shelf, 'growth') + sleeveBps(made, shelf, 'gold')).toBe(7000);
    expect(
      made.lines.find((l) => l.assetId === 'solana:syrupusdc')?.reasons.map((r) => r.rule),
    ).toContain('OVERFLOW_ISSUER');
  });

  it('does not let a capacity read from no sample decide a ceiling', () => {
    const thin = fixtureLiquidity({ 'solana:spyx': 0 }, 0);
    const made = plan({}, P, { liquidity: thin });
    // Its tier still holds it: 70% with one issuer at most, less the gold that issuer also holds.
    expect(made.lines.find((l) => l.assetId === 'solana:spyx')?.weightBps).toBe(6500);
    expect(made.flags).toContain('exit_capacity_thin:solana:spyx');
    const measured = plan({}, P, { liquidity: fixtureLiquidity({ 'solana:spyx': 0 }) });
    expect(measured.lines.some((l) => l.assetId === 'solana:spyx')).toBe(false);
  });

  it('says so when a figure is not live', () => {
    const mock = editShelf(shelf, (a) => ({ ...a, provenance: 'mock' }));
    const made = compose(sheet(), mock, fixtureContext());
    expect(made.flags).toEqual(
      expect.arrayContaining(['shelf_provenance:mock', 'yield_provenance:fixture']),
    );
    for (const o of made.observations) expect(o.provenance).toBe('fixture');
  });
});

describe('the same inputs, the same plan', () => {
  const ctx = fixtureContext({ holdings: [{ underlying: 'NVDA', valueUsd: 700 }] });
  const person = sheet({
    themes: ['the-seven', 'storm-cellar'],
    amountUsd: 120_000,
    horizonMonths: 30,
  });
  const made = compose(person, shelf, ctx);

  it('is the same plan twice, and in whatever order the shelf is listed', () => {
    expect(compose(person, shelf, ctx)).toEqual(made);
    for (let turn = 1; turn <= 5; turn += 1) {
      const shuffled: Shelf = {
        ...shelf,
        assets: [...shelf.assets]
          .sort((a, b) => ((a.id.length * turn) % 7) - ((b.id.length * turn) % 7))
          .reverse(),
        families: [...shelf.families].reverse().map((f) => ({
          ...f,
          recipes: [...f.recipes].reverse().map((r) => ({
            ...r,
            components:
              turn % 2
                ? [...r.components].reverse()
                : [...r.components.slice(turn), ...r.components.slice(0, turn)],
          })),
        })),
      };
      expect(compose(person, shuffled, ctx)).toEqual(made);
    }
  });

  it('carries the hashes that say what it was made from', () => {
    expect(made.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(made.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(made.shelfVersion).toBe(shelf.version);
    const other = compose({ ...person, amountUsd: 120_001 }, shelf, ctx);
    expect(other.inputsHash).not.toBe(made.inputsHash);
    expect(other.paramsHash).toBe(made.paramsHash);
    const later = compose(person, shelf, { ...ctx, now: '2026-11-03T15:00:00.000Z' });
    expect(later.inputsHash).not.toBe(made.inputsHash);
    const tuned = compose(person, shelf, { ...ctx, params: { ...P, minLineUsd: 6 } });
    expect(tuned.paramsHash).not.toBe(made.paramsHash);
  });

  it('reads the goal date from the time it is given, not from a clock', () => {
    const near = compose(sheet({ horizonMonths: 6 }), shelf, { now: NOW });
    const glide = near.lines.flatMap((l) => l.reasons).find((r) => r.rule === 'GLIDE');
    expect(glide?.params.by).toBe('2027-04');
    expect(glide?.text).toContain('by April 2027');
    const acrossTheYear = compose(sheet({ horizonMonths: 3 }), shelf, {
      now: '2026-12-31T23:59:59.000Z',
    });
    expect(
      acrossTheYear.lines.flatMap((l) => l.reasons).find((r) => r.rule === 'GLIDE')?.params.by,
    ).toBe('2027-03');
  });
});

describe('a recipe is what a vault takes', () => {
  it('flattens, through packages/basket, to a set of targets with no cash to spare when the plan holds none', () => {
    const made = plan(
      {
        goal: 'grow',
        amountUsd: 2_000,
        risk: 'high',
        themes: ['sand-to-server'],
        chains: ['robinhood'],
      },
      P,
    );
    for (const r of made.recipes) {
      const recipe: Recipe = {
        schemaVersion: 1,
        familyId: '0'.repeat(64),
        chain: r.chain,
        onchainId: null,
        creator: shelf.assets.find((a) => a.chain === r.chain && a.cls === 'cash')?.address ?? '',
        kind: 'personal',
        version: 1,
        effectiveAt: 0,
        components: r.components,
        metaHash: '0'.repeat(64),
        maxFeeBps: 0,
        flags: 0,
      };
      const targets = flatten(recipe, shelf, {
        minLineBps: P.minLineBps,
        maxLines: P.maxLinesPerChain,
      });
      expect(Targets.safeParse(targets).success, r.chain).toBe(true);
    }
  });
});
