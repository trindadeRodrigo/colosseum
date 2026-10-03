import { describe, expect, it } from 'vitest';
import { compose } from './index';
import {
  distanceBps,
  editShelf,
  fixtureContext,
  launchShelf,
  newReasonsNaming,
  sheet,
  sleeveBps,
  violations,
} from './testing';
import type { ComposeContext, PersonalProposal, PersonalSheet } from './types';

// HANDOFF-VAULT, "What changes the plan": each input has to change the plan visibly. If it does not,
// it is a template. One test per input: changed alone, it moves the plan and adds a reason that
// names it.

const shelf = launchShelf();
const BASE = sheet({ themes: ['the-seven'] }); // grow $10,000 over ten years at medium risk, on Solana
const base = compose(BASE, shelf, fixtureContext());

/** The plan with one thing changed, held to every rule a plan must keep. */
function changed(
  over: Partial<PersonalSheet>,
  context: Partial<ComposeContext> = {},
  onShelf = shelf,
): PersonalProposal {
  const ctx = fixtureContext(context);
  const plan = compose({ ...BASE, ...over }, onShelf, ctx);
  expect(violations(plan, onShelf, ctx)).toEqual([]);
  return plan;
}

/** It moved, and it says why in a reason that names the input. Returns the rules of those reasons. */
function movedBecauseOf(input: string, plan: PersonalProposal): string[] {
  expect(distanceBps(base, plan), `${input} did not move the plan`).toBeGreaterThan(0);
  const named = newReasonsNaming(base, plan, input);
  expect(named.length, `${input} moved the plan with no reason naming it`).toBeGreaterThan(0);
  return [...new Set(named.map((r) => r.rule))].sort();
}

describe('each input alone moves the plan and says so', () => {
  it('the base plan is in order', () => {
    expect(violations(base, shelf, fixtureContext())).toEqual([]);
    // 80% in stocks by the table; one issuer may hold 70% at medium risk, and on Solana every stock
    // token and the gold token share one. The rest is held in dollar yield.
    expect(sleeveBps(base, shelf, 'growth')).toBe(6500);
    expect(sleeveBps(base, shelf, 'dollarYield')).toBe(3000);
    expect(sleeveBps(base, shelf, 'gold')).toBe(500);
    expect(sleeveBps(base, shelf, 'cash')).toBe(0);
  });

  it('goal', () => {
    // A plan to protect holds no stocks, so The Seven is left out of it: dollar yield and gold.
    const plan = changed({ goal: 'protect' });
    expect(movedBecauseOf('goal', plan)).toEqual(['SLEEVE', 'THEME_NOT_FOR_GOAL']);
    expect(sleeveBps(plan, shelf, 'growth')).toBe(0);
    expect(sleeveBps(plan, shelf, 'dollarYield')).toBe(7500);
    expect(sleeveBps(plan, shelf, 'gold')).toBe(2500);
  });

  it('risk', () => {
    const plan = changed({ risk: 'low' });
    expect(movedBecauseOf('risk', plan)).toEqual(expect.arrayContaining(['SLEEVE', 'ISSUER_CAP']));
    // 60% in stocks by the table, 50% with one issuer at most, 10% of it already in gold.
    expect(sleeveBps(plan, shelf, 'growth')).toBe(4000);
  });

  it('time frame', () => {
    const plan = changed({ horizonMonths: 12 });
    expect(movedBecauseOf('horizon', plan)).toEqual(['CASH_NEAR_DATE', 'GLIDE']);
    expect(sleeveBps(plan, shelf, 'cash')).toBe(500);
    expect(sleeveBps(plan, shelf, 'dollarYield')).toBeGreaterThanOrEqual(6000);
  });

  it('amount', () => {
    const plan = changed({ amountUsd: 400_000 });
    // Gold meets its measured limit and four stocks the limit of their tier; The Seven no longer
    // fits whole; what they cannot take is held in dollar yield, and what that cannot take, in cash.
    expect(movedBecauseOf('amount', plan)).toEqual([
      'EXIT_CEILING',
      'NOT_WHOLE_CEILING',
      'OVERFLOW_CEILING',
      'TIER_CEILING',
      'UNPLACED',
    ]);
    // What the tokens cannot take at this size is held in dollar yield, then in cash: not forced in.
    expect(sleeveBps(plan, shelf, 'growth')).toBeLessThan(6500);
    expect(sleeveBps(plan, shelf, 'cash')).toBeGreaterThan(0);
  });

  it('themes', () => {
    const plan = changed({ themes: ['crypto-in-a-suit'] });
    expect(movedBecauseOf('themes', plan)).toContain('FROM_THEME');
    expect(plan.lines.some((l) => l.assetId === 'solana:mstrx')).toBe(true);
  });

  it('holdings', () => {
    const plan = changed({}, { holdings: [{ underlying: 'NVDA', valueUsd: 4_000 }] });
    expect(movedBecauseOf('holdings', plan)).toEqual(['ALREADY_HELD_NONE', 'MORE_BECAUSE_HELD']);
    expect(plan.lines.some((l) => /nvda/.test(l.assetId))).toBe(false);
    expect(plan.removed.find((r) => r.ref === 'NVDA')?.reasons[0]?.text).toBe(
      'No NVDA: you already hold $4,000 of it.',
    );
    // Switched off, the rule does nothing.
    const off = compose(
      { ...BASE, rules: { useHoldings: false, glide: true } },
      shelf,
      fixtureContext({ holdings: [{ underlying: 'NVDA', valueUsd: 4_000 }] }),
    );
    expect(distanceBps(base, off)).toBe(0);
  });

  it('country', () => {
    // A fixture rule, not a legal claim: the Solana stock tokens are not offered in XX.
    const blocked = editShelf(shelf, (a) =>
      a.chain === 'solana' && a.cls === 'stock' ? { ...a, blockedCountries: ['XX'] } : a,
    );
    const here = compose(BASE, blocked, fixtureContext());
    expect(distanceBps(base, here)).toBe(0);
    const plan = changed({ country: 'XX' }, {}, blocked);
    expect(movedBecauseOf('country', plan)).toEqual(['NOT_IN_COUNTRY']);
    expect(plan.lines.some((l) => l.assetId === 'solana:nvdax')).toBe(false);
    // No part of The Seven can be held there, so it is left out as one, and says why.
    expect(plan.removed.find((r) => r.ref === 'the-seven')?.reasons.map((r) => r.text)).toEqual([
      'The Seven is left out: it is not offered in XX.',
    ]);
    expect(plan.lines.some((l) => l.assetId === 'solana:spyx')).toBe(true);
  });

  it('the chain the person is on', () => {
    const plan = changed({ chains: ['robinhood'] });
    expect(movedBecauseOf('chain', plan)).toEqual(
      expect.arrayContaining(['BY_YIELD', 'FROM_THEME']),
    );
    expect(plan.lines.every((l) => l.chain === 'robinhood')).toBe(true);
    expect(plan.recipes.map((r) => r.chain)).toEqual(['robinhood']);
    expect(distanceBps(base, plan)).toBe(10_000);
  });

  it('what the person cannot hold', () => {
    // AAPL is one of the six stocks the base plan holds. (TSLA, the seventh, has no line in it.)
    const plan = changed({ limits: { cannotHold: { underlyings: ['AAPL'] } } });
    expect(movedBecauseOf('cannotHold', plan)).toEqual(['EXCLUDED']);
    expect(plan.lines.some((l) => /aapl/.test(l.assetId))).toBe(false);
    // The rest of the stocks take its place, TSLA among them: the sleeve keeps its size.
    expect(plan.lines.some((l) => l.assetId === 'solana:tslax')).toBe(true);
    expect(sleeveBps(plan, shelf, 'growth')).toBe(6500);
  });

  it('what the person must not lose', () => {
    const plan = changed({ limits: { mustKeepUsd: 5_000 } });
    expect(movedBecauseOf('mustKeep', plan)).toEqual(['MUST_KEEP']);
    expect(
      sleeveBps(plan, shelf, 'dollarYield') + sleeveBps(plan, shelf, 'cash'),
    ).toBeGreaterThanOrEqual(5000);
  });

  it('how soon they may need the money', () => {
    const plan = changed({ limits: { mayNeedInMonths: 3 } });
    expect(movedBecauseOf('mayNeed', plan)).toEqual(['CASH_MAY_NEED']);
    expect(sleeveBps(plan, shelf, 'cash')).toBe(2000);
  });
});

describe('what does not move the plan', () => {
  it('the language changes the words and nothing else', () => {
    const pt = changed({ language: 'pt' });
    expect(distanceBps(base, pt)).toBe(0);
    expect(pt.lines.map((l) => l.reasons.map((r) => r.rule))).toEqual(
      base.lines.map((l) => l.reasons.map((r) => r.rule)),
    );
    expect(pt.lines[0]?.reasons[0]?.text).not.toBe(base.lines[0]?.reasons[0]?.text);
    expect(pt.disclaimer).not.toBe(base.disclaimer);
  });

  it('an income target adds a verdict to an income plan, and leaves the lines alone', () => {
    const income = { ...BASE, goal: 'income' as const, themes: [] };
    const without = compose(income, shelf, fixtureContext());
    const withTarget = compose({ ...income, incomeTargetUsdMonthly: 20 }, shelf, fixtureContext());
    expect(without.verdict).toBeUndefined();
    expect(withTarget.verdict).toEqual({ met: true, gapUsdMonthly: 0, ways: [] });
    expect(distanceBps(without, withTarget)).toBe(0);
  });

  it('the glide rule, switched off, takes the date out of the sleeves', () => {
    // At high risk one issuer may hold the whole plan, so the sleeves are as the table sizes them.
    const near = { ...BASE, risk: 'high' as const, horizonMonths: 6 };
    const on = compose(near, shelf, fixtureContext());
    const off = compose(
      { ...near, rules: { useHoldings: true, glide: false } },
      shelf,
      fixtureContext(),
    );
    expect(sleeveBps(on, shelf, 'dollarYield')).toBe(8000);
    expect(sleeveBps(on, shelf, 'cash')).toBe(1000);
    expect(sleeveBps(off, shelf, 'dollarYield')).toBe(500);
    expect(sleeveBps(off, shelf, 'cash')).toBe(0);
  });
});
