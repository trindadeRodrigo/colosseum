import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createDb } from '@colosseum/db';
import { sql } from 'drizzle-orm';
import { HISTORY_DIR } from './lib-history';
import { RISK_HOME } from './lib-lending';

// Step 10b item 9 — freeze the report's inputs for tests (`pnpm risk:lending-freeze-report-fixtures`), from mainnet
// data already on disk and in the tables: the latest complete collector hour of the Sentora xStocks Market (its
// obligations, the run's reserve rows, the registry rows with their parameters) and Jupiter Lend vault 81 (positions,
// vault row, registry row), the routed sell curves of the assets they hold, and Step 5b's hourly ±2% sell depth of one
// asset. Output: fixtures/risk/lending/report.json.
const MARKET = '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr';
const JL_VAULT = 81;
const DEPTH_ASSET = 'TSLAx';
const readJsonl = <T>(f: string): T[] =>
  (f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString() : readFileSync(f, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

const posRoot = join(RISK_HOME, 'lending-positions');
const hour = readdirSync(posRoot)
  .sort()
  .flatMap((d) =>
    readdirSync(join(posRoot, d))
      .filter((h) => existsSync(join(posRoot, d, h, '.done')))
      .map((h) => `${d}/${h}`),
  )
  .at(-1) as string;
const obligations = readJsonl<{ fetchedAt: string }>(
  join(posRoot, hour, `kamino-${MARKET}.jsonl.gz`),
);
const positions = readJsonl<Record<string, unknown>>(
  join(posRoot, hour, `jupiter_lend-${JL_VAULT}.jsonl.gz`),
);
const fetchedAt = obligations[0]?.fetchedAt;
const live = readJsonl<Record<string, unknown>>(
  join(RISK_HOME, 'lending', `${hour.slice(0, 10)}.jsonl`),
).filter((r) => r.fetchedAt === fetchedAt);
const registry = (
  JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
    rows: Array<Record<string, unknown>>;
  }
).rows;
const reserves = registry.filter((r) => r.market === MARKET);
const vaultReg = registry.find((r) => r.market === `jupiter_lend:${JL_VAULT}`);
const vaultRow = live.find((r) => r.kind === 'jl_vault' && Number(r.vaultId) === JL_VAULT);
const mints = [
  ...new Set([...reserves, vaultReg].map((r) => r?.dexAssetMint).filter(Boolean) as string[]),
];

const { db, client } = createDb();
const q =
  (await db.execute(sql`select distinct on (asset_mint, regime) asset_mint, asset_symbol, regime, points,
  insufficient_from, quantile, min_samples, samples, data_from, data_to from risk_depth_curves
  where side = 'sell' and method_version = 'risk-0.3' and asset_mint in ${sql.raw(`(${mints.map((m) => `'${m}'`).join(',')})`)}
  order by asset_mint, regime, computed_at desc`)) as unknown as { rows?: unknown[] } & unknown[];
const curves = q.rows ?? q;
await client.end();

const depth = readdirSync(join(HISTORY_DIR, 'hourly'))
  .filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) =>
    readJsonl<{ asset: string; hour: string; regime: string; depth2pctSellUsd: number | null }>(
      join(HISTORY_DIR, 'hourly', f),
    ),
  )
  .filter((r) => r.asset === DEPTH_ASSET && r.depth2pctSellUsd !== null)
  .map((r) => ({ hour: r.hour, regime: r.regime, depthUsd: r.depth2pctSellUsd }));

const out = {
  frozenAt: new Date().toISOString(),
  source:
    'lending collector files (~/.colosseum/risk lending-positions, lending, lending-registry.json), risk_depth_curves (risk-0.3), data/risk/history-full/hourly (Step 5b)',
  hour,
  kamino: {
    market: MARKET,
    obligations,
    reserveRows: live.filter((r) => r.kind === 'kamino_reserve' && r.market === MARKET),
    registry: reserves,
  },
  jl: { vaultId: JL_VAULT, vaultRow, registry: vaultReg, positions },
  curves,
  depth: { asset: DEPTH_ASSET, rows: depth },
};
mkdirSync('fixtures/risk/lending', { recursive: true });
writeFileSync('fixtures/risk/lending/report.json', `${JSON.stringify(out)}\n`);
console.log(
  `fixtures/risk/lending/report.json: hour ${hour}, ${obligations.length} obligations, ${positions.length} positions, ${(curves as unknown[]).length} curves, ${depth.length} depth hours`,
);
