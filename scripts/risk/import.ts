import 'dotenv/config';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  riskAssetSnapshots,
  riskEvents,
  riskLpConcentration,
  riskPoolSnapshots,
  riskPools,
  riskQuotes,
} from '@colosseum/db';
import { max } from 'drizzle-orm';
import { dayFilesFrom, jsonlChunks } from './lib-import';

// Imports the collectors' files (~/.colosseum/risk) into the risk tables. Idempotent: every table has a
// natural primary key and inserts skip existing rows. Snapshots for pools not in risk_pools are skipped.
// Each table reads only the day files from its newest imported day on, streamed in chunks of 500 (PLAN-ANALYTICS
// item 2: re-reading all history grew the heap by about 0.24 GB per collected day). RISK_IMPORT_ALL=1 re-reads all.
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const { db, client } = createDb();
const known = new Set((await db.select({ a: riskPools.address }).from(riskPools)).map((r) => r.a));
const ALL = process.env.RISK_IMPORT_ALL === '1';
type Row = Record<string, unknown>;
/** Every chunk of the day files of `sub` from the table's newest imported day on. */
async function* rowsOf(
  sub: string,
  newest: () => Promise<Array<{ t: Date | null }>>,
): AsyncGenerator<Row[]> {
  const last = ALL ? null : ((await newest())[0]?.t ?? null);
  for (const f of dayFilesFrom(join(HOME, sub), last)) yield* jsonlChunks<Row>(f, 500);
}
const counts = { assets: 0, snapshots: 0, events: 0, lp: 0, quotes: 0, skippedUnknownPool: 0 };

for await (const all of rowsOf('pools', () =>
  db.select({ t: max(riskPoolSnapshots.fetchedAt) }).from(riskPoolSnapshots),
)) {
  const c = all.filter((r) => {
    const ok = known.has(r.pool as string);
    if (!ok) counts.skippedUnknownPool++;
    return ok && r.sell && r.buy;
  });
  if (!c.length) continue;
  const res = await db
    .insert(riskPoolSnapshots)
    .values(
      c.map((r) => ({
        pool: r.pool as string,
        fetchedAt: new Date(r.fetchedAt as string),
        slot: Number(r.slot),
        midPrice: Number(r.midQuotePerAsset),
        activeLiquidity: (r.activeLiquidity as string | null) ?? null,
        sell: r.sell,
        buy: r.buy,
        inBandLiquidity:
          (r.depth2pct as { sellQuoteOut: number } | undefined)?.sellQuoteOut ?? null,
        methodVersion: r.methodVersion as string,
        source: r.source as string,
        method: r.method as string,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskPoolSnapshots.pool });
  counts.snapshots += res.length;
}
// events.jsonl is one file: streamed, rows before the newest imported day skipped
const lastEvent = ALL
  ? null
  : ((await db.select({ t: max(riskEvents.fetchedAt) }).from(riskEvents))[0]?.t ?? null);
const eventsFrom = lastEvent ? lastEvent.toISOString().slice(0, 10) : '';
const eventChunks = existsSync(join(HOME, 'events.jsonl'))
  ? jsonlChunks<Row>(join(HOME, 'events.jsonl'), 500)
  : [];
for await (const all of eventChunks) {
  const c = all.filter((e) => String(e.fetchedAt) >= eventsFrom);
  if (!c.length) continue;
  const res = await db
    .insert(riskEvents)
    .values(
      c.map((e) => ({
        pool: e.pool as string,
        kind: e.kind as string,
        fetchedAt: new Date(e.fetchedAt as string),
        slot: Number(e.slot ?? 0),
        asset: (e.asset as string) ?? null,
        detail: e,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskEvents.pool });
  counts.events += res.length;
}
for await (const c of rowsOf('lp', () =>
  db.select({ t: max(riskLpConcentration.fetchedAt) }).from(riskLpConcentration),
)) {
  const res = await db
    .insert(riskLpConcentration)
    .values(
      c.map((r) => ({
        pool: r.pool as string,
        fetchedAt: new Date(r.fetchedAt as string),
        asset: r.asset as string,
        positions: Number(r.positions),
        inBandPositions: Number(r.inBandPositions),
        top1: Number(r.top1),
        top3: Number(r.top3),
        top10: Number(r.top10),
        holderKind: r.holderKind as string,
        bandPct: Number(r.bandPct),
        lpExitN: Number(r.lpExitN),
        sellBase: r.sellBase,
        sellWithoutTopN: r.sellWithoutTopN,
        methodVersion: r.methodVersion as string,
        source: r.source as string,
        method: r.method as string,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskLpConcentration.pool });
  counts.lp += res.length;
}
for await (const all of rowsOf('quotes', () =>
  db.select({ t: max(riskQuotes.fetchedAt) }).from(riskQuotes),
)) {
  const c = all.filter((q) => q.runId && q.assetMint && q.side && q.notionalUsd);
  if (!c.length) continue;
  const res = await db
    .insert(riskQuotes)
    .values(
      c.map((q) => ({
        runId: q.runId as string,
        assetMint: q.assetMint as string,
        asset: q.asset as string,
        side: q.side as string,
        notionalUsd: Number(q.notionalUsd),
        amountIn: (q.amountIn as string) ?? null,
        outAmount: (q.outAmount as string) ?? null,
        route: q.route ?? null,
        error: (q.error as string) ?? null,
        fetchedAt: new Date(q.fetchedAt as string),
        source: (q.source as string) ?? null,
        method: (q.method as string) ?? null,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskQuotes.runId });
  counts.quotes += res.length;
}
for await (const c of rowsOf('assets', () =>
  db.select({ t: max(riskAssetSnapshots.fetchedAt) }).from(riskAssetSnapshots),
)) {
  const res = await db
    .insert(riskAssetSnapshots)
    .values(
      c.map((r) => ({
        assetMint: r.assetMint as string,
        asset: r.asset as string,
        fetchedAt: new Date(r.fetchedAt as string),
        slot: Number(r.slot),
        refPool: r.refPool as string,
        refMidUsd: Number(r.refMidUsd),
        pools: Number(r.pools),
        sell: r.sell,
        buy: r.buy,
        methodVersion: r.methodVersion as string,
        source: r.source as string,
        method: r.method as string,
        provenance: 'live' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ a: riskAssetSnapshots.assetMint });
  counts.assets += res.length;
}
await client.end();
console.log(JSON.stringify({ home: HOME, inserted: counts }));
