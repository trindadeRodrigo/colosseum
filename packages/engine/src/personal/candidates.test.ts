import type { Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { candidates, compose } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  distanceBps,
  fixtureContext,
  launchShelf,
  NOW,
  sheet,
  usdBrl,
  violations,
  withReais,
} from './testing';
import type {
  ComposeContext,
  PersonalCandidates,
  PersonalProposal,
  PersonalSheet,
  Scorecard,
} from './types';
import { buildWorld, monthAfter } from './world';

// Slice 3 of docs/vault/PROMPT-BUILD-SOLVER.md: the three candidates (gate THREE-PLANS, C10), their
// scorecard (C11) and the ways to close a gap in the status (C12). The comparison below is written
// apart from the engine's, so the test does not grade the engine with its own rule.

const launch = launchShelf();
const ctx = fixtureContext();
const inMonths = (n: number) => monthAfter(NOW, n);
const monthly = (amount: number, months: number, currency = 'USD') =>
  Array.from({ length: months }, (_, m) => ({ month: inMonths(m), amount, currency }));

const run = (s: PersonalSheet, shelf: Shelf = launch, c: ComposeContext = ctx) => {
  const answer = candidates(s, shelf, c);
  for (const { plan } of answer.shown) expect(violations(plan, shelf, c)).toEqual([]);
  return answer;
};

/** Each number of the scorecard and which way is better; a stress that does not apply pays the base. */
function numbers(card: Scorecard, stresses: string[]): [number | null, 'up' | 'down'][] {
  return [
    [card.monthsCovered, 'up'],
    [card.base?.monthsPaid ?? null, 'up'],
    [card.carryObservedBps, 'up'],
    [card.exit.costBps, 'down'],
    [card.exit.measuredShareBps, 'up'],
    [card.concentration.largestIssuerBps, 'down'],
    [card.concentration.issuers, 'up'],
    [card.creditBasisBps, 'down'],
    [card.openFxUsd ?? null, 'down'],
    ...stresses.map((id): [number | null, 'up'] => [
      card.stresses.find((s) => s.id === id)?.monthsPaid ?? card.base?.monthsPaid ?? null,
      'up',
    ]),
  ];
}

/** For each attribute every card has: +1 where `a` is better than `b`, -1 worse, 0 the same. */
function signs(a: Scorecard, b: Scorecard, stresses: string[]): number[] {
  const [x, y] = [numbers(a, stresses), numbers(b, stresses)];
  return x.flatMap(([va, way], i) => {
    const vb = y[i]?.[0] ?? null;
    if (va === null || vb === null) return [];
    return [way === 'up' ? Math.sign(va - vb) : Math.sign(vb - va)];
  });
}

function checkChoice(answer: PersonalCandidates) {
  const cards = answer.shown.map((c) => c.plan.scorecard as Scorecard);
  const stresses = [...new Set(cards.flatMap((c) => c.stresses.map((s) => s.id)))];
  // Present on every plan shown, in the fixed order, none twice.
  const order = answer.shown.map((c) => c.id);
  expect(order).toEqual(['cover', 'spread', 'carry'].filter((id) => order.includes(id as never)));
  expect(answer.shown.length + answer.notShown.length).toBe(3);
  for (const n of answer.notShown) expect(n.why.length).toBeGreaterThan(20);
  answer.shown.forEach((a, i) => {
    expect(a.plan.candidate).toBe(a.id);
    answer.shown.forEach((b, j) => {
      if (i === j) return;
      // Different enough to be a choice.
      expect(distanceBps(a.plan, b.plan)).toBeGreaterThanOrEqual(
        PERSONAL_PARAMS.candidates.distinctBps,
      );
      // Not weakly dominated: b is not at least as good everywhere and better somewhere.
      const s = signs(b.plan.scorecard as Scorecard, a.plan.scorecard as Scorecard, stresses);
      expect(s.every((x) => x >= 0) && s.some((x) => x > 0), `${b.id} dominates ${a.id}`).toBe(
        false,
      );
    });
    // Wins at least one attribute outright, when there is anything to win against.
    if (answer.shown.length > 1) {
      const others = answer.shown.filter((o) => o !== a);
      const wins = numbers(a.plan.scorecard as Scorecard, stresses).filter((_, k) =>
        others.every((o) => {
          const s = signs(a.plan.scorecard as Scorecard, o.plan.scorecard as Scorecard, stresses);
          return (s[k] ?? 0) > 0;
        }),
      );
      expect(wins.length, `${a.id} wins nothing`).toBeGreaterThan(0);
    }
  });
}

describe('three candidates from one goal (C10)', () => {
  const grid: PersonalSheet[] = [];
  for (const goal of ['grow', 'income', 'protect'] as const)
    for (const risk of ['low', 'medium', 'high'] as const)
      for (const amountUsd of [2_000, 25_000, 250_000])
        for (const obligations of [undefined, monthly(amountUsd / 100, 36)])
          grid.push(sheet({ goal, risk, amountUsd, ...(obligations ? { obligations } : {}) }));

  it('on a grid of goals, none is dominated and each wins at least one attribute', () => {
    let three = 0;
    let shown = 0;
    for (const s of grid) {
      const answer = run(s);
      checkChoice(answer);
      shown += answer.shown.length;
      if (answer.shown.length === 3) three += 1;
    }
    // Not a test that passes by showing one plan each time.
    expect(three).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(grid.length * 1.5);
  });

  it('marks none: no field selects, recommends or ranks a candidate', () => {
    const answer = run(sheet({ goal: 'protect', amountUsd: 50_000 }));
    expect(answer.shown.map((c) => c.id)).toEqual(['cover', 'spread', 'carry']);
    // No key marks one, and no sentence calls one better for the person.
    const keys = JSON.stringify(answer).match(/"\w+":/g) ?? [];
    for (const word of [/select/i, /recommend/i, /default/i, /preferred/i, /\brank/i])
      expect(
        keys.filter((k) => word.test(k)),
        String(word),
      ).toEqual([]);
    const words = [...answer.notShown.map((n) => n.why)].join(' ');
    for (const word of [/recommend/i, /\bbest\b/i, /suitable/i])
      expect(word.test(words)).toBe(false);
  });

  it('keeps each inside its aim: Cover holds no credit leg, Spread no issuer over its cap, Carry is the plan', () => {
    const s = sheet({ goal: 'protect', amountUsd: 50_000, obligations: monthly(500, 24) });
    const answer = run(s);
    const of = (id: string) => answer.shown.find((c) => c.id === id)?.plan as PersonalProposal;
    expect(of('cover').scorecard?.creditBasisBps).toBe(0);
    // Twelve months set aside, said on the plan.
    expect(
      of('cover')
        .lines.flatMap((l) => l.reasons)
        .some((r) => r.rule === 'SET_ASIDE' && r.params.months === 12),
    ).toBe(true);
    const spread = of('spread').scorecard;
    for (const share of spread?.concentration.byIssuer ?? [])
      expect(share.bps).toBeLessThanOrEqual(PERSONAL_PARAMS.candidates.spread.issuerCapBps);
    const { candidate: _c, scorecard: _s, ...carry } = of('carry');
    expect(carry).toEqual(compose(s, launch, ctx));
  });

  it("reads Cover's capacity at its tighter cost, but never counts an unmeasured sale as cheaper", () => {
    const s = sheet({ goal: 'income', amountUsd: 50_000 });
    const cover = buildWorld(s, launch, ctx, 'cover');
    expect(cover.P.tau).toBe(PERSONAL_PARAMS.candidates.cover.tau);
    expect(cover.unmeasuredCost).toBe(PERSONAL_PARAMS.tau);
    expect(buildWorld(s, launch, ctx).unmeasuredCost).toBe(PERSONAL_PARAMS.tau);
  });

  it('shows fewer when two come out as one choice, and says why', () => {
    const answer = run(sheet({ goal: 'grow', risk: 'high', amountUsd: 10_000 }));
    expect(answer.shown.length).toBeLessThan(3);
    expect(answer.notShown.length).toBeGreaterThan(0);
  });

  it('is the same every time, in whatever order the shelf is listed', () => {
    const s = sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(600, 60) });
    const first = candidates(s, launch, ctx);
    expect(candidates(s, launch, ctx)).toEqual(first);
    const reversed: Shelf = { ...launch, assets: [...launch.assets].reverse() };
    expect(candidates(s, reversed, ctx)).toEqual(first);
  });
});

describe('the scorecard (C11)', () => {
  it('has open FX only where something is owed in another currency than dollars (C19)', () => {
    const c = fixtureContext({ fx: [usdBrl(5.5)] });
    const shelf = withReais();
    const dollars = run(sheet({ goal: 'income', obligations: monthly(500, 12) }), shelf, c);
    const reais = run(
      sheet({ goal: 'income', currency: 'BRL', obligations: monthly(2750, 12, 'BRL') }),
      shelf,
      c,
    );
    for (const { plan } of dollars.shown) expect(plan.scorecard?.openFxUsd).toBeUndefined();
    // A dollar goal that owes reais is open to the rate on what its reais leg does not hold.
    const owesReais = run(
      sheet({ goal: 'income', amountUsd: 20_000, obligations: monthly(2750, 12, 'BRL') }),
      shelf,
      c,
    );
    for (const { plan } of owesReais.shown) {
      const brl = plan.lines.find((l) => l.assetId === 'solana:brlx')?.amountUsd ?? 0;
      const owed = Math.ceil((2750 / 5.5) * 100) * 12;
      expect(plan.scorecard?.openFxUsd).toBeCloseTo(
        Math.max(0, owed - Math.round(brl * 100)) / 100,
        2,
      );
    }
    for (const { plan } of reais.shown) expect(plan.scorecard?.openFxUsd).toBeGreaterThanOrEqual(0);
  });

  it('counts the months cash and the matching legs pay, in order', () => {
    const answer = run(
      sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(1_000, 24) }),
    );
    for (const { plan } of answer.shown) {
      const cash = plan.lines
        .filter((l) => launch.assets.find((a) => a.id === l.assetId)?.cls === 'cash')
        .reduce((n, l) => n + l.amountUsd, 0);
      expect(plan.scorecard?.monthsCovered).toBe(Math.min(24, Math.floor(cash / 1_000 + 1e-9)));
    }
  });
});

describe('each way to close a gap, found by running the engine again (C12)', () => {
  const s = sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(600, 120) });
  const plan = compose(s, launch, ctx);

  it('lists a larger amount and smaller withdrawals, and each one is met', () => {
    expect(plan.status?.met).toBe(false);
    const ways = plan.status?.ways ?? [];
    expect(ways).toHaveLength(2);
    const add = /for \$([\d,]+) in all/.exec(ways[0]?.change ?? '');
    const enough = Number(add?.[1]?.replace(/,/g, ''));
    expect(enough).toBeGreaterThan(s.amountUsd);
    expect(compose({ ...s, amountUsd: enough }, launch, ctx).status?.met).toBe(true);
    // The smallest in whole steps: one step less is not met.
    expect(
      compose({ ...s, amountUsd: enough - PERSONAL_PARAMS.wayStepUsd }, launch, ctx).status?.met,
    ).toBe(false);
    const pct = Number(/withdraw ([\d.]+)%/.exec(ways[1]?.change ?? '')?.[1]);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
    const less = (s.obligations ?? []).map((o) => ({
      ...o,
      amount: Math.floor(o.amount * pct) / 100,
    }));
    expect(compose({ ...s, obligations: less }, launch, ctx).status?.met).toBe(true);
  });

  it('lists none for a plan that is met', () => {
    const met = compose(
      sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(100, 3) }),
      launch,
      ctx,
    );
    expect(met.status?.met).toBe(true);
    expect(met.status?.ways).toEqual([]);
  });

  it('works past the goal date, on a balance goal', () => {
    const late = compose(
      sheet({
        goal: 'grow',
        amountUsd: 5_000,
        horizonMonths: 6,
        obligations: monthly(400, 24),
      }),
      launch,
      ctx,
    );
    expect(late.status?.met).toBe(false);
    expect(late.status?.ways.length).toBeGreaterThan(0);
  });
});

describe('no odds in the candidates either', () => {
  it('names no probability, percentile, chance or likelihood', () => {
    const answer = run(
      sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(600, 120) }),
    );
    const text = JSON.stringify(answer);
    for (const ban of [/probab/i, /percentil/i, /\bchances?\b/i, /\bodds\b/i, /likel(y|ihood)/i])
      expect(ban.test(text), String(ban)).toBe(false);
  });
});
