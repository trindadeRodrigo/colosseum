import { describe, expect, it } from 'vitest';
import type { BasketCard, BasketSheet, ObservationRef, Verdict } from './basket-sheet';
import { VaultPlan } from './order-api';

// What a vault's plan says of its goal (`VaultPlan`): the sheet, the card, the verdict and the
// observations come the four together or not at all. The schema holds that itself, so a route that
// answers a card without the readings it stands on, or a verdict beside no sheet, fails its own answer.

const sheet: BasketSheet = {
  basketType: 'standard',
  goal: 'income',
  amountUsd: 1_000,
  horizonMonths: 60,
  risk: 'medium',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: false },
  language: 'en',
};
const card: BasketCard = {
  moneyTodayUsd: 1_000,
  termMonths: 60,
  cashFlow: 'monthly',
  expectedReturn: { lowPct: 0, highPct: 0, basis: 'test fixture', lossInFallUsd: 0 },
  exit: { text: 'not measured', costBps: null },
};
const verdict: Verdict = {
  met: false,
  gapUsdMonthly: 12.5,
  ways: [{ change: 'a longer term', closesGap: true }],
};
// A reading written by hand for this test, and labelled so: no figure here is a yield anybody read.
const observations: ObservationRef[] = [
  {
    id: 'yield solana:yield',
    kind: 'yield',
    source: 'packages/schemas/src/order-api.test.ts',
    method: 'mock_value_written_by_hand_not_a_reading',
    fetchedAt: '2026-10-05T00:00:00.000Z',
    provenance: 'mock',
  },
];

const held = {
  kind: 'personal' as const,
  placedAt: '2026-10-06T12:00:00.000Z',
  proposalId: '6f1c1a52-6a55-4f0b-9a57-3f1f8f0f3a10',
};
const goal = { sheet, card, verdict, observations };
const takes = (plan: unknown) => VaultPlan.safeParse(plan).success;

describe('what a vault’s plan says of its goal', () => {
  it('takes the four together, and none of them', () => {
    expect(VaultPlan.parse({ ...held, ...goal })).toEqual({ ...held, ...goal });
    expect(VaultPlan.parse(held)).toEqual(held);
  });

  it('refuses a goal with one of the four missing, whichever it is', () => {
    for (const missing of ['sheet', 'card', 'verdict', 'observations'] as const) {
      const { [missing]: _, ...rest } = goal;
      expect(Object.keys(rest)).toHaveLength(3);
      expect([missing, takes({ ...held, ...rest })]).toEqual([missing, false]);
    }
  });

  it('refuses any one of the four on its own, and says the rule', () => {
    for (const [key, value] of Object.entries(goal))
      expect([key, takes({ ...held, [key]: value })]).toEqual([key, false]);
    const refused = VaultPlan.safeParse({ ...held, card });
    expect(refused.error?.issues.map((issue) => issue.message)).toEqual([
      'the sheet, the card, the verdict and the observations come together or not at all',
    ]);
  });

  it('takes a null verdict with the other three: a goal that is not an income has none', () => {
    expect(takes({ ...held, ...goal, verdict: null })).toBe(true);
    // Null is a verdict that is there. It does not stand without the other three either.
    expect(takes({ ...held, verdict: null })).toBe(false);
  });

  it('takes a plan that follows a shared portfolio, which says none of the four', () => {
    const follow = { kind: 'follow', placedAt: held.placedAt, familyId: 'a'.repeat(64) };
    expect(VaultPlan.parse(follow)).toEqual(follow);
  });
});
