import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  allReasons,
  fixtureContext,
  fixtureLiquidity,
  fixtureYields,
  LIQUIDITY_SOURCE,
  launchShelf,
  NOW,
  sheet,
  violations,
} from './testing';
import { PersonalInputError, type PersonalProposal, type PersonalSheet } from './types';

// What a plan says has to be true where it says it. Each case here is one a review found: a reason
// with no subject, a reason that contradicted what the person chose, a reason that said "left out"
// on a line that held the thing, and a figure that shaped the plan with no label on it.

const shelf = launchShelf();
const ctx = fixtureContext();
const line = (plan: PersonalProposal, id: string) => plan.lines.find((l) => l.assetId === id);
const rulesOn = (plan: PersonalProposal, id: string) => line(plan, id)?.reasons.map((r) => r.rule);
/** The rules that say something was left out. */
const LEFT_OUT = [
  'MAX_LINES',
  'BELOW_MINIMUM',
  'EXCLUDED',
  'NOT_FOR_GOAL',
  'NOT_IN_COUNTRY',
  'NOT_ON_CHAIN',
];

describe('a reason names what it is about', () => {
  it('at $20 the dollar-yield share is too small to hold, and the cash line says that, not " is left out"', () => {
    for (const language of ['en', 'pt'] as const) {
      const plan = compose(sheet({ amountUsd: 20, risk: 'high', language }), shelf, ctx);
      for (const r of allReasons(plan)) {
        for (const [key, value] of Object.entries(r.params))
          expect(String(value), `${r.rule}.${key}`).not.toBe('');
        expect(r.text, r.rule).not.toMatch(/^\s|\s\s|\s[:,.]/);
      }
      expect(violations(plan, shelf, ctx)).toEqual([]);
      const cash = line(plan, 'solana:usdc');
      expect(cash?.amountUsd).toBe(1);
      expect(cash?.reasons.map((r) => r.rule)).toContain('YIELD_TOO_SMALL');
      expect(cash?.reasons.map((r) => r.rule)).not.toContain('BELOW_MINIMUM');
    }
    const plan = compose(sheet({ amountUsd: 20, risk: 'high' }), shelf, ctx);
    expect(line(plan, 'solana:usdc')?.reasons.find((r) => r.rule === 'YIELD_TOO_SMALL')?.text).toBe(
      '$1 meant for dollar yield stays in cash: it is too small to be a part of your plan.',
    );
  });

  it('what stocks could not take, and is too small for dollar yield, is named too', () => {
    // The 500 can take $15 here, so $4 of the $19 meant for stocks spills, and $4 is under the least
    // a part of a plan can be.
    const tight = fixtureContext({ liquidity: fixtureLiquidity({ 'solana:spyx': 60 }) });
    const plan = compose(sheet({ amountUsd: 20, risk: 'high' }), shelf, tight);
    expect(violations(plan, shelf, tight)).toEqual([]);
    expect(line(plan, 'solana:usdc')?.amountUsd).toBe(5);
    for (const r of allReasons(plan))
      for (const value of Object.values(r.params)) expect(String(value), r.rule).not.toBe('');
  });
});

describe('a reason does not contradict what the person chose', () => {
  it('gold beside a chosen portfolio that holds none: not "when you choose no shared portfolio"', () => {
    const plan = compose(sheet({ themes: ['the-seven'] }), shelf, ctx);
    expect(rulesOn(plan, 'solana:gldx')).not.toContain('SLEEVE_DEFAULT');
    expect(line(plan, 'solana:gldx')?.reasons.find((r) => r.rule === 'SLEEVE_FILLED')?.text).toBe(
      'GLD holds the gold share of this plan: no shared portfolio you chose fills it.',
    );
    for (const r of allReasons(plan)) expect(r.rule).not.toBe('SLEEVE_DEFAULT');
  });

  it('with no portfolio chosen, the starting one is named as that', () => {
    const plan = compose(sheet(), shelf, ctx);
    expect(rulesOn(plan, 'solana:spyx')).toContain('SLEEVE_DEFAULT');
    expect(line(plan, 'solana:spyx')?.reasons.find((r) => r.rule === 'SLEEVE_DEFAULT')?.text).toBe(
      'The 500: where a goal to grow starts when you choose no shared portfolio.',
    );
    for (const r of allReasons(plan)) expect(r.rule).not.toBe('SLEEVE_FILLED');
  });

  it('a chosen portfolio with no version on this chain: the sleeve starts where the goal starts, and says the choice did not fill it', () => {
    for (const themes of [['sand-to-server'], ['no-such-portfolio']]) {
      const plan = compose(sheet({ themes }), shelf, ctx);
      expect(violations(plan, shelf, ctx)).toEqual([]);
      expect(plan.removed.map((r) => r.ref)).toContain(themes[0]);
      expect(rulesOn(plan, 'solana:spyx')).not.toContain('SLEEVE_DEFAULT');
      expect(line(plan, 'solana:spyx')?.reasons.find((r) => r.rule === 'SLEEVE_FILLED')?.text).toBe(
        'The 500 holds the stocks and crypto share of this plan: no shared portfolio you chose fills it.',
      );
    }
    const plan = compose(sheet({ themes: ['sand-to-server'] }), shelf, ctx);
    expect(
      plan.removed.find((r) => r.ref === 'sand-to-server')?.reasons.map((r) => r.text),
    ).toEqual(['Sand to Server is left out: it has no version on Solana.']);
  });
});

describe('a reason on a line is true of that line', () => {
  const two = sheet({
    themes: ['the-seven', 'chips-and-agents'],
    chains: ['base'],
    risk: 'high',
    amountUsd: 20_000,
  });

  it('a portfolio opened for lack of room is not called "left out" on the lines that hold it', () => {
    const plan = compose(two, shelf, ctx);
    expect(violations(plan, shelf, ctx)).toEqual([]);
    const names = shelf.families.map((f) => f.meta.name);
    const tokens = new Map(shelf.assets.map((a) => [a.id, a]));
    for (const l of plan.lines) {
      const token = tokens.get(l.assetId);
      for (const r of l.reasons) {
        // No reason names a chain other than the one the plan is on.
        if (r.params.chain !== undefined) expect(r.params.chain, r.text).toBe('base');
        if (!LEFT_OUT.includes(r.rule) || token?.cls === 'cash') continue;
        expect(names, `${l.assetId}: ${r.text}`).not.toContain(r.params.asset);
        expect([token?.symbol, token?.underlying], `${l.assetId}: ${r.text}`).not.toContain(
          r.params.asset,
        );
      }
    }
    // The portfolio that did not fit says why, as a fact about the portfolio.
    const why = plan.lines.flatMap((l) => l.reasons).filter((r) => r.rule.startsWith('NOT_WHOLE_'));
    expect(why.length).toBeGreaterThan(0);
    expect(why[0]?.text).toBe(
      'Chips & Agents cannot be held whole: a plan holds at most 8 parts, and it would make 9.',
    );
  });

  it('the base plan: the reason The Seven is opened names the issuer cap as a fact about it', () => {
    const plan = compose(sheet({ themes: ['the-seven'] }), shelf, ctx);
    expect(
      line(plan, 'solana:nvdax')?.reasons.find((r) => r.rule === 'NOT_WHOLE_ISSUER')?.text,
    ).toBe(
      'The Seven cannot be held whole: more than 70% of the plan would be with Backed (xStocks), the most with one issuer at medium risk.',
    );
    // "Backed is at that limit" is said only on the line that was cut short by it.
    expect(
      plan.lines
        .filter((l) => l.reasons.some((r) => r.rule === 'ISSUER_CAP'))
        .map((l) => l.assetId),
    ).toEqual(['solana:msftx']);
  });
});

describe('a figure that shaped the plan is on the plan', () => {
  it('a fixture capacity that removes a token is listed and labelled', () => {
    const none = fixtureContext({ liquidity: fixtureLiquidity({ 'solana:spyx': 0 }) });
    const plan = compose(sheet(), shelf, none);
    expect(plan.lines.some((l) => l.assetId === 'solana:spyx')).toBe(false);
    expect(plan.flags).toContain('liquidity_provenance:fixture');
    expect(plan.observations.map((o) => `${o.kind}:${o.id}`)).toContain('liquidity:solana:spyx');
    expect(violations(plan, shelf, none)).toEqual([]);
  });

  it('lists the yield of every dollar-yield token that was ranked, held or not', () => {
    const plan = compose(sheet(), shelf, ctx);
    expect(plan.lines.some((l) => l.assetId === 'solana:jlusdc')).toBe(false);
    expect(plan.observations.filter((o) => o.kind === 'yield').map((o) => o.id)).toEqual([
      'solana:jlusdc',
      'solana:syrupusdc',
    ]);
  });

  it('carries the time and the source the provider and the caller give, and never makes one up', () => {
    const dated = compose(sheet(), shelf, ctx);
    const read = dated.observations.find((o) => o.kind === 'liquidity');
    expect(read).toMatchObject({
      source: LIQUIDITY_SOURCE,
      method: 'fixture-0.1',
      fetchedAt: '2026-10-02T00:00:00.000Z',
      provenance: 'fixture',
    });
    expect(dated.flags.filter((f) => /undated|unsourced/.test(f))).toEqual([]);

    // A provider that gives no time, wired by a caller that names no source.
    const bare = {
      now: NOW,
      yields: fixtureYields(),
      liquidity: fixtureLiquidity(undefined, 40, null),
    };
    const plan = compose(sheet(), shelf, bare);
    for (const o of plan.observations.filter((x) => x.kind === 'liquidity')) {
      expect(o.fetchedAt, o.id).toBeNull();
      expect(o.source, o.id).toBeNull();
      expect(plan.flags).toContain(`liquidity_undated:${o.id}`);
    }
    expect(plan.flags).toContain('liquidity_unsourced');
    expect(JSON.stringify(plan.observations)).not.toContain(NOW);
    expect(violations(plan, shelf, bare)).toEqual([]);
  });
});

describe('what compose is handed is checked before it is used', () => {
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
  const [first] = fixtureYields();
  if (!first) throw new Error('no fixture yield');

  it('refuses a yield with no source, no method, no time, or a number that is not one', () => {
    const bad = [
      { assetId: 'solana:syrupusdc', quotedYield: 0.5, haircutYield: 0.5 },
      { ...first, source: '' },
      { ...first, method: '' },
      { ...first, fetchedAt: 'last week' },
      { ...first, haircutYield: Number.NaN },
      { ...first, quotedYield: Number.POSITIVE_INFINITY },
      { ...first, provenance: 'trust me' },
    ];
    for (const y of bad) {
      const income = sheet({ goal: 'income', incomeTargetUsdMonthly: 30 });
      const context = fixtureContext({ yields: [y as never] });
      expect(
        code(() => compose(income, shelf, context)),
        JSON.stringify(y),
      ).toBe('InvalidContext');
    }
  });

  it('gives the same plan in whatever order the yields are listed, and counts the lower of two equally good', () => {
    const ys = fixtureYields();
    const [jl] = ys.filter((y) => y.assetId === 'solana:jlusdc');
    if (!jl) throw new Error('no fixture yield for jlUSDC');
    // A second observation of the same token, as good as the first (same method and time), higher.
    const higher = { ...jl, quotedYield: 0.09, haircutYield: 0.08 };
    const plans = [[...ys, higher], [higher, ...ys], [...ys].reverse().concat(higher, higher)].map(
      (yields) => compose(sheet(), shelf, fixtureContext({ yields })),
    );
    expect(plans[1]).toEqual(plans[0]);
    expect(plans[2]).toEqual(plans[0]);
    // The lower one counts: jlUSDC stays behind syrupUSDC.
    expect(plans[0]?.lines.some((l) => l.assetId === 'solana:syrupusdc')).toBe(true);
    expect(plans[0]?.lines.some((l) => l.assetId === 'solana:jlusdc')).toBe(false);
  });
});

describe('what the person already holds', () => {
  const BASE = sheet({ themes: ['the-seven'] });
  const base = compose(BASE, shelf, ctx);
  const withHeld = (valueUsd: number, over = BASE) =>
    compose(over, shelf, fixtureContext({ holdings: [{ underlying: 'NVDA', valueUsd }] }));

  it('a holding under the threshold is ignored everywhere: $60 of NVDA beside a $10,000 plan', () => {
    // The threshold is 1% of the amount: $100 here.
    expect(withHeld(60).lines).toEqual(base.lines);
    expect(withHeld(99.99).lines).toEqual(base.lines);
    expect(withHeld(100).lines).not.toEqual(base.lines);
  });

  it('a holding that counts leaves a reason on every line it moved, gold and dollar yield too', () => {
    const movedBy = (over: PersonalSheet) => {
      const without = compose(over, shelf, ctx);
      const plan = withHeld(4_000, over);
      const before = new Map(without.lines.map((l) => [l.assetId, l.amountUsd]));
      const moved = plan.lines.filter((l) => before.get(l.assetId) !== l.amountUsd);
      for (const l of moved)
        expect(
          l.reasons.some((r) => r.inputs.includes('holdings')),
          `${l.assetId} moved from ${before.get(l.assetId)} to ${l.amountUsd} with no reason naming holdings`,
        ).toBe(true);
      return { plan, moved: moved.map((l) => l.assetId) };
    };
    const grow = movedBy(BASE);
    expect(grow.moved).toEqual(expect.arrayContaining(['solana:gldx', 'solana:aaplx']));
    expect(
      line(grow.plan, 'solana:gldx')?.reasons.find((r) => r.rule === 'MORE_BECAUSE_HELD')?.text,
    ).toBe('A larger share here: you already hold $4,000 of NVDA, so this plan buys less of it.');
    // A plan to protect has room under the issuer cap, so its dollar yield moves too, and says why.
    const protect = movedBy({ ...BASE, goal: 'protect' });
    expect(protect.moved).toEqual(
      expect.arrayContaining(['solana:gldx', 'solana:syrupusdc', 'solana:aaplx']),
    );
    expect(rulesOn(protect.plan, 'solana:syrupusdc')).toContain('MORE_BECAUSE_HELD');
  });

  it('sets the target on the amount plus the holding, then takes the holding off', () => {
    // Grow at high risk: 95% in The Seven, so $1,360.40 of NVDA. With $1,000 of it held the target is
    // set on $11,000: $1,496.44, less the $1,000 held. The other lines are scaled by the same 1.1.
    const plan = withHeld(1_000, sheet({ themes: ['the-seven'], risk: 'high' }));
    expect(line(plan, 'solana:nvdax')?.amountUsd).toBe(496.44);
    expect(line(plan, 'solana:aaplx')?.amountUsd).toBe(1492.26);
    expect(line(plan, 'solana:syrupusdc')?.amountUsd).toBe(550);
    expect(rulesOn(plan, 'solana:nvdax')).toContain('ALREADY_HELD');
  });

  it('a shared portfolio with a held part is not followed whole: the held part is cut on its own line', () => {
    const ana = sheet({
      amountUsd: 2_000,
      risk: 'high',
      themes: ['sand-to-server'],
      chains: ['robinhood'],
    });
    const whole = compose(ana, shelf, ctx);
    expect(whole.lines.filter((l) => l.viaIndex === 'sand-to-server')).toHaveLength(7);
    const plan = withHeld(300, ana);
    expect(plan.lines.every((l) => l.viaIndex === undefined)).toBe(true);
    expect(plan.recipes[0]?.components.every((c) => c.kind === 'asset')).toBe(true);
    expect(rulesOn(plan, 'robinhood:nvda')).toEqual(
      expect.arrayContaining(['OPENED', 'ALREADY_HELD']),
    );
    expect(line(plan, 'robinhood:nvda')?.amountUsd).toBeLessThan(570);
  });
});

describe('an income goal: what the verdict says is so', () => {
  const carla = sheet({
    goal: 'income',
    amountUsd: 80_000,
    horizonMonths: 60,
    incomeTargetUsdMonthly: 300,
  });
  const yields = new Map(fixtureYields().map((y) => [y.assetId, y.haircutYield]));
  const monthly = (plan: PersonalProposal) =>
    plan.lines.reduce((n, l) => n + l.amountUsd * (yields.get(l.assetId) ?? 0), 0) / 12;

  it('states the gap to the cent, at the yield after haircut', () => {
    const plan = compose(carla, shelf, ctx);
    // $50,000 and $30,000 in the two dollar-yield tokens: $272.63 a month after haircut.
    expect(monthly(plan)).toBeCloseTo(272.625, 6);
    expect(plan.verdict?.met).toBe(false);
    expect(plan.verdict?.gapUsdMonthly).toBe(27.37);
  });

  it('lists a way only if it closes the gap: the amount it names does, and one step less does not', () => {
    const plan = compose(carla, shelf, ctx);
    expect(plan.verdict?.ways).toEqual([
      { change: 'You can add $10,600, for $90,600 in all.', closesGap: true },
      { change: 'You can aim for $272 a month instead of $300.', closesGap: true },
    ]);
    expect(compose({ ...carla, amountUsd: 90_600 }, shelf, ctx).verdict?.met).toBe(true);
    expect(compose({ ...carla, amountUsd: 90_500 }, shelf, ctx).verdict?.met).toBe(false);
    expect(compose({ ...carla, incomeTargetUsdMonthly: 272 }, shelf, ctx).verdict?.met).toBe(true);
  });

  it('says once that no amount closes the gap, when the tokens that pay are at their limits', () => {
    // Both dollar-yield tokens of this chain full: about $324 a month at most.
    const plan = compose({ ...carla, incomeTargetUsdMonthly: 400 }, shelf, ctx);
    expect(plan.verdict?.ways).toEqual([
      {
        change: 'No larger amount closes the gap with the dollar-yield tokens you can hold.',
        closesGap: false,
      },
      { change: 'You can aim for $272 a month instead of $400.', closesGap: true },
    ]);
    const most = compose(
      { ...carla, amountUsd: 1_000_000, incomeTargetUsdMonthly: 400 },
      shelf,
      ctx,
    );
    expect(most.verdict?.met).toBe(false);
  });

  it('an income plan that holds nothing in dollar yield pays nothing: not met, the gap is the target, no cash flow', () => {
    // Base lists no dollar-yield token today.
    const plan = compose({ ...carla, chains: ['base'] }, shelf, ctx);
    expect(plan.lines.map((l) => l.assetId)).toEqual(['base:usdc']);
    expect(plan.card.cashFlow).toBe('none');
    expect(plan.verdict).toEqual({
      met: false,
      gapUsdMonthly: 300,
      ways: [
        {
          change: 'No larger amount closes the gap with the dollar-yield tokens you can hold.',
          closesGap: false,
        },
      ],
    });
    // With no target there is no verdict, and still no cash flow to show.
    const { incomeTargetUsdMonthly: _, ...noTarget } = { ...carla, chains: ['base' as const] };
    const quiet = compose(noTarget, shelf, ctx);
    expect(quiet.verdict).toBeUndefined();
    expect(quiet.card.cashFlow).toBe('none');
  });

  it('a met target has no gap and no way to list', () => {
    const plan = compose({ ...carla, incomeTargetUsdMonthly: 200 }, shelf, ctx);
    expect(plan.verdict).toEqual({ met: true, gapUsdMonthly: 0, ways: [] });
    expect(plan.card.cashFlow).toBe('monthly');
  });
});

describe('the hash of the inputs pins everything that shaped the plan', () => {
  const person = sheet({ themes: ['the-seven'] });
  const hashOf = (over: Partial<Parameters<typeof fixtureContext>[0]> = {}, onShelf = shelf) =>
    compose(person, onShelf, fixtureContext(over)).inputsHash;
  const base = hashOf();

  it('changes with the holdings, the yields, the liquidity figures, the shelf and the table', () => {
    expect(hashOf()).toBe(base);
    expect(hashOf({ holdings: [{ underlying: 'SOL', valueUsd: 20_000 }] })).not.toBe(base);
    expect(hashOf({ yields: fixtureYields().slice(1) })).not.toBe(base);
    expect(hashOf({ liquidity: fixtureLiquidity({ 'solana:nvdax': 2_000 }) })).not.toBe(
      hashOf({ liquidity: fixtureLiquidity({ 'solana:nvdax': 2_000_000 }) }),
    );
    expect(hashOf({ liquiditySource: 'somewhere else' })).not.toBe(base);
    // The same shelf version with one token's tier changed.
    const edited = {
      ...shelf,
      assets: shelf.assets.map((a) => (a.id === 'solana:nvdax' ? { ...a, tier: 'C' as const } : a)),
    };
    expect(hashOf({}, edited)).not.toBe(base);
    expect(hashOf({ params: { ...PERSONAL_PARAMS, fallBps: 2500 } })).not.toBe(base);
  });

  it('does not change with the order things are listed in', () => {
    const reordered = {
      ...shelf,
      assets: [...shelf.assets].reverse(),
      families: [...shelf.families]
        .reverse()
        .map((f) => ({ ...f, recipes: [...f.recipes].reverse() })),
    };
    const held = [
      { underlying: 'SOL', valueUsd: 20_000 },
      { underlying: 'NVDA', valueUsd: 700 },
    ];
    expect(hashOf({ yields: fixtureYields().reverse(), holdings: held }, reordered)).toBe(
      hashOf({ holdings: [...held].reverse() }),
    );
  });

  it('two liquidity tables that give different plans never share a hash', () => {
    const thin = compose(
      person,
      shelf,
      fixtureContext({ liquidity: fixtureLiquidity({ 'solana:nvdax': 2_000 }) }),
    );
    const deep = compose(
      person,
      shelf,
      fixtureContext({ liquidity: fixtureLiquidity({ 'solana:nvdax': 2_000_000 }) }),
    );
    expect(thin.lines).not.toEqual(deep.lines);
    expect(thin.inputsHash).not.toBe(deep.inputsHash);
  });
});

describe('a recipe never asks a vault for more of a token than its limit', () => {
  // Grow $333,333 at high risk in The Seven: AAPLx can take $10,000, which is 300.0003 basis points
  // of the amount. Rounded to the nearest whole basis point the target would be over the limit.
  const big = sheet({ amountUsd: 333_333, risk: 'high', themes: ['the-seven'] });

  it('rounds a target at its ceiling down, and says where the rest went', () => {
    const plan = compose(big, shelf, ctx);
    expect(violations(plan, shelf, ctx)).toEqual([]);
    const [recipe] = plan.recipes;
    const token = shelf.assets.find((a) => a.id === 'solana:aaplx');
    if (!recipe || !token) throw new Error('no recipe');
    const target = recipe.components.find((c) => c.kind === 'asset' && c.asset === token.id);
    const targetUsd = (recipe.amountUsd * (target?.weightBps ?? 0)) / 10_000;
    expect(targetUsd).toBeLessThanOrEqual(10_000);
    expect(targetUsd).toBeGreaterThan(10_000 - recipe.amountUsd / 10_000);
    // The line is its target: the same basis points, and dollars within one of them.
    const held = plan.lines.find((l) => l.assetId === token.id);
    expect(held?.weightBps).toBe(target?.weightBps);
    expect(held?.amountUsd).toBeLessThanOrEqual(10_000);
  });

  it('every line is its target, to the basis point, on every chain', () => {
    for (const chain of ['solana', 'robinhood', 'base'] as const)
      for (const amountUsd of [333_333, 858_895, 77_777.77]) {
        const plan = compose({ ...big, amountUsd, chains: [chain] }, shelf, ctx);
        expect(violations(plan, shelf, ctx), `${chain} ${amountUsd}`).toEqual([]);
        expect(plan.lines.reduce((n, l) => n + l.weightBps, 0)).toBe(10_000);
      }
  });

  it('says so on the cash line when a basis point was held back for a limit', () => {
    const plans = [333_333, 858_895, 77_777.77].map((amountUsd) =>
      compose({ ...big, amountUsd }, shelf, ctx),
    );
    const said = plans
      .flatMap((p) => p.lines.flatMap((l) => l.reasons))
      .filter((r) => r.rule === 'ROUNDING');
    expect(said.length).toBeGreaterThan(0);
    for (const r of said)
      expect(r.text).toMatch(
        /stays in cash: targets are whole basis points, and \w+ may not pass its limit\.$/,
      );
  });
});

describe('the words', () => {
  it('a sleeve reason says where the sleeve starts, which stays true when the plan moves it', () => {
    // Twelve months out, stocks are 30% of the plan, not the 80% the table starts from.
    const near = compose(sheet({ themes: ['the-seven'], horizonMonths: 12 }), shelf, ctx);
    expect(near.sleeves.find((s) => s.sleeve === 'growth')?.weightBps).toBe(3000);
    expect(line(near, 'solana:nvdax')?.reasons[0]?.text).toBe(
      'For a goal to grow at medium risk, the starting share of stocks and crypto is 80%.',
    );
    // On Base an income plan is all cash, and no line claims a share the plan does not hold.
    const cash = compose(sheet({ goal: 'income', chains: ['base'] }), shelf, ctx);
    expect(cash.lines.map((l) => [l.assetId, l.weightBps])).toEqual([['base:usdc', 10_000]]);
    for (const r of allReasons(cash)) expect(r.text).not.toMatch(/of the plan in/);
    expect(cash.lines[0]?.reasons.map((r) => r.text)).toEqual([
      'For a goal of income at medium risk, the starting share of dollar yield is 100%.',
      'No dollar-yield token you can hold is on Base, so $10,000 stays in cash.',
    ]);
  });

  it('names a country, not its code, and reads as a Brazilian would say it', () => {
    const blocked = {
      ...shelf,
      assets: shelf.assets.map((a) =>
        a.id === 'solana:nvdax' ? { ...a, blockedCountries: ['BR'] } : a,
      ),
    };
    const said = (language: 'en' | 'pt') =>
      compose(sheet({ themes: ['the-seven'], language }), blocked, ctx)
        .removed.find((r) => r.ref === 'NVDA')
        ?.reasons.map((r) => r.text);
    expect(said('en')).toEqual(['NVDAx is left out: it is not offered in Brazil.']);
    expect(said('pt')).toEqual(['NVDAx fica de fora: não é oferecido no Brasil.']);
    const pt = compose(sheet({ language: 'pt' }), shelf, ctx);
    expect(line(pt, 'solana:syrupusdc')?.reasons.map((r) => r.text)).toEqual([
      'Para um objetivo de crescimento, com risco médio, a parcela inicial de rendimento em dólar é 15%.',
      'Escolhido pelo rendimento após o deságio, entre os tokens de rendimento em dólar que você pode ter na Solana.',
      'Inclui US$ 1.500 que SPY não comporta neste tamanho.',
    ]);
  });

  it('writes a loss rounded up, and an amount under a dollar with its cents', () => {
    // $12 at high risk: $11.40 in The 500, so a 20% fall costs $2.28, written "$3", never "$2".
    const small = compose(sheet({ amountUsd: 12, risk: 'high' }), shelf, ctx);
    expect(line(small, 'solana:spyx')?.amountUsd).toBe(11.4);
    expect(line(small, 'solana:spyx')?.reasons.at(-1)?.text).toBe(
      'No return is assumed for this part of your plan. In a 20% fall it would lose $3.',
    );
    expect(small.card.expectedReturn.lossInFallUsd).toBe(2.28);
    expect(
      line(small, 'solana:usdc')?.reasons.find((r) => r.rule === 'YIELD_TOO_SMALL')?.text,
    ).toBe(
      '$0.60 meant for dollar yield stays in cash: it is too small to be a part of your plan.',
    );
  });
});

describe('the card', () => {
  const bruno = sheet({ goal: 'protect', amountUsd: 50_000, horizonMonths: 18, risk: 'low' });

  it('gives a range: after haircut at the low end, as quoted at the high end, and they differ', () => {
    // $25,000 and $5,000 in the two dollar-yield tokens of a $50,000 plan.
    const { expectedReturn } = compose(bruno, shelf, ctx).card;
    const ys = new Map(fixtureYields().map((y) => [y.assetId, y]));
    const part = (pick: 'haircutYield' | 'quotedYield') =>
      (25_000 * (ys.get('solana:syrupusdc')?.[pick] ?? 0) +
        5_000 * (ys.get('solana:jlusdc')?.[pick] ?? 0)) /
      500;
    expect(expectedReturn.lowPct).toBe(2.65);
    expect(expectedReturn.highPct).toBe(3.01);
    expect(expectedReturn.lowPct).toBeCloseTo(part('haircutYield'), 2);
    expect(expectedReturn.highPct).toBeCloseTo(part('quotedYield'), 2);
    expect(expectedReturn.highPct).toBeGreaterThan(expectedReturn.lowPct);
  });

  it('writes the exit cost rounded up, never down', () => {
    const { exit } = compose(bruno, shelf, ctx).card;
    // 12.75 basis points measured: "about 0.13%", not 0.12%.
    expect(exit.costBps).toBe(12.75);
    expect(exit.text).toBe(
      'You can withdraw the tokens to your own wallet at any time. Selling everything in the worst hours measured would cost about 0.13%; that is measured for 40% of the plan.',
    );
  });
});
