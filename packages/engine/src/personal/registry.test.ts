import { AssetClass, type BasketAsset } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { isEligible } from '../assets/eligibility';
import { eligibleForGoal, profileOfGoal, registryRowOf, sleeveOfClass } from './registry';

// CLAUDE.md: stock tokens are ineligible for income profiles, enforced in the asset registry. The
// personalization engine asks the same registry function the structurer asks, about every token.

const token = (cls: BasketAsset['cls']): Pick<BasketAsset, 'cls'> => ({ cls });

describe('the asset registry, as the personalization engine reads it', () => {
  it('puts every class in a sleeve', () => {
    expect(Object.fromEntries(AssetClass.options.map((cls) => [cls, sleeveOfClass(cls)]))).toEqual({
      stock: 'growth',
      etf: 'growth',
      crypto: 'growth',
      gold: 'gold',
      commodity: 'gold',
      dollar_yield: 'dollarYield',
      cash: 'cash',
    });
  });

  it('never lets a stock token into an income plan, whatever its row says', () => {
    for (const cls of ['stock', 'etf'] as const) {
      expect(eligibleForGoal(token(cls), 'income')).toBe(false);
      expect(eligibleForGoal(token(cls), 'grow')).toBe(true);
      expect(eligibleForGoal(token(cls), 'protect')).toBe(true);
      // The rule is the registry's own: a row that claims income is still refused.
      const row = { ...registryRowOf(token(cls)), eligibleProfiles: ['income' as const] };
      expect(isEligible(row, profileOfGoal('income'))).toBe(false);
    }
  });

  it('keeps what pays no income out of an income plan: gold, commodities and crypto too', () => {
    for (const cls of ['gold', 'commodity', 'crypto'] as const) {
      expect(registryRowOf(token(cls)).kind).toBe('equity');
      expect(eligibleForGoal(token(cls), 'income')).toBe(false);
      expect(eligibleForGoal(token(cls), 'grow')).toBe(true);
      expect(eligibleForGoal(token(cls), 'protect')).toBe(true);
    }
  });

  it('lets dollar yield and cash into every plan', () => {
    for (const cls of ['dollar_yield', 'cash'] as const)
      for (const goal of ['grow', 'income', 'protect'] as const)
        expect(eligibleForGoal(token(cls), goal)).toBe(true);
  });

  it('decides through the registry function, not beside it', () => {
    for (const cls of AssetClass.options)
      for (const goal of ['grow', 'income', 'protect'] as const)
        expect(eligibleForGoal(token(cls), goal)).toBe(
          isEligible(registryRowOf(token(cls)), profileOfGoal(goal)),
        );
  });
});
