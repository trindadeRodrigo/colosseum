import type { PlanSleeve } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  allReasons,
  expectedSleeves,
  fixtureContext,
  launchShelf,
  sheet,
  violations,
} from './testing';
import { PersonalInputError, type PersonalProposal, type PersonalSheet, SLEEVES } from './types';

// Slice 2 of docs/vault/PROMPT-BUILD-SOLVER.md, step 1: the person's split of a plan (gate SLEEVES).
// A goal sleeve keeps the table and the floors, scaled to its share; a safe-yield sleeve holds rate
// legs only, by the banded fill, and what no rate leg takes stays in cash. A theme sleeve waits for
// slice 4 and is refused.

const shelf = launchShelf();
const ctx = fixtureContext();
const run = (s: PersonalSheet) => {
  const plan = compose(s, shelf, ctx);
  expect(violations(plan, shelf, ctx)).toEqual([]);
  return plan;
};
const halves: PlanSleeve[] = [
  { kind: 'goal', shareBps: 5000 },
  { kind: 'safe_yield', shareBps: 5000 },
];
const on = (chain: 'solana' | 'robinhood', over: Partial<PersonalSheet> = {}) =>
  sheet({ chains: [chain], ...over });
const safeOf = (plan: PersonalProposal) => plan.split?.find((x) => x.kind === 'safe_yield');
const rules = (plan: PersonalProposal) => allReasons(plan).map((r) => r.rule);

describe('a plan with no split is the plan it was', () => {
  it.each(['solana', 'robinhood'] as const)(
    'on %s, one goal sleeve at 10,000 changes no line',
    (chain) => {
      const plain = run(on(chain));
      const whole = run(on(chain, { sleeves: [{ kind: 'goal', shareBps: 10_000 }] }));
      expect(whole.lines).toEqual(plain.lines);
      expect(whole.sleeves).toEqual(plain.sleeves);
      expect(plain.split).toBeUndefined();
      expect(whole.split).toEqual([
        { kind: 'goal', shareBps: 10_000, amountUsd: 10_000, holds: [] },
      ]);
      expect(rules(whole)).not.toContain('SPLIT_GOAL');
    },
  );
});

describe('the goal sleeve keeps the table, scaled to its share', () => {
  it('half the plan for a goal to grow: each sleeve is half the row, and the reason says so', () => {
    const s = on('robinhood', { sleeves: halves });
    const asked = expectedSleeves(s, PERSONAL_PARAMS);
    const row = PERSONAL_PARAMS.sleeves['grow:medium'];
    expect(SLEEVES.reduce((n, x) => n + asked[x], 0)).toBe(5000);
    expect(asked.growth).toBe(Math.floor((row?.growthBps ?? 0) / 2));
    const plan = run(s);
    const said = allReasons(plan).find((r) => r.rule === 'SPLIT_GOAL');
    expect(said?.text).toBe(
      'You set 50% of the plan for a goal to grow; the shares here are of the whole plan.',
    );
  });

  it('what must not be lost counts the safe-yield sleeve: no stock is moved for it', () => {
    const keep = { limits: { mustKeepUsd: 5000 } };
    const split = run(on('robinhood', { ...keep, risk: 'high', sleeves: halves }));
    expect(rules(split)).not.toContain('MUST_KEEP');
    // Without the split, the same limit moves money out of stocks.
    expect(rules(run(on('robinhood', { ...keep, risk: 'high' })))).toContain('MUST_KEEP');
  });
});

describe('the safe-yield sleeve: rate legs only, then cash', () => {
  it('on Robinhood Chain: SGOV to its 40% cap, the rest of the sleeve in cash, each said', () => {
    const plan = run(on('robinhood', { sleeves: halves }));
    expect(safeOf(plan)?.holds).toEqual([
      { assetId: 'robinhood:sgov', amountUsd: 4000 },
      { assetId: 'robinhood:usdg', amountUsd: 1000 },
    ]);
    const cash = plan.lines.find((l) => l.assetId === 'robinhood:usdg');
    const texts = cash?.reasons.map((r) => r.text) ?? [];
    expect(texts).toContain(
      'You set 50% of the plan apart for dollar yield from a rate alone: tokens that pass through a government or money-market rate, with no lending to borrowers and no trading spread.',
    );
    expect(texts).toContain(
      '$1,000 stays in cash: no token you can hold has room for it at this size.',
    );
  });

  it('on Solana the launch shelf has no rate leg: the whole sleeve stays in cash, said and flagged', () => {
    const plan = run(on('solana', { sleeves: halves }));
    expect(safeOf(plan)?.holds).toEqual([{ assetId: 'solana:usdc', amountUsd: 5000 }]);
    expect(plan.flags).toContain('safe_yield_no_rate_leg');
    expect(allReasons(plan).map((r) => r.text)).toContain(
      'No token you can hold on Solana pays a rate alone, so $5,000 of the part you set apart for it stays in cash.',
    );
    // jlUSDC (a market deposit) and syrupUSDC (credit and basis) are in the goal sleeve, if anywhere.
    expect(safeOf(plan)?.holds.some((h) => h.assetId !== 'solana:usdc')).toBe(false);
  });

  it('has first call on the rate legs: the goal’s dollar yield takes what the sleeve leaves', () => {
    const s = on('robinhood', {
      goal: 'income',
      sleeves: [
        { kind: 'goal', shareBps: 7000 },
        { kind: 'safe_yield', shareBps: 3000 },
      ],
    });
    const plan = run(s);
    expect(safeOf(plan)?.holds).toEqual([{ assetId: 'robinhood:sgov', amountUsd: 3000 }]);
    // SGOV's cap is of the whole plan: what the goal's dollar yield adds stops at 40% in all.
    expect(plan.lines.find((l) => l.assetId === 'robinhood:sgov')?.weightBps).toBe(4000);
  });

  it('the whole plan in the safe-yield sleeve holds SGOV and cash, and no stock', () => {
    const plan = run(on('robinhood', { sleeves: [{ kind: 'safe_yield', shareBps: 10_000 }] }));
    expect(plan.lines.map((l) => [l.assetId, l.weightBps])).toEqual([
      ['robinhood:sgov', 4000],
      ['robinhood:usdg', 6000],
    ]);
  });

  it('is the same plan whatever order the shelf lists its tokens in', () => {
    const s = on('robinhood', { sleeves: halves });
    const reversed = { ...shelf, assets: [...shelf.assets].reverse() };
    expect(compose(s, reversed, ctx)).toEqual(compose(s, shelf, ctx));
  });
});

describe('a theme sleeve waits for slice 4', () => {
  it('is refused, never ignored', () => {
    const s = on('solana', {
      sleeves: [
        { kind: 'goal', shareBps: 5000 },
        { kind: 'theme', shareBps: 5000, theme: 'ai' },
      ],
    });
    expect(() => compose(s, shelf, ctx)).toThrow(PersonalInputError);
    try {
      compose(s, shelf, ctx);
    } catch (e) {
      expect((e as PersonalInputError).issues).toEqual([
        { path: 'sleeves', message: 'a theme sleeve is not built yet' },
      ]);
    }
  });
});
