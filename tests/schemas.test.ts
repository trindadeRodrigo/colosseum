import { BRL_LEG_ID, isEligible, isExecutable } from '@colosseum/engine';
import { ConstraintSheet, DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

const income = {
  language: 'pt',
  currency: 'BRL',
  profile: 'income',
  target: { kind: 'monthly_cashflow', amountBrl: 3000, startMonth: '2028-01' },
  horizonMonths: 120,
  liquidityWindowDays: 7,
  riskBudget: 'low',
  creditTolerance: 'limited',
  fxStance: 'hedge_near_term',
} as const;

describe('ConstraintSheet', () => {
  it('accepts a valid income sheet', () => {
    expect(ConstraintSheet.safeParse(income).success).toBe(true);
  });
  it('rejects a cash-flow target with a non-income profile', () => {
    const r = ConstraintSheet.safeParse({ ...income, profile: 'accumulation' });
    expect(r.success).toBe(false);
  });
  it('rejects high_risk with a low risk budget', () => {
    const r = ConstraintSheet.safeParse({
      ...income,
      profile: 'high_risk',
      target: { kind: 'balance', amountBrl: 250000, byMonth: '2029-09' },
    });
    expect(r.success).toBe(false);
  });
});

describe('registry eligibility rules', () => {
  const xstock: Parameters<typeof isEligible>[0] = {
    kind: 'equity',
    eligibleProfiles: ['income', 'accumulation', 'high_risk'],
    mintPath: 'dex_swap',
  };
  it('never allows equity in income, even if the row says so', () => {
    expect(isEligible(xstock, 'income')).toBe(false);
    expect(isEligible(xstock, 'high_risk')).toBe(true);
  });
  it('keeps the abstract BRL leg non-executable until the gate passes', () => {
    expect(BRL_LEG_ID).toBe('brl-leg');
    expect(isExecutable({ mintPath: 'unavailable' })).toBe(false);
  });
});

describe('disclaimer', () => {
  it('exists in both languages and says it is not licensed advice', () => {
    expect(DISCLAIMER.en).toMatch(/not licensed/i);
    expect(DISCLAIMER.pt).toMatch(/não presta consultoria/i);
  });
});
