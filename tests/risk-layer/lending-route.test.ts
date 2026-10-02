import { readFileSync } from 'node:fs';
import {
  type AssetCurves,
  bestRoute,
  costAt,
  coverageRatio,
  curveFor,
  type DepthCurve,
  defaultLendingReportParams,
  type GapPosition,
  type IssuerModel,
  lendingGapSim,
  liquidationCapacity,
  liquidationRoutes,
  liquidatorMargin,
  marginTolerance,
  type OracleGapObs,
  type Regime,
  saleCapacity,
  weekendDepthRatio,
} from '@colosseum/risk';
import { collectFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 8 — liquidation margin, capacity and routes, on the frozen report fixture
// (fixtures/risk/lending/report.json, the same one tests/risk-layer/lending-report.test.ts reads).
type Fx = {
  kamino: {
    obligations: Array<{
      deposits: Array<{ reserve: string; symbol: string; amount: number; usd: number | null }>;
      debtUsd: number;
    }>;
    reserveRows: Array<{ account: string; liquidationThresholdPct: number }>;
    registry: Array<{
      account: string;
      dexAssetMint: string | null;
      params: Record<string, number>;
    }>;
  };
  jl: {
    vaultRow: {
      symbol: string;
      oraclePrice: number;
      liquidationThreshold: number;
      liquidationPenalty: number;
    };
    registry: { params: Record<string, number> };
    positions: Array<{ collateral: number; debt: number; liquidatedBranch?: boolean }>;
  };
  curves: Array<{
    asset_symbol: string;
    regime: Regime;
    points: DepthCurve['points'];
    insufficient_from: number | null;
    quantile: number;
    min_samples: number;
    samples: number;
  }>;
  depth: { asset: string; rows: Array<{ hour: string; regime: Regime; depthUsd: number }> };
};
const fx = JSON.parse(readFileSync('fixtures/risk/lending/report.json', 'utf8')) as Fx;
const P = defaultLendingReportParams();
const thr = new Map(fx.kamino.reserveRows.map((r) => [r.account, r.liquidationThresholdPct / 100]));
const reg = new Map(fx.kamino.registry.map((r) => [r.account, r]));
const v = fx.jl.vaultRow;
// the report's positions, built the way scripts/risk/lending-report.ts builds them (Kamino close factor 0.2 and
// full-liquidation LTV 0.95 as in lending-report.test.ts: the market account is not in the fixture)
const positions: GapPosition[] = [
  ...fx.kamino.obligations
    .filter((o) => o.debtUsd > 0)
    .map((o) => ({
      deposits: o.deposits
        .filter((d) => d.amount > 0)
        .map((d) => ({
          asset: d.symbol,
          usd: d.usd as number,
          liqThreshold: thr.get(d.reserve) as number,
          liqBonus: (reg.get(d.reserve)?.params.maxLiquidationBonusBps as number) / 10_000,
          liqBonusMin: (reg.get(d.reserve)?.params.minLiquidationBonusBps as number) / 10_000,
          stock: reg.get(d.reserve)?.dexAssetMint != null,
          oracle: `kamino ${d.symbol}`,
        })),
      debtUsd: o.debtUsd,
      closeFactor: 0.2,
      fullLiqLtv: 0.95,
    })),
  ...fx.jl.positions
    .filter((p) => p.debt > 0 && !p.liquidatedBranch)
    .map((p) => ({
      deposits: [
        {
          asset: v.symbol,
          usd: p.collateral * v.oraclePrice,
          liqThreshold: v.liquidationThreshold,
          liqBonus: v.liquidationPenalty,
          stock: true,
          oracle: `jupiter_lend ${v.symbol}`,
        },
      ],
      debtUsd: p.debt,
      closeFactor: P.jlCloseFactor,
      fullLiqLtv: fx.jl.registry.params.liquidationMaxLimit as number,
    })),
];
const curvesOf = new Map<string, AssetCurves>();
for (const c of fx.curves) {
  const a = curvesOf.get(c.asset_symbol) ?? { assetId: c.asset_symbol, byRegime: {} };
  a.byRegime[c.regime] = {
    points: c.points,
    insufficientFrom: c.insufficient_from,
    quantile: c.quantile,
    minSamples: c.min_samples,
    from: null,
    to: '2026-10-02T13:00:00.000Z',
    samples: c.samples,
  };
  curvesOf.set(c.asset_symbol, a);
}
const wr = weekendDepthRatio(fx.depth.rows);
const weekendOf = (asset: string) =>
  asset === fx.depth.asset && wr ? { ratio: wr.ratio, from: 'us_market_hours' as Regime } : null;

/** The earlier coverage ratio exactly as the report computes it (section 5). */
const earlier = () =>
  P.gapGridPct.flatMap((g) =>
    lendingGapSim(positions, g).byAsset.flatMap((a) => {
      const curves = curvesOf.get(a.asset);
      if (!curves || a.minBonus === null) return [];
      const cap = saleCapacity(
        curves,
        Object.keys(curves.byRegime) as Regime[],
        a.minBonus,
        weekendOf(a.asset),
      );
      return [{ g, a, curves, cap, ratio: coverageRatio(cap.capacityUsd, a.seizedUsd) }];
    }),
  );

// [gap, asset, seized, capacity, ratio], computed at 96a9f32 before item 8 changed report.ts
const PINNED: Array<[number, string, number, number, number]> = [
  [10, 'TSLAx', 994.9349277242701, 247382.37137876256, 248.6417598632345],
  [15, 'SPYx', 104331.66795471038, 1182339.4344030798, 11.33250773788381],
  [15, 'QQQx', 38103.45997892409, 1025487.9295367058, 26.913249613130333],
  [15, 'TSLAx', 2472.6949847636697, 247382.37137876256, 100.0456477256965],
  [20, 'SPYx', 115373.98787014814, 1182339.4344030798, 10.247885647619174],
  [20, 'QQQx', 38103.45997892409, 1025487.9295367058, 26.913249613130333],
  [20, 'TSLAx', 28077.87882161005, 247382.37137876256, 8.810579066548485],
  [20, 'NVDAx', 4716.098779609915, 1398179.0009429688, 296.4694053882003],
  [25, 'SPYx', 115580.60910917625, 1182339.4344030798, 10.229565698916279],
  [25, 'QQQx', 38336.85158265349, 1025487.9295367058, 26.749403959941105],
  [25, 'TSLAx', 34785.33633603502, 247382.37137876256, 7.111685481174803],
  [25, 'NVDAx', 30621.364225691956, 1398179.0009429688, 45.660245266599446],
  [30, 'SPYx', 528072.0050711678, 1182339.4344030798, 2.238973895697684],
  [30, 'QQQx', 178520.1952671494, 1025487.9295367058, 5.744380505533831],
  [30, 'TSLAx', 44562.57875558561, 247382.37137876256, 5.5513477515650935],
  [30, 'NVDAx', 30621.364225691956, 1398179.0009429688, 45.660245266599446],
  [40, 'SPYx', 564634.2177575141, 1182339.4344030798, 2.0939918219955334],
  [40, 'NVDAx', 160605.83697195645, 1398179.0009429688, 8.705654958151404],
  [40, 'QQQx', 154028.13072694774, 1025487.9295367058, 6.65779636938289],
  [40, 'TSLAx', 138640.58637123922, 247382.37137876256, 1.7843430834629077],
  [50, 'SPYx', 842079.2983198042, 1182339.4344030798, 1.4040713704305456],
  [50, 'NVDAx', 199890.18428391134, 1398179.0009429688, 6.994735664243943],
  [50, 'TSLAx', 134414.5056322514, 247382.37137876256, 1.8404440072530805],
  [50, 'QQQx', 128995.18761708957, 1025487.9295367058, 7.949815403817801],
];
const close = (a: number, b: number, rel = 1e-12) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));

const ZERO: Partial<Record<Regime, number>> = {
  us_market_hours: 0,
  us_offhours_weekday: 0,
  weekend: 0,
  us_holiday: 0,
};

describe('margin', () => {
  it('is (1 + b)(P_m / P_o)(1 − c) − 1, with the gap measured as P_o / P_m − 1', () => {
    close(liquidatorMargin(0.05, 0, 0.02), 1.05 * 0.98 - 1);
    // oracle 1% above the pool mid: each seized unit sells for less than the oracle valued it
    close(liquidatorMargin(0.05, 0.01, 0.02), (1.05 / 1.01) * 0.98 - 1);
    close(liquidatorMargin(0.1, -0.02, 0), 1.1 / 0.98 - 1);
  });

  it('the tolerance is the cost at which the margin equals the minimum; at gap 0 it is b / (1 + b), not b', () => {
    for (const [b, g, m] of [
      [0.05, 0, 0],
      [0.1, 0.012, 0],
      [0.03, -0.004, 0.005],
    ] as const)
      close(liquidatorMargin(b, g, marginTolerance(b, g, m)), m);
    close(marginTolerance(0.1, 0, 0), 0.1 / 1.1);
    // the earlier rule (cost ≤ bonus) leaves the liquidator −b²
    close(liquidatorMargin(0.1, 0, 0.1), -0.01);
  });
});

describe('coverage on the frozen report fixture', () => {
  it('the earlier coverage ratio is unchanged (all 24 rows, values pinned before this item)', () => {
    const rows = earlier();
    expect(rows.map((r) => [r.g, r.a.asset])).toEqual(PINNED.map(([g, a]) => [g, a]));
    rows.forEach((r, i) => {
      const [, , seized, cap, ratio] = PINNED[i] as (typeof PINNED)[number];
      close(r.a.seizedUsd, seized);
      close(r.cap.capacityUsd, cap);
      close(r.ratio as number, ratio);
    });
  });

  it('with the oracle gap at zero and one route, the new capacity is the earlier one at τ = b / (1 + b)', () => {
    let below = 0;
    const rows = earlier();
    for (const r of rows) {
      const regimes = Object.keys(r.curves.byRegime) as Regime[];
      const b = r.a.minBonus as number;
      const n = liquidationCapacity(
        r.curves,
        regimes,
        { bonus: b, oracleGap: ZERO, minMargin: 0 },
        weekendOf(r.a.asset),
      );
      const same = saleCapacity(r.curves, regimes, b / (1 + b), weekendOf(r.a.asset));
      expect(n.missing).toEqual([]);
      close(n.worst?.capacityUsd as number, same.capacityUsd, 1e-9);
      expect(n.worst?.regime).toBe(same.regime);
      expect(n.worst?.derived).toBe(same.derived);
      // the earlier ratio is the same calculation at τ = b: it can only be higher
      expect(n.worst?.capacityUsd as number).toBeLessThanOrEqual(r.cap.capacityUsd);
      if ((n.worst?.capacityUsd as number) < r.cap.capacityUsd * (1 - 1e-9)) below++;
      // at the capacity the liquidator's margin is exactly the minimum
      if (!n.worst?.derived && !n.worst?.lowerBound && (n.worst?.capacityUsd ?? 0) > 0) {
        const curve = curveFor(r.curves, n.worst?.regime as Regime).curve as DepthCurve;
        close(
          liquidatorMargin(b, 0, costAt(curve, n.worst?.capacityUsd as number) as number),
          0,
          1e-9,
        );
      }
    }
    // not a rounding artefact: on this fixture every row is lower (by 0.6% to 3.5% of capacity)
    expect(below).toBe(rows.length);
  });

  it('a positive oracle gap lowers capacity; a gap above the bonus leaves a measured zero, not a missing one', () => {
    const a = curvesOf.get('SPYx') as AssetCurves;
    const regimes = Object.keys(a.byRegime) as Regime[];
    const at = (gap: number) =>
      liquidationCapacity(a, regimes, {
        bonus: 0.1,
        oracleGap: { us_market_hours: gap, us_offhours_weekday: gap },
        minMargin: 0,
      }).worst;
    expect((at(0.02)?.capacityUsd as number) < (at(0)?.capacityUsd as number)).toBe(true);
    const none = at(0.2);
    expect(none?.tau).toBeLessThan(0);
    expect(none?.capacityUsd).toBe(0);
  });

  it('a regime without an oracle gap is skipped and named, never zero; with none measured there is no answer', () => {
    const a = curvesOf.get('QQQx') as AssetCurves;
    const regimes = Object.keys(a.byRegime) as Regime[];
    const one = liquidationCapacity(a, regimes, {
      bonus: 0.1,
      oracleGap: { us_market_hours: 0 },
      minMargin: 0,
    });
    expect(one.byRegime.map((r) => r.regime)).toEqual(['us_market_hours']);
    expect(one.missing).toEqual([
      {
        regime: 'us_offhours_weekday',
        reason: 'no_samples_in_regime',
        detail: 'no oracle-against-DEX rows in this regime',
      },
    ]);
    expect(one.worst?.capacityUsd).toBeGreaterThan(0);
    const none = liquidationCapacity(a, regimes, { bonus: 0.1, oracleGap: {}, minMargin: 0 });
    expect(none.worst).toBeNull();
    // the weekend derived from market-hours depth needs a weekend gap
    const t = curvesOf.get('TSLAx') as AssetCurves;
    const w = liquidationCapacity(
      t,
      Object.keys(t.byRegime) as Regime[],
      { bonus: 0.03, oracleGap: { us_market_hours: 0, us_offhours_weekday: 0 }, minMargin: 0 },
      weekendOf('TSLAx'),
    );
    expect(w.missing.map((m) => m.regime)).toEqual(['weekend']);
    expect(w.worst?.derived).toBe(false);
  });
});

describe('routes', () => {
  const gapObs = (value: number): OracleGapObs => ({
    value,
    samples: 40,
    fetchedAt: '2026-10-02T13:05:00.000Z',
    source: 'collector 5-minute lending rows; risk_asset_snapshots refMidUsd',
    method: 'oracle_vs_routed_mid_median',
    methodVersion: 'lending-report-0.2',
    provenance: 'live',
  });
  const curveMeta = {
    source: 'risk_depth_curves',
    method: 'routed_greedy_32_chunks',
    methodVersion: 'risk-0.3',
    provenance: 'live' as const,
  };
  const issuer: IssuerModel & { fetchedAt: string } = {
    issuer: 'Backed (xStocks)',
    window: '24x5',
    minNotionalUsd: 5000,
    kycRequired: true,
    settlementHours: 120,
    capacityUsdPerOpenHour: 100_000,
    feePct: 0,
    provenance: 'assumption',
    source: 'fixtures/risk/issuer-models.json',
    fetchedAt: '2026-10-01T02:00:00Z',
  };
  const routes = (regime: Regime, seizedUsd: number, gap = 0.001) =>
    liquidationRoutes({
      regime,
      seizedUsd,
      bonus: 0.1,
      oracleGap: { us_market_hours: gapObs(gap), us_offhours_weekday: gapObs(gap) },
      curves: curvesOf.get('SPYx') as AssetCurves,
      curveMeta,
      twoHop: { pools: 5, tvlUsd: 117_949 },
      issuer,
    });

  it('the routed sale equals the curve and the margin formula; every fact is complete or null with a reason', () => {
    const rs = routes('us_offhours_weekday', 100_000);
    expect(rs.map((r) => r.route)).toEqual([
      'routed_dex',
      'issuer_redemption',
      'wait_for_market_open',
      'two_hop',
    ]);
    const c = costAt(
      (curvesOf.get('SPYx') as AssetCurves).byRegime.us_offhours_weekday as DepthCurve,
      100_000,
    ) as number;
    close(rs[0]?.recovered.value as number, 1 - c);
    close(rs[0]?.liquidatorMargin.value as number, liquidatorMargin(0.1, 0.001, c));
    expect(rs[0]?.recovered).toMatchObject({ quality: 'measured', regime: 'us_offhours_weekday' });
    expect(rs[2]?.recovered).toMatchObject({ quality: 'assumption' });
    expect(rs[3]?.recovered).toMatchObject({ value: null, reason: 'not_collected' });
    const { facts, invalid } = collectFacts({ routes: rs });
    expect(invalid).toEqual([]);
    expect(facts.length).toBe(8);
    expect(facts.filter((f) => f.fact.value === 0)).toEqual([]);
  });

  it('a route resting on an assumption is never chosen over a measured one, even when it recovers more', () => {
    // oracle 3% above the mid: redemption at the oracle price recovers 1.03 of the mid value, the DEX sale less
    const rs = routes('us_market_hours', 100_000, 0.03);
    expect((rs.find((r) => r.route === 'issuer_redemption')?.recovered.value as number) > 1).toBe(
      true,
    );
    expect(bestRoute(rs)?.route).toBe('routed_dex');
    expect(rs.find((r) => r.route === 'wait_for_market_open')?.recovered).toMatchObject({
      value: null,
      reason: 'not_applicable',
    });
  });

  it('not measured is a reason: no weekend curve, a size beyond the grid, a seizure below the issuer minimum', () => {
    const w = routes('weekend', 100_000);
    expect(w.find((r) => r.route === 'routed_dex')?.recovered).toMatchObject({
      value: null,
      reason: 'no_samples_in_regime',
    });
    expect(bestRoute(w)).toBeNull();
    expect(
      routes('us_market_hours', 6_000_000).find((r) => r.route === 'routed_dex')?.recovered,
    ).toMatchObject({ value: null, reason: 'beyond_measured_size' });
    expect(
      routes('us_market_hours', 1_000).find((r) => r.route === 'issuer_redemption')
        ?.liquidatorMargin,
    ).toMatchObject({ value: null, reason: 'not_applicable' });
  });
});
