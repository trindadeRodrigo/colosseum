import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskDepthRecovery } from '@colosseum/db';
import { depthRecovery, type LargeTrade } from '@colosseum/risk';

// PLAN-ANALYTICS item 15 — `pnpm risk:recovery-import [report.json]`: depth recovery after large trades, from the
// latest Step 5b history report (data/risk/history-full/report/report-<stamp>.json and its large-trades-<stamp>.jsonl)
// into risk_depth_recovery. The medians are recomputed from the trades by `depthRecovery` and compared with the
// report's own table (`vsReport`: the largest difference in minutes, on Step 5b's lower-middle median, and in share,
// which the report rounds to 2 decimals). Idempotent per report.
const DIR = join(process.env.RISK_DATA_DIR ?? 'data/risk', 'history-full', 'report');
const reportFile =
  process.argv[2] ??
  join(
    DIR,
    readdirSync(DIR)
      .filter((f) => /^report-.*\.json$/.test(f))
      .sort()
      .at(-1) as string,
  );
const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
  generatedAt: string;
  method: string;
  largeShare: number;
  provenance: string;
  table: Array<{
    asset: string;
    regime: string;
    trades: number;
    medRecover50Min: number | null;
    medRecover90Min: number | null;
    unrecovered90Share: number;
  }>;
};
const trades = readFileSync(
  reportFile.replace(/report-(.*)\.json$/, 'large-trades-$1.jsonl'),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as LargeTrade);
const rows = depthRecovery(trades);
// the check uses Step 5b's own median (the lower middle value); the stored medians interpolate, as every fact does
const lowerMedian = (a: number[]) => {
  if (!a.length) return null;
  const x = [...a].sort((p, q) => p - q);
  return x[Math.floor((x.length - 1) / 2)] as number;
};
let maxMin = 0;
let maxShare = 0;
let maxConvention = 0;
let matched = 0;
for (const r of rows) {
  const t = report.table.find((x) => x.asset === r.asset && x.regime === r.regime);
  if (!t) continue;
  matched++;
  if (t.trades !== r.trades)
    throw new Error(`${r.asset} ${r.regime}: ${r.trades} trades, report ${t.trades}`);
  const own = trades.filter((x) => x.asset === r.asset && x.regime === r.regime);
  const pick = (k: 'recover50Min' | 'recover90Min') =>
    own.map((x) => x[k]).filter((x): x is number => x !== null);
  for (const [k, theirs, mine] of [
    ['recover50Min', t.medRecover50Min, r.minutesTo50],
    ['recover90Min', t.medRecover90Min, r.minutesTo90],
  ] as const) {
    const lower = lowerMedian(pick(k));
    if (lower !== null && theirs !== null) maxMin = Math.max(maxMin, Math.abs(lower - theirs));
    if (lower !== null && mine !== null)
      maxConvention = Math.max(maxConvention, Math.abs(lower - mine));
  }
  maxShare = Math.max(maxShare, Math.abs(r.notRecovered24h - t.unrecovered90Share));
}
const { db, client } = createDb();
const reportAt = new Date(report.generatedAt);
const fetchedAt = new Date();
const written = await db
  .insert(riskDepthRecovery)
  .values(
    rows.map((r) => ({
      asset: r.asset,
      regime: r.regime,
      reportAt,
      largeShare: report.largeShare,
      trades: r.trades,
      recovered: r.recovered,
      minutesTo50: r.minutesTo50,
      minutesTo90: r.minutesTo90,
      notRecovered24h: r.notRecovered24h,
      dataFrom: new Date(r.dataFrom),
      dataTo: new Date(r.dataTo),
      methodVersion: 'recovery-0.1',
      source: `Step 5b history replay (${report.method}): large trades and the depth after them`,
      method:
        'median minutes to 50% and 90% of the pre-trade ±2% depth; share not back to 90% within 24 h',
      fetchedAt,
      provenance: report.provenance === 'live' ? ('live' as const) : ('prior_dataset' as const),
    })),
  )
  .onConflictDoNothing()
  .returning({ a: riskDepthRecovery.asset });
await client.end();
console.log(
  JSON.stringify({
    reportFile,
    trades: trades.length,
    rows: rows.length,
    written: written.length,
    vsReport: {
      matched,
      of: report.table.length,
      maxMinutes: maxMin,
      maxShare,
      interpolatedVsLowerMedianMinutes: maxConvention,
    },
  }),
);
