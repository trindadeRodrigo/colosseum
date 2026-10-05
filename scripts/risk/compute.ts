import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createDb, riskAssetSnapshots, riskDepthCurves, riskPools } from '@colosseum/db';
import {
  type CostSample,
  carrySplit,
  type DepthCurve,
  defaultRegimeParams,
  fitCurve,
  REGIMES,
  type Regime,
  regimeAt,
} from '@colosseum/risk';
import { eq, sql } from 'drizzle-orm';

// Computes asset-level depth curves from routed asset snapshots (risk-0.3): per asset and collector run, the
// best split of a sale across the asset's USDC/USDT and SOL pools. Samples are bucketed by
// regime and fitted with fitCurve. Persisted to risk_depth_curves with method_version.
export const CURVE_METHOD_VERSION = 'risk-0.3';
const QUANTILE = Number(process.env.RISK_CURVE_QUANTILE ?? 0.5);
const MIN_SAMPLES = Number(process.env.RISK_MIN_SAMPLES ?? 8);
const P = defaultRegimeParams(
  JSON.parse(
    readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
  ),
);

const { db, client } = createDb();
const pools = await db.select().from(riskPools);
// routed asset snapshots: the best split across the asset's dollar-exit pools (risk-0.3)
const assetRows = await db
  .select({
    assetMint: riskAssetSnapshots.assetMint,
    fetchedAt: riskAssetSnapshots.fetchedAt,
    sell: riskAssetSnapshots.sell,
    buy: riskAssetSnapshots.buy,
  })
  .from(riskAssetSnapshots);
type Pt = { notionalUsd: number; outUsd: number };
const best = new Map<
  string,
  Map<string, { sell: Map<number, number>; buy: Map<number, number> }>
>();
for (const r of assetRows) {
  const a = best.get(r.assetMint) ?? new Map();
  const e = { sell: new Map<number, number>(), buy: new Map<number, number>() };
  for (const side of ['sell', 'buy'] as const)
    for (const pt of (r[side] as Pt[]) ?? [])
      if (Number.isFinite(pt.outUsd)) e[side].set(pt.notionalUsd, pt.outUsd);
  a.set(r.fetchedAt.toISOString(), e);
  best.set(r.assetMint, a);
}
const snaps = assetRows;
// the cost split (`pnpm risk:cost-breakdown`) lives as optional keys on the points; a refit keeps them
const previous = new Map(
  (
    await db
      .select({
        assetMint: riskDepthCurves.assetMint,
        side: riskDepthCurves.side,
        regime: riskDepthCurves.regime,
        points: riskDepthCurves.points,
      })
      .from(riskDepthCurves)
      .where(eq(riskDepthCurves.methodVersion, CURVE_METHOD_VERSION))
  ).map((r) => [`${r.assetMint}|${r.side}|${r.regime}`, r.points as DepthCurve['points']]),
);
const symbol = new Map(pools.map((p) => [p.assetMint, p.assetSymbol]));
let written = 0;
const now = new Date();
for (const [mint, times] of best) {
  for (const side of ['sell', 'buy'] as const) {
    const byRegime = new Map<Regime, Array<CostSample & { at: string }>>();
    for (const [t, e] of times) {
      const r = regimeAt(new Date(t), P);
      const arr = byRegime.get(r) ?? [];
      for (const [n, out] of e[side]) arr.push({ notionalUsd: n, cost: 1 - out / n, at: t });
      byRegime.set(r, arr);
    }
    for (const r of REGIMES) {
      const samples = byRegime.get(r);
      if (!samples?.length) continue;
      const c = fitCurve(samples, { quantile: QUANTILE, minSamples: MIN_SAMPLES });
      const row = {
        assetMint: mint,
        assetSymbol: symbol.get(mint) ?? mint.slice(0, 6),
        side,
        regime: r,
        points: carrySplit(previous.get(`${mint}|${side}|${r}`), c.points),
        insufficientFrom: c.insufficientFrom,
        quantile: c.quantile,
        minSamples: c.minSamples,
        samples: c.samples,
        dataFrom: c.from ? new Date(c.from) : null,
        dataTo: c.to ? new Date(c.to) : null,
        computedAt: now,
        methodVersion: CURVE_METHOD_VERSION,
        source: 'risk_asset_snapshots (routed: best split across dollar-exit pools per snapshot)',
        method: 'fitCurve_isotonic_pl_ln_notional',
        provenance: 'live' as const,
      };
      await db
        .insert(riskDepthCurves)
        .values(row)
        .onConflictDoUpdate({
          target: [
            riskDepthCurves.assetMint,
            riskDepthCurves.side,
            riskDepthCurves.regime,
            riskDepthCurves.methodVersion,
          ],
          set: { ...row, assetMint: sql`excluded.asset_mint` },
        });
      written++;
    }
  }
}
await client.end();
console.log(
  JSON.stringify({
    assets: best.size,
    curves: written,
    snapshots: snaps.length,
    quantile: QUANTILE,
    minSamples: MIN_SAMPLES,
    methodVersion: CURVE_METHOD_VERSION,
  }),
);
