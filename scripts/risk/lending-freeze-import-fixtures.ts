import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { RISK_HOME } from './lib-lending';

// Step 10b item 8 — freeze real mainnet data for tests/risk-layer/lending-import.test.ts, from what the lending
// collector wrote (no RPC):
//  registry   the lending registry rows (protocol accounts; curated-vault managers dropped) and the DEX registry's
//             pool addresses and mints: the public address list of the import
//  positions  one complete collector hour: every obligation of the smallest Kamino market with debt and at least 10 obligations, and every
//             position of the smallest Jupiter Lend vault, with the vault's 5-minute row of the same run
// Usage: tsx scripts/risk/lending-freeze-import-fixtures.ts
const OUT = 'fixtures/risk/lending/import.json';
const readJsonl = (f: string) =>
  gunzipSync(readFileSync(f))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const reg = (
  JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
    rows: Array<Record<string, unknown>>;
  }
).rows.map(({ manager: _m, params: _p, ...r }) => r);
const dex = (
  JSON.parse(readFileSync(join(RISK_HOME, 'registry.json'), 'utf8')) as {
    pools: Array<{ address: string; assetMint: string; quoteMint: string }>;
  }
).pools.map((p) => ({ address: p.address, assetMint: p.assetMint, quoteMint: p.quoteMint }));

// latest hour that is complete (every registered market and vault has a file)
const base = join(RISK_HOME, 'lending-positions');
const hours = readdirSync(base)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  .flatMap((d) => readdirSync(join(base, d)).map((h) => join(d, h)))
  .sort();
const hour = hours.at(-2) as string;
const files = readdirSync(join(base, hour)).filter(
  (f) => f.endsWith('.jsonl.gz') && !f.includes('.raw.'),
);
const sized = files
  .map((f) => ({ f, rows: readJsonl(join(base, hour, f)) }))
  .sort((a, b) => a.rows.length - b.rows.length);
const kamino = sized.find(
  (x) =>
    x.f.startsWith('kamino-') &&
    x.rows.length >= 10 &&
    x.rows.some((r) => (r.borrows as unknown[]).length > 0),
);
const jl = sized.find(
  (x) => x.f.startsWith('jupiter_lend-') && x.rows.some((r) => Number(r.debt) > 0),
);
if (!kamino || !jl) throw new Error('no market with debt in that hour');
const vaultId = /jupiter_lend-(\d+)/.exec(jl.f)?.[1] as string;
const fetchedAt = jl.rows[0]?.fetchedAt as string;
const day = fetchedAt.slice(0, 10);
const liveFile = join(RISK_HOME, 'lending', `${day}.jsonl`);
if (!existsSync(liveFile)) throw new Error(`missing ${liveFile}`);
const vaultRow = readFileSync(liveFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>)
  .find(
    (r) =>
      r.kind === 'jl_vault' && r.market === `jupiter_lend:${vaultId}` && r.fetchedAt === fetchedAt,
  );
if (!vaultRow) throw new Error('no jl_vault row in the positions run');

writeFileSync(
  OUT,
  JSON.stringify(
    {
      frozenAt: new Date().toISOString(),
      source:
        'lending collector files (~/.colosseum/risk): lending-registry.json, registry.json, lending-positions, lending',
      hour,
      registry: reg,
      dex,
      kamino: { file: kamino.f, rows: kamino.rows },
      jl: { file: jl.f, market: `jupiter_lend:${vaultId}`, vaultRow, rows: jl.rows },
    },
    null,
    0,
  ),
);
console.log(
  JSON.stringify({
    out: OUT,
    hour,
    kamino: [kamino.f, kamino.rows.length],
    jl: [jl.f, jl.rows.length],
  }),
);
