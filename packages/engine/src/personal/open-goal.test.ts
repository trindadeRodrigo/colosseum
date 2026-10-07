import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { allReasons, editShelf, fixtureContext, launchShelf, sheet, violations } from './testing';
import { PersonalInputError, type PersonalSheet } from './types';

// Rodrigo, Oct 6 (gate GLIDE-OPT-IN), and the review of 9d7dabf. A goal with no date carries a starting
// number of months only so the engine can run: no card, reason or date shows it.

const shelf = launchShelf();
const ctx = fixtureContext();
const open: PersonalSheet = sheet({
  horizonMonths: 120,
  horizonOpen: true,
  rules: { useHoldings: true, glide: false },
});

describe('a goal with no date', () => {
  it('has no term on the card, no glide or near-date reason, and no month made from its 120', () => {
    const plan = compose(open, shelf, ctx);
    expect(violations(plan, shelf, ctx)).toEqual([]);
    expect(plan.card.termMonths).toBeNull();
    const rules = allReasons(plan).map((r) => r.rule);
    expect(rules).not.toContain('GLIDE');
    expect(rules).not.toContain('CASH_NEAR_DATE');
    // 120 months from October 2026 is October 2036: no figure or sentence of the plan says it.
    const said = JSON.stringify({ lines: plan.lines, card: plan.card, reasons: allReasons(plan) });
    expect(said).not.toMatch(/2036|120 months|120 meses/);
    // The same sheet with a date shows its term.
    const dated = compose({ ...open, horizonOpen: undefined }, shelf, ctx);
    expect(dated.card.termMonths).toBe(120);
  });

  it('refuses the glide: it has no date to near', () => {
    expect(() =>
      compose({ ...open, rules: { useHoldings: true, glide: true } }, shelf, ctx),
    ).toThrow(PersonalInputError);
  });
});

// Gate COUNTRY-REMOVED (Rodrigo, Oct 6): the plan reads no country. These tests held that ZZ, SU or
// UK were refused and that an asset blocked in Brazil was left out of a Brazilian's plan.
describe('the country of a sheet', () => {
  it('shapes nothing: none, ZZ, UK or BR give the same plan, and a blocked asset is held', () => {
    const blocked = editShelf(shelf, (a) =>
      a.symbol === 'SPYx' ? { ...a, blockedCountries: ['BR', 'US'] } : a,
    );
    const glideOff = { rules: { useHoldings: true, glide: false } };
    const { country: _, ...base } = sheet(glideOff);
    const none = compose(base, blocked, ctx);
    expect(violations(none, blocked, ctx)).toEqual([]);
    expect(none.lines.map((l) => l.assetId)).toContain('solana:spyx');
    for (const country of ['ZZ', 'UK', 'BR'])
      expect(compose(sheet({ ...glideOff, country }), blocked, ctx).lines, country).toEqual(
        none.lines,
      );
    expect(JSON.stringify(allReasons(none))).not.toMatch(/not offered|Brazil/);
  });
});
