/**
 * Depth curve fit (method risk-0.2): per grid notional, take the `quantile` of observed sell cost across
 * samples in one bucket; enforce monotonicity with isotonic regression (pool-adjacent-violators);
 * interpolate linearly in ln(notional). Queries:
 *   costAt(n)          interpolated cost (fraction); null above the grid (beyond measured)
 *   maxNotionalAt(tau) largest n with costAt(n) ≤ tau; lowerBound when even the top grid point passes
 *   recoverable(n)     n × (1 − costAt(n))
 * Grid points with fewer than `minSamples` successful samples make the curve `insufficient` from there up.
 */
export type CostSample = { notionalUsd: number; cost: number };

/**
 * Optional keys on a curve point (PLAN-ANALYTICS item 4, `pnpm risk:cost-breakdown`): the median pool fee,
 * transfer fee and basis at this size, as fractions, fitted from the split snapshots (`split-0.1`); `impact` is the
 * point's cost less the three. Absent until the fit runs; the curve's own answers never read them.
 */
export type SplitKeys = {
  poolFee?: number;
  transferFee?: number;
  basis?: number;
  /** Split snapshots behind the three keys at this size and regime. */
  splitSamples?: number;
  /** First and last split snapshot behind them (ISO 8601). */
  splitFrom?: string;
  splitTo?: string;
};

export type DepthCurve = {
  points: Array<{ notionalUsd: number; cost: number; samples: number } & SplitKeys>;
  /** Index of the first grid point with too few samples (points from here up are not used). */
  insufficientFrom: number | null;
  quantile: number;
  minSamples: number;
  from: string | null;
  to: string | null;
  samples: number;
};

export function quantileOf(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

/** Pool-adjacent-violators: the closest non-decreasing sequence (equal weights). */
export function isotonic(ys: number[]): number[] {
  const blocks: Array<{ sum: number; n: number }> = [];
  for (const y of ys) {
    blocks.push({ sum: y, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1] as { sum: number; n: number };
      const a = blocks[blocks.length - 2] as { sum: number; n: number };
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.sum / b.n));
}

export function fitCurve(
  samples: Array<CostSample & { at?: string }>,
  opts: { quantile: number; minSamples: number },
): DepthCurve {
  const byN = new Map<number, number[]>();
  for (const s of samples) {
    if (!Number.isFinite(s.cost)) continue;
    const arr = byN.get(s.notionalUsd) ?? [];
    arr.push(s.cost);
    byN.set(s.notionalUsd, arr);
  }
  const grid = [...byN.keys()].sort((a, b) => a - b);
  const raw = grid.map((n) => quantileOf(byN.get(n) as number[], opts.quantile));
  const mono = isotonic(raw);
  const points = grid.map((n, i) => ({
    notionalUsd: n,
    cost: mono[i] as number,
    samples: (byN.get(n) as number[]).length,
  }));
  const bad = points.findIndex((p) => p.samples < opts.minSamples);
  const times = samples
    .map((s) => s.at)
    .filter((t): t is string => !!t)
    .sort();
  return {
    points,
    insufficientFrom: bad < 0 ? null : bad,
    quantile: opts.quantile,
    minSamples: opts.minSamples,
    from: times[0] ?? null,
    to: times.at(-1) ?? null,
    samples: samples.length,
  };
}

const usable = (c: DepthCurve) =>
  c.insufficientFrom === null ? c.points : c.points.slice(0, c.insufficientFrom);

/** Grid points with enough samples to be used. Zero means the curve measures nothing yet. */
export const usableCount = (c: DepthCurve): number => usable(c).length;

export function costAt(c: DepthCurve, n: number): number | null {
  const pts = usable(c);
  if (pts.length === 0) return null;
  const first = pts[0] as { notionalUsd: number; cost: number };
  const last = pts.at(-1) as { notionalUsd: number; cost: number };
  if (n <= first.notionalUsd) return first.cost;
  if (n > last.notionalUsd) return null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { notionalUsd: number; cost: number };
    const b = pts[i] as { notionalUsd: number; cost: number };
    if (n <= b.notionalUsd) {
      const t =
        (Math.log(n) - Math.log(a.notionalUsd)) /
        (Math.log(b.notionalUsd) - Math.log(a.notionalUsd));
      return a.cost + t * (b.cost - a.cost);
    }
  }
  return last.cost;
}

export function maxNotionalAt(
  c: DepthCurve,
  tau: number,
): { notionalUsd: number; lowerBound: boolean } {
  const pts = usable(c);
  if (pts.length === 0 || (pts[0] as { cost: number }).cost > tau)
    return { notionalUsd: 0, lowerBound: false };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { notionalUsd: number; cost: number };
    const b = pts[i] as { notionalUsd: number; cost: number };
    if (b.cost > tau) {
      if (b.cost === a.cost) return { notionalUsd: a.notionalUsd, lowerBound: false };
      const t = (tau - a.cost) / (b.cost - a.cost);
      return {
        notionalUsd: Math.exp(
          Math.log(a.notionalUsd) + t * (Math.log(b.notionalUsd) - Math.log(a.notionalUsd)),
        ),
        lowerBound: false,
      };
    }
  }
  return { notionalUsd: (pts.at(-1) as { notionalUsd: number }).notionalUsd, lowerBound: true };
}

export function recoverable(c: DepthCurve, n: number): number | null {
  const k = costAt(c, n);
  return k === null ? null : n * (1 - k);
}
