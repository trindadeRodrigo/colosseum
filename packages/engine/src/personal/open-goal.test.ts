import { describe, expect, it } from 'vitest';
import { ISO_3166_1_ALPHA2 } from './countries';
import { compose } from './index';
import { allReasons, editShelf, fixtureContext, launchShelf, sheet, violations } from './testing';
import { isCountryCode, PersonalInputError, type PersonalSheet } from './types';

// Rodrigo, Oct 6 (gate GLIDE-OPT-IN), and the review of 9d7dabf. A goal with no date carries a starting
// number of months only so the engine can run: no card, reason or date shows it. And a country that is
// no country ("ZZ") is refused, never read as "nothing is blocked here".

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

describe('the country of a sheet', () => {
  it('is a country a person lives in, not an unknown place, a group or a code no country has', () => {
    for (const code of ['BR', 'PT', 'US']) expect(isCountryCode(code), code).toBe(true);
    for (const code of ['ZZ', 'AA', 'EU', 'UN', 'XA', 'QZ', 'QQ', 'br', 'BRA', ''])
      expect(isCountryCode(code), code).toBe(false);
  });

  it('a sheet with ZZ is refused, never treated as a place where nothing is blocked', () => {
    try {
      compose(sheet({ country: 'ZZ' }), shelf, ctx);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PersonalInputError);
      expect((e as PersonalInputError).code).toBe('InvalidSheet');
      expect((e as PersonalInputError).issues[0]?.path).toBe('country');
    }
  });

  it('a plan for someone in Brazil leaves out an asset blocked in Brazil', () => {
    const blocked = editShelf(shelf, (a) =>
      a.symbol === 'SPYx' ? { ...a, blockedCountries: ['BR'] } : a,
    );
    const inBrazil = compose(
      sheet({ country: 'BR', rules: { useHoldings: true, glide: false } }),
      blocked,
      ctx,
    );
    expect(inBrazil.lines.map((l) => l.assetId)).not.toContain('solana:spyx');
    expect(allReasons(inBrazil).some((r) => r.rule === 'NOT_IN_COUNTRY')).toBe(true);
    const inPortugal = compose(
      sheet({ country: 'PT', rules: { useHoldings: true, glide: false } }),
      blocked,
      ctx,
    );
    expect(inPortugal.lines.map((l) => l.assetId)).toContain('solana:spyx');
  });
});

// The re-review of Oct 6: aliases and retired codes are no country; "the UK" is GB.
describe('the list of countries', () => {
  it('refuses aliases, retired, reserved and user-assigned codes, and takes assigned ones', () => {
    for (const code of [
      'SU',
      'UK',
      'DD',
      'YU',
      'CS',
      'AN',
      'FX',
      'QO',
      'EA',
      'IC',
      'AC',
      'ZZ',
      'XX',
      'XK',
      'EU',
    ])
      expect(isCountryCode(code), code).toBe(false);
    for (const code of ['GB', 'RU', 'BR', 'US', 'PT']) expect(isCountryCode(code), code).toBe(true);
    expect(ISO_3166_1_ALPHA2.size).toBe(249);
  });

  it('a sheet for SU or UK is refused, so it never buys what is blocked for RU or GB', () => {
    for (const country of ['SU', 'UK'])
      expect(() => compose(sheet({ country }), shelf, ctx), country).toThrow(/is not a country/);
  });
});
