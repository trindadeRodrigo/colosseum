import { quantileOf } from '../curves';
import type { Regime } from '../time';

/**
 * Liquidity stability (PLAN-ANALYTICS item 15). Pure functions over rows the caller read.
 *   Depth recovery   from the Step 5b history replay: each trade of at least `largeShare` of its pool's ±2% depth,
 *                    with the minutes until the depth was back to half and to 90% of what it was (null when not back
 *                    within 24 hours). Per asset and regime: the trades, the median minutes over those that came
 *                    back, and the share that did not.
 *   Variation        standard deviation ÷ mean of exit capacity at tau across snapshots, per regime.
 */
export type LargeTrade = {
  asset: string;
  regime: Regime;
  at: string;
  recover50Min: number | null;
  recover90Min: number | null;
};

export type DepthRecoveryRow = {
  asset: string;
  regime: Regime;
  trades: number;
  recovered: number;
  minutesTo50: number | null;
  minutesTo90: number | null;
  notRecovered24h: number;
  dataFrom: string;
  dataTo: string;
};

export function depthRecovery(trades: LargeTrade[]): DepthRecoveryRow[] {
  const groups = new Map<string, LargeTrade[]>();
  for (const t of trades) {
    const k = `${t.asset}|${t.regime}`;
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  const med = (xs: number[]) => (xs.length ? quantileOf(xs, 0.5) : null);
  return [...groups]
    .map(([k, ts]) => {
      const [asset, regime] = k.split('|') as [string, Regime];
      const r90 = ts.map((t) => t.recover90Min).filter((x): x is number => x !== null);
      const times = ts.map((t) => t.at).sort();
      return {
        asset,
        regime,
        trades: ts.length,
        recovered: r90.length,
        minutesTo50: med(ts.map((t) => t.recover50Min).filter((x): x is number => x !== null)),
        minutesTo90: med(r90),
        notRecovered24h: 1 - r90.length / ts.length,
        dataFrom: times[0] as string,
        dataTo: times.at(-1) as string,
      };
    })
    .sort((a, b) => a.asset.localeCompare(b.asset) || a.regime.localeCompare(b.regime));
}

/** Standard deviation ÷ mean of a capacity series; null below `minSamples` or with a mean that is not positive. */
export function seriesVariation(xs: number[], minSamples: number): number | null {
  if (xs.length < minSamples) return null;
  const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
  if (!(mean > 0)) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length) / mean;
}
