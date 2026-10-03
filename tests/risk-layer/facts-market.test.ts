import { readFileSync } from 'node:fs';
import {
  type AssetFactsInput,
  buildAssetFacts,
  buildPlanFacts,
  correlation,
  type DailyClose,
  dailyCloses,
  defaultFactsParams,
  gapFrequency,
  maxDrawdown,
  type PlanLeg,
  type PricePoint,
  planCloses,
  type Regime,
  volatilityAnnual,
  weekendGaps,
} from '@colosseum/risk';
import { AssetFacts, collectFacts, PlanFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 12: volatility, drawdown, correlation and weekend gap frequency from the reference price.
// Hand-computed cases on small series, then frozen mainnet rows (risk_reference_prices, 120 days to 2026-10-02):
// every fact carries its samples, a gap never seen is a measured zero with its weekends, and a missing price is
// `null` with its reason, never zero.
const fx = JSON.parse(readFileSync('fixtures/risk/prices/market-series.json', 'utf8')) as {
  source: string;
  method: string;
  methodVersion: string;
  series: Record<string, Array<[string, number, Regime, string | null]>>;
};
const real = (symbol: string): PricePoint[] =>
  (fx.series[symbol] ?? []).map(([at, priceUsd, regime, quality]) => ({
    at,
    priceUsd,
    regime,
    quality,
  }));
const meta = {
  source: fx.source,
  method: fx.method,
  methodVersion: fx.methodVersion,
  provenance: 'fixture' as const,
};
const P = defaultFactsParams();

const pt = (at: string, priceUsd: number, regime: Regime): PricePoint => ({
  at,
  priceUsd,
  regime,
  quality: 'traded',
});
const closes = (prices: number[]): DailyClose[] =>
  prices.map((priceUsd, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    at: `2026-01-${String(i + 1).padStart(2, '0')}T20:00:00.000Z`,
    priceUsd,
  }));

describe('market risk on hand-computed series', () => {
  it('a daily close is the last market-hours price of the ET date', () => {
    const c = dailyCloses([
      pt('2026-09-28T14:00:00.000Z', 100, 'us_market_hours'),
      pt('2026-09-28T19:00:00.000Z', 101, 'us_market_hours'),
      pt('2026-09-28T23:00:00.000Z', 140, 'us_offhours_weekday'),
      // 00:00Z on the 29th is still the 28th in New York, and off-hours
      pt('2026-09-29T00:00:00.000Z', 150, 'us_offhours_weekday'),
      pt('2026-09-29T15:00:00.000Z', 99, 'us_market_hours'),
    ]);
    expect(c).toEqual([
      { date: '2026-09-28', at: '2026-09-28T19:00:00.000Z', priceUsd: 101 },
      { date: '2026-09-29', at: '2026-09-29T15:00:00.000Z', priceUsd: 99 },
    ]);
  });

  it('volatility is the sample sd of log returns times the square root of trading days', () => {
    const c = closes([100, 110, 99, 108.9]);
    const rs = [Math.log(1.1), Math.log(0.9), Math.log(1.1)];
    const mean = rs.reduce((a, x) => a + x, 0) / 3;
    const sd = Math.sqrt(rs.reduce((a, x) => a + (x - mean) ** 2, 0) / 2);
    expect(volatilityAnnual(c, { tradingDays: 252, minReturns: 3 })?.value).toBeCloseTo(
      sd * Math.sqrt(252),
      12,
    );
    expect(volatilityAnnual(c, { tradingDays: 252, minReturns: 4 })).toBeNull();
  });

  it('drawdown is the largest fall from a running peak', () => {
    expect(maxDrawdown(closes([100, 120, 90, 130, 104, 125]), 2)).toEqual({
      value: 0.25,
      samples: 6,
      peak: '2026-01-02',
      trough: '2026-01-03',
    });
    expect(maxDrawdown(closes([1, 2, 3]), 2)?.value).toBe(0);
    expect(maxDrawdown(closes([1, 2]), 3)).toBeNull();
  });

  it('a weekend gap runs from the last market-hours price before it to the first after it', () => {
    const s = [
      // stretch at the start of the data: no close before it, not counted
      pt('2026-09-05T12:00:00.000Z', 90, 'weekend'),
      pt('2026-09-11T19:00:00.000Z', 100, 'us_market_hours'),
      pt('2026-09-11T22:00:00.000Z', 300, 'us_offhours_weekday'),
      pt('2026-09-12T12:00:00.000Z', 50, 'weekend'),
      pt('2026-09-14T14:00:00.000Z', 112, 'us_market_hours'),
      // a weekday night: not a weekend
      pt('2026-09-14T23:00:00.000Z', 10, 'us_offhours_weekday'),
      pt('2026-09-15T14:00:00.000Z', 100, 'us_market_hours'),
      // a long weekend (holiday Monday) is one gap
      pt('2026-09-18T19:00:00.000Z', 100, 'us_market_hours'),
      pt('2026-09-19T12:00:00.000Z', 100, 'weekend'),
      pt('2026-09-21T15:00:00.000Z', 100, 'us_holiday'),
      pt('2026-09-22T14:00:00.000Z', 96, 'us_market_hours'),
      // stretch at the end: no open after it, not counted
      pt('2026-09-25T19:00:00.000Z', 96, 'us_market_hours'),
      pt('2026-09-26T12:00:00.000Z', 20, 'weekend'),
    ];
    const g = weekendGaps(s);
    expect(g.map((x) => [x.closeAt, x.openAt])).toEqual([
      ['2026-09-11T19:00:00.000Z', '2026-09-14T14:00:00.000Z'],
      ['2026-09-18T19:00:00.000Z', '2026-09-22T14:00:00.000Z'],
    ]);
    expect(g[0]?.gap).toBeCloseTo(0.12, 12);
    expect(g[1]?.gap).toBeCloseTo(-0.04, 12);
    expect(gapFrequency(g, [5, 10, 20], 2)).toEqual([
      { gapPct: 5, share: 0.5, seen: 1, weekends: 2 },
      { gapPct: 10, share: 0.5, seen: 1, weekends: 2 },
      { gapPct: 20, share: 0, seen: 0, weekends: 2 },
    ]);
    expect(gapFrequency(g, [5], 3)).toEqual([{ gapPct: 5, weekends: 2 }]);
  });

  it('correlation is 1 for the same moves, −1 for mirrored ones, and needs common dates', () => {
    const a = closes([100, 110, 99, 108.9, 100]);
    const mirror = closes([100, 100 / 1.1, 100 / 0.99, 100 / 1.089, 100]);
    expect(correlation(a, a, 3)?.value).toBeCloseTo(1, 12);
    expect(correlation(a, mirror, 3)?.value).toBeCloseTo(-1, 12);
    expect(correlation(a, a.slice(0, 3), 3)).toBeNull();
  });

  it('a plan index grows by the weighted return of its legs', () => {
    const a = closes([100, 110, 121]);
    const b = closes([10, 10, 5]);
    expect(planCloses([{ weight: 1, closes: a }]).map((c) => c.priceUsd)).toEqual([
      1,
      1.1,
      1.1 * 1.1,
    ]);
    const mix = planCloses([
      { weight: 0.5, closes: a },
      { weight: 0.5, closes: b },
    ]).map((c) => c.priceUsd);
    expect(mix[1]).toBeCloseTo(1.05, 12);
    expect(mix[2]).toBeCloseTo(1.05 * (1 + 0.5 * 0.1 + 0.5 * -0.5), 12);
  });
});

const sheet = (marketRisk: AssetFactsInput['marketRisk']) =>
  buildAssetFacts({
    assetId: 'tslax',
    symbol: 'TSLAx',
    chain: 'solana',
    mint: null,
    sizeUsd: 10_000,
    tau: 0.01,
    asOf: '2026-10-03T00:00:00.000Z',
    sell: null,
    buy: null,
    curveMeta: meta,
    platformFeeBps: 0,
    lp: null,
    lpWithdrawals: null,
    capacitySeries: null,
    lendingCollateral: null,
    tracking: [],
    issuer: null,
    gapGridPct: [2, 5, 20],
    marketRisk,
  });

describe('the asset sheet on frozen mainnet prices', () => {
  it('measures volatility, drawdown and gap frequency with their samples', () => {
    const series = real('TSLAx');
    const s = sheet({ ...meta, series });
    expect(AssetFacts.safeParse(s).success).toBe(true);
    expect(collectFacts(s).invalid).toEqual([]);
    const c = dailyCloses(series);
    const vol = volatilityAnnual(c, {
      tradingDays: P.tradingDaysPerYear,
      minReturns: P.marketRiskMinReturns,
    });
    expect(s.marketRisk.volatilityAnnual).toMatchObject({
      value: vol?.value,
      quality: 'measured',
      samples: c.length - 1,
    });
    expect(c.length).toBeGreaterThan(70);
    const gaps = weekendGaps(series);
    expect(gaps.length).toBeGreaterThanOrEqual(P.minWeekends);
    // every gap spans a weekend: close on a Friday (or earlier), open on a Monday (or later)
    for (const g of gaps)
      expect(Date.parse(g.openAt) - Date.parse(g.closeAt)).toBeGreaterThan(48 * 3_600_000);
    for (const g of s.marketRisk.weekendGapFrequency) {
      expect(g.value).toMatchObject({ quality: 'measured', samples: gaps.length });
      const seen = gaps.filter((x) => Math.abs(x.gap) > g.gapPct / 100).length;
      expect(g.value.value).toBe(seen / gaps.length);
    }
  });

  it('names what is missing, never zero; a price that is only par is an assumption', () => {
    const none = sheet(null);
    expect(none.marketRisk.volatilityAnnual).toMatchObject({
      value: null,
      reason: 'no_reference_price',
    });
    expect(none.marketRisk.weekendGapFrequency.every((g) => g.value.value === null)).toBe(true);
    const short = sheet({ ...meta, series: real('TSLAx').slice(-24 * 10) });
    expect(short.marketRisk.volatilityAnnual).toMatchObject({
      value: null,
      reason: 'insufficient_samples',
    });
    expect(short.marketRisk.weekendGapFrequency[0]?.value).toMatchObject({
      value: null,
      reason: 'insufficient_samples',
    });
    const usdc = sheet({ ...meta, series: real('USDC') });
    expect(usdc.marketRisk.volatilityAnnual).toMatchObject({ value: 0, quality: 'assumption' });
  });
});

describe('the plan on frozen mainnet prices', () => {
  const leg = (assetId: string, valueUsd: number, symbol: string | null): PlanLeg => ({
    assetId,
    valueUsd,
    attrs: { issuer: null, chain: 'solana', class: 'equity', venue: null, quoteToken: null },
    sheet: null,
    exitPools: [],
    usesSol: false,
    prices: symbol ? { ...meta, series: real(symbol) } : null,
  });
  const plan = (legs: PlanLeg[]) =>
    buildPlanFacts({
      legs,
      asOf: '2026-10-03T00:00:00.000Z',
      provenance: 'fixture',
      platformFeeBps: 0,
      stress: { gapPct: 20, lpExitN: 3 },
    });

  it('gives the correlation of each moving pair and the plan held at its weights', () => {
    const p = plan([
      leg('spyx', 50_000, 'SPYx'),
      leg('qqqx', 30_000, 'QQQx'),
      leg('usdc', 20_000, 'USDC'),
    ]);
    expect(PlanFacts.safeParse(p).success).toBe(true);
    expect(collectFacts(p).invalid).toEqual([]);
    const mr = p.marketRisk as NonNullable<typeof p.marketRisk>;
    expect(mr.legsAtPar).toEqual(['usdc']);
    expect(mr.correlations.map((c) => [c.a, c.b])).toEqual([['spyx', 'qqqx']]);
    const corr = correlation(dailyCloses(real('SPYx')), dailyCloses(real('QQQx')), 20);
    expect(mr.correlations[0]?.value).toMatchObject({ value: corr?.value, quality: 'measured' });
    expect(corr?.value).toBeGreaterThan(0.5);
    // USDC at par enters as a peg: the plan's own figures are an assumption
    expect(mr.volatilityAnnual).toMatchObject({ quality: 'assumption' });
    const index = planCloses([
      { weight: 0.5, closes: dailyCloses(real('SPYx')) },
      { weight: 0.3, closes: dailyCloses(real('QQQx')) },
      { weight: 0.2, closes: dailyCloses(real('USDC')) },
    ]);
    expect(mr.volatilityAnnual.value).toBe(
      volatilityAnnual(index, { tradingDays: 252, minReturns: 20 })?.value,
    );
    expect(mr.maxDrawdown.value).toBe(maxDrawdown(index, 21)?.value);
  });

  it('a leg with no price makes the plan figures null with the leg named', () => {
    const p = plan([leg('tslax', 50_000, 'TSLAx'), leg('usdy', 50_000, null)]);
    const mr = p.marketRisk as NonNullable<typeof p.marketRisk>;
    expect(mr.legsWithoutPrices).toEqual(['usdy']);
    expect(mr.volatilityAnnual).toMatchObject({ value: null, reason: 'no_reference_price' });
    expect(mr.maxDrawdown).toMatchObject({ value: null, reason: 'no_reference_price' });
    expect(plan([{ ...leg('x', 1, null), prices: undefined }]).marketRisk).toBeUndefined();
  });
});
