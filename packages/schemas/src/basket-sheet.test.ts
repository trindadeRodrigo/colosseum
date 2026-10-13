import { describe, expect, it } from 'vitest';
import { BasketSheet, PlanSleeve } from './basket-sheet';

// A theme names a shared portfolio by its slug, at most 64 characters: a sheet anybody may send (a plan
// made from a link, gate AGENT-LINK) carries no long text of its own.

const sheet = {
  basketType: 'standard',
  goal: 'grow',
  amountUsd: 1000,
  horizonMonths: 12,
  risk: 'medium',
  themes: ['a'.repeat(64)],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
};

describe('a theme', () => {
  it('is at most 64 characters, in the themes and in a theme sleeve', () => {
    expect(BasketSheet.safeParse(sheet).success).toBe(true);
    expect(BasketSheet.safeParse({ ...sheet, themes: ['a'.repeat(65)] }).success).toBe(false);
    const sleeve = { kind: 'theme', shareBps: 5000 };
    expect(PlanSleeve.safeParse({ ...sleeve, theme: 'a'.repeat(64) }).success).toBe(true);
    expect(PlanSleeve.safeParse({ ...sleeve, theme: 'a'.repeat(65) }).success).toBe(false);
  });
});
