// PLAN-ANALYTICS item 8 — how a liquidation gets sold, and how much of it the market absorbs at a profit for the
// liquidator. Pure functions; the lending report (scripts/risk/lending-report.ts) feeds them its rows.
//
//   Margin      A liquidator repays debt d and seizes d(1 + b) of stock at the venue's oracle price P_o, then sells it
//               at cost c against the DEX mid P_m: margin = (1 + b) × (P_m / P_o) × (1 − c) − 1 (PLAN-ANALYTICS §5).
//               The oracle gap is measured as P_o / P_m − 1, so P_m / P_o = 1 / (1 + gap).
//   Capacity    the largest seized notional with margin ≥ minMargin: the sale capacity at the cost tolerance
//               c* = 1 − (1 + minMargin)(1 + gap) / (1 + b), in the worst regime where both the curve and the gap
//               are measured. At gap 0 and minMargin 0, c* = b / (1 + b), not b: the earlier coverage ratio
//               (`saleCapacity` at τ = bonus) lets the liquidator lose b² on the last dollar.
//   Routes      routed_dex (the routed sale across dollar and SOL pools, risk-0.3 curves), two_hop (through pools
//               that pair the stock with a token we do not price: not collected), wait_for_market_open (the
//               market-hours sale, price held flat over the wait: an assumption until item 12), issuer_redemption
//               (the issuer model: an assumption). A route resting on an assumption is listed, never chosen over
//               a measured one.

import {
  FACTS_METHOD_VERSION,
  type Fact,
  type FactNullReason,
  fact,
  type LiquidationRoute,
  type MeasuredFact,
  missing,
} from '@colosseum/schemas';
import { type AssetCurves, curveFor, type IssuerModel, measuredRegimes } from '../assess';
import { costAt, type DepthCurve, maxNotionalAt } from '../curves';
import type { Regime } from '../time';

/** (1 + b) × (P_m / P_o) × (1 − c) − 1, with `oracleGap` = P_o / P_m − 1. */
export const liquidatorMargin = (bonus: number, oracleGap: number, cost: number) =>
  ((1 + bonus) / (1 + oracleGap)) * (1 - cost) - 1;

/** The highest sale cost at which the margin is still ≥ `minMargin`. Negative when no sale pays. */
export const marginTolerance = (bonus: number, oracleGap: number, minMargin = 0) =>
  1 - ((1 + minMargin) * (1 + oracleGap)) / (1 + bonus);

export type LiquidationCapacityRegime = {
  regime: Regime;
  /** Cost tolerance at which the margin reaches the minimum. */
  tau: number;
  capacityUsd: number;
  lowerBound: boolean;
  /** Weekend capacity derived from another regime's curve × the measured weekend depth ratio. */
  derived: boolean;
};

/**
 * Liquidation capacity: per regime, the routed sale capacity at the margin tolerance of that regime's oracle gap;
 * the worst of them. A regime whose curve or oracle gap is not measured is skipped and named in `missing`, never
 * read as zero capacity (DA2). `weekend` mirrors `saleCapacity`: the weekend capacity derived as the `from`
 * regime's capacity × `ratio` stands in when lower, at the weekend's own oracle gap; without a weekend gap it is
 * missing too. A capacity of 0 is measured: no sale at any measured size leaves the liquidator its margin.
 */
export function liquidationCapacity(
  curves: AssetCurves,
  regimes: readonly Regime[],
  inp: { bonus: number; oracleGap: Partial<Record<Regime, number>>; minMargin: number },
  weekend?: { ratio: number; from: Regime } | null,
) {
  const { measured, missing: gaps } = measuredRegimes(curves, regimes);
  const missingRegimes: Array<{ regime: Regime; reason: FactNullReason; detail?: string }> =
    gaps.map((g) => ({ ...g }));
  const byRegime: LiquidationCapacityRegime[] = [];
  const at = (curve: DepthCurve, regime: Regime, gap: number, scale = 1) => {
    const tau = marginTolerance(inp.bonus, gap, inp.minMargin);
    const m = maxNotionalAt(curve, tau);
    return {
      regime,
      tau,
      capacityUsd: m.notionalUsd * scale,
      lowerBound: m.lowerBound,
      derived: scale !== 1,
    };
  };
  for (const r of measured) {
    const gap = inp.oracleGap[r];
    if (gap === undefined) {
      missingRegimes.push({
        regime: r,
        reason: 'no_samples_in_regime',
        detail: 'no oracle-against-DEX rows in this regime',
      });
      continue;
    }
    byRegime.push(at(curveFor(curves, r).curve as DepthCurve, r, gap));
  }
  if (weekend && measured.includes(weekend.from)) {
    const gap = inp.oracleGap.weekend;
    if (gap === undefined)
      missingRegimes.push({
        regime: 'weekend',
        reason: 'no_samples_in_regime',
        detail: 'derived weekend depth has no weekend oracle gap to price it',
      });
    else {
      const derived = at(
        curveFor(curves, weekend.from).curve as DepthCurve,
        'weekend',
        gap,
        weekend.ratio,
      );
      const measuredWorst = Math.min(...byRegime.map((x) => x.capacityUsd));
      // as saleCapacity: the derived weekend replaces the measured worst only when it is lower
      if (derived.capacityUsd < measuredWorst) byRegime.push(derived);
    }
  }
  const worst = byRegime.reduce<LiquidationCapacityRegime | null>(
    (w, x) => (!w || x.capacityUsd < w.capacityUsd ? x : w),
    null,
  );
  return { worst, byRegime, missing: missingRegimes };
}

// ---------------------------------------------------------------------------------------------------------------
// Routes as facts

type RowMeta = {
  source: string;
  method: string;
  methodVersion: string;
  provenance: MeasuredFact['provenance'];
};

/** One venue oracle against the routed reference mid in one regime (median of the 5-minute rows). */
export type OracleGapObs = RowMeta & {
  value: number;
  samples: number;
  fetchedAt: string;
  dataFrom?: string;
};

export type LiquidationRoutesInput = {
  regime: Regime;
  seizedUsd: number;
  /** The smallest bonus the liquidator earns on this collateral (Kamino: the bonus at the threshold). */
  bonus: number;
  /** Venue oracle over the pool mid, minus 1, by regime; absent where no row was matched. */
  oracleGap: Partial<Record<Regime, OracleGapObs>>;
  /** Routed sell curves (dollar and SOL exits); null when the asset has none. */
  curves: AssetCurves | null;
  curveMeta: RowMeta;
  /** Pools pairing the stock with a token the collector does not price. */
  twoHop: { pools: number; tvlUsd: number };
  issuer: (IssuerModel & { fetchedAt: string }) | null;
};

const later = (a: string | null | undefined, b: string | null | undefined) =>
  [a, b]
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);

/**
 * The four liquidation routes for one seizure, best first: the measured route with the highest recovered value,
 * then the other measured ones, then those resting on an assumption, then those not measured with their reason.
 */
export function liquidationRoutes(inp: LiquidationRoutesInput): LiquidationRoute[] {
  const ctx = { regime: inp.regime, sizeUsd: inp.seizedUsd };
  const both = (
    curve: DepthCurve,
    gap: OracleGapObs | undefined,
    value: number,
    method: string,
    quality: MeasuredFact['quality'],
  ): MeasuredFact =>
    fact({
      value,
      unit: 'fraction',
      quality,
      ...ctx,
      source: gap ? `${inp.curveMeta.source}; ${gap.source}` : inp.curveMeta.source,
      method,
      methodVersion: FACTS_METHOD_VERSION,
      fetchedAt: later(curve.to ?? curve.from, gap?.fetchedAt) as string,
      ...(curve.from ? { dataFrom: curve.from } : {}),
      samples: Math.min(curve.samples, gap?.samples ?? curve.samples),
      provenance: inp.curveMeta.provenance,
    });

  /** A DEX sale in `saleRegime`, margin at `saleRegime`'s oracle gap. */
  const dexSale = (
    route: string,
    saleRegime: Regime,
    quality: MeasuredFact['quality'],
    method: string,
  ): LiquidationRoute => {
    const out = (reason: FactNullReason, detail?: string): LiquidationRoute => ({
      route,
      regime: inp.regime,
      seizedUsd: inp.seizedUsd,
      recovered: missing(reason, 'fraction', { ...ctx, ...(detail ? { detail } : {}) }),
      liquidatorMargin: missing(reason, 'fraction', { ...ctx, ...(detail ? { detail } : {}) }),
    });
    if (!inp.curves) return out('not_collected', 'no routed curve for this asset');
    const { curve } = curveFor(inp.curves, saleRegime);
    if (!curve || !measuredRegimes(inp.curves, [saleRegime]).measured.length)
      return out(curve ? 'insufficient_samples' : 'no_samples_in_regime');
    const c = costAt(curve, inp.seizedUsd);
    if (c === null) return out('beyond_measured_size');
    const gap = inp.oracleGap[saleRegime];
    return {
      route,
      regime: inp.regime,
      seizedUsd: inp.seizedUsd,
      recovered: both(curve, undefined, 1 - c, `${method}:recovered`, quality),
      liquidatorMargin: gap
        ? both(curve, gap, liquidatorMargin(inp.bonus, gap.value, c), `${method}:margin`, quality)
        : missing('no_samples_in_regime', 'fraction', {
            ...ctx,
            detail: 'no oracle-against-DEX rows in this regime',
          }),
    };
  };

  const routedDex = dexSale('routed_dex', inp.regime, 'measured', 'routed_dex_sale');
  const wait: LiquidationRoute =
    inp.regime === 'us_market_hours'
      ? {
          route: 'wait_for_market_open',
          regime: inp.regime,
          seizedUsd: inp.seizedUsd,
          recovered: missing('not_applicable', 'fraction', { ...ctx, detail: 'market is open' }),
          liquidatorMargin: missing('not_applicable', 'fraction', {
            ...ctx,
            detail: 'market is open',
          }),
        }
      : // the market-hours sale with the price held flat over the wait: market risk is item 12
        dexSale('wait_for_market_open', 'us_market_hours', 'assumption', 'sale_at_next_open');
  const twoHopDetail = `${inp.twoHop.pools} pools ($${Math.round(inp.twoHop.tvlUsd)} TVL at discovery) pair it with a token whose dollar leg is not collected`;
  const twoHop: LiquidationRoute = {
    route: 'two_hop',
    regime: inp.regime,
    seizedUsd: inp.seizedUsd,
    recovered: missing('not_collected', 'fraction', { ...ctx, detail: twoHopDetail }),
    liquidatorMargin: missing('not_collected', 'fraction', { ...ctx, detail: twoHopDetail }),
  };
  const issuer = ((): LiquidationRoute => {
    const m = inp.issuer;
    const none = (reason: FactNullReason, detail: string): LiquidationRoute => ({
      route: 'issuer_redemption',
      regime: inp.regime,
      seizedUsd: inp.seizedUsd,
      recovered: missing(reason, 'fraction', { ...ctx, detail }),
      liquidatorMargin: missing(reason, 'fraction', { ...ctx, detail }),
    });
    if (!m) return none('not_applicable', 'no issuer model for this asset');
    if (inp.seizedUsd < m.minNotionalUsd) return none('not_applicable', 'below the issuer minimum');
    const meta = {
      unit: 'fraction' as const,
      quality: 'assumption' as const,
      ...ctx,
      method: `issuer_redemption_at_oracle (settles in ${m.settlementHours}h, KYC ${m.kycRequired ? 'required' : 'not required'})`,
      methodVersion: FACTS_METHOD_VERSION,
      provenance: inp.curveMeta.provenance,
    };
    // redeemed at the venue oracle price, less the issuer fee: recovered against the DEX mid needs the gap
    const gap = inp.oracleGap[inp.regime];
    return {
      route: 'issuer_redemption',
      regime: inp.regime,
      seizedUsd: inp.seizedUsd,
      recovered: gap
        ? fact({
            ...meta,
            value: (1 + gap.value) * (1 - m.feePct),
            source: `${m.source}; ${gap.source}`,
            fetchedAt: later(m.fetchedAt, gap.fetchedAt) as string,
          })
        : missing('no_samples_in_regime', 'fraction', {
            ...ctx,
            detail: 'no oracle-against-DEX rows in this regime',
          }),
      liquidatorMargin: fact({
        ...meta,
        value: (1 + inp.bonus) * (1 - m.feePct) - 1,
        source: m.source,
        fetchedAt: m.fetchedAt,
      }),
    };
  })();
  return rankRoutes([routedDex, twoHop, wait, issuer]);
}

const rank = (f: Fact) =>
  f.value === null ? 2 : f.quality === 'measured' || f.quality === 'lower_bound' ? 0 : 1;

/** Measured routes by recovered value, then routes resting on an assumption, then those not measured. */
export function rankRoutes(routes: readonly LiquidationRoute[]): LiquidationRoute[] {
  return [...routes].sort(
    (a, b) =>
      rank(a.recovered) - rank(b.recovered) || (b.recovered.value ?? 0) - (a.recovered.value ?? 0),
  );
}

/** The route to plan on: the first measured one, or null when none is measured. */
export const bestRoute = (routes: readonly LiquidationRoute[]) =>
  routes.find((r) => rank(r.recovered) === 0) ?? null;
