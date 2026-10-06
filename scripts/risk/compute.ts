import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createDb, riskAssetSnapshots, riskDepthCurves, riskPools } from '@colosseum/db';
import { type DepthCurve, defaultRegimeParams } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { CURVE_METHOD_VERSION, curveRows, previousKey } from './curve-rows';

// Computes asset-level depth curves from the asset snapshots. A Solana row is routed (risk-0.3): per asset
// and collector run, the best split of a sale across the asset's USDC/USDT and SOL pools. A row of the EVM
// collector is the best single pool per size, and its curve keeps the collector's symbol and its evmq-
// method version. Samples are bucketed by regime and fitted with fitCurve (scripts/risk/curve-rows.ts).
// Persisted to risk_depth_curves with method_version.
export { CURVE_METHOD_VERSION };

const QUANTILE = Number(process.env.RISK_CURVE_QUANTILE ?? 0.5);
const MIN_SAMPLES = Number(process.env.RISK_MIN_SAMPLES ?? 8);
const P = defaultRegimeParams(
  JSON.parse(
    readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
  ),
);

const { db, client } = createDb();
const pools = await db.select().from(riskPools);
const snaps = await db
  .select({
    assetMint: riskAssetSnapshots.assetMint,
    asset: riskAssetSnapshots.asset,
    methodVersion: riskAssetSnapshots.methodVersion,
    fetchedAt: riskAssetSnapshots.fetchedAt,
    sell: riskAssetSnapshots.sell,
    buy: riskAssetSnapshots.buy,
  })
  .from(riskAssetSnapshots);
// the cost split (`pnpm risk:cost-breakdown`) lives as optional keys on the points; a refit keeps them
const previous = new Map(
  (
    await db
      .select({
        assetMint: riskDepthCurves.assetMint,
        side: riskDepthCurves.side,
        regime: riskDepthCurves.regime,
        methodVersion: riskDepthCurves.methodVersion,
        points: riskDepthCurves.points,
      })
      .from(riskDepthCurves)
  ).map((r) => [
    previousKey(r.assetMint, r.side, r.regime, r.methodVersion),
    r.points as DepthCurve['points'],
  ]),
);
const { rows, assets } = curveRows({
  snapshots: snaps,
  poolSymbols: new Map(pools.map((p) => [p.assetMint, p.assetSymbol])),
  previous,
  now: new Date(),
  quantile: QUANTILE,
  minSamples: MIN_SAMPLES,
  regimeParams: P,
});
const byVersion: Record<string, number> = {};
for (const row of rows) {
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
  byVersion[row.methodVersion] = (byVersion[row.methodVersion] ?? 0) + 1;
}
await client.end();
console.log(
  JSON.stringify({
    assets,
    curves: rows.length,
    snapshots: snaps.length,
    quantile: QUANTILE,
    minSamples: MIN_SAMPLES,
    methodVersion: CURVE_METHOD_VERSION,
    byVersion,
  }),
);
