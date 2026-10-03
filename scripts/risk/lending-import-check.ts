import 'dotenv/config';
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync } from 'node:zlib';
import { createDb } from '@colosseum/db';
import { collectAddresses, LENDING_EVENT_KINDS_NOT_STORED } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { LENDING_HISTORY_DIR, RISK_HOME } from './lib-lending';

// Step 10b item 8 — `pnpm risk:lending-import-check`: are the lending tables complete, and do they name no wallet or
// position? Read-only (files and Postgres; no RPC). Writes data/risk/lending-history/import-check-<stamp>.json.
//   counts    every table against its source files: live 5-minute rows; reconstructed hourly rows; positions summed
//             over the aggregates = open positions in the collector's files and in the reconstruction; event rows and
//             skipped events = the decode pass's event count; configuration rows = its change rows.
//   addresses every address-shaped string in the three tables is collected in Postgres and compared with the private
//             list: obligation owners and obligations and Jupiter Lend positions and position mints in every collector
//             hour, the liquidators and positions of every liquidation, and every signer, obligation, position and
//             event user or recipient in the decoded history (registry addresses excluded).
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const { db, client } = createDb();
const q = async <T>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const jsonl = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const LIVE = ['kamino_reserve', 'jl_vault', 'jl_liquidity', 'kvault'];

// --- snapshots
const liveFiles = readdirSync(join(RISK_HOME, 'lending')).filter((n) =>
  /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n),
);
// rows the collector wrote after the last import wait for the next one
const lastImport = jsonl(readFileSync(join(RISK_HOME, 'lending-import-runs.jsonl'), 'utf8'))
  .map((r) => Date.parse(r.at as string))
  .reduce((a, b) => Math.max(a, b), 0);
let liveRows = 0;
for (const n of liveFiles)
  liveRows += jsonl(readFileSync(join(RISK_HOME, 'lending', n), 'utf8')).filter(
    (r) => LIVE.includes(r.kind as string) && Date.parse(r.fetchedAt as string) <= lastImport,
  ).length;
const hourly = join(LENDING_HISTORY_DIR, 'hourly');
const gz = (f: string) => jsonl(gunzipSync(readFileSync(f)).toString('utf8'));
const reserves = gz(join(hourly, 'reserves.jsonl.gz'));
const vaults = gz(join(hourly, 'jl-vaults.jsonl.gz'));
const markets = gz(join(hourly, 'markets.jsonl.gz'));
const snapDb = await q<{ kind: string; n: number }>(
  sql`select kind, count(*)::int as n from risk_lending_snapshots group by kind order by kind`,
);
const snapN = (kinds: string[]) =>
  snapDb.filter((r) => kinds.includes(r.kind)).reduce((s, r) => s + r.n, 0);

// --- positions: open positions in the files vs summed over the table, and the private list
const priv = new Set<string>();
const base = join(RISK_HOME, 'lending-positions');
const liveLatestHour = new Date(Date.now() - 120_000);
let filePositions = 0;
for (const d of readdirSync(base).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))
  for (const h of readdirSync(join(base, d)).filter((x) => /^\d{2}$/.test(x)))
    for (const f of readdirSync(join(base, d, h)).filter(
      (x) => x.endsWith('.jsonl.gz') && !x.includes('.raw.'),
    )) {
      const rows = gz(join(base, d, h, f));
      for (const r of rows)
        for (const k of ['owner', 'obligation', 'position', 'positionMint'])
          if (typeof r[k] === 'string') priv.add(r[k] as string);
      if (new Date(`${d}T${h}:00:00Z`) > liveLatestHour) continue;
      filePositions += rows.filter((r) =>
        f.startsWith('kamino-')
          ? (r.deposits as Array<{ amount: number }>).some((x) => x.amount > 0) ||
            (r.borrows as Array<{ amount: number }>).some((x) => x.amount > 0)
          : Number(r.collateral) > 0 || Number(r.debt) > 0,
      ).length;
    }
const histPositions = [...markets, ...vaults].reduce(
  (s, r) =>
    s +
    Object.values((r.ltvByCollateralAsset ?? {}) as Record<string, { positions: number }>).reduce(
      (t, a) => t + a.positions,
      0,
    ),
  0,
);
const posDb = await q<{ method: string; rows: number; positions: number }>(
  sql`select method, count(*)::int as rows, sum(positions)::int as positions from risk_lending_positions group by method`,
);
const liqFile = join(LENDING_HISTORY_DIR, 'decoded', 'liquidations.jsonl');
let liquidations = 0;
for (const r of jsonl(readFileSync(liqFile, 'utf8'))) {
  liquidations++;
  if (typeof r.liquidator === 'string') priv.add(r.liquidator);
  if (r.venue === 'kamino' && typeof r.position === 'string') priv.add(r.position);
}

// every signer, obligation, liquidator, position and event user of the decoded history, less registry addresses
// (Jupiter Lend logs the vault itself as the liquidity layer's `user`)
const registry = JSON.parse(
  readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8'),
) as unknown;
const publicAddrs = collectAddresses(registry, new Set(['manager']));
const PRIV_ACCOUNT_KEYS = new Set(['signer', 'obligation', 'liquidator', 'position', 'owner']);
const PRIV_EVENT_KEYS = new Set(['user', 'signer', 'to']);
const decDir = join(LENDING_HISTORY_DIR, 'decoded');
let privFromHistory = 0;
for (const n of readdirSync(decDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(x))) {
  const rl = createInterface({ input: createReadStream(join(decDir, n)).pipe(createGunzip()) });
  for await (const line of rl) {
    if (!line.includes('"ev"')) continue;
    const tx = JSON.parse(line) as {
      ev?: Array<{
        accounts: Record<string, string>;
        events?: Array<{ fields: Record<string, unknown> }>;
      }>;
    };
    for (const e of tx.ev ?? []) {
      const add = (a: unknown) => {
        if (typeof a === 'string' && !publicAddrs.has(a) && !priv.has(a)) {
          priv.add(a);
          privFromHistory++;
        }
      };
      for (const [k, v] of Object.entries(e.accounts)) if (PRIV_ACCOUNT_KEYS.has(k)) add(v);
      for (const ev of e.events ?? [])
        for (const [k, v] of Object.entries(ev.fields)) if (PRIV_EVENT_KEYS.has(k)) add(v);
    }
  }
}

// --- events
const summary = JSON.parse(
  readFileSync(join(LENDING_HISTORY_DIR, 'decoded', 'summary.json'), 'utf8'),
) as {
  events: Record<string, number>;
};
const decodedEvents = Object.values(summary.events).reduce((s, n) => s + n, 0);
const notStored = Object.entries(summary.events)
  .filter(([k]) => LENDING_EVENT_KINDS_NOT_STORED.has(k))
  .reduce((s, [, n]) => s + n, 0);
// lines marked `changed: false` repeat the previous value and are not rows
const configLines = jsonl(
  readFileSync(join(LENDING_HISTORY_DIR, 'decoded', 'config-changes.jsonl'), 'utf8'),
).filter((r) => r.changed !== false).length;
const evDb = await q<{ kind: string; n: number }>(
  sql`select kind, count(*)::int as n from risk_lending_events group by kind order by n desc`,
);
const evN = (k: string) => evDb.find((r) => r.kind === k)?.n ?? 0;
const runs = jsonl(readFileSync(join(RISK_HOME, 'lending-import-runs.jsonl'), 'utf8'));
const lastHistory = runs.filter((r) => r.history).at(-1) as
  | { inserted: Record<string, number>; at: string }
  | undefined;
const unregistered = lastHistory?.inserted.eventsSkippedUnregistered ?? null;
const eventsByKind = Object.fromEntries(
  Object.entries(summary.events)
    .filter(([k]) => !LENDING_EVENT_KINDS_NOT_STORED.has(k))
    .map(([k, n]) => [k, { decoded: n, stored: evN(k) }]),
);

// --- addresses in the tables
const ADDR = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const found = new Map<string, Set<string>>();
for (const [table, cols] of [
  [
    'risk_lending_events',
    [
      'detail::text',
      'flows::text',
      "coalesce(pool, '')",
      "coalesce(market, '')",
      "coalesce(caller, '')",
      'event_key',
    ],
  ],
  [
    'risk_lending_positions',
    ['market', 'collateral_asset', 'buckets::text', "coalesce(debt_by_asset::text, '')"],
  ],
  ['risk_lending_snapshots', ['account', 'market', 'detail::text']],
] as const) {
  const expr = cols.join(` || ' ' || `);
  const rows = await q<{ a: string }>(
    sql.raw(`select distinct (regexp_matches(${expr}, '${ADDR}', 'g'))[1] as a from ${table}`),
  );
  found.set(table, new Set(rows.map((r) => r.a).filter((a) => !/^\d+$/.test(a))));
}
const leaks = Object.fromEntries(
  [...found].map(([t, s]) => [t, [...s].filter((a) => priv.has(a))]),
);
await client.end();

const out = {
  checkedAt: new Date().toISOString(),
  method: 'lending-import-check-0.1',
  source:
    'Postgres risk_lending_* tables against ~/.colosseum/risk and data/risk/lending-history files',
  snapshots: {
    live: {
      filesUpToLastImport: liveRows,
      lastImport: new Date(lastImport).toISOString(),
      table: snapN(LIVE),
      ok: liveRows === snapN(LIVE),
    },
    kaminoReserveHourly: {
      files: reserves.length,
      table: snapN(['kamino_reserve_hourly']),
      ok: reserves.length === snapN(['kamino_reserve_hourly']),
    },
    jlVaultHourly: {
      files: vaults.length,
      table: snapN(['jl_vault_hourly']),
      ok: vaults.length === snapN(['jl_vault_hourly']),
    },
  },
  positions: {
    live: {
      openPositionsInFiles: filePositions,
      table: posDb.find((r) => r.method === 'lending_positions_aggregate') ?? null,
    },
    history: {
      positionsInReconstruction: histPositions,
      table: posDb.find((r) => String(r.method).startsWith('lending-reconstruct-')) ?? null,
    },
  },
  events: {
    decodedEvents,
    notStoredKinds: notStored,
    unregistered,
    storedExpected: unregistered === null ? null : decodedEvents - notStored - unregistered,
    storedInstructionRows: evDb
      .filter((r) => r.kind !== 'config_change')
      .reduce((s, r) => s + r.n, 0),
    configChanges: configLines,
    configChangeRows: evN('config_change'),
    byKind: eventsByKind,
    liquidations: { file: liquidations, table: evN('liquidation') },
  },
  addresses: {
    privateList: priv.size,
    privateFromHistory: privFromHistory,
    distinctInTables: Object.fromEntries([...found].map(([t, s]) => [t, s.size])),
    privateFoundInTables: leaks,
    ok: Object.values(leaks).every((l) => l.length === 0),
  },
};
const file = join(LENDING_HISTORY_DIR, `import-check-${stamp}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
console.log(file);
if (!existsSync(file)) process.exit(1);
