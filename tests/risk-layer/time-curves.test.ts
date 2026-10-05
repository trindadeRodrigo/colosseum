import { readFileSync } from 'node:fs';
import {
  costAt,
  defaultRegimeParams,
  fitCurve,
  hourOfWeek,
  isotonic,
  maxNotionalAt,
  recoverable,
  regimeAt,
  regimesIn,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

const cal = JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8'));
const P = defaultRegimeParams(cal);
const at = (s: string) => new Date(s);

describe('time of week (ET, DST, holidays)', () => {
  it('classifies regimes', () => {
    expect(regimeAt(at('2026-10-03T10:00:00Z'), P)).toBe('weekend'); // Sat 06:00 ET
    expect(regimeAt(at('2026-10-06T15:00:00Z'), P)).toBe('us_market_hours'); // Tue 11:00 EDT
    expect(regimeAt(at('2026-10-06T23:00:00Z'), P)).toBe('us_offhours_weekday'); // Tue 19:00 EDT
    expect(regimeAt(at('2026-10-02T23:59:00Z'), P)).toBe('us_offhours_weekday'); // Fri 19:59 EDT
    expect(regimeAt(at('2026-10-03T00:00:00Z'), P)).toBe('weekend'); // Fri 20:00 EDT
    expect(regimeAt(at('2026-10-05T00:00:00Z'), P)).toBe('us_offhours_weekday'); // Sun 20:00 EDT
    expect(regimeAt(at('2026-11-26T16:00:00Z'), P)).toBe('us_holiday'); // Thanksgiving
    expect(regimeAt(at('2026-11-27T19:00:00Z'), P)).toBe('us_offhours_weekday'); // early close 13:00, now 14:00 EST
  });
  it('handles the DST change (Sun Nov 1, 2026)', () => {
    // 14:00Z is 10:00 EDT before the change and 09:00 EST after it
    expect(regimeAt(at('2026-10-30T14:00:00Z'), P)).toBe('us_market_hours');
    expect(regimeAt(at('2026-11-02T14:00:00Z'), P)).toBe('us_offhours_weekday');
    expect(regimeAt(at('2026-11-02T14:30:00Z'), P)).toBe('us_market_hours');
    expect(hourOfWeek(at('2026-11-02T14:00:00Z'))).toBe(9);
  });
  it('lists the regimes a horizon can contain', () => {
    expect(regimesIn(at('2026-10-03T10:00:00Z'), 24, P)).toEqual(['weekend']);
    expect(regimesIn(at('2026-10-03T10:00:00Z'), 72, P)).toEqual([
      'us_market_hours',
      'us_offhours_weekday',
      'weekend',
    ]);
  });
});

describe('depth curve fit and queries', () => {
  const grid = [100, 1_000, 10_000, 100_000];
  const samples = grid.flatMap((n, i) =>
    [0.001, 0.002, 0.003].map((base, k) => ({
      notionalUsd: n,
      cost: base * (i + 1) + k * 0.0001,
      at: `2026-10-0${k + 1}T00:00:00Z`,
    })),
  );
  const c = fitCurve(samples, { quantile: 0.5, minSamples: 3 });
  it('fits a monotone curve with coverage', () => {
    expect(c.points.map((p) => p.samples)).toEqual([3, 3, 3, 3]);
    for (let i = 1; i < c.points.length; i++)
      expect((c.points[i] as { cost: number }).cost).toBeGreaterThanOrEqual(
        (c.points[i - 1] as { cost: number }).cost,
      );
    expect(c.from).toBe('2026-10-01T00:00:00Z');
    expect(isotonic([1, 3, 2, 4])).toEqual([1, 2.5, 2.5, 4]);
  });
  it('queries are consistent and do not extrapolate', () => {
    const tau = 0.005;
    const m = maxNotionalAt(c, tau);
    expect(costAt(c, m.notionalUsd)).toBeCloseTo(tau, 12);
    expect(costAt(c, 1e9)).toBeNull();
    expect(recoverable(c, 1_000)).toBeCloseTo(1_000 * (1 - (costAt(c, 1_000) as number)), 9);
    expect(maxNotionalAt(c, 1).lowerBound).toBe(true);
    expect(maxNotionalAt(c, 0).notionalUsd).toBe(0);
  });
  it('marks thin grid points insufficient', () => {
    const thin = fitCurve(
      samples.filter((s) => !(s.notionalUsd === 100_000 && s.cost > 0.005)),
      { quantile: 0.5, minSamples: 3 },
    );
    expect(thin.insufficientFrom).toBe(3);
    expect(costAt(thin, 100_000)).toBeNull();
  });
});
