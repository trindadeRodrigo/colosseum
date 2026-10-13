import { describe, expect, it } from 'vitest';
import { createModelQuota } from './model-quota';

describe('one allowance for intake and vault conversation', () => {
  it('counts both entry points against the same person and total', () => {
    const quota = createModelQuota({ dailyCalls: 3, dailyCallsPerPerson: 2 });
    const intake = () => quota.reserve('owner');
    const vault = () => quota.reserve('owner');
    expect(intake()).toBeNull();
    expect(vault()).toBeNull();
    expect(intake()).toBe('model_person_budget_spent');
    expect(quota.reserve('another')).toBeNull();
    expect(quota.reserve('third')).toBe('model_budget_spent');
  });

  it('resets both counters at the same UTC day boundary', () => {
    let time = new Date('2026-10-07T23:59:59Z');
    const quota = createModelQuota({ dailyCalls: 1, dailyCallsPerPerson: 1, now: () => time });
    expect(quota.reserve('owner')).toBeNull();
    expect(quota.reserve('another')).toBe('model_budget_spent');
    time = new Date('2026-10-08T00:00:00Z');
    expect(quota.reserve('owner')).toBeNull();
  });

  it('does not reserve a call when either configured allowance is zero', () => {
    expect(createModelQuota({ dailyCalls: 0, dailyCallsPerPerson: 1 }).reserve('owner')).toBe(
      'model_budget_spent',
    );
    expect(createModelQuota({ dailyCalls: 1, dailyCallsPerPerson: 0 }).reserve('owner')).toBe(
      'model_person_budget_spent',
    );
  });
});
