import { costAt, type DepthCurve, maxNotionalAt, usableCount } from './curves';
import { REGIMES, type Regime, type RegimeParams, regimeAt, regimesIn } from './time';

/** Sell-side curves per regime for one asset. Missing regimes fall back as documented in `curveFor`. */
export type AssetCurves = { assetId: string; byRegime: Partial<Record<Regime, DepthCurve>> };

/** A us_holiday curve with no data falls back to the weekend curve (both are closed-market regimes). */
export function curveFor(
  a: AssetCurves,
  r: Regime,
): { curve: DepthCurve | null; regimeUsed: Regime } {
  const c = a.byRegime[r];
  if (c?.points.length) return { curve: c, regimeUsed: r };
  if (r === 'us_holiday' && a.byRegime.weekend)
    return { curve: a.byRegime.weekend, regimeUsed: 'weekend' };
  return { curve: null, regimeUsed: r };
}

export type RegimeGap = { regime: Regime; reason: 'no_samples_in_regime' | 'insufficient_samples' };

/**
 * Which regimes an asset's curves measure (PLAN-ANALYTICS DA2). A regime with no snapshot, or whose curve has
 * no grid point with enough samples, is not measured: it is named with its reason and never read as zero
 * capacity. us_holiday counts as measured through the weekend curve (`curveFor`).
 */
export function measuredRegimes(
  a: AssetCurves,
  regimes: readonly Regime[] = REGIMES,
): { measured: Regime[]; missing: RegimeGap[] } {
  const measured: Regime[] = [];
  const missing: RegimeGap[] = [];
  for (const r of regimes) {
    const { curve } = curveFor(a, r);
    if (!curve) missing.push({ regime: r, reason: 'no_samples_in_regime' });
    else if (usableCount(curve) === 0) missing.push({ regime: r, reason: 'insufficient_samples' });
    else measured.push(r);
  }
  return { measured, missing };
}

/**
 * Exit capacity at tau in the worst measured regime among `regimes`. When none of them is measured, the worst
 * of every measured regime stands in (`fallback: true`); null when the asset has no measured regime at all.
 */
export function worstMeasuredCapacity(a: AssetCurves, regimes: readonly Regime[], tau: number) {
  const inWindow = measuredRegimes(a, regimes);
  const use = inWindow.measured.length ? inWindow.measured : measuredRegimes(a).measured;
  if (!use.length) return null;
  return {
    ...worstCapacity(a, use, tau),
    regimesMissing: inWindow.missing,
    fallback: inWindow.measured.length === 0,
  };
}

/** Exit capacity at tolerance tau in the worst regime among `regimes` (0 when a regime has no curve). */
export function worstCapacity(a: AssetCurves, regimes: Regime[], tau: number) {
  let worst: { regime: Regime; capacityUsd: number; lowerBound: boolean } | null = null;
  for (const r of regimes) {
    const { curve } = curveFor(a, r);
    const m = curve ? maxNotionalAt(curve, tau) : { notionalUsd: 0, lowerBound: false };
    if (!worst || m.notionalUsd < worst.capacityUsd)
      worst = { regime: r, capacityUsd: m.notionalUsd, lowerBound: m.lowerBound };
  }
  return worst ?? { regime: 'weekend' as Regime, capacityUsd: 0, lowerBound: false };
}

/** Weekend / market-hours exit capacity ratio at tau; null when either regime is not measured. */
export function weekendRatio(a: AssetCurves, tau: number): number | null {
  const w = a.byRegime.weekend;
  const m = a.byRegime.us_market_hours;
  if (!w || !m || usableCount(w) === 0 || usableCount(m) === 0) return null;
  const cm = maxNotionalAt(m, tau).notionalUsd;
  return cm > 0 ? maxNotionalAt(w, tau).notionalUsd / cm : null;
}

// ---------------------------------------------------------------- primary redemption (issuer route)

/** Issuer redemption terms. Every field is a labelled assumption unless a primary source is cited. */
export type IssuerModel = {
  issuer: string;
  /** '24x5': open except the weekend regime and NYSE holidays; '24x7': always open. */
  window: '24x5' | '24x7';
  minNotionalUsd: number;
  kycRequired: boolean;
  settlementHours: number;
  capacityUsdPerOpenHour: number;
  feePct: number;
  provenance: 'assumption' | 'live';
  source: string;
};

export type PrimaryStatus =
  | 'available'
  | 'window_closed'
  | 'below_minimum'
  | 'settles_after_horizon'
  | 'kyc_required';

export function primaryPath(
  m: IssuerModel,
  at: Date,
  hours: number,
  n: number,
  holderKyc: boolean,
  p: RegimeParams,
) {
  const open = (t: Date) =>
    m.window === '24x7' || !['weekend', 'us_holiday'].includes(regimeAt(t, p));
  let openHoursInHorizon = 0;
  let openHoursSettling = 0;
  for (let k = 0; k < Math.floor(hours); k++) {
    const t = new Date(at.getTime() + k * 3_600_000);
    if (!open(t)) continue;
    openHoursInHorizon++;
    if (k + m.settlementHours <= hours) openHoursSettling++;
  }
  const capacityUsd = Math.min(n, m.capacityUsdPerOpenHour * openHoursSettling);
  let status: PrimaryStatus = 'available';
  if (n < m.minNotionalUsd) status = 'below_minimum';
  else if (openHoursInHorizon === 0) status = 'window_closed';
  else if (openHoursSettling === 0) status = 'settles_after_horizon';
  else if (m.kycRequired && !holderKyc) status = 'kyc_required';
  return {
    issuer: m.issuer,
    status,
    capacityUsd: status === 'available' ? capacityUsd : 0,
    listedCapacityUsd: capacityUsd,
    openHoursInHorizon,
    settlementHours: m.settlementHours,
    provenance: m.provenance,
    source: m.source,
  };
}

// ---------------------------------------------------------------- recoverable value

export function recoverableValue(
  a: AssetCurves,
  issuer: IssuerModel | null,
  n: number,
  at: Date,
  hours: number,
  p: RegimeParams,
  holderKyc = false,
) {
  const regimes = regimesIn(at, hours, p);
  // DEX: one sale in the best regime reachable inside the horizon
  let best: { regime: Regime; regimeUsed: Regime; cost: number } | null = null;
  for (const r of regimes) {
    const { curve, regimeUsed } = curveFor(a, r);
    const k = curve ? costAt(curve, n) : null;
    if (k !== null && (!best || k < best.cost)) best = { regime: r, regimeUsed, cost: k };
  }
  const dexValue = best ? n * (1 - best.cost) : null;
  const primary = issuer ? primaryPath(issuer, at, hours, n, holderKyc, p) : null;
  let combined: number | null = null;
  if (primary && primary.status === 'available') {
    const x = primary.capacityUsd;
    const rest = n - x;
    const restCost =
      rest > 0 && best
        ? (() => {
            const { curve } = curveFor(a, best.regime);
            return curve ? costAt(curve, rest) : null;
          })()
        : 0;
    combined = restCost === null ? null : x * (1 - (issuer?.feePct ?? 0)) + rest * (1 - restCost);
  }
  const usePrimary = combined !== null && (dexValue === null || combined > dexValue);
  return {
    assetId: a.assetId,
    notionalUsd: n,
    at: at.toISOString(),
    horizonHours: hours,
    regimes,
    value: usePrimary ? combined : dexValue,
    path: usePrimary ? 'dex+primary' : dexValue === null ? 'none' : 'dex',
    dex: best
      ? {
          regime: best.regime,
          curveRegime: best.regimeUsed,
          costPct: best.cost * 100,
          value: dexValue,
        }
      : null,
    primary,
  };
}

// ---------------------------------------------------------------- liquidity score

/** Fraction of nRef exitable within the horizon at ≤ tau, in the worst regime the horizon can contain. */
export function liquidityScore(a: AssetCurves, regimes: Regime[], tau: number, nRef: number) {
  const w = worstCapacity(a, regimes, tau);
  return {
    assetId: a.assetId,
    score: nRef > 0 ? Math.min(1, w.capacityUsd / nRef) : 0,
    worstRegime: w.regime,
    capacityUsd: w.capacityUsd,
    lowerBound: w.lowerBound,
    tau,
    nRef,
  };
}
