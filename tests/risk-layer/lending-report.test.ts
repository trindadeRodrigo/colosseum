import { readFileSync } from 'node:fs';
import {
  type AssetCurves,
  alarmShare,
  coverageRatio,
  type DepthCurve,
  defaultLendingReportParams,
  type GapPosition,
  gapSim,
  lendingGapSim,
  liquidationTable,
  maxNotionalAt,
  measuredRegimes,
  type Regime,
  reallocationSummary,
  saleCapacity,
  supplierConcentration,
  vaultExit,
  weekendDepthRatio,
  worstCapacity,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 10b item 9 — the lending report's pure functions, on frozen mainnet data:
// fixtures/risk/lending/report.json (`pnpm risk:lending-freeze-report-fixtures`): one collector hour of the Sentora
// xStocks Market (obligations, the run's reserve rows, registry parameters) and Jupiter Lend vault 81 (positions and
// vault row), the routed sell curves of their assets, and Step 5b's hourly TSLAx ±2% sell depth.
// Expected values come from the inputs' own fields (the collector's per-obligation `liquidationLtv`, gapSim on the same
// positions), not from the function under test.
type Deposit = { reserve: string; symbol: string; amount: number; usd: number | null };
type Fx = {
  kamino: {
    obligations: Array<{
      deposits: Deposit[];
      borrows: Array<{ symbol: string; usd: number | null }>;
      collateralUsd: number;
      debtUsd: number;
      liquidationLtv: number | null;
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
    asset_mint: string;
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

const kaminoPositions = (closeFactor: number, fullLiqLtv: number): GapPosition[] =>
  fx.kamino.obligations
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
        })),
      debtUsd: o.debtUsd,
      closeFactor,
      fullLiqLtv,
    }));
const v = fx.jl.vaultRow;
const jlMarket = {
  ltvLiq: v.liquidationThreshold,
  closeFactor: P.jlCloseFactor,
  fullLiqLtv: fx.jl.registry.params.liquidationMaxLimit as number,
  liqBonus: v.liquidationPenalty,
  bandPct: 1,
  provenance: 'fixture' as const,
  source: 'fixtures/risk/lending/report.json',
};
const jlLive = fx.jl.positions.filter((p) => p.debt > 0 && !p.liquidatedBranch);
const jlGapPositions: GapPosition[] = jlLive.map((p) => ({
  deposits: [
    {
      asset: v.symbol,
      usd: p.collateral * v.oraclePrice,
      liqThreshold: jlMarket.ltvLiq,
      liqBonus: jlMarket.liqBonus,
      stock: true,
    },
  ],
  debtUsd: p.debt,
  closeFactor: jlMarket.closeFactor,
  fullLiqLtv: jlMarket.fullLiqLtv,
}));

describe('lendingGapSim', () => {
  it('fixture has positions with debt in both venues', () => {
    expect(kaminoPositions(0.2, 0.95).length).toBeGreaterThan(10);
    expect(jlGapPositions.length).toBeGreaterThan(20);
  });

  it('equals gapSim on single-collateral positions (Jupiter Lend vault 81), every gap of the grid', () => {
    for (const g of P.gapGridPct) {
      const a = lendingGapSim(jlGapPositions, g);
      const b = gapSim(
        jlMarket,
        jlGapPositions.map((p) => ({
          collateralUsd: p.deposits[0]?.usd as number,
          debtUsd: p.debtUsd,
        })),
        g / 100,
        () => 0,
      );
      expect(a.liquidatableDebtUsd).toBeCloseTo(b.liquidatableDebtUsd, 6);
      expect(a.repayUsd).toBeCloseTo(b.repayUsd, 6);
      expect(a.seizedUsd).toBeCloseTo(b.seizedCollateralUsd, 6);
      expect(a.unliquidatableWhileClosedDebtUsd).toBeCloseTo(b.unliquidatableWhileClosedDebtUsd, 6);
    }
  });

  it('at gap 0 a Kamino obligation is liquidatable exactly when the collector says debt > liquidationLtv × collateral', () => {
    const expected = fx.kamino.obligations.filter(
      (o) =>
        o.debtUsd > 0 &&
        o.liquidationLtv !== null &&
        o.debtUsd > o.liquidationLtv * o.collateralUsd,
    ).length;
    expect(lendingGapSim(kaminoPositions(0.2, 0.95), 0).positionsLiquidatable).toBe(expected);
  });

  it('on all-xStock obligations, a gap g liquidates exactly those with debt > liquidationLtv × collateral × (1 − g)', () => {
    const allStock = fx.kamino.obligations.filter(
      (o) =>
        o.debtUsd > 0 &&
        o.deposits
          .filter((d) => d.amount > 0)
          .every((d) => reg.get(d.reserve)?.dexAssetMint != null),
    );
    expect(allStock.length).toBeGreaterThan(5);
    const idx = new Set(allStock);
    const positions = kaminoPositions(0.2, 0.95).filter((_, i) =>
      idx.has(fx.kamino.obligations.filter((o) => o.debtUsd > 0)[i] as (typeof allStock)[0]),
    );
    for (const g of P.gapGridPct) {
      const expected = allStock.filter(
        (o) =>
          o.debtUsd > (o.liquidationLtv as number) * o.collateralUsd * (1 - g / 100) * (1 + 1e-12),
      ).length;
      expect(lendingGapSim(positions, g).positionsLiquidatable).toBe(expected);
    }
  });

  it('is monotone in the gap, seizes no more than the liquidatable collateral, and splits seizures by bonus', () => {
    const all = [...kaminoPositions(0.2, 0.95), ...jlGapPositions];
    let prev = -1;
    for (const g of P.gapGridPct) {
      const s = lendingGapSim(all, g);
      expect(s.positionsLiquidatable).toBeGreaterThanOrEqual(prev);
      prev = s.positionsLiquidatable;
      for (const a of s.byAsset) {
        expect(a.seizedUsd).toBeLessThanOrEqual(a.liquidatableCollateralUsd + 1e-6);
        const byBonus = Object.values(a.seizedByBonusBps).reduce((x, y) => x + y, 0);
        expect(byBonus).toBeCloseTo(a.seizedUsd, 6);
      }
      expect(s.byAsset.reduce((x, a) => x + a.seizedUsd, 0)).toBeLessThanOrEqual(
        s.seizedUsd + 1e-6,
      );
    }
  });

  it('the sale-cost tolerance is the smallest bonus at the threshold, not the seizure bonus', () => {
    const p = (liqBonusMin?: number): GapPosition => ({
      deposits: [
        { asset: 'SPYx', usd: 100, liqThreshold: 0.8, liqBonus: 0.1, liqBonusMin, stock: true },
      ],
      debtUsd: 90,
      closeFactor: 0.2,
      fullLiqLtv: 0.95,
    });
    expect(lendingGapSim([p(0.05)], 0).byAsset[0]?.minBonus).toBe(0.05);
    expect(lendingGapSim([p()], 0).byAsset[0]?.minBonus).toBe(0.1);
    expect(lendingGapSim([p(0.05)], 0).seizedUsd).toBeCloseTo(18 * 1.1, 9);
  });

  it('a stable deposit does not drop with the gap', () => {
    const p: GapPosition = {
      deposits: [
        { asset: 'USDC', usd: 100, liqThreshold: 0.9, liqBonus: 0.05, stock: false },
        { asset: 'SPYx', usd: 100, liqThreshold: 0.8, liqBonus: 0.1, stock: true },
      ],
      debtUsd: 160,
      closeFactor: 0.5,
      fullLiqLtv: 0.95,
    };
    // threshold value after a 10% gap: 90 + 72 = 162 ≥ 160 → safe; after 15%: 90 + 68 = 158 < 160 → liquidatable
    expect(lendingGapSim([p], 10).positionsLiquidatable).toBe(0);
    const s = lendingGapSim([p], 15);
    expect(s.positionsLiquidatable).toBe(1);
    // repay 80 × (1 + the stock deposit's 10% bonus) = 88 seized; SPYx holds 85 after the gap, so 85 comes from it
    expect(s.repayUsd).toBe(80);
    expect(s.byAsset[0]?.seizedUsd).toBeCloseTo(85, 9);
    expect(s.seizedUsd).toBeCloseTo(88, 9);
  });
});

describe('capacity and coverage', () => {
  const curvesOf = new Map<string, AssetCurves>();
  for (const c of fx.curves) {
    const a = curvesOf.get(c.asset_symbol) ?? { assetId: c.asset_symbol, byRegime: {} };
    a.byRegime[c.regime] = {
      points: c.points,
      insufficientFrom: c.insufficient_from,
      quantile: c.quantile,
      minSamples: c.min_samples,
      from: null,
      to: null,
      samples: c.samples,
    };
    curvesOf.set(c.asset_symbol, a);
  }

  it('measured capacity is worstCapacity over the measured regimes', () => {
    for (const [, a] of curvesOf) {
      const regimes = Object.keys(a.byRegime) as Regime[];
      const s = saleCapacity(a, regimes, 0.03, null);
      const usable = measuredRegimes(a, regimes).measured;
      if (!usable.length) {
        expect(s).toBeNull();
        continue;
      }
      expect(s?.derived).toBe(false);
      expect(s?.capacityUsd).toBe(worstCapacity(a, usable, 0.03).capacityUsd);
    }
  });

  it('uses the derived weekend capacity only when it is lower', () => {
    const a = [...curvesOf.values()].find((c) => c.byRegime.us_market_hours) as AssetCurves;
    const regimes = Object.keys(a.byRegime) as Regime[];
    const base = maxNotionalAt(a.byRegime.us_market_hours as DepthCurve, 0.03).notionalUsd;
    const low = saleCapacity(a, regimes, 0.03, {
      ratio: 0.1,
      from: 'us_market_hours',
    }) as NonNullable<ReturnType<typeof saleCapacity>>;
    expect(low.derived).toBe(true);
    expect(low.regime).toBe('weekend');
    expect(low.capacityUsd).toBeCloseTo(base * 0.1, 6);
    const high = saleCapacity(a, regimes, 0.03, {
      ratio: 10,
      from: 'us_market_hours',
    }) as NonNullable<ReturnType<typeof saleCapacity>>;
    expect(high.derived).toBe(false);
  });

  it('a regime whose curve is too thin is skipped, never zero capacity (DA2; report of 2026-10-03 00:43Z)', () => {
    // the first weekend curve arrived with fewer samples than the minimum: the report read it as $0 capacity
    const a = [...curvesOf.values()].find((c) => c.byRegime.us_market_hours) as AssetCurves;
    const rth = a.byRegime.us_market_hours as DepthCurve;
    const thin: AssetCurves = {
      ...a,
      byRegime: {
        ...a.byRegime,
        weekend: {
          ...rth,
          points: rth.points.map((p) => ({ ...p, samples: 1 })),
          insufficientFrom: 0,
        },
      },
    };
    const regimes = Object.keys(thin.byRegime) as Regime[];
    const s = saleCapacity(thin, regimes, 0.03, null);
    expect(s?.regime).not.toBe('weekend');
    expect(s?.capacityUsd).toBe(
      saleCapacity(a, Object.keys(a.byRegime) as Regime[], 0.03, null)?.capacityUsd,
    );
    expect(s?.capacityUsd).toBeGreaterThan(0);
    // nothing measured at all: no capacity, not $0
    expect(saleCapacity(thin, ['weekend'], 0.03, null)).toBeNull();
  });

  it('coverage ratio is capacity over seized, null with nothing seized', () => {
    expect(coverageRatio(300, 100)).toBe(3);
    expect(coverageRatio(300, 0)).toBeNull();
  });

  it('weekend depth ratio from Step 5b hours: median weekend over median market-hours hourly depth', () => {
    const r = weekendDepthRatio(fx.depth.rows);
    expect(r).not.toBeNull();
    const byHour = new Map<string, { regime: Regime; d: number }>();
    for (const x of fx.depth.rows) {
      const h = byHour.get(x.hour) ?? { regime: x.regime, d: 0 };
      h.d += x.depthUsd;
      byHour.set(x.hour, h);
    }
    const w = [...byHour.values()].filter((h) => h.regime === 'weekend');
    expect(r?.weekendHours).toBe(w.length);
    expect(r?.ratio).toBeCloseTo(
      (r?.weekendMedianUsd as number) / (r?.marketMedianUsd as number),
      12,
    );
    expect(weekendDepthRatio(fx.depth.rows.slice(0, 3))).toBeNull();
  });
});

describe('pools and lenders', () => {
  it('alarm share counts values strictly above the alarm and ignores nulls', () => {
    const a = alarmShare([0.5, 0.95, 0.951, null, 1.002], 95);
    expect(a).toEqual({ n: 4, above: 2, share: 0.5, max: 1.002 });
    expect(alarmShare([], 95).share).toBeNull();
  });

  it('supplier concentration over the reserve supply, with the unattributed rest', () => {
    const c = supplierConcentration(
      [{ amount: 50 }, { amount: 30 }, { amount: 5, named: 'vault' }],
      100,
      [1, 3, 10],
    );
    expect(c.top1).toBe(0.5);
    expect(c.top3).toBe(0.85);
    expect(c.unattributedShare).toBeCloseTo(0.15, 12);
    expect(c.topNLowerBound).toBe(true);
    expect(supplierConcentration([{ amount: 60 }, { amount: 40 }], 100, [1]).topNLowerBound).toBe(
      false,
    );
  });

  it('supplier concentration on the fixture market: obligation deposits per reserve sum to at most its supply', () => {
    for (const r of fx.kamino.reserveRows as Array<{ account: string; suppliedUi?: number }>) {
      const amounts = fx.kamino.obligations.map((o) =>
        o.deposits.filter((d) => d.reserve === r.account).reduce((s, d) => s + d.amount, 0),
      );
      const supplied = Number(r.suppliedUi);
      const c = supplierConcentration(
        amounts.map((amount) => ({ amount })),
        supplied,
        [1],
      );
      expect(c.unattributedShare ?? 0).toBeGreaterThanOrEqual(0);
      expect(amounts.reduce((s, a) => s + a, 0)).toBeLessThanOrEqual(supplied * (1 + 1e-9));
    }
  });

  it('a curated vault can take at most what is available; the rest is stuck', () => {
    const e = vaultExit({ supplied: 1000, borrowed: 900, available: 100 }, 150);
    expect(e.withdrawableNow).toBe(100);
    expect(e.stuck).toBe(50);
    expect(e.shareLentOutNow).toBe(0.9);
    expect(e.shareLentOutAfter).toBe(1);
    const f = vaultExit({ supplied: 1000, borrowed: 500, available: 500 }, 200);
    expect(f.shareLentOutAfter).toBeCloseTo(500 / 800, 12);
  });

  it('reallocation summary splits ins and outs and finds the largest out', () => {
    const s = reallocationSummary(
      [
        { at: '2026-01-02T00:00:00Z', delta: 5_000_000n },
        { at: '2026-01-01T00:00:00Z', delta: -2_000_000n },
        { at: '2026-01-03T00:00:00Z', delta: -7_000_000n },
      ],
      6,
    );
    expect(s).toMatchObject({
      legs: 3,
      ins: 1,
      outs: 2,
      inUi: 5,
      outUi: 9,
      first: '2026-01-01T00:00:00Z',
    });
    expect(s.largestOut).toEqual({ ui: 7, at: '2026-01-03T00:00:00Z' });
  });
});

describe('liquidation table', () => {
  it('groups by regime with an `all` row; USD sums skip rows without USD', () => {
    const t = liquidationTable([
      { regime: 'weekend', usd: 100, saleVsOracle: -0.01, saleVsMid: null, impliedBonus: 0.05 },
      { regime: 'weekend', usd: null, saleVsOracle: null, saleVsMid: null, impliedBonus: 0.03 },
      {
        regime: 'us_market_hours',
        usd: 300,
        saleVsOracle: 0.002,
        saleVsMid: 0.001,
        impliedBonus: 0.05,
      },
    ]);
    const all = t.find((r) => r.regime === 'all');
    const w = t.find((r) => r.regime === 'weekend');
    expect(all).toMatchObject({ count: 3, usd: 400, usdMissing: 1, largestUsd: 300, withSale: 2 });
    expect(w).toMatchObject({ count: 2, usd: 100, usdMissing: 1 });
    expect(w?.saleVsOracle.median).toBe(-0.01);
    expect(all?.saleVsMid.n).toBe(1);
  });
});
