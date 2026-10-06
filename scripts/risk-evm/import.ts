import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskAssetSnapshots } from '@colosseum/db';
import { parseRow, toDbRow } from './curve';
import { type OracleRow, parseOracleRow } from './oracle';
import { insertOracleRows } from './oracle-import';

// Loads the collector's JSONL (data/risk-evm/assets) into risk_asset_snapshots. Idempotent: the table's
// key is (asset_mint, fetched_at) and an existing row is left as it is. Lines that are not a whole row
// are counted and skipped.
// It also loads the oracle rows of a list run (data/risk-evm/oracle, PLAN-UNIVERSE RU.7) into
// risk_price_observations, the same way: a row that is there is left as it is.
//   pnpm risk-evm:import
const root = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const dir = join(root, 'assets');
const oracleDir = join(root, 'oracle');
const oracleFiles = existsSync(oracleDir)
  ? readdirSync(oracleDir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
  : [];
const oracle = {
  files: oracleFiles.length,
  read: 0,
  inserted: 0,
  alreadyThere: 0,
  noPrice: 0,
  skippedBadLine: 0,
};
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
  : [];
const { db, client } = createDb();
const counts = { files: files.length, read: 0, inserted: 0, alreadyThere: 0, skippedBadLine: 0 };
try {
  for (const name of files) {
    const rows = [];
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // a line cut short by a crash mid-append
      }
      const row = parseRow(parsed);
      if (row) rows.push(toDbRow(row));
      else counts.skippedBadLine++;
    }
    counts.read += rows.length;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await db
        .insert(riskAssetSnapshots)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing()
        .returning({ a: riskAssetSnapshots.assetMint });
      counts.inserted += res.length;
    }
  }
  counts.alreadyThere = counts.read - counts.inserted;
  console.log(JSON.stringify({ dir, ...counts }));
  for (const name of oracleFiles) {
    const rows: OracleRow[] = [];
    for (const line of readFileSync(join(oracleDir, name), 'utf8').split('\n').filter(Boolean)) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // a line cut short by a crash mid-append
      }
      const row = parseOracleRow(parsed);
      if (row) rows.push(row);
      else oracle.skippedBadLine++;
    }
    const res = await insertOracleRows(db, rows);
    oracle.read += rows.length;
    oracle.inserted += res.inserted;
    oracle.noPrice += res.noPrice;
  }
  oracle.alreadyThere = oracle.read - oracle.noPrice - oracle.inserted;
  console.log(JSON.stringify({ dir: oracleDir, ...oracle }));
} catch (e) {
  // drizzle's error repeats the whole query; the cause underneath says what went wrong
  type Nested = { code?: string; message?: string; cause?: Nested; errors?: Nested[] };
  let root = e as Nested;
  while (root.cause ?? root.errors?.[0]) root = (root.cause ?? root.errors?.[0]) as Nested;
  console.error(
    root.code === 'ECONNREFUSED'
      ? 'no database at DATABASE_URL: start it with pnpm db:up, then run this again'
      : `import failed: ${String(root.message ?? root).slice(0, 300)}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
