import type { Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import { type ScheduleInputs, scheduleOf } from './schedule';
import { REASON_TEMPLATES, TEXT_TEMPLATES } from './templates';
import {
  fixtureContext,
  fixtureYields,
  launchShelf,
  NOW,
  sheet,
  usdBrl,
  violations,
  withReais,
} from './testing';
import type { ComposeContext, PersonalProposal, PersonalSheet } from './types';
import { monthAfter } from './world';

// Slice 3 of docs/vault/PROMPT-BUILD-SOLVER.md, the status (section 2.5 of the research note, C12):
// months paid at the rates observed, the same under each named stress, and the carry needed beside
// the carry observed. No odds, no percentile, no projected return.

const launch = launchShelf();
const ctx = fixtureContext();
const run = (s: PersonalSheet, shelf: Shelf = launch, c: ComposeContext = ctx) => {
  const plan = compose(s, shelf, c);
  expect(violations(plan, shelf, c)).toEqual([]);
  return plan;
};
const inMonths = (n: number) => monthAfter(NOW, n);
/** $600 a month for ten years from a $50,000 plan: more than the plan, so it needs carry. */
const monthly = (usd: number, months: number, currency = 'USD') =>
  Array.from({ length: months }, (_, m) => ({ month: inMonths(m), amount: usd, currency }));
const ids = (p: PersonalProposal) => p.status?.stresses.map((s) => s.id) ?? [];

describe('the status of a plan with withdrawals', () => {
  const plan = run(sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(600, 120) }));
  const status = plan.status;

  it('says the date of the rates it counts, and counts the months paid at them', () => {
    expect(status?.observedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(status?.base.monthsWithWithdrawal).toBe(120);
    expect(status?.base.monthsPaid).toBe(plan.schedule?.monthsPaid);
    expect(status?.met).toBe(false);
  });

  it('runs each stress that applies, and none pays more months than the rates observed', () => {
    expect(ids(plan)).toEqual(['yields_fall', 'credit_gate']);
    for (const s of status?.stresses ?? [])
      expect(s.monthsPaid, s.id).toBeLessThanOrEqual(status?.base.monthsPaid ?? 0);
    const grow = run(sheet({ goal: 'grow', obligations: monthly(100, 12) }));
    expect(ids(grow)).toContain('equity_fall');
  });

  it('gives the carry needed: the least flat rate on dollar yield that pays every month', () => {
    const needed = status?.carryNeededBps ?? null;
    expect(needed).not.toBeNull();
    if (needed === null || !plan.schedule) return;
    expect(needed).toBeGreaterThan(status?.carryObservedBps ?? 0);
    const byId = new Map(launch.assets.map((a) => [a.id, a]));
    const inputs: ScheduleInputs = {
      lines: plan.lines,
      byId,
      yields: new Map(fixtureYields().map((y) => [y.assetId, y])),
      withdrawals: monthly(600, 120).map((o) => ({ ...o, cents: o.amount * 100 })),
      currency: 'USD',
      rate: 1,
      nowMonth: inMonths(0),
      months: plan.schedule.rows.length,
      liquidity: ctx.liquidity,
      tau: PERSONAL_PARAMS.tau,
      ceilingUsdOf: (a) => PERSONAL_PARAMS.tierCeilingUsd[a.tier],
    };
    const paysAll = (bps: number) => {
      const s = scheduleOf({ ...inputs, stress: { id: 'flat_carry', yearly: bps / 10_000 } });
      return s.monthsPaid === s.monthsWithWithdrawal;
    };
    expect(paysAll(needed)).toBe(true);
    expect(paysAll(needed - 1)).toBe(false);
  });

  it('is met, at no carry needed, when what is set aside pays everything', () => {
    const small = run(sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(100, 3) }));
    expect(small.status?.met).toBe(true);
    expect(small.status?.carryNeededBps).toBe(0);
  });

  it('counts a goal past its own date: withdrawals after the goal month are in the status', () => {
    const late = run(
      sheet({
        goal: 'grow',
        horizonMonths: 3,
        obligations: [{ month: inMonths(9), amount: 500, currency: 'USD' }],
      }),
    );
    expect(late.schedule?.rows.length).toBe(10);
    expect(late.status?.base).toMatchObject({ monthsWithWithdrawal: 1, monthsPaid: 1 });
  });
});

describe('FX stresses exist only for a goal not in dollars (C19)', () => {
  it('a dollar goal has none; the same goal in reais has the rate both ways', () => {
    const c = fixtureContext({ fx: [usdBrl(5.5)] });
    const shelf = withReais();
    const dollars = run(sheet({ goal: 'income', obligations: monthly(500, 12) }), shelf, c);
    const reais = run(
      sheet({ goal: 'income', currency: 'BRL', obligations: monthly(2750, 12, 'BRL') }),
      shelf,
      c,
    );
    expect(ids(dollars).some((id) => id.startsWith('fx_'))).toBe(false);
    expect(ids(reais)).toEqual(expect.arrayContaining(['fx_goal_up', 'fx_goal_down']));
  });
});

describe('no odds, anywhere', () => {
  // A probability, a percentile, a chance or "likely to reach" is a return promise in another form.
  const BANNED = [
    /probab/i,
    /percentil/i,
    /\bchances?\b/i,
    /\bodds\b/i,
    /likel(y|ihood)/i,
    /prov[aá]v/i,
  ];
  it('in the wording of every reason and sentence', () => {
    const words = [
      ...Object.values(REASON_TEMPLATES).flatMap((t) => [t.en, t.pt]),
      ...Object.values(TEXT_TEMPLATES).flatMap((t) => [t.en, t.pt]),
    ];
    for (const ban of BANNED)
      expect(
        words.filter((w) => ban.test(w)),
        String(ban),
      ).toEqual([]);
  });

  it('in what a plan answers, its status included', () => {
    const plan = run(sheet({ goal: 'income', amountUsd: 50_000, obligations: monthly(600, 24) }));
    const text = JSON.stringify(plan);
    for (const ban of BANNED) expect(ban.test(text), String(ban)).toBe(false);
  });
});
