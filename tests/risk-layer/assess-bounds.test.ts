import { readFileSync } from 'node:fs';
import {
  type AssetCurves,
  assessLiquidity,
  type DepthCurve,
  defaultRegimeParams,
  REGIMES,
  type Regime,
  type RegimeParams,
  regimeAt,
  regimesIn,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 2 — `POST /risk/positions/assess` froze the API (AUDIT-VAULT.md finding 9): a 365-day window
// walked every hour per withdrawal, and the breach loop repeated it up to 21 times. Reproduced 2026-10-02 at 96a9f32+:
// 60 monthly withdrawals with a 365-day window took 25.2 s (12 took 4.8 s). The fix must give the same answers.
const RP = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
type Fx = {
  curves: Array<{
    asset_symbol: string;
    regime: Regime;
    points: DepthCurve['points'];
    insufficient_from: number | null;
    min_samples: number;
    samples: number;
  }>;
};
const fx = JSON.parse(readFileSync('fixtures/risk/lending/report.json', 'utf8')) as Fx;
const curves: AssetCurves = {
  assetId: 'spyx',
  byRegime: Object.fromEntries(
    fx.curves
      .filter((c) => c.asset_symbol === 'SPYx')
      .map((c) => [
        c.regime,
        {
          points: c.points,
          insufficientFrom: c.insufficient_from,
          quantile: 0.5,
          minSamples: c.min_samples,
          from: null,
          to: null,
          samples: c.samples,
        },
      ]),
  ),
};

/** The hour-by-hour walk as it was before the fix: the reference the fast version must equal. */
function regimesInReference(at: Date, hours: number, p: RegimeParams): Regime[] {
  const seen = new Set<Regime>();
  for (let k = 0; k <= Math.ceil(hours); k++)
    seen.add(regimeAt(new Date(at.getTime() + Math.min(k, hours) * 3_600_000), p));
  return REGIMES.filter((r) => seen.has(r));
}

describe('assess stays fast on the largest input the route accepts', () => {
  it('600 monthly withdrawals (the route maximum) with a 365-day window finish in under 1.5 s', () => {
    const withdrawals = Array.from({ length: 600 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 10 + i, 15, 12, i % 60)).toISOString(),
      usd: 50_000,
    }));
    const t = performance.now();
    const r = assessLiquidity({
      cashUsd: 0,
      brlUsd: 0,
      liquid: [],
      illiquid: [{ assetId: 'spyx', valueUsd: 10_000_000, curves }],
      withdrawals,
      windowDays: 365,
      tau: 0.01,
      shareOfDepth: 0.25,
      dryFactorFloor: 0.25,
      regimeParams: RP,
    });
    expect(performance.now() - t).toBeLessThan(1_500);
    expect(r.checks).toHaveLength(600);
  });

  it('regimesIn equals the hour-by-hour walk: DST changes, holidays at the edges, short and long windows', () => {
    const starts = [
      '2026-11-01T05:30:00Z', // DST ends that morning in New York
      '2026-03-08T06:59:00Z', // DST starts
      '2026-11-26T04:59:00Z', // Thanksgiving begins at ET midnight
      '2026-11-25T23:00:00Z',
      '2026-12-24T20:45:00Z',
      '2026-10-02T13:17:00Z',
      '2026-10-02T23:59:59Z',
      '2027-01-01T04:00:00Z',
    ];
    const lengths = [
      0,
      0.5,
      1,
      3.25,
      7,
      23,
      24,
      25,
      47.9,
      48,
      72,
      167,
      168,
      169,
      400,
      24 * 30,
      24 * 365,
    ];
    let n = 0;
    for (const s of starts)
      for (const h of lengths) {
        expect(regimesIn(new Date(s), h, RP), `${s} +${h}h`).toEqual(
          regimesInReference(new Date(s), h, RP),
        );
        n++;
      }
    // and on a seeded spread of random windows
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 300; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + rnd() * 2 * 365 * 86_400_000);
      const h = rnd() < 0.5 ? rnd() * 72 : rnd() * 24 * 120;
      expect(regimesIn(at, h, RP), `${at.toISOString()} +${h}h`).toEqual(
        regimesInReference(at, h, RP),
      );
      n++;
    }
    expect(n).toBe(starts.length * lengths.length + 300);
  });
});
