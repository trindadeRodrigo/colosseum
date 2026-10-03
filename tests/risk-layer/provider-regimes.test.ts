import { readFileSync } from 'node:fs';
import {
  type AssetCurves,
  assessLiquidity,
  createLiquidityProvider,
  type DepthCurve,
  defaultRegimeParams,
  liquidityScore,
  measuredRegimes,
  REGIMES,
  weekendRatio,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS items 2 (first fix) and 6: a regime with too few samples is "not measured", never zero capacity,
// and the provider answers per regime beside its worst-regime answers.
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const GRID = [100, 1_000, 10_000, 100_000];
const curve = (costs: number[], samples: number, insufficientFrom: number | null): DepthCurve => ({
  points: GRID.map((n, i) => ({ notionalUsd: n, cost: costs[i] as number, samples })),
  insufficientFrom,
  quantile: 0.5,
  minSamples: 8,
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
  samples: samples * GRID.length,
});
const rth = curve([0.001, 0.002, 0.004, 0.02], 40, null);
const offhours = curve([0.001, 0.003, 0.008, 0.05], 40, null);
const thinWeekend = curve([0.002, 0.004, 0.02, 0.2], 3, 0);
const buyRth = curve([0.0012, 0.0022, 0.005, 0.03], 40, null);

const asset = (byRegime: AssetCurves['byRegime']): AssetCurves => ({ assetId: 'spyx', byRegime });
const provider = (sell: AssetCurves, buy?: AssetCurves) =>
  createLiquidityProvider({
    curves: new Map([['spyx', sell]]),
    buyCurves: buy ? new Map([['spyx', buy]]) : undefined,
    regimeParams: P,
    methodVersion: 'risk-0.3',
    provenance: 'fixture',
  });

describe('a regime with too few samples is not measured (DA2)', () => {
  const thin = asset({
    us_market_hours: rth,
    us_offhours_weekday: offhours,
    weekend: thinWeekend,
  });

  it('measuredRegimes names it with its reason', () => {
    const m = measuredRegimes(thin);
    expect(m.measured).toEqual(['us_market_hours', 'us_offhours_weekday']);
    expect(m.missing).toEqual([
      { regime: 'weekend', reason: 'insufficient_samples' },
      { regime: 'us_holiday', reason: 'insufficient_samples' },
    ]);
    expect(measuredRegimes(asset({ us_market_hours: rth })).missing).toContainEqual({
      regime: 'weekend',
      reason: 'no_samples_in_regime',
    });
  });

  it('exit capacity comes from the measured regimes, not zero', () => {
    const c = provider(thin).exitCapacity('spyx', 0.01, 7);
    // off-hours crosses 1% between $10k (0.8%) and $100k (5%)
    expect(c?.regime).toBe('us_offhours_weekday');
    expect(c?.capacityUsd).toBeGreaterThan(10_000);
    expect(c?.capacityUsd).toBeLessThan(100_000);
  });

  it('exit cost is the worst of the measured regimes, not null', () => {
    expect(provider(thin).exitCost('spyx', 10_000, 7)).toBe(0.008);
  });

  it('the weekend ratio is null until the weekend is measured', () => {
    expect(weekendRatio(thin, 0.01)).toBeNull();
    expect(provider(thin).weekendRatio('spyx', 0.01)).toBeNull();
    const full = asset({
      us_market_hours: rth,
      weekend: curve([0.002, 0.004, 0.02, 0.2], 40, null),
    });
    expect(weekendRatio(full, 0.01)).toBeGreaterThan(0);
  });

  it('a breach check names the missing regime and uses the measured ones', () => {
    const r = assessLiquidity({
      cashUsd: 0,
      brlUsd: 0,
      liquid: [],
      illiquid: [{ assetId: 'spyx', valueUsd: 50_000, curves: thin }],
      withdrawals: [{ at: '2026-10-12T15:00:00.000Z', usd: 2_000 }],
      windowDays: 7,
      tau: 0.01,
      shareOfDepth: 0.25,
      dryFactorFloor: 0.25,
      regimeParams: P,
    });
    // 25% of the off-hours capacity at 1% (about $11k), where the thin weekend used to give zero
    expect(r.checks[0]?.capacity).toBeGreaterThan(2_500);
    expect(r.checks[0]?.capacity).toBeLessThan(3_000);
    expect(r.breach).toBe(false);
    expect(r.regimesMissing).toEqual([{ assetId: 'spyx', regime: 'weekend' }]);
  });

  it('an asset with no measured regime has no capacity answer', () => {
    const none = provider(asset({ weekend: thinWeekend }));
    expect(none.exitCapacity('spyx', 0.01, 7)).toBeNull();
    expect(none.exitCost('spyx', 1_000, 7)).toBeNull();
    expect(none.entry('spyx', { tau: 0.01, windowDays: 7, legAmountUsd: 1_000 })).toBeNull();
  });
});

describe('per-regime answers (item 6)', () => {
  const full = asset({ us_market_hours: rth, us_offhours_weekday: offhours, weekend: thinWeekend });
  const p = provider(full, asset({ us_market_hours: buyRth }));

  it('exitCostIn equals the curve in each measured regime', () => {
    expect(p.exitCostIn('spyx', 10_000, 'us_market_hours')).toMatchObject({
      cost: 0.004,
      reason: null,
      regimeUsed: 'us_market_hours',
      samples: 160,
    });
    expect(p.exitCostIn('spyx', 10_000, 'us_offhours_weekday')?.cost).toBe(0.008);
  });

  it('a missing answer carries its reason', () => {
    expect(p.exitCostIn('spyx', 10_000, 'weekend')).toMatchObject({
      cost: null,
      reason: 'insufficient_samples',
    });
    expect(p.exitCostIn('spyx', 500_000, 'us_market_hours')).toMatchObject({
      cost: null,
      reason: 'beyond_measured_size',
    });
    expect(p.entryCostIn('spyx', 10_000, 'weekend')).toMatchObject({
      cost: null,
      reason: 'no_samples_in_regime',
    });
    expect(p.exitCostIn('unknown', 10_000, 'weekend')).toBeNull();
  });

  it('entryCostIn reads the buy curves', () => {
    expect(p.entryCostIn('spyx', 10_000, 'us_market_hours')?.cost).toBe(0.005);
    expect(provider(full).entryCostIn('spyx', 10_000, 'us_market_hours')).toBeNull();
  });

  it('the worst-regime answer is the maximum over the measured regimes', () => {
    const per = REGIMES.map((r) => p.exitCostIn('spyx', 10_000, r)?.cost).filter(
      (c): c is number => typeof c === 'number',
    );
    expect(p.exitCost('spyx', 10_000, 7)).toBe(Math.max(...per));
    expect(p.regimes('spyx')?.measured).toEqual(['us_market_hours', 'us_offhours_weekday']);
  });

  it('exitCapacityIn answers per regime', () => {
    expect(p.exitCapacityIn('spyx', 0.01, 'us_market_hours')?.capacityUsd).toBeGreaterThan(10_000);
    expect(p.exitCapacityIn('spyx', 0.01, 'weekend')).toBeNull();
  });
});

describe('the liquidity score and the planner order skip a regime that is not measured (DA2)', () => {
  const thin = asset({ us_market_hours: rth, us_offhours_weekday: offhours, weekend: thinWeekend });

  it('a window with a thin weekend scores on the measured regimes and names the weekend', () => {
    const s = liquidityScore(
      thin,
      ['us_market_hours', 'us_offhours_weekday', 'weekend'],
      0.01,
      100_000,
    );
    expect(s.worstRegime).toBe('us_offhours_weekday');
    expect(s.score).toBeGreaterThan(0);
    expect(s.regimesMissing).toEqual([{ regime: 'weekend', reason: 'insufficient_samples' }]);
  });

  it('a window with no measured regime has no score, never zero', () => {
    const s = liquidityScore(thin, ['weekend'], 0.01, 100_000);
    expect(s.score).toBeNull();
    expect(s.capacityUsd).toBeNull();
    expect(s.regimesMissing).toEqual([{ regime: 'weekend', reason: 'insufficient_samples' }]);
  });

  it('sells the least liquid leg first even when both have a thin weekend', () => {
    // `deep` has the market-hours curve, `shallow` costs more at every size; the deep one is listed first
    const shallowCurve = curve([0.004, 0.008, 0.03, 0.2], 40, null);
    const r = assessLiquidity({
      cashUsd: 0,
      brlUsd: 0,
      liquid: [],
      illiquid: [
        { assetId: 'deep', valueUsd: 50_000, curves: { ...thin, assetId: 'deep' } },
        {
          assetId: 'shallow',
          valueUsd: 50_000,
          curves: asset({
            us_market_hours: shallowCurve,
            us_offhours_weekday: shallowCurve,
            weekend: thinWeekend,
          }),
        },
      ],
      withdrawals: [{ at: '2026-10-12T15:00:00.000Z', usd: 20_000 }],
      windowDays: 7,
      tau: 0.01,
      shareOfDepth: 0.25,
      dryFactorFloor: 0.25,
      regimeParams: P,
    });
    expect(r.orders[0]?.fromAssetId).toBe('shallow');
  });
});
