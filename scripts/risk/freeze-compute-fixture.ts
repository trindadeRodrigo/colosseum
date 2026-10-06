import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createDb, riskAssetSnapshots, riskPools } from '@colosseum/db';
import { defaultRegimeParams } from '@colosseum/risk';
import { asc, eq, inArray } from 'drizzle-orm';
import { curveRows } from './curve-rows';

// Freezes what `pnpm risk:compute` reads for two Solana stocks, and the rows it writes from them, into
// fixtures/risk/compute/solana-snapshots.json.gz (PLAN-UNIVERSE RU.8). Read-only on the database.
// The committed file was written while curve-rows.ts still held compute's old lines unchanged, so its
// expected rows are what compute wrote before RU.8, and the test that reads it holds a Solana curve to
// that. Running this again writes the expected rows with the code as it is now: the pin then holds
// today's code to itself, so do it only to move the line on purpose, and say so.
//   pnpm exec tsx scripts/risk/freeze-compute-fixture.ts [every-nth-snapshot]
const SYMBOLS = ['SPYx', 'QQQx'];
const nth = Number(process.argv[2] ?? 12);
const OUT = 'fixtures/risk/compute/solana-snapshots.json.gz';
const QUANTILE = 0.5;
const MIN_SAMPLES = 8;
const NOW = '2026-10-06T00:00:00.000Z';

const { db, client } = createDb();
const pools = await db.select().from(riskPools).where(inArray(riskPools.assetSymbol, SYMBOLS));
const poolSymbols = [...new Map(pools.map((p) => [p.assetMint, p.assetSymbol]))];
const snapshots = [];
for (const [mint] of poolSymbols) {
  const rows = await db
    .select()
    .from(riskAssetSnapshots)
    .where(eq(riskAssetSnapshots.assetMint, mint))
    .orderBy(asc(riskAssetSnapshots.fetchedAt));
  for (const [i, r] of rows.entries())
    if (i % nth === 0)
      snapshots.push({
        assetMint: r.assetMint,
        asset: r.asset,
        methodVersion: r.methodVersion,
        fetchedAt: r.fetchedAt.toISOString(),
        sell: r.sell,
        buy: r.buy,
      });
}
await client.end();
const expected = curveRows({
  snapshots: snapshots.map((s) => ({ ...s, fetchedAt: new Date(s.fetchedAt) })),
  poolSymbols: new Map(poolSymbols),
  previous: new Map(),
  now: new Date(NOW),
  quantile: QUANTILE,
  minSamples: MIN_SAMPLES,
  regimeParams: defaultRegimeParams(
    JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
  ),
}).rows;
const file = {
  source: `risk_asset_snapshots and risk_pools of the local database, every ${nth}th snapshot of ${SYMBOLS.join(' and ')} (the Solana collector's routed rows)`,
  fetchedAt: snapshots.at(-1)?.fetchedAt ?? null,
  method: 'scripts/risk/freeze-compute-fixture.ts; expected rows by scripts/risk/curve-rows.ts',
  provenance: 'fixture',
  params: { quantile: QUANTILE, minSamples: MIN_SAMPLES, now: NOW },
  poolSymbols,
  snapshots,
  expected,
};
writeFileSync(OUT, gzipSync(JSON.stringify(file)));
console.log(
  JSON.stringify({ out: OUT, snapshots: snapshots.length, expected: expected.length, nth }),
);
