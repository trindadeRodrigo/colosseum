import 'dotenv/config';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync } from 'node:zlib';
import {
  createDb,
  riskLendingEvents,
  riskLendingPositions,
  riskLendingSnapshots,
  riskPools,
} from '@colosseum/db';
import {
  aggregateLendingPositions,
  collectAddresses,
  type DecodedLendingEvent,
  defaultLendingReconstructParams,
  type JupiterLendPositionRow,
  jupiterLendPositionInput,
  type KaminoObligationRow,
  kaminoPositionInput,
  type LendingConfigChange,
  type LendingEventRow,
  type LendingPositionInput,
  lendingConfigRows,
  lendingEventRows,
  lendingPoolIndex,
} from '@colosseum/risk';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';

// Step 10b item 8 — `pnpm risk:lending-import`. Imports the lending files into risk_lending_snapshots,
// risk_lending_positions and risk_lending_events. Idempotent: every table has a natural key and inserts skip
// existing rows; files already fully imported are skipped without being parsed.
//
//   default    the live collector's files in ~/.colosseum/risk (what the hourly job com.colosseum.risk-lending-import
//              runs at minute 12): 5-minute rows `lending/<day>.jsonl` and hourly positions
//              `lending-positions/<day>/<HH>/*.jsonl.gz`, aggregated (no owner or position is written).
//   --history  also the complete history in data/risk/lending-history (run by hand; launchd jobs cannot read
//              ~/Documents): reconstructed hourly rows (item 7), their LTV tables, and every decoded event and
//              configuration change of the decode pass (items 4–5), scrubbed of wallets and positions.
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const HISTORY = process.argv.includes('--history');
const HIST_DIR = resolve(process.env.RISK_LENDING_HISTORY ?? 'data/risk/lending-history');
const METHOD_VERSION = 'lending-import-0.1';
const P = defaultLendingReconstructParams();
/** Files younger than this are still being written by the collector and wait for the next run. */
const MIN_FILE_AGE_MS = 120_000;

type Row = Record<string, unknown>;
type RegRow = {
  account: string;
  market: string;
  venue: string;
  role: string;
  mint: string;
  symbol: string;
  decimals: number;
  accounts: Record<string, unknown>;
  debtMint?: string | null;
  debtSymbol?: string | null;
};
const t0 = Date.now();
const registry = JSON.parse(readFileSync(join(HOME, 'lending-registry.json'), 'utf8')) as {
  rows: RegRow[];
};
const reg = registry.rows;
const regByMarket = new Map(reg.map((r) => [r.market, r]));
const { db, client } = createDb();
const counts: Record<string, number> = {};
const bump = (k: string, n = 1) => {
  counts[k] = (counts[k] ?? 0) + n;
};
const chunk = <T>(xs: T[], n = 500) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const jsonl = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
const old = (f: string) => Date.now() - statSync(f).mtimeMs >= MIN_FILE_AGE_MS;

// ---------------------------------------------------------------------------------------------------------------
// Snapshots

type SnapshotInsert = typeof riskLendingSnapshots.$inferInsert;
const LIVE_KINDS = ['kamino_reserve', 'jl_vault', 'jl_liquidity', 'kvault'];

/** Mint decimals: registry rows, plus Jupiter Lend debt tokens from the vault rows' raw and whole amounts. */
const decimalsOf = new Map(reg.map((r) => [r.mint, r.decimals]));
function learnDecimals(r: Row) {
  if (r.kind !== 'jl_vault' || decimalsOf.has(r.debtMint as string)) return;
  const raw = Number(r.liquidityBorrowed);
  const ui = Number(r.liquidityBorrowedUi);
  if (raw > 0 && ui > 0) decimalsOf.set(r.debtMint as string, Math.round(Math.log10(raw / ui)));
}

function liveSnapshot(r: Row): SnapshotInsert | null {
  const base = {
    account: r.account as string,
    observedAt: new Date(r.fetchedAt as string),
    kind: r.kind as string,
    chain: (r.chain as string) ?? 'solana',
    venue: r.venue as string,
    market: r.market as string,
    symbol: (r.symbol as string) ?? null,
    role: (r.role as string) ?? null,
    slot: num(r.slot),
    detail: r,
    methodVersion: (r.methodVersion as string) ?? METHOD_VERSION,
    source: r.source as string,
    method: r.method as string,
    fetchedAt: new Date(r.fetchedAt as string),
    provenance: 'live' as const,
  };
  switch (r.kind) {
    case 'kamino_reserve':
      return {
        ...base,
        supplied: num(r.suppliedUi),
        borrowed: num(r.borrowedUi),
        available: num(r.availableUi),
        shareLentOut: num(r.utilization),
        supplyApr: num(r.supplyApr),
        borrowApr: num(r.borrowApr),
        supplyApy: num(r.supplyApy),
        borrowApy: num(r.borrowApy),
        priceUsd: num(r.oraclePriceUsd),
        suppliedUsd: num(r.suppliedUsd),
        borrowedUsd: num(r.borrowedUsd),
      };
    case 'jl_vault': {
      // supplied = collateral deposited (collateral token), borrowed = debt (debt token); the debt token's layer
      // gives the share lent out and the borrow rate. USD only when the debt token is USDC (at par, as item 7).
      const usdc = r.debtSymbol === 'USDC';
      const px = num(r.oraclePrice);
      return {
        ...base,
        supplied: num(r.collateralUi),
        borrowed: num(r.debtUi),
        shareLentOut: num(r.debtLayerUtilization),
        borrowApr: num(r.debtLayerBorrowApr),
        priceUsd: usdc ? px : null,
        suppliedUsd: usdc && px !== null ? Number(r.collateralUi) * px : null,
        borrowedUsd: usdc ? num(r.debtUi) : null,
        usdNullReason: usdc ? null : 'no_price_source',
      };
    }
    case 'jl_liquidity': {
      const d = decimalsOf.get(r.mint as string);
      const ui = (v: unknown) => (d === undefined ? null : Number(v) / 10 ** d);
      return {
        ...base,
        supplied: ui(r.supplied),
        borrowed: ui(r.borrowed),
        available: ui(r.available),
        shareLentOut: num(r.utilization),
        supplyApr: num(r.supplyApr),
        borrowApr: num(r.borrowApr),
        usdNullReason: 'no_price_source',
      };
    }
    case 'kvault':
      // supplied = assets under management, available = idle cash, in the vault's token
      return {
        ...base,
        supplied: num(r.aumUi),
        available: num(r.idleUi),
        usdNullReason: r.symbol === 'USDC' ? null : 'no_price_source',
        suppliedUsd: r.symbol === 'USDC' ? num(r.aumUi) : null,
      };
    default:
      return null;
  }
}

async function insertSnapshots(rows: SnapshotInsert[], key: string) {
  for (const c of chunk(rows)) {
    const res = await db
      .insert(riskLendingSnapshots)
      .values(c)
      .onConflictDoNothing()
      .returning({ a: riskLendingSnapshots.account });
    bump(key, res.length);
  }
}

async function importLiveSnapshots() {
  const dir = join(HOME, 'lending');
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .sort();
  for (const n of files) {
    const day = n.slice(0, 10);
    const from = new Date(`${day}T00:00:00Z`);
    const to = new Date(from.getTime() + 86_400_000);
    const rows = jsonl(readFileSync(join(dir, n), 'utf8')).filter((r) =>
      LIVE_KINDS.includes(r.kind as string),
    );
    const [have] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(riskLendingSnapshots)
      .where(
        and(
          inArray(riskLendingSnapshots.kind, LIVE_KINDS),
          gte(riskLendingSnapshots.observedAt, from),
          lt(riskLendingSnapshots.observedAt, to),
        ),
      );
    bump('snapshotFileRows', rows.length);
    if ((have?.n ?? 0) >= rows.length) {
      bump('snapshotDaysSkipped');
      continue;
    }
    for (const r of rows) learnDecimals(r);
    const out = rows.map(liveSnapshot).filter((x): x is SnapshotInsert => x !== null);
    await insertSnapshots(out, 'snapshots');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Positions

type PositionInsert = typeof riskLendingPositions.$inferInsert;
const LIVE_POSITIONS_METHOD = 'lending_positions_aggregate';
const LIVE_POSITIONS_SOURCE =
  'lending collector hourly positions (Solana RPC getProgramAccounts, decoded on-chain)';

/** The 5-minute Jupiter Lend vault rows by run time, for the oracle price at the positions' read. */
let jlVaultRows: Map<string, Row[]> | null = null;
function jlVaultAt(market: string, at: number): Row | null {
  if (!jlVaultRows) {
    jlVaultRows = new Map();
    const dir = join(HOME, 'lending');
    for (const n of existsSync(dir)
      ? readdirSync(dir).filter((x) => /^\d{4}.*\.jsonl$/.test(x))
      : [])
      for (const r of jsonl(readFileSync(join(dir, n), 'utf8')))
        if (r.kind === 'jl_vault') {
          const l = jlVaultRows.get(r.market as string) ?? [];
          l.push(r);
          jlVaultRows.set(r.market as string, l);
        }
  }
  let best: Row | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const r of jlVaultRows.get(market) ?? []) {
    const g = Math.abs(Date.parse(r.fetchedAt as string) - at);
    if (g < gap) {
      gap = g;
      best = r;
    }
  }
  return gap <= 10 * 60_000 ? best : null;
}

function positionRows(
  market: string,
  venue: string,
  hour: Date,
  fetchedAt: Date,
  inputs: LendingPositionInput[],
  usdNullReason: string | null,
): PositionInsert[] {
  return aggregateLendingPositions(inputs, P.ltvBucketsPct).map((a) => ({
    market,
    collateralAsset: a.collateralAsset,
    observedAt: hour,
    chain: 'solana',
    venue,
    positions: a.positions,
    positionsWithDebt: a.positionsWithDebt,
    positionsStateUnknown: a.positionsStateUnknown,
    collateralUnits: a.collateralUnits,
    collateralUsd: a.collateralUsd,
    debtUsd: a.debtUsd,
    debtByAsset: a.debtByAsset,
    ltvBucketsPct: P.ltvBucketsPct,
    buckets: a.buckets,
    ltvNull: a.ltvNull,
    ltvNullUnits: a.ltvNullUnits,
    top1: a.top1,
    top3: a.top3,
    top10: a.top10,
    usdNullReason: a.collateralUsd === null ? usdNullReason : null,
    methodVersion: METHOD_VERSION,
    source: LIVE_POSITIONS_SOURCE,
    method: LIVE_POSITIONS_METHOD,
    fetchedAt,
    provenance: 'live' as const,
  }));
}

async function importLivePositions() {
  const base = join(HOME, 'lending-positions');
  if (!existsSync(base)) return;
  const done = new Set(
    (
      await db
        .selectDistinct({ m: riskLendingPositions.market, t: riskLendingPositions.observedAt })
        .from(riskLendingPositions)
        .where(eq(riskLendingPositions.method, LIVE_POSITIONS_METHOD))
    ).map((r) => `${r.m}|${r.t.toISOString()}`),
  );
  for (const day of readdirSync(base)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort())
    for (const hh of readdirSync(join(base, day))
      .filter((h) => /^\d{2}$/.test(h))
      .sort()) {
      const hour = new Date(`${day}T${hh}:00:00Z`);
      for (const f of readdirSync(join(base, day, hh)).filter(
        (n) => n.endsWith('.jsonl.gz') && !n.includes('.raw.'),
      )) {
        const path = join(base, day, hh, f);
        const m = /^(kamino|jupiter_lend)-(.+)\.jsonl\.gz$/.exec(f);
        if (!m) continue;
        const venue = m[1] as string;
        const market = venue === 'kamino' ? (m[2] as string) : `jupiter_lend:${m[2]}`;
        if (done.has(`${market}|${hour.toISOString()}`)) {
          bump('positionFilesSkipped');
          continue;
        }
        if (!old(path)) {
          bump('positionFilesTooNew');
          continue;
        }
        const rows = jsonl(gunzipSync(readFileSync(path)).toString('utf8'));
        bump('positionsRead', rows.length);
        const fetchedAt = new Date(
          (rows[0]?.fetchedAt as string | undefined) ?? hour.toISOString(),
        );
        let inputs: LendingPositionInput[];
        let reason: string | null = null;
        if (venue === 'kamino') {
          inputs = rows
            .map((r) => kaminoPositionInput(r as unknown as KaminoObligationRow))
            .filter((x): x is LendingPositionInput => x !== null);
        } else {
          const v = regByMarket.get(market);
          const live = jlVaultAt(market, fetchedAt.getTime());
          if (!v) {
            bump('positionFilesUnknownMarket');
            continue;
          }
          const debtSymbol = (live?.debtSymbol as string) ?? v.debtSymbol ?? 'debt';
          const usdc = debtSymbol === 'USDC';
          reason = !live ? 'no_oracle_row' : usdc ? null : 'no_price_source';
          inputs = rows
            .map((r) =>
              jupiterLendPositionInput(r as unknown as JupiterLendPositionRow, {
                symbol: v.symbol,
                debtSymbol,
                oraclePrice: num(live?.oraclePrice),
                debtPriceUsd: usdc ? 1 : null,
              }),
            )
            .filter((x): x is LendingPositionInput => x !== null);
        }
        const out = positionRows(market, venue, hour, fetchedAt, inputs, reason);
        if (!out.length) continue;
        const res = await db
          .insert(riskLendingPositions)
          .values(out)
          .onConflictDoNothing()
          .returning({ m: riskLendingPositions.market });
        bump('positions', res.length);
      }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// History (--history): reconstructed hourly rows, their LTV tables, decoded events and configuration changes

const gzLines = (f: string) => jsonl(gunzipSync(readFileSync(f)).toString('utf8'));

async function importHistorySnapshotsAndPositions() {
  const hourly = join(HIST_DIR, 'hourly');
  const reserves = gzLines(join(hourly, 'reserves.jsonl.gz'));
  await insertSnapshots(
    reserves.map((r) => ({
      account: r.reserve as string,
      observedAt: new Date(r.hour as string),
      kind: 'kamino_reserve_hourly',
      chain: r.chain as string,
      venue: r.venue as string,
      market: r.market as string,
      symbol: r.symbol as string,
      role: r.role as string,
      slot: num(r.slot),
      supplied: num(r.supplied),
      borrowed: num(r.borrowed),
      available: num(r.available),
      shareLentOut: num(r.shareLentOut),
      supplyApr: num(r.supplyApr),
      borrowApr: num(r.borrowApr),
      supplyApy: num(r.supplyApy),
      borrowApy: num(r.borrowApy),
      priceUsd: num(r.priceUsd),
      suppliedUsd: num(r.suppliedUsd),
      borrowedUsd: num(r.borrowedUsd),
      usdNullReason: (r.usdNullReason as string) ?? null,
      detail: r,
      methodVersion: r.method as string,
      source: r.source as string,
      method: r.method as string,
      fetchedAt: new Date(r.fetched_at as string),
      provenance: r.provenance as 'live',
    })),
    'historySnapshots',
  );
  bump('historyReserveRows', reserves.length);
  const marketOfVault = new Map(
    reg.filter((r) => r.role === 'vault').map((r) => [r.account, r.market]),
  );
  const vaults = gzLines(join(hourly, 'jl-vaults.jsonl.gz'));
  await insertSnapshots(
    vaults.map((r) => ({
      account: r.vault as string,
      observedAt: new Date(r.hour as string),
      kind: 'jl_vault_hourly',
      chain: r.chain as string,
      venue: r.venue as string,
      market: marketOfVault.get(r.vault as string) ?? (r.vault as string),
      symbol: r.symbol as string,
      role: 'vault',
      supplied: num(r.collateral),
      borrowed: num(r.debt),
      borrowApr: num(r.debtBorrowAprImplied),
      priceUsd: num(r.priceUsd),
      suppliedUsd: num(r.collateralUsd),
      borrowedUsd: num(r.debtUsd),
      usdNullReason: (r.usdNullReason as string) ?? null,
      detail: r,
      methodVersion: r.method as string,
      source: r.source as string,
      method: r.method as string,
      fetchedAt: new Date(r.fetched_at as string),
      provenance: r.provenance as 'live',
    })),
    'historySnapshots',
  );
  bump('historyVaultRows', vaults.length);

  // LTV tables of item 7 (dominant asset by USD, as the live rows): no per-asset debt count or top-N shares there
  const pos: PositionInsert[] = [];
  const add = (r: Row, market: string, unknown: number) => {
    const t = r.ltvByCollateralAsset as Record<
      string,
      {
        positions: number;
        collateralUnits: number;
        ltvNull: number;
        ltvNullUnits: number;
        usdNull?: number;
        buckets: Row;
      }
    >;
    for (const [asset, a] of Object.entries(t ?? {})) {
      // the USD totals are whole only when every position has an LTV and a USD value
      const usdOk = !r.usdNullReason && a.ltvNull === 0 && (a.usdNull ?? 0) === 0;
      const sum = (k: string) =>
        Object.values(a.buckets).reduce<number>((s, b) => s + Number((b as Row)[k] ?? 0), 0);
      pos.push({
        market,
        collateralAsset: asset,
        observedAt: new Date(r.hour as string),
        chain: r.chain as string,
        venue: r.venue as string,
        positions: a.positions,
        positionsWithDebt: null,
        positionsStateUnknown: unknown,
        collateralUnits: a.collateralUnits,
        collateralUsd: usdOk ? sum('collateralUsd') : null,
        debtUsd: usdOk ? sum('debtUsd') : null,
        debtByAsset: null,
        ltvBucketsPct: r.ltvBucketsPct,
        buckets: a.buckets,
        ltvNull: a.ltvNull,
        ltvNullUnits: a.ltvNullUnits,
        top1: null,
        top3: null,
        top10: null,
        usdNullReason: usdOk
          ? null
          : ((r.usdNullReason as string) ??
            (a.ltvNull > 0 ? 'ltv_null_positions' : 'usd_null_positions')),
        methodVersion: r.method as string,
        source: r.source as string,
        method: r.method as string,
        fetchedAt: new Date(r.fetched_at as string),
        provenance: r.provenance as 'live',
      });
    }
  };
  for (const r of gzLines(join(hourly, 'markets.jsonl.gz'))) add(r, r.market as string, 0);
  for (const r of vaults)
    add(
      r,
      marketOfVault.get(r.vault as string) ?? (r.vault as string),
      Number(r.positionsStateUnknown ?? 0),
    );
  for (const c of chunk(pos)) {
    const res = await db
      .insert(riskLendingPositions)
      .values(c)
      .onConflictDoNothing()
      .returning({ m: riskLendingPositions.market });
    bump('historyPositions', res.length);
  }
  bump('historyPositionRows', pos.length);
}

type EventInsert = typeof riskLendingEvents.$inferInsert;
const EVENTS_SOURCE =
  'lending history raw bodies (Solana RPC getTransaction); decoders packages/risk/src/lending/tx.ts';

async function insertEvents(rows: LendingEventRow[], method: string, fetchedAt: Date) {
  const values: EventInsert[] = rows.map((r) => ({
    ...r,
    chain: 'solana',
    methodVersion: METHOD_VERSION,
    source: EVENTS_SOURCE,
    method,
    fetchedAt,
    provenance: 'live' as const,
  }));
  for (const c of chunk(values, 1000)) {
    const res = await db
      .insert(riskLendingEvents)
      .values(c)
      .onConflictDoNothing()
      .returning({ s: riskLendingEvents.signature });
    bump('events', res.length);
  }
}

async function importHistoryEvents() {
  // public addresses: everything in the lending registry except the curated vaults' managers, and the DEX pools
  const pools = await db
    .select({ a: riskPools.address, m: riskPools.assetMint, q: riskPools.quoteMint })
    .from(riskPools);
  const allowed = collectAddresses([reg, pools], new Set(['manager']));
  const { poolOf, marketOf } = lendingPoolIndex(reg);
  const ctx = { poolOf, marketOf, allowed };
  const dec = join(HIST_DIR, 'decoded');
  const summary = JSON.parse(readFileSync(join(dec, 'summary.json'), 'utf8')) as {
    method: string;
    decodedAt: string;
  };
  const fetchedAt = new Date(summary.decodedAt);
  const days = readdirSync(dec)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n))
    .sort();
  for (const n of days) {
    let buf: LendingEventRow[] = [];
    const rl = createInterface({ input: createReadStream(join(dec, n)).pipe(createGunzip()) });
    for await (const line of rl) {
      if (!line) continue;
      const tx = JSON.parse(line) as {
        s: string;
        sl: number;
        t: number;
        ev?: DecodedLendingEvent[];
      };
      bump('historyTxs');
      const r = lendingEventRows(tx, ctx);
      bump('eventsSkippedKind', r.skippedKind);
      bump('eventsSkippedUnregistered', r.skippedUnregistered);
      bump('addressesRemoved', r.removed);
      bump('eventRows', r.rows.length);
      buf.push(...r.rows);
      if (buf.length >= 20_000) {
        await insertEvents(buf, summary.method, fetchedAt);
        buf = [];
      }
    }
    await insertEvents(buf, summary.method, fetchedAt);
    bump('historyDays');
  }
  // configuration changes (value changes only, with old and new)
  let buf: LendingConfigChange[] = [];
  const flush = async () => {
    const rows = lendingConfigRows(buf, ctx);
    bump('configRows', rows.length);
    bump('configRowsOutsideRegistry', rows.filter((r) => r.pool === null).length);
    await insertEvents(rows, summary.method, fetchedAt);
    buf = [];
  };
  // rows of one transaction stay in one batch, so the repeat counter in the event key is stable
  let lastSig = '';
  const rl = createInterface({ input: createReadStream(join(dec, 'config-changes.jsonl')) });
  for await (const line of rl) {
    if (!line) continue;
    const c = JSON.parse(line) as LendingConfigChange & { changed?: boolean };
    if (c.changed === false) continue;
    if (buf.length >= 20_000 && c.s !== lastSig) await flush();
    buf.push(c);
    lastSig = c.s;
  }
  await flush();
}

// ---------------------------------------------------------------------------------------------------------------

await importLiveSnapshots();
await importLivePositions();
if (HISTORY) {
  await importHistorySnapshotsAndPositions();
  await importHistoryEvents();
}
await client.end();
const summary = {
  kind: 'lending-import',
  at: new Date().toISOString(),
  history: HISTORY,
  seconds: Math.round((Date.now() - t0) / 100) / 10,
  inserted: counts,
  methodVersion: METHOD_VERSION,
};
appendFileSync(join(HOME, 'lending-import-runs.jsonl'), `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify(summary));
