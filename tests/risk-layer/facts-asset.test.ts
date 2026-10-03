import {
  type AssetCurves,
  type AssetFactsInput,
  breakEvenReturn,
  buildAssetFacts,
  type DepthCurve,
  roundTripCost,
} from '@colosseum/risk';
import { AssetFacts, collectFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 7: the sheet holds what the rows hold, and names what they do not. No zero for missing.
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
const sell: AssetCurves = {
  assetId: 'spyx',
  byRegime: {
    us_market_hours: curve([0.001, 0.002, 0.004, 0.02], 40, null),
    us_offhours_weekday: curve([0.001, 0.003, 0.008, 0.05], 40, null),
    weekend: curve([0.002, 0.004, 0.02, 0.2], 3, 0),
  },
};
const buy: AssetCurves = {
  assetId: 'spyx',
  byRegime: { us_market_hours: curve([0.0012, 0.0022, 0.005, 0.03], 40, null) },
};
const meta = {
  source: 'fixture rows',
  method: 'fixture',
  methodVersion: 'risk-0.3',
  provenance: 'fixture' as const,
};
const input = (over: Partial<AssetFactsInput> = {}): AssetFactsInput => ({
  assetId: 'spyx',
  symbol: 'SPYx',
  chain: 'solana',
  mint: 'FIXTUREmint',
  sizeUsd: 10_000,
  tau: 0.01,
  asOf: '2026-10-02T12:00:00.000Z',
  sell,
  buy,
  curveMeta: meta,
  platformFeeBps: 10,
  lp: {
    ...meta,
    fetchedAt: '2026-10-02T11:00:00.000Z',
    top1: 0.4,
    top3: 0.63,
    top10: 0.9,
    lpExitN: 3,
    sellWithoutTopN: [
      { notionalUsd: 10_000, costPct: 1.5 },
      { notionalUsd: 100_000, costPct: 30 },
    ],
  },
  lpWithdrawals: { count: 0, to: '2026-10-02T12:00:00.000Z', source: 'fixture', method: 'count' },
  capacitySeries: {
    ...meta,
    byRegime: {
      us_offhours_weekday: [9_000, 11_000, 9_000, 11_000, 9_000, 11_000, 9_000, 11_000],
      us_market_hours: [50_000, 50_000],
    },
    to: '2026-10-02T12:00:00.000Z',
    minSamples: 8,
  },
  lendingCollateral: { ...meta, usd: 2_000_000, fetchedAt: '2026-10-02T11:00:00.000Z' },
  tracking: [
    { against: 'kamino_scope', regime: 'us_market_hours', gap: 'not_imported' },
    {
      against: 'jupiter_lend_oracle',
      regime: 'us_market_hours',
      gap: { ...meta, value: 0.0015, fetchedAt: '2026-10-02T11:00:00.000Z', samples: 34 },
    },
  ],
  issuer: {
    issuer: 'fixture issuer',
    window: '24x5',
    minNotionalUsd: 5_000,
    kycRequired: true,
    settlementHours: 120,
    capacityUsdPerOpenHour: 100_000,
    feePct: 0,
    provenance: 'assumption',
    source: 'fixture issuer model',
    fetchedAt: '2026-10-01T02:00:00.000Z',
  },
  gapGridPct: [5, 20],
  ...over,
});
const regime = (s: AssetFacts, r: string) =>
  s.costs.find((c) => c.regime === r) as AssetFacts['costs'][number];

describe('buildAssetFacts', () => {
  const sheet = buildAssetFacts(input());

  it('parses, and every number in it is a full fact', () => {
    expect(AssetFacts.safeParse(sheet).success).toBe(true);
    const { facts, invalid } = collectFacts(sheet);
    expect(invalid).toEqual([]);
    expect(facts.length).toBeGreaterThan(80);
  });

  it('costs equal the curves at the sheet size', () => {
    const rth = regime(sheet, 'us_market_hours');
    expect(rth.exit.total.value).toBe(0.004);
    expect(rth.entry.total.value).toBe(0.005);
    expect(rth.roundTrip.value).toBeCloseTo(roundTripCost(0.005, 0.004), 12);
    expect(rth.breakEvenReturn.value).toBeCloseTo(breakEvenReturn(0.005, 0.004), 12);
    expect(rth.exit.total).toMatchObject({
      quality: 'measured',
      regime: 'us_market_hours',
      sizeUsd: 10_000,
      source: 'fixture rows',
      methodVersion: 'risk-0.3',
      fetchedAt: '2026-10-02T00:00:00.000Z',
      samples: 160,
    });
  });

  it('the loss in dollars adds the platform fee and is a lower bound without the network fee', () => {
    const { exit } = regime(sheet, 'us_market_hours');
    // 10,000 × 0.4% + 10,000 × 10 bps
    expect(exit.lossUsd.value).toBeCloseTo(50, 10);
    expect(exit.lossUsd).toMatchObject({ quality: 'lower_bound' });
    expect(exit.networkFeeUsd).toMatchObject({ value: null, reason: 'not_collected' });
    expect(exit.platformFee).toMatchObject({ value: 0.001, quality: 'assumption' });
    expect(exit.poolFee).toMatchObject({ value: null, reason: 'not_collected' });
  });

  it('a thin weekend is null with its reason everywhere, never zero', () => {
    const w = regime(sheet, 'weekend');
    for (const f of [w.exit.total, w.exit.lossUsd, w.roundTrip, w.exitCapacityUsd])
      expect(f).toMatchObject({ value: null, reason: 'insufficient_samples' });
    expect(regime(sheet, 'us_holiday').exit.total).toMatchObject({
      value: null,
      reason: 'insufficient_samples',
    });
    expect(sheet.weekendRatio).toMatchObject({ value: null, reason: 'insufficient_samples' });
    expect(sheet.coverage.regimesMeasured).toEqual(['us_market_hours', 'us_offhours_weekday']);
    expect(sheet.coverage.regimesMissing).toEqual(['weekend', 'us_holiday']);
  });

  it('a regime with no buy curve has an exit and no round trip', () => {
    const off = regime(sheet, 'us_offhours_weekday');
    expect(off.exit.total.value).toBe(0.008);
    expect(off.entry.total).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
    expect(off.roundTrip).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
  });

  it('the worst regime is the costliest measured one, or one that cannot take the size', () => {
    expect(sheet.worstRegime).toBe('us_offhours_weekday');
    const big = buildAssetFacts(
      input({
        sizeUsd: 50_000,
        sell: {
          assetId: 'spyx',
          byRegime: {
            us_market_hours: sell.byRegime.us_market_hours,
            us_offhours_weekday: curve([0.001, 0.003, 0.008, 0.05], 40, 3),
          },
        },
      }),
    );
    expect(big.worstRegime).toBe('us_offhours_weekday');
    expect(regime(big, 'us_offhours_weekday').exit.total).toMatchObject({
      value: null,
      reason: 'beyond_measured_size',
    });
  });

  it('capacity is flagged a lower bound when the whole grid is under tau', () => {
    const cheap = buildAssetFacts(
      input({
        sell: {
          assetId: 'spyx',
          byRegime: { us_market_hours: curve([0.001, 0.001, 0.002, 0.003], 40, null) },
        },
      }),
    );
    expect(regime(cheap, 'us_market_hours').exitCapacityUsd).toMatchObject({
      value: 100_000,
      quality: 'lower_bound',
    });
    expect(regime(sheet, 'us_market_hours').exitCapacityUsd).toMatchObject({ quality: 'measured' });
  });

  it('liquidity stability reads the LP row and the capacity series of the worst regime', () => {
    const s = sheet.liquidityStability;
    expect(s.lpTop3Share.value).toBe(0.63);
    expect(s.lpExitCost).toMatchObject({ value: 0.015, sizeUsd: 10_000 });
    expect(s.lpWithdrawalEvents7d.value).toBe(0);
    // 9k/11k alternating: mean 10k, standard deviation 1k
    expect(s.capacityVariation).toMatchObject({ regime: 'us_offhours_weekday', samples: 8 });
    expect(s.capacityVariation.value).toBeCloseTo(0.1, 12);
    const noLp = buildAssetFacts(input({ lp: null, capacitySeries: null }));
    expect(noLp.liquidityStability.lpTop1Share).toMatchObject({ value: null });
    expect(noLp.liquidityStability.capacityVariation).toMatchObject({
      value: null,
      reason: 'insufficient_samples',
    });
  });

  it('tracking, lending use and the issuer route keep their own sources', () => {
    expect(sheet.tracking[0]?.gap).toMatchObject({ value: null, reason: 'not_imported' });
    expect(sheet.tracking[1]?.gap).toMatchObject({ value: 0.0015, samples: 34 });
    expect(sheet.lendingUse.collateralUsd.value).toBe(2_000_000);
    expect(sheet.lendingUse.coverageByGap.map((g) => g.gapPct)).toEqual([5, 20]);
    expect(sheet.lendingUse.coverageByGap[0]?.value).toMatchObject({ reason: 'not_imported' });
    expect(sheet.issuerRoute.settlementHours).toMatchObject({
      value: 120,
      quality: 'assumption',
      source: 'fixture issuer model',
    });
    expect(sheet.marketRisk.volatilityAnnual).toMatchObject({ reason: 'no_reference_price' });
  });

  it('an asset no collector measures gets a sheet of reasons', () => {
    const none = buildAssetFacts(
      input({
        chain: 'base',
        sell: null,
        buy: null,
        uncoveredReason: 'chain_not_covered',
        lp: null,
        lpWithdrawals: null,
        capacitySeries: null,
        lendingCollateral: null,
        tracking: [],
        issuer: null,
      }),
    );
    expect(AssetFacts.safeParse(none).success).toBe(true);
    const { facts, invalid } = collectFacts(none);
    expect(invalid).toEqual([]);
    const measured = facts.filter((f) => f.fact.value !== null);
    // the platform fee, a policy input, is the only number on the sheet
    expect(measured.every((f) => f.path.endsWith('.platformFee'))).toBe(true);
    expect(none.worstRegime).toBeNull();
    expect(regime(none, 'weekend').exit.total).toMatchObject({ reason: 'chain_not_covered' });
    expect(none.lendingUse.collateralUsd).toMatchObject({ reason: 'not_applicable' });
  });
});
