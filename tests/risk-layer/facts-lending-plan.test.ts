import { readFileSync } from 'node:fs';
import {
  type AssetCurves,
  breakEvenReturn,
  buildAssetFacts,
  buildLendingPoolFacts,
  buildPlanFacts,
  type DepthCurve,
  type LendingPoolFactsInput,
  type PlanLeg,
  type Regime,
  roundTripCost,
} from '@colosseum/risk';
import { type AssetFacts, collectFacts, LendingPoolFacts, PlanFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 10 — LendingPoolFacts and PlanFacts. The plan sheet is built from AssetFacts on the frozen
// routed sell curves of fixtures/risk/lending/report.json (mainnet, risk-0.3); every expected value is recomputed from
// the legs' own facts. No sheet may hold a zero where its input was missing.
type Fx = {
  curves: Array<{
    asset_symbol: string;
    regime: Regime;
    points: DepthCurve['points'];
    insufficient_from: number | null;
    quantile: number;
    min_samples: number;
    samples: number;
  }>;
};
const fx = JSON.parse(readFileSync('fixtures/risk/lending/report.json', 'utf8')) as Fx;
const curvesOf = new Map<string, AssetCurves>();
for (const c of fx.curves) {
  const a = curvesOf.get(c.asset_symbol) ?? { assetId: c.asset_symbol, byRegime: {} };
  a.byRegime[c.regime] = {
    points: c.points,
    insufficientFrom: c.insufficient_from,
    quantile: c.quantile,
    minSamples: c.min_samples,
    from: '2026-10-01T21:00:00.000Z',
    to: '2026-10-02T13:00:00.000Z',
    samples: c.samples,
  };
  curvesOf.set(c.asset_symbol, a);
}
const meta = {
  source: 'fixtures/risk/lending/report.json (risk_depth_curves risk-0.3)',
  method: 'routed_greedy_32_chunks',
  methodVersion: 'risk-0.3',
  provenance: 'fixture' as const,
};
const sheetOf = (symbol: string, sizeUsd: number, buy: AssetCurves | null = null): AssetFacts =>
  buildAssetFacts({
    assetId: symbol.toLowerCase(),
    symbol,
    chain: 'solana',
    mint: null,
    sizeUsd,
    tau: 0.01,
    asOf: '2026-10-02T13:00:00.000Z',
    sell: curvesOf.get(symbol) as AssetCurves,
    buy,
    curveMeta: meta,
    platformFeeBps: 0,
    lp: null,
    lpWithdrawals: null,
    capacitySeries: null,
    lendingCollateral: null,
    tracking: [],
    issuer: null,
    gapGridPct: [20],
  });
const leg = (
  symbol: string,
  valueUsd: number,
  over: Partial<PlanLeg> = {},
  buy: AssetCurves | null = null,
): PlanLeg => ({
  assetId: symbol.toLowerCase(),
  valueUsd,
  attrs: {
    issuer: 'Backed Finance (xStocks)',
    chain: 'solana',
    class: 'equity',
    venue: 'raydium_clmm',
    quoteToken: 'USDC',
  },
  sheet: sheetOf(symbol, valueUsd, buy),
  exitPools: [`${symbol}-pool`],
  usesSol: false,
  ...over,
});
const cash = (valueUsd: number): PlanLeg => ({
  assetId: 'usdc',
  valueUsd,
  attrs: { issuer: 'Circle', chain: 'solana', class: 'cash', venue: null, quoteToken: null },
  sheet: null,
  exitPools: [],
  usesSol: false,
});
const plan = (legs: PlanLeg[], extra: Partial<Parameters<typeof buildPlanFacts>[0]> = {}) =>
  buildPlanFacts({
    legs,
    asOf: '2026-10-02T13:00:00.000Z',
    provenance: 'fixture',
    platformFeeBps: 0,
    stress: { gapPct: 20, lpExitN: 3 },
    ...extra,
  });
const exitOf = (s: AssetFacts, r: Regime) =>
  s.costs.find((c) => c.regime === r)?.exit.total.value as number;

describe('PlanFacts', () => {
  const legs = [leg('SPYx', 50_000), leg('TSLAx', 250_000), leg('NVDAx', 10_000), cash(40_000)];
  const p = plan(legs);

  it('parses, every fact is complete or null with a reason, and no missing input reads as zero', () => {
    expect(PlanFacts.safeParse(p).success).toBe(true);
    const { facts, invalid } = collectFacts(p);
    expect(invalid).toEqual([]);
    // the only zero is the stated scenario output (no price change when the lending pools are full)
    expect(facts.filter((f) => f.fact.value === 0).map((f) => f.path)).toEqual([
      'stress[2].lossUsd',
    ]);
  });

  it('exit: the regime with the highest loss among those every leg measures; the plan cost is the legs summed', () => {
    const regimes: Regime[] = ['us_market_hours', 'us_offhours_weekday'];
    const loss = (r: Regime) =>
      legs.slice(0, 3).reduce((s, l) => s + l.valueUsd * exitOf(l.sheet as AssetFacts, r), 0);
    const worst = regimes.reduce((w, r) => (loss(r) > loss(w) ? r : w));
    expect(p.exit.regime).toBe(worst);
    expect(p.exit.planExit.value).toBeCloseTo(loss(worst) / 350_000, 12);
    expect(p.exit.lossUsd.value).toBeCloseTo(loss(worst), 9);
    expect(p.exit.planExit).toMatchObject({ quality: 'measured', regime: worst });
    // network fee not measured: the dollar loss is at least this
    expect(p.exit.lossUsd).toMatchObject({ quality: 'lower_bound' });
    expect(p.exit.legs[3]?.exit).toMatchObject({ value: null, reason: 'not_applicable' });
    expect(p.measuredShare).toBe(1);
  });

  it('a leg with no sheet is named, not dropped: the plan cost becomes a lower bound and the measured share falls', () => {
    const q = plan([
      ...legs,
      {
        ...cash(10_000),
        assetId: 'usdy',
        attrs: { ...cash(0).attrs, class: 'usd_yield', issuer: 'Ondo Finance' },
      },
    ]);
    expect(q.exit.legs[4]?.exit).toMatchObject({ value: null, reason: 'not_collected' });
    expect(q.measuredShare).toBeCloseTo(350_000 / 360_000, 12);
    expect(q.exit.planExit).toMatchObject({ quality: 'lower_bound' });
  });

  it('legs that both route through SOL, or share a pool, are flagged and make the sum a lower bound', () => {
    const q = plan([
      leg('SPYx', 50_000, { usesSol: true }),
      leg('TSLAx', 50_000, { usesSol: true }),
      leg('NVDAx', 50_000, { exitPools: ['shared'] }),
      leg('QQQx', 50_000, { exitPools: ['shared'] }),
      leg('SPYx', 0, { assetId: 'idle', usesSol: true }),
    ]);
    expect(q.exit.legs.map((l) => l.sharedRoute)).toEqual([true, true, true, true, false]);
    expect(q.exit.planExit).toMatchObject({ quality: 'lower_bound' });
  });

  it('concentration by value sums to 1 in every split', () => {
    for (const rows of Object.values(p.concentration))
      expect((rows ?? []).reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 12);
    expect(p.concentration.byClass).toEqual([
      { key: 'equity', share: 310_000 / 350_000 },
      { key: 'cash', share: 40_000 / 350_000 },
    ]);
  });

  it('round trip and break-even from value-weighted entry and exit costs (synthetic buy curve)', () => {
    const buy: AssetCurves = {
      assetId: 'synthetic',
      byRegime: Object.fromEntries(
        Object.entries((curvesOf.get('SPYx') as AssetCurves).byRegime).map(([r, c]) => [
          r,
          {
            ...(c as DepthCurve),
            points: (c as DepthCurve).points.map((x) => ({ ...x, cost: x.cost + 0.001 })),
          },
        ]),
      ),
    };
    const l = leg('SPYx', 100_000, {}, buy);
    const q = plan([l, cash(100_000)]);
    const r = q.exit.regime as Regime;
    const c = (l.sheet as AssetFacts).costs.find((x) => x.regime === r);
    const cIn = (100_000 * (c?.entry.total.value as number)) / 200_000;
    const cOut = (100_000 * (c?.exit.total.value as number)) / 200_000;
    expect(q.netReturn.roundTrip.value).toBeCloseTo(roundTripCost(cIn, cOut), 12);
    expect(q.netReturn.breakEvenReturn.value).toBeCloseTo(breakEvenReturn(cIn, cOut), 12);
    expect(p.netReturn.roundTrip).toMatchObject({ value: null, reason: 'not_collected' });
  });

  it('stress: the weekend gap states its loss; liquidity without weekend curves is null, not zero', () => {
    const w = p.stress.find((s) => s.scenario === 'weekend_gap');
    expect(w?.inputs).toEqual({ gapPct: 20, stockLegs: 3 });
    expect(w?.lossUsd).toMatchObject({ value: 310_000 * 0.2, quality: 'assumption' });
    expect(w?.liquidUsd).toMatchObject({
      value: null,
      reason: 'no_samples_in_regime',
      regime: 'weekend',
    });
    const lp = p.stress.find((s) => s.scenario === 'lp_exit');
    expect(lp?.lossUsd).toMatchObject({ value: null, reason: 'not_collected' });
  });

  it('the breach assessment passes through with its shortfall as a fact', () => {
    const q = plan(legs, {
      breach: {
        result: {
          breach: true,
          likelyBreach: true,
          shortfallUsd: 12_345,
          monthsAtRisk: ['2026-11'],
          regimesMissing: [{ assetId: 'spyx', regime: 'weekend' }],
        },
        source: 'fixture',
        method: 'assessLiquidity',
        methodVersion: 'risk-0.2',
      },
    });
    expect(q.breach).toMatchObject({ breach: true, likelyBreach: true, monthsAtRisk: ['2026-11'] });
    expect(q.breach?.shortfallUsd).toMatchObject({
      value: 12_345,
      unit: 'usd',
      quality: 'measured',
    });
    expect(p.breach).toBeUndefined();
  });
});

describe('LendingPoolFacts', () => {
  const rowMeta = {
    source: 'risk_lending_snapshots (kamino_reserve)',
    method: 'kamino_reserve_decode',
    methodVersion: 'lending-0.1',
    provenance: 'fixture' as const,
    fetchedAt: '2026-10-02T18:11:04.994Z',
  };
  const input: LendingPoolFactsInput = {
    account: 'reserve',
    chain: 'solana',
    venue: 'kamino',
    market: 'xStocks Market',
    symbol: 'USDC',
    verification: 'onchain',
    provenance: 'fixture',
    withdrawal: {
      suppliedUsd: { value: 5_702_770, ...rowMeta },
      availableUsd: { value: 553_607, ...rowMeta },
      shareLentOut: { value: 0.9039, ...rowMeta },
      hoursAboveAlarmShare: { value: 0.0056, ...rowMeta, samples: 1800 },
    },
    rates: {
      supplyApy: { value: 0.0456, ...rowMeta },
      supplyApyVariation: { reason: 'insufficient_samples' },
      borrowApy: { value: 0.0564, ...rowMeta },
    },
    lenders: {
      top1Share: { value: 0.916, ...rowMeta, lowerBound: true },
      top3Share: { reason: 'not_collected', detail: 'no supplier attributed' },
      top10Share: { reason: 'not_collected' },
    },
    collateral: [
      {
        asset: 'SPYx',
        collateralUsd: { value: 4_415_220, ...rowMeta },
        liquidationThreshold: { value: 0.75, ...rowMeta },
        liquidationBonus: { value: 0.05, ...rowMeta },
        oracleGap: { us_market_hours: { value: 0.00026, samples: 56, ...rowMeta } },
        coverageByGap: [
          { gapPct: 20, ratio: { value: 1.41, ...rowMeta, regime: 'us_market_hours' } },
          {
            gapPct: 5,
            ratio: { reason: 'not_applicable', detail: 'no position is liquidated at this gap' },
          },
        ],
        regimesMissing: ['weekend'],
        routes: [],
        observed: {
          liquidations: { value: 61, ...rowMeta },
          soldInSameTxShare: { value: 0.393, ...rowMeta },
          realisedVsMid: { reason: 'not_collected' },
        },
      },
    ],
    history: {
      liquidations: { value: 274, ...rowMeta },
      liquidatedUsd: { value: 44_300, ...rowMeta, lowerBound: true },
      socialisedLossUsd: { value: 0, ...rowMeta },
      parameterChanges30d: { value: 1, ...rowMeta },
    },
    dataFrom: '2025-07-08T15:00:00.000Z',
    dataTo: '2026-10-02T18:11:04.994Z',
  };
  const s = buildLendingPoolFacts(input);

  it('parses; every fact is complete or null with its reason', () => {
    expect(LendingPoolFacts.safeParse(s).success).toBe(true);
    expect(collectFacts(s).invalid).toEqual([]);
  });

  it('a read value keeps its source and time; a reason stays null; a lower bound says so', () => {
    expect(s.withdrawal.availableUsd).toMatchObject({
      value: 553_607,
      unit: 'usd',
      quality: 'measured',
      source: rowMeta.source,
      fetchedAt: rowMeta.fetchedAt,
    });
    expect(s.lenders.top1Share).toMatchObject({ value: 0.916, quality: 'lower_bound' });
    expect(s.lenders.top3Share).toMatchObject({
      value: null,
      reason: 'not_collected',
      detail: 'no supplier attributed',
    });
    expect(s.history.liquidatedUsd).toMatchObject({ quality: 'lower_bound' });
    // a zero is kept only where it was read (no socialised loss decoded), never for a missing input
    const zeros = collectFacts(s)
      .facts.filter((f) => f.fact.value === 0)
      .map((f) => f.path);
    expect(zeros).toEqual(['history.socialisedLossUsd']);
  });

  it('oracle gaps cover every regime, missing ones named; coverage carries its regime and the regimes it could not price', () => {
    const c = s.collateral[0];
    expect(c?.oracleGap.map((g) => g.regime)).toEqual([
      'us_market_hours',
      'us_offhours_weekday',
      'weekend',
      'us_holiday',
    ]);
    expect(c?.oracleGap[0]?.gap).toMatchObject({
      value: 0.00026,
      regime: 'us_market_hours',
      samples: 56,
    });
    expect(c?.oracleGap[2]?.gap).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
    expect(c?.coverageByGap[0]?.value).toMatchObject({
      value: 1.41,
      unit: 'ratio',
      regime: 'us_market_hours',
    });
    expect(c?.coverageByGap[1]?.value).toMatchObject({ value: null, reason: 'not_applicable' });
    expect(c?.regimesMissing).toEqual(['weekend']);
  });
});
