import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskLendingCoverage, riskLendingFacts } from '@colosseum/db';
import { LENDING_HISTORY_DIR } from '../lib-lending';
import {
  type LendingReportFile,
  lendingCoverageRows,
  lendingFactsRows,
} from './lib-lending-import';

// PLAN-ANALYTICS item 11 — imports the latest lending report's sheets and coverage into the tables the API reads
// (`pnpm risk:facts-import [report.json]`). Idempotent: rows are keyed by report time. Run after
// `pnpm risk:lending-report`; scheduling it hourly is a launchd job a person installs.
const dir = join(LENDING_HISTORY_DIR, 'report');
const file =
  process.argv[2] ??
  join(
    dir,
    readdirSync(dir)
      .filter((f) => /^lending-report-.*\.json$/.test(f))
      .sort()
      .at(-1) ?? '',
  );
const report = JSON.parse(readFileSync(file, 'utf8')) as LendingReportFile;
const facts = lendingFactsRows(report);
const coverage = lendingCoverageRows(report);
const { db, client } = createDb();
const f = facts.rows.length
  ? await db
      .insert(riskLendingFacts)
      .values(facts.rows)
      .onConflictDoNothing()
      .returning({ a: riskLendingFacts.account })
  : [];
const c = coverage.length
  ? await db
      .insert(riskLendingCoverage)
      .values(coverage)
      .onConflictDoNothing()
      .returning({ a: riskLendingCoverage.asset })
  : [];
await client.end();
console.log(
  JSON.stringify({
    file,
    reportAt: report.fetched_at,
    sheets: f.length,
    coverageRows: c.length,
    rejected: facts.rejected,
  }),
);
if (facts.rejected.length) process.exit(1);
