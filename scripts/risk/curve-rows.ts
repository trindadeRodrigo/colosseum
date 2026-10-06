import {
  type CostSample,
  carrySplit,
  type DepthCurve,
  fitCurve,
  REGIMES,
  type Regime,
  type RegimeParams,
  regimeAt,
} from '@colosseum/risk';

// The rows `pnpm risk:compute` writes to risk_depth_curves, from the rows of risk_asset_snapshots. No I/O
// and no clock: compute.ts reads the tables, calls this and writes what it returns.
export const CURVE_METHOD_VERSION = 'risk-0.3';
/** A snapshot of the EVM collector says `evmq-…`, and its curve keeps that (scripts/risk-evm, RISK-1). */
export const EVM_VERSION_PREFIX = 'evmq-';

const SOURCE_ROUTED =
  'risk_asset_snapshots (routed: best split across dollar-exit pools per snapshot)';
const SOURCE_BEST_POOL =
  'risk_asset_snapshots (best single pool per size among the pools the vault reaches, per snapshot)';

/** The method version a curve is stored under: the snapshot's own when it is the EVM collector's. */
export const curveVersionOf = (snapshotVersion: string) =>
  snapshotVersion.startsWith(EVM_VERSION_PREFIX) ? snapshotVersion : CURVE_METHOD_VERSION;

/** What compute reads of one row of risk_asset_snapshots. */
export type SnapshotForCurve = {
  assetMint: string;
  /** The symbol the collector wrote on the row. */
  asset: string;
  methodVersion: string;
  fetchedAt: Date;
  sell: unknown;
  buy: unknown;
};

export type CurveRowsInput = {
  snapshots: SnapshotForCurve[];
  /** The symbol risk_pools gives each mint. */
  poolSymbols: Map<string, string>;
  /** The points stored today, by `previousKey`: a refit keeps the cost split they carry. */
  previous: Map<string, DepthCurve['points']>;
  now: Date;
  quantile: number;
  minSamples: number;
  regimeParams: RegimeParams;
};

export const previousKey = (mint: string, side: string, regime: string, version: string) =>
  `${mint}|${side}|${regime}|${version}`;

type Pt = { notionalUsd: number; outUsd: number };

export function curveRows(input: CurveRowsInput) {
  const best = new Map<
    string,
    Map<string, { sell: Map<number, number>; buy: Map<number, number> }>
  >();
  // each mint's symbol and method version as its newest snapshot has them
  const meta = new Map<string, { asset: string; version: string; at: number }>();
  for (const r of input.snapshots) {
    const at = r.fetchedAt.getTime();
    if (at >= (meta.get(r.assetMint)?.at ?? Number.NEGATIVE_INFINITY))
      meta.set(r.assetMint, { asset: r.asset, version: r.methodVersion, at });
    const a = best.get(r.assetMint) ?? new Map();
    const e = { sell: new Map<number, number>(), buy: new Map<number, number>() };
    for (const side of ['sell', 'buy'] as const)
      for (const pt of (r[side] as Pt[]) ?? [])
        if (Number.isFinite(pt.outUsd)) e[side].set(pt.notionalUsd, pt.outUsd);
    a.set(r.fetchedAt.toISOString(), e);
    best.set(r.assetMint, a);
  }
  const rows = [];
  for (const [mint, times] of best) {
    const version = curveVersionOf(meta.get(mint)?.version ?? '');
    for (const side of ['sell', 'buy'] as const) {
      const byRegime = new Map<Regime, Array<CostSample & { at: string }>>();
      for (const [t, e] of times) {
        const r = regimeAt(new Date(t), input.regimeParams);
        const arr = byRegime.get(r) ?? [];
        for (const [n, out] of e[side]) arr.push({ notionalUsd: n, cost: 1 - out / n, at: t });
        byRegime.set(r, arr);
      }
      for (const r of REGIMES) {
        const samples = byRegime.get(r);
        if (!samples?.length) continue;
        const c = fitCurve(samples, { quantile: input.quantile, minSamples: input.minSamples });
        rows.push({
          assetMint: mint,
          assetSymbol: input.poolSymbols.get(mint) ?? meta.get(mint)?.asset ?? mint.slice(0, 6),
          side,
          regime: r,
          points: carrySplit(input.previous.get(previousKey(mint, side, r, version)), c.points),
          insufficientFrom: c.insufficientFrom,
          quantile: c.quantile,
          minSamples: c.minSamples,
          samples: c.samples,
          dataFrom: c.from ? new Date(c.from) : null,
          dataTo: c.to ? new Date(c.to) : null,
          computedAt: input.now,
          methodVersion: version,
          source: version === CURVE_METHOD_VERSION ? SOURCE_ROUTED : SOURCE_BEST_POOL,
          method: 'fitCurve_isotonic_pl_ln_notional',
          provenance: 'live' as const,
        });
      }
    }
  }
  return { rows, assets: best.size };
}

export type CurveRow = ReturnType<typeof curveRows>['rows'][number];
