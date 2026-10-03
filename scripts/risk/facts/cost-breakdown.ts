import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskDepthCurves, riskNetworkFees } from '@colosseum/db';
import {
  attachSplit,
  type DepthCurve,
  defaultRegimeParams,
  fitCostBreakdown,
  networkFeePerSwap,
  type Regime,
  regimeAt,
  type SplitRow,
  splitKey,
} from '@colosseum/risk';
import { and, eq } from 'drizzle-orm';
import { LENDING_DATA } from '../lib-lending';

// PLAN-ANALYTICS item 4 — `pnpm risk:cost-breakdown [asset]`: fits the cost split (pool fee, transfer fee, basis;
// median per asset, side, regime and size) from the split snapshots in data/risk/split/ (`split-0.1`) and stores
// it as optional keys on the `risk-0.3` curve points. Cost, samples and every provider answer are unchanged; impact
// is the point's cost less the three. Prints one asset's table by regime and size, with the network fee per swap.
// Run after `pnpm risk:split-snapshot`; an hourly schedule is a launchd job a person installs.
const CURVE_METHOD_VERSION = 'risk-0.3';
const dir = join(LENDING_DATA, 'split');
const show = (process.argv[2] ?? 'SPYx').toLowerCase();
const P = defaultRegimeParams(
  JSON.parse(
    readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
  ),
);

const rows: SplitRow[] = [];
if (existsSync(dir))
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort())
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n'))
      if (l) rows.push(JSON.parse(l) as SplitRow);
const fit = fitCostBreakdown(rows, (at) => regimeAt(at, P));

const { db, client } = createDb();
const curves = await db
  .select()
  .from(riskDepthCurves)
  .where(eq(riskDepthCurves.methodVersion, CURVE_METHOD_VERSION));
let updated = 0;
let withKeys = 0;
const unmatched = new Set(fit.keys());
const table: Array<Record<string, string | number>> = [];
const pct = (x: number | undefined) => (x === undefined ? '—' : `${(x * 100).toFixed(4)}%`);
for (const c of curves) {
  const k = splitKey(c.assetMint, c.side, c.regime);
  unmatched.delete(k);
  const points = attachSplit(c.points as DepthCurve['points'], fit.get(k));
  if (fit.has(k)) withKeys++;
  await db
    .update(riskDepthCurves)
    .set({ points })
    .where(
      and(
        eq(riskDepthCurves.assetMint, c.assetMint),
        eq(riskDepthCurves.side, c.side),
        eq(riskDepthCurves.regime, c.regime),
        eq(riskDepthCurves.methodVersion, CURVE_METHOD_VERSION),
      ),
    );
  updated++;
  if (c.assetSymbol.toLowerCase() === show)
    for (const p of points)
      table.push({
        side: c.side,
        regime: c.regime as Regime,
        sizeUsd: p.notionalUsd,
        total: pct(p.cost),
        poolFee: pct(p.poolFee),
        transferFee: pct(p.transferFee),
        basis: pct(p.basis),
        impact:
          p.poolFee === undefined
            ? '—'
            : pct(p.cost - (p.poolFee ?? 0) - (p.transferFee ?? 0) - (p.basis ?? 0)),
        splitSamples: p.splitSamples ?? 0,
      });
}
const fees = await db.select().from(riskNetworkFees);
await client.end();
const MIN_SAMPLES = Number(process.env.RISK_MIN_SAMPLES ?? 8);
const fee = networkFeePerSwap(
  fees.map((r) => ({
    signature: r.signature,
    blockTime: r.blockTime.toISOString(),
    feeLamports: r.feeLamports,
    solUsd: r.solUsd,
  })),
  MIN_SAMPLES,
);
table.sort(
  (a, b) =>
    String(a.side).localeCompare(String(b.side)) ||
    String(a.regime).localeCompare(String(b.regime)) ||
    Number(a.sizeUsd) - Number(b.sizeUsd),
);
if (table.length) console.table(table);
console.log(
  JSON.stringify({
    splitRows: rows.length,
    splitRuns: new Set(rows.map((r) => r.fetchedAt)).size,
    fittedGroups: fit.size,
    curvesUpdated: updated,
    curvesWithSplit: withKeys,
    groupsWithoutCurve: unmatched.size,
    networkFeePerSwap: fee,
    minSamplesPerPoint: MIN_SAMPLES,
  }),
);
