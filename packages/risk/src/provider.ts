import type {
  ExitCapacity,
  LiquidityAssessInput,
  LiquidityAssessment,
  LiquidityEntry,
  RegimeCost,
  RegimeLiquidityProvider,
} from '@colosseum/schemas';
import { type AssetCurves, curveFor, measuredRegimes, weekendRatio, worstCapacity } from './assess';
import { assessLiquidity } from './breach';
import { costAt, maxNotionalAt, usableCount } from './curves';
import type { Regime, RegimeParams } from './time';

/**
 * LiquidityProvider over a frozen snapshot of curves (deterministic: no clock, no I/O).
 * "Worst regime of a window" is the worst of every measured regime: any window of two days or more
 * contains a weekend, and shorter windows are treated the same way (conservative, documented).
 * A regime whose curve has no grid point with enough samples is not measured: it is skipped and named
 * (`regimes`), never read as zero capacity (PLAN-ANALYTICS DA2). The per-regime methods answer one regime.
 */
export type ProviderSnapshot = {
  /** Sell curves keyed by the structurer's asset id (registry id, e.g. 'spyx'). */
  curves: Map<string, AssetCurves>;
  /** Buy curves, same keys; `entryCostIn` is null for an asset without them. */
  buyCurves?: Map<string, AssetCurves>;
  /** Optional LP-exit stress cost (fraction) at a notional, per asset id. */
  lpExitCost?: (assetId: string, notionalUsd: number) => number | null;
  regimeParams: RegimeParams;
  methodVersion: string;
  provenance: 'live' | 'fixture' | 'mock';
};

export function createLiquidityProvider(s: ProviderSnapshot): RegimeLiquidityProvider {
  const cap = (assetId: string, tau: number): ExitCapacity | null => {
    const a = s.curves.get(assetId);
    if (!a) return null;
    const regimes = measuredRegimes(a).measured;
    if (!regimes.length) return null;
    const w = worstCapacity(a, regimes, tau);
    const c = curveFor(a, w.regime).curve;
    return {
      capacityUsd: w.capacityUsd,
      lowerBound: w.lowerBound,
      regime: w.regime,
      samples: c?.samples ?? 0,
      dataFrom: c?.from ?? null,
      dataTo: c?.to ?? null,
    };
  };
  const cost = (assetId: string, n: number): number | null => {
    const a = s.curves.get(assetId);
    if (!a) return null;
    let worst: number | null = null;
    for (const r of measuredRegimes(a).measured) {
      const c = curveFor(a, r).curve;
      const k = c ? costAt(c, n) : null;
      if (k === null) return null; // beyond measured in some regime: not sellable at a known cost
      worst = worst === null ? k : Math.max(worst, k);
    }
    return worst;
  };
  const costIn = (a: AssetCurves | undefined, n: number, regime: Regime): RegimeCost | null => {
    if (!a) return null;
    const { curve, regimeUsed } = curveFor(a, regime);
    const base = {
      regime,
      regimeUsed,
      samples: curve?.samples ?? 0,
      dataFrom: curve?.from ?? null,
      dataTo: curve?.to ?? null,
    };
    if (!curve) return { cost: null, reason: 'no_samples_in_regime', ...base };
    if (usableCount(curve) === 0) return { cost: null, reason: 'insufficient_samples', ...base };
    const k = costAt(curve, n);
    return k === null
      ? { cost: null, reason: 'beyond_measured_size', ...base }
      : { cost: k, reason: null, ...base };
  };
  return {
    methodVersion: s.methodVersion,
    provenance: s.provenance,
    covers: (id) => s.curves.has(id),
    exitCapacity: (id, tau) => cap(id, tau),
    exitCost: (id, n) => cost(id, n),
    weekendRatio: (id, tau) => {
      const a = s.curves.get(id);
      return a ? weekendRatio(a, tau) : null;
    },
    entry: (id, ctx): LiquidityEntry | null => {
      const c = cap(id, ctx.tau);
      if (!c) return null;
      return {
        assetId: id,
        score: ctx.legAmountUsd > 0 ? Math.min(1, c.capacityUsd / ctx.legAmountUsd) : 1,
        capacityUsd: c.capacityUsd,
        capacityLowerBound: c.lowerBound,
        worstRegime: c.regime,
        tau: ctx.tau,
        windowDays: ctx.windowDays,
        legAmountUsd: ctx.legAmountUsd,
        weekendRatio: (() => {
          const a = s.curves.get(id);
          return a ? weekendRatio(a, ctx.tau) : null;
        })(),
        lpExitCostPct: (() => {
          const k = s.lpExitCost?.(id, ctx.legAmountUsd);
          return k === null || k === undefined ? null : k * 100;
        })(),
        primaryPath: null,
        samples: c.samples,
        dataFrom: c.dataFrom,
        dataTo: c.dataTo,
        methodVersion: s.methodVersion,
        provenance: s.provenance,
      };
    },
    assess: (inp: LiquidityAssessInput): LiquidityAssessment => {
      const illiquid = inp.illiquid
        .filter((l) => s.curves.has(l.assetId))
        .map((l) => ({ ...l, curves: s.curves.get(l.assetId) as AssetCurves }));
      const r = assessLiquidity({ ...inp, illiquid, regimeParams: s.regimeParams });
      return {
        breach: r.breach,
        likelyBreach: r.likelyBreach,
        shortfallUsd: r.shortfallUsd,
        monthsAtRisk: r.monthsAtRisk,
        orders: r.orders,
        params: r.params,
        regimesMissing: r.regimesMissing,
        methodVersion: s.methodVersion,
      };
    },
    regimes: (id) => {
      const a = s.curves.get(id);
      return a ? measuredRegimes(a) : null;
    },
    exitCostIn: (id, n, regime) => costIn(s.curves.get(id), n, regime),
    entryCostIn: (id, n, regime) => costIn(s.buyCurves?.get(id), n, regime),
    exitCapacityIn: (id, tau, regime) => {
      const a = s.curves.get(id);
      if (!a) return null;
      const { curve } = curveFor(a, regime);
      if (!curve || usableCount(curve) === 0) return null;
      const m = maxNotionalAt(curve, tau);
      return {
        capacityUsd: m.notionalUsd,
        lowerBound: m.lowerBound,
        regime,
        samples: curve.samples,
        dataFrom: curve.from,
        dataTo: curve.to,
      };
    },
  };
}
