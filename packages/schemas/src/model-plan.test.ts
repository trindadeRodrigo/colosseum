import { describe, expect, it } from 'vitest';
import { ModelPlanConfirmationV1, ModelPlanTerms } from './model-plan';

const terms = {
  chain: 'solana',
  goal: 'grow',
  objective: 'Keep a reserve while seeking growth',
  amountUsdCents: 100000,
  risk: 'medium',
  limits: {
    cannotHoldClasses: [],
    cannotHoldAssets: [],
    cannotHoldUnderlyings: [],
    creditTolerance: 'limited',
    mustKeepUsdCents: 0,
    mayNeedInMonths: null,
  },
  incomeTargetUsdCentsMonthly: null,
};
describe('standalone model financial review schema', () => {
  it('requires explicit financial terms and existing medium risk label', () => {
    expect(ModelPlanTerms.safeParse(terms).success).toBe(true);
    expect(ModelPlanTerms.safeParse({ ...terms, risk: 'moderate' }).success).toBe(false);
    expect(ModelPlanTerms.safeParse({ ...terms, limits: undefined }).success).toBe(false);
  });
  it.each([999, 100000001, 1000.5])('rejects out-of-contract cents %s', (amountUsdCents) =>
    expect(ModelPlanTerms.safeParse({ ...terms, amountUsdCents }).success).toBe(false),
  );
  it.each([1000, 100000000])('retains existing amount bound %s', (amountUsdCents) =>
    expect(ModelPlanTerms.safeParse({ ...terms, amountUsdCents }).success).toBe(true),
  );
  it('rejects reserve above amount and monthly target without income goal', () => {
    expect(
      ModelPlanTerms.safeParse({ ...terms, limits: { ...terms.limits, mustKeepUsdCents: 100001 } })
        .success,
    ).toBe(false);
    expect(ModelPlanTerms.safeParse({ ...terms, incomeTargetUsdCentsMonthly: 30000 }).success).toBe(
      false,
    );
  });
  it('rejects omitted review and any executable funding/order field', () => {
    const confirmation = {
      version: 1,
      draftId: '88888888-8888-4888-8888-888888888888',
      draftHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      idempotencyKey: 'one',
      reviewed: true,
      terms,
    };
    expect(ModelPlanConfirmationV1.safeParse(confirmation).success).toBe(true);
    expect(ModelPlanConfirmationV1.safeParse({ ...confirmation, reviewed: false }).success).toBe(
      false,
    );
    expect(
      ModelPlanConfirmationV1.safeParse({ ...confirmation, order: 'executable' }).success,
    ).toBe(false);
  });
});
