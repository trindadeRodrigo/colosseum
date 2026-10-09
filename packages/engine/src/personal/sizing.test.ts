import { describe, expect, it } from 'vitest';
import { amountToMeet, composeAs } from './compose';
import { extendedContext, extendedShelf, fixtureContext, launchShelf, NOW, sheet } from './testing';
import { CANDIDATES, type PersonalSheet } from './types';
import { monthAfter } from './world';

// How much a plan needs (Rodrigo's test of `/plan-chat` on Oct 7: "I want $2k a month for a
// sabbatical year in three years. How much should I invest?" was answered "I can't size the amount
// for you", and then in round hundreds). The least amount at which the plan pays every withdrawal,
// to the cent, found by making the plan: no formula beside the engine. Every figure here is MOCK,
// from the engine's fixtures.

const launch = launchShelf();
const ctx = fixtureContext();
/** $2,000 a month for a year, starting in three years. */
const sabbatical = Array.from({ length: 12 }, (_, m) => ({
  month: monthAfter(NOW, 36 + m),
  amount: 2000,
  currency: 'USD',
}));
const asked = (over: Partial<PersonalSheet> = {}) =>
  sheet({ goal: 'income', risk: 'medium', horizonMonths: 36, obligations: sabbatical, ...over });

describe('the amount a plan needs', () => {
  it('is the least amount, to the cent, at which every withdrawal is paid', () => {
    for (const candidate of [null, ...CANDIDATES]) {
      const needs = amountToMeet(candidate, asked(), launch, ctx);
      const usd = needs?.withdrawalsUsd ?? null;
      expect(usd, String(candidate)).not.toBeNull();
      if (usd === null) continue;
      // It has cents: nothing is rounded to a hundred.
      expect(Math.round(usd * 100) / 100, String(candidate)).toBe(usd);
      const at = (amountUsd: number) =>
        (candidate
          ? composeAs(candidate, asked({ amountUsd }), launch, ctx)
          : composeAs('carry', asked({ amountUsd }), launch, ctx)
        ).status?.met;
      if (candidate) {
        expect(at(usd), candidate).toBe(true);
        // One cent less does not pay them all.
        expect(at(Math.round(usd * 100 - 1) / 100), candidate).toBe(false);
      }
      // Less than the withdrawals come to, since the money earns for three years first; and more
      // than nothing.
      expect(usd).toBeLessThan(24_000);
      expect(usd).toBeGreaterThan(12_000);
    }
  });

  it('does not depend on the amount the sheet came with', () => {
    const a = amountToMeet('cover', asked({ amountUsd: 500 }), launch, ctx);
    const b = amountToMeet('cover', asked({ amountUsd: 900_000 }), launch, ctx);
    expect(a).toEqual(b);
  });

  it('is the same on every run, and on the extended shelf with its own figures', () => {
    const shelf = extendedShelf();
    const context = extendedContext();
    const once = amountToMeet('cover', asked(), shelf, context);
    expect(amountToMeet('cover', asked(), shelf, context)).toEqual(once);
    expect(once?.withdrawalsUsd ?? null).not.toBeNull();
  });

  it('for an income target, the amount whose income alone reaches it, or none where no amount does', () => {
    const small = amountToMeet(
      'carry',
      sheet({ goal: 'income', incomeTargetUsdMonthly: 20 }),
      launch,
      ctx,
    );
    const usd = small?.incomeUsd ?? null;
    expect(usd).not.toBeNull();
    if (usd !== null) {
      const plan = (amountUsd: number) =>
        composeAs(
          'carry',
          sheet({ goal: 'income', incomeTargetUsdMonthly: 20, amountUsd }),
          launch,
          ctx,
        );
      expect(plan(usd).verdict?.met).toBe(true);
      expect(plan(Math.round(usd * 100 - 1) / 100).verdict?.met).toBe(false);
    }
    // More a month than the tokens' limits let any amount earn: none, said as null.
    const large = amountToMeet(
      'carry',
      sheet({ goal: 'income', incomeTargetUsdMonthly: 200_000 }),
      launch,
      ctx,
    );
    expect(large).toEqual({ incomeUsd: null });
  });

  it('is null for a goal with nothing to pay', () => {
    expect(amountToMeet('carry', sheet({ goal: 'grow' }), launch, ctx)).toBeNull();
  });
});
