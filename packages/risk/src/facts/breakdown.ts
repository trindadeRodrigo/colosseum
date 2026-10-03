import { type DepthCurve, quantileOf, type SplitKeys } from '../curves';
import type { Regime } from '../time';

/**
 * The cost split on the curves (PLAN-ANALYTICS item 4, §5). The split snapshots (`pnpm risk:split-snapshot`,
 * `split-0.1`) route each asset's exit pools with `routeTrade` and store, per side and size, the pool fee, the
 * transfer fee and the basis. Here they are fitted the way the curves are (median per asset, side, regime and
 * size) and attached as optional keys on the `risk-0.3` curve points. `impact` is never stored: it is the
 * point's cost less the three, so the four always sum to the curve. Pure functions; the caller does the I/O.
 */
export type SplitRow = {
  assetMint: string;
  fetchedAt: string;
  side: 'sell' | 'buy';
  notionalUsd: number;
  split: { poolFee: number; transferFee: number; basis: number };
};

export type SplitFit = Map<string, Map<number, Required<SplitKeys>>>;

export const splitKey = (assetMint: string, side: string, regime: string) =>
  `${assetMint}|${side}|${regime}`;

const SPLIT_KEYS = [
  'poolFee',
  'transferFee',
  'basis',
  'splitSamples',
  'splitFrom',
  'splitTo',
] as const;

/** Median of each part per asset, side, regime and size, with the samples and the dates behind it. */
export function fitCostBreakdown(rows: SplitRow[], regimeOf: (at: Date) => Regime): SplitFit {
  const groups = new Map<string, Map<number, SplitRow[]>>();
  for (const r of rows) {
    const { poolFee, transferFee, basis } = r.split;
    if (![poolFee, transferFee, basis].every(Number.isFinite)) continue;
    const k = splitKey(r.assetMint, r.side, regimeOf(new Date(r.fetchedAt)));
    const byN = groups.get(k) ?? new Map<number, SplitRow[]>();
    byN.set(r.notionalUsd, [...(byN.get(r.notionalUsd) ?? []), r]);
    groups.set(k, byN);
  }
  const fit: SplitFit = new Map();
  for (const [k, byN] of groups) {
    const out = new Map<number, Required<SplitKeys>>();
    for (const [n, rs] of byN) {
      const times = rs.map((r) => r.fetchedAt).sort();
      out.set(n, {
        poolFee: quantileOf(
          rs.map((r) => r.split.poolFee),
          0.5,
        ),
        transferFee: quantileOf(
          rs.map((r) => r.split.transferFee),
          0.5,
        ),
        basis: quantileOf(
          rs.map((r) => r.split.basis),
          0.5,
        ),
        splitSamples: new Set(times).size,
        splitFrom: times[0] as string,
        splitTo: times.at(-1) as string,
      });
    }
    fit.set(k, out);
  }
  return fit;
}

type Point = DepthCurve['points'][number];

const withoutSplit = (p: Point): Point => {
  const q: Record<string, unknown> = { ...p };
  for (const k of SPLIT_KEYS) delete q[k];
  return q as Point;
};

/** The points with the fitted keys of `bySize` attached (earlier keys replaced); cost and samples untouched. */
export function attachSplit(
  points: Point[],
  bySize: Map<number, Required<SplitKeys>> | undefined,
): Point[] {
  return points.map((p) => {
    const s = bySize?.get(p.notionalUsd);
    return s ? { ...withoutSplit(p), ...s } : withoutSplit(p);
  });
}

/** Keeps the split keys of `previous` on a refitted curve's points of the same size (for `risk:compute`). */
export function carrySplit(previous: Point[] | null | undefined, next: Point[]): Point[] {
  if (!previous?.length) return next;
  const old = new Map(previous.map((p) => [p.notionalUsd, p]));
  return next.map((p) => {
    const o = old.get(p.notionalUsd);
    if (o?.splitSamples === undefined) return p;
    const keep: SplitKeys = {};
    for (const k of SPLIT_KEYS) if (o[k] !== undefined) Object.assign(keep, { [k]: o[k] });
    return { ...p, ...keep };
  });
}

export type SplitAt =
  | {
      poolFee: number;
      transferFee: number;
      basis: number;
      samples: number;
      from: string;
      to: string;
    }
  | { reason: 'not_collected' | 'insufficient_samples' | 'beyond_measured_size' };

/**
 * The split at size `n`, interpolated in ln(notional) like `costAt` over the curve's usable points. Both points
 * around `n` need at least `minSamples` split snapshots; otherwise the reason (no keys yet: `not_collected`).
 */
export function splitAt(c: DepthCurve, n: number, minSamples: number): SplitAt {
  const pts = c.insufficientFrom === null ? c.points : c.points.slice(0, c.insufficientFrom);
  if (pts.length === 0) return { reason: 'insufficient_samples' };
  const last = pts.at(-1) as Point;
  if (n > last.notionalUsd) return { reason: 'beyond_measured_size' };
  let i = pts.findIndex((p) => n <= p.notionalUsd);
  if (i < 0) i = pts.length - 1;
  const b = pts[i] as Point;
  const a = i === 0 || n === b.notionalUsd ? b : (pts[i - 1] as Point);
  for (const p of [a, b]) {
    if (p.splitSamples === undefined) return { reason: 'not_collected' };
    if (p.splitSamples < minSamples) return { reason: 'insufficient_samples' };
  }
  const t =
    a === b
      ? 0
      : (Math.log(n) - Math.log(a.notionalUsd)) /
        (Math.log(b.notionalUsd) - Math.log(a.notionalUsd));
  const lerp = (k: 'poolFee' | 'transferFee' | 'basis') =>
    (a[k] as number) + t * ((b[k] as number) - (a[k] as number));
  return {
    poolFee: lerp('poolFee'),
    transferFee: lerp('transferFee'),
    basis: lerp('basis'),
    samples: Math.min(a.splitSamples as number, b.splitSamples as number),
    from: [a.splitFrom as string, b.splitFrom as string].sort()[0] as string,
    to: [a.splitTo as string, b.splitTo as string].sort()[1] as string,
  };
}

/** One swap's network fee as read from its transaction (`meta.fee`: base plus priority fee, in lamports). */
export type NetworkFeeRow = {
  signature: string;
  blockTime: string;
  feeLamports: number;
  /** SOL in USD when the fee was read. */
  solUsd: number;
};

/** Median network fee per swap in USD, or `insufficient_samples` below `minSamples` transactions. */
export function networkFeePerSwap(
  rows: NetworkFeeRow[],
  minSamples: number,
):
  | { usd: number; lamports: number; samples: number; from: string; to: string }
  | { reason: 'insufficient_samples'; samples: number } {
  const ok = rows.filter((r) => Number.isFinite(r.feeLamports) && r.solUsd > 0);
  if (ok.length < minSamples) return { reason: 'insufficient_samples', samples: ok.length };
  const times = ok.map((r) => r.blockTime).sort();
  return {
    usd: quantileOf(
      ok.map((r) => (r.feeLamports / 1e9) * r.solUsd),
      0.5,
    ),
    lamports: quantileOf(
      ok.map((r) => r.feeLamports),
      0.5,
    ),
    samples: ok.length,
    from: times[0] as string,
    to: times.at(-1) as string,
  };
}
