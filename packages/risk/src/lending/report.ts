// Step 10b item 9 — the lending report: can the market absorb the collateral? Pure functions; the script
// (scripts/risk/lending-report.ts) reads the tables and files and prints the tables.
//
//   Pools          share of hours with more than `utilAlarmPct` lent out.
//   Lenders        top 1, 3 and 10 suppliers' share of a reserve (aggregates only); curated vaults are products and
//                  are named: their share, and what the share lent out becomes if they leave.
//   Liquidations   count, USD, largest, realised sale price against the oracle and the pool mid, by regime.
//   Oracle vs DEX  the lending oracle's price against the routed reference pool mid, by regime.
//   At risk        for each gap in `gapGridPct`, the stock collateral seized per asset (`lendingGapSim`, gapSim's rule per
//                  position), against the routed DEX sale capacity at a cost equal to the liquidation bonus in the
//                  worst regime: the liquidation coverage ratio.

import { type AssetCurves, measuredRegimes, worstCapacity } from '../assess';
import { quantileOf } from '../curves';
import type { Regime } from '../time';

export type LendingReportParams = {
  /** A pool is in alarm in an hour when more than this share of its supply is lent out (percent). */
  utilAlarmPct: number;
  /** Price gaps applied to every xStock at once, percent. */
  gapGridPct: number[];
  topN: number[];
  /** Jupiter Lend: share of a liquidatable position's debt repaid in one liquidation (no close factor on chain). */
  jlCloseFactor: number;
  /** Largest oracle move allowed while the primary market is closed; 1 = no band (neither venue has one). */
  bandPct: number;
  /** A 5-minute lending row and a routed reference mid are compared when they are at most this far apart. */
  oracleMatchSec: number;
  /** A liquidation counts toward capacity while the liquidator's margin is at least this (percent; item 8). */
  minLiquidatorMarginPct: number;
  /** Seizure size buckets of the observed routes (USD edges; item 9). */
  sizeBucketsUsd: number[];
};

export const defaultLendingReportParams = (): LendingReportParams => ({
  utilAlarmPct: 95,
  gapGridPct: [5, 10, 15, 20, 25, 30, 40, 50],
  topN: [1, 3, 10],
  jlCloseFactor: 1,
  bandPct: 1,
  oracleMatchSec: 180,
  minLiquidatorMarginPct: 0,
  sizeBucketsUsd: [1_000, 10_000, 100_000],
});

// ---------------------------------------------------------------------------------------------------------------
// Pools

/** Hours (or rows) with more than `alarmPct` lent out. `values` are shares lent out as fractions. */
export function alarmShare(values: readonly (number | null)[], alarmPct: number) {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const above = xs.filter((v) => 100 * v > alarmPct).length;
  return {
    n: xs.length,
    above,
    share: xs.length ? above / xs.length : null,
    max: xs.length ? Math.max(...xs) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lenders

/** One supplier of a reserve. `named` suppliers (curated vaults) may be listed; the rest are counted only. */
export type Supplier = { amount: number; named?: string };

/** Top-N shares of a reserve's supply over the suppliers we can attribute. What no attributed supplier holds (cTokens
 *  in wallets or untracked programs) is `unattributed`; since it may be one holder, top-N shares are lower bounds
 *  whenever it exceeds the smallest share counted. */
export function supplierConcentration(
  suppliers: readonly Supplier[],
  totalSupply: number,
  topN: readonly number[],
): {
  suppliers: number;
  unattributedShare: number | null;
  topNLowerBound: boolean;
} & Record<`top${number}`, number | null> {
  const amounts = suppliers.map((s) => s.amount).filter((a) => a > 0);
  const sorted = [...amounts].sort((a, b) => b - a);
  const attributed = sorted.reduce((s, a) => s + a, 0);
  const unattributed = Math.max(0, totalSupply - attributed);
  const top: Record<`top${number}`, number | null> = {};
  for (const n of topN)
    top[`top${n}`] =
      totalSupply > 0 ? sorted.slice(0, n).reduce((s, a) => s + a, 0) / totalSupply : null;
  const smallestCounted = sorted.length ? (sorted.at(-1) as number) : 0;
  return {
    suppliers: sorted.length,
    ...top,
    unattributedShare: totalSupply > 0 ? unattributed / totalSupply : null,
    topNLowerBound: unattributed > smallestCounted,
  };
}

/** A curated vault leaving a reserve: it can take at most what is available; the share lent out after it takes it. */
export function vaultExit(
  r: { supplied: number; borrowed: number; available: number },
  vaultLiquidity: number,
) {
  const withdrawableNow = Math.max(0, Math.min(vaultLiquidity, r.available));
  const after = r.supplied - withdrawableNow;
  return {
    shareOfSupply: r.supplied > 0 ? vaultLiquidity / r.supplied : null,
    withdrawableNow,
    stuck: vaultLiquidity - withdrawableNow,
    shareLentOutNow: r.supplied > 0 ? r.borrowed / r.supplied : null,
    shareLentOutAfter: after > 0 ? Math.min(1, r.borrowed / after) : null,
  };
}

/** One curated-vault reallocation leg on one reserve (raw units, signed: + into the reserve). */
export type ReallocationLeg = { at: string; delta: bigint };

/** Past reallocations of one vault on one reserve. */
export function reallocationSummary(legs: readonly ReallocationLeg[], decimals: number) {
  let inUi = 0;
  let outUi = 0;
  let largestOut: { ui: number; at: string } | null = null;
  let ins = 0;
  let outs = 0;
  for (const l of legs) {
    const ui = Number(l.delta) / 10 ** decimals;
    if (ui > 0) {
      ins++;
      inUi += ui;
    } else if (ui < 0) {
      outs++;
      outUi += -ui;
      if (!largestOut || -ui > largestOut.ui) largestOut = { ui: -ui, at: l.at };
    }
  }
  const times = legs.map((l) => l.at).sort();
  return {
    legs: legs.length,
    ins,
    outs,
    inUi,
    outUi,
    largestOut,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Collateral at risk

/** One collateral deposit of a position, valued at the oracle price of the hour. */
export type GapDeposit = {
  asset: string;
  usd: number;
  /** Liquidation threshold of this deposit's reserve or vault, fraction. */
  liqThreshold: number;
  /** Liquidation bonus paid on this collateral, fraction (the most a liquidation seizes). */
  liqBonus: number;
  /** Smallest bonus a liquidator earns on it (Kamino: the bonus at the threshold); the sale-cost tolerance. Defaults to
   *  `liqBonus`. */
  liqBonusMin?: number;
  /** True for an xStock: the gap applies to it. */
  stock: boolean;
  /** The venue oracle that prices this deposit, as the report labels it; seizures are also split by it. */
  oracle?: string;
};

export type GapPosition = {
  deposits: GapDeposit[];
  debtUsd: number;
  /** Share of debt repaid in one liquidation, and the LTV above which all of it can be. */
  closeFactor: number;
  fullLiqLtv: number;
};

export type GapAssetRow = {
  asset: string;
  /** Positions with this asset made liquidatable by the gap. */
  positions: number;
  /** All of this asset's collateral in those positions, after the gap (the upper bound of a seizure). */
  liquidatableCollateralUsd: number;
  /** Seized in one liquidation round by the program's rule, after the gap. */
  seizedUsd: number;
  /** Smallest `liqBonusMin` among the seizures of this asset (the sale-cost tolerance used for its capacity). */
  minBonus: number | null;
  /** Seized USD by liquidation bonus (key: bonus in bps). */
  seizedByBonusBps: Record<string, number>;
  /** Seized USD and smallest sale-cost tolerance by venue oracle (deposits that name one). */
  byOracle: Record<string, { seizedUsd: number; minBonus: number }>;
};

/**
 * gapSim's rule (breach.ts) applied position by position, for positions with several deposits and per-deposit
 * thresholds: every xStock deposit drops by `gapPct` at once, other collateral keeps its value. A position is
 * liquidatable when debt > Σ deposit × threshold after the gap. Repay = closeFactor × debt, or all of it above
 * fullLiqLtv; seized = min(collateral after the gap, repay × (1 + bonus)), taken from the xStock deposits first, pro
 * rata to their value after the gap, bonus weighted the same way. For a position with one deposit this is gapSim
 * exactly (tested). Debt that is underwater at the gap but not inside the band cannot be liquidated while closed.
 */
export function lendingGapSim(positions: readonly GapPosition[], gapPct: number, bandPct = 1) {
  const byAsset = new Map<string, GapAssetRow>();
  let liquidatableDebtUsd = 0;
  let repayUsd = 0;
  let seizedUsd = 0;
  let badDebtUsd = 0;
  let unliquidatableWhileClosedDebtUsd = 0;
  let liquidatable = 0;
  const g = gapPct / 100;
  const band = Math.min(g, bandPct);
  for (const p of positions) {
    if (!(p.debtUsd > 0)) continue;
    const after = p.deposits.map((d) => ({ ...d, usd: d.usd * (d.stock ? 1 - g : 1) }));
    const cGap = after.reduce((s, d) => s + d.usd, 0);
    const lGap = after.reduce((s, d) => s + d.usd * d.liqThreshold, 0);
    if (!(p.debtUsd > lGap)) continue;
    liquidatable++;
    liquidatableDebtUsd += p.debtUsd;
    const lBand = p.deposits.reduce(
      (s, d) => s + d.usd * (d.stock ? 1 - band : 1) * d.liqThreshold,
      0,
    );
    if (p.debtUsd <= lBand) unliquidatableWhileClosedDebtUsd += p.debtUsd;
    if (p.debtUsd > cGap) badDebtUsd += p.debtUsd - cGap;
    const full = cGap > 0 && p.debtUsd / cGap > p.fullLiqLtv;
    const r = full ? p.debtUsd : p.closeFactor * p.debtUsd;
    repayUsd += r;
    const stocks = after.filter((d) => d.stock && d.usd > 0);
    const stockUsd = stocks.reduce((s, d) => s + d.usd, 0);
    const pool = stockUsd > 0 ? stocks : after.filter((d) => d.usd > 0);
    const poolUsd = pool.reduce((s, d) => s + d.usd, 0);
    const bonus = poolUsd > 0 ? pool.reduce((s, d) => s + d.liqBonus * d.usd, 0) / poolUsd : 0;
    const seized = Math.min(cGap, r * (1 + bonus));
    seizedUsd += seized;
    const fromStocks = Math.min(seized, stockUsd);
    const touched = new Set<string>();
    for (const d of stocks) {
      const row = byAsset.get(d.asset) ?? {
        asset: d.asset,
        positions: 0,
        liquidatableCollateralUsd: 0,
        seizedUsd: 0,
        minBonus: null,
        seizedByBonusBps: {},
        byOracle: {},
      };
      if (!touched.has(d.asset)) row.positions++;
      touched.add(d.asset);
      row.liquidatableCollateralUsd += d.usd;
      const part = (fromStocks * d.usd) / stockUsd;
      row.seizedUsd += part;
      const bps = String(Math.round(d.liqBonus * 10_000));
      row.seizedByBonusBps[bps] = (row.seizedByBonusBps[bps] ?? 0) + part;
      const tol = d.liqBonusMin ?? d.liqBonus;
      row.minBonus = row.minBonus === null ? tol : Math.min(row.minBonus, tol);
      if (d.oracle) {
        const o = row.byOracle[d.oracle];
        row.byOracle[d.oracle] = o
          ? { seizedUsd: o.seizedUsd + part, minBonus: Math.min(o.minBonus, tol) }
          : { seizedUsd: part, minBonus: tol };
      }
      byAsset.set(d.asset, row);
    }
  }
  return {
    gapPct,
    positionsLiquidatable: liquidatable,
    liquidatableDebtUsd,
    repayUsd,
    seizedUsd,
    badDebtUsd,
    unliquidatableWhileClosedDebtUsd,
    byAsset: [...byAsset.values()].sort((a, b) => b.seizedUsd - a.seizedUsd),
  };
}

/** Routed DEX sale capacity at cost ≤ tau in the worst of `regimes` (assess.ts `worstCapacity`). A derived weekend
 *  capacity (measured capacity × the measured weekend depth ratio) is used instead when it is lower. A regime whose
 *  curve has too few samples is skipped, never read as zero capacity (DA2); with none measured the answer is null. */
export function saleCapacity(
  curves: AssetCurves,
  regimes: readonly Regime[],
  tau: number,
  weekend?: { ratio: number; from: Regime } | null,
) {
  const usable = measuredRegimes(curves, [...regimes]).measured;
  if (!usable.length) return null;
  const measured = worstCapacity(curves, usable, tau);
  if (weekend && usable.includes(weekend.from)) {
    const base = worstCapacity(curves, [weekend.from], tau);
    const derived = base.capacityUsd * weekend.ratio;
    if (derived < measured.capacityUsd)
      return {
        regime: 'weekend' as Regime,
        capacityUsd: derived,
        lowerBound: base.lowerBound,
        derived: true,
      };
  }
  return { ...measured, derived: false };
}

/** Liquidation coverage ratio: DEX sale capacity at the bonus over the collateral seized. ≥ 1: the market absorbs it. */
export const coverageRatio = (capacityUsd: number, seizedUsd: number) =>
  seizedUsd > 0 ? capacityUsd / seizedUsd : null;

/** Weekend over US-market-hours median of an asset's ±2% sell depth, from hourly rows (Step 5b). Null when either
 *  regime has fewer than `minHours` hours. */
export function weekendDepthRatio(
  rows: readonly { hour: string; regime: Regime; depthUsd: number }[],
  minHours = 12,
) {
  const byHour = new Map<string, { regime: Regime; depth: number }>();
  for (const r of rows) {
    const h = byHour.get(r.hour) ?? { regime: r.regime, depth: 0 };
    h.depth += r.depthUsd;
    byHour.set(r.hour, h);
  }
  const of = (g: Regime) => [...byHour.values()].filter((h) => h.regime === g).map((h) => h.depth);
  const w = of('weekend');
  const m = of('us_market_hours');
  if (w.length < minHours || m.length < minHours) return null;
  const mw = quantileOf(w, 0.5);
  const mm = quantileOf(m, 0.5);
  return mm > 0
    ? {
        ratio: mw / mm,
        weekendHours: w.length,
        marketHours: m.length,
        weekendMedianUsd: mw,
        marketMedianUsd: mm,
      }
    : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Liquidations and oracle

/** Distribution of relative gaps (fractions): n, median, 5th and 95th percentile, largest absolute. */
export function gapStats(xs: readonly number[]) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, median: null, p05: null, p95: null, maxAbs: null };
  return {
    n: v.length,
    median: quantileOf(v, 0.5),
    p05: quantileOf(v, 0.05),
    p95: quantileOf(v, 0.95),
    maxAbs: Math.max(...v.map(Math.abs)),
  };
}

export type LiquidationInput = {
  regime: Regime;
  /** Collateral seized, USD at the price the program used; null when that price is not in USD. */
  usd: number | null;
  /** Units-weighted realised sale price over the program's collateral price, minus 1 (same-transaction DEX sales). */
  saleVsOracle: number | null;
  /** Realised sale price over the sale pool's hourly mid (Step 5b), minus 1, when the hour is covered. */
  saleVsMid: number | null;
  impliedBonus: number | null;
};

/** Liquidations by regime: count, USD (sum, largest; `usdMissing` without a USD price), sale price against oracle and
 *  pool mid, implied bonus. */
export function liquidationTable(rows: readonly LiquidationInput[]) {
  const groups = new Map<string, LiquidationInput[]>();
  for (const r of rows) {
    groups.set(r.regime, [...(groups.get(r.regime) ?? []), r]);
    groups.set('all', [...(groups.get('all') ?? []), r]);
  }
  return [...groups].map(([regime, list]) => {
    const usd = list.map((r) => r.usd).filter((u): u is number => u !== null);
    return {
      regime,
      count: list.length,
      usd: usd.reduce((s, u) => s + u, 0),
      usdMissing: list.length - usd.length,
      largestUsd: usd.length ? Math.max(...usd) : null,
      withSale: list.filter((r) => r.saleVsOracle !== null).length,
      saleVsOracle: gapStats(
        list.map((r) => r.saleVsOracle).filter((x): x is number => x !== null),
      ),
      saleVsMid: gapStats(list.map((r) => r.saleVsMid).filter((x): x is number => x !== null)),
      impliedBonus: gapStats(
        list.map((r) => r.impliedBonus).filter((x): x is number => x !== null),
      ),
    };
  });
}
