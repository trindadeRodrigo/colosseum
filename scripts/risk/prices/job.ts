import 'dotenv/config';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskPriceObservations } from '@colosseum/db';
import {
  assetRowObservation,
  hourlyReferencePrices,
  lendingRowObservation,
  type PriceObservation,
  type PriceSourceId,
} from '@colosseum/risk';
import { gte } from 'drizzle-orm';
import { RISK_HOME } from '../lib-lending';
import { observationKey, referenceRow, upsertObservations, upsertReferencePrices } from './db';
import { buildPriceInputs, PRICES_METHOD_VERSION, type StoredObservation } from './lib';

// Step 11 item 5 — the hourly price job (`com.colosseum.risk-prices`, minute 14; PLAN-RISK D22). It keeps the live
// end of the price tables current. launchd cannot read ~/Documents, so it reads only ~/.colosseum/risk and
// Postgres, and it fetches nothing:
//   1. the collectors' 5-minute rows of the last `fileDays` days (`lending/<day>.jsonl`: Scope feed and Jupiter
//      Lend cache prices; `assets/<day>.jsonl`: the reference pool mid) become observations; the ones not yet in
//      risk_price_observations are inserted. A row that exists is left as it is.
//   2. the observations of the last `windowSec` in the table, of every source, are resolved into the reference
//      price of each asset for every hour of the last `refreshSec`, and written to risk_reference_prices.
// The window is longer than the oldest observation the resolver accepts (`maxClosedAgeSec`), so these hours come
// out as a full import (`pnpm risk:prices-import`) would write them. A liveness flag already in the table wins;
// a new row takes the flag computed over the window.
// It is installed by scripts/risk/prices/install-job.sh, beside the collectors: it edits none of their files and
// reloads none of their jobs. By hand: tsx scripts/risk/prices/job.ts
const P = { fileDays: 3, windowSec: 6 * 86400, refreshSec: 2 * 86400 };
const t0 = Date.now();
const now = Math.floor(t0 / 1000);
const fetchedAt = new Date(t0);
const { db, client } = createDb();

// ------------------------------------------------------------------------------------------------- 1. new rows
const fromFiles: StoredObservation[] = [];
let badLines = 0;
const stored = (o: PriceObservation, source: string): StoredObservation => ({
  ...o,
  source,
  fetchedAt: fetchedAt.toISOString(),
  methodVersion: PRICES_METHOD_VERSION,
  provenance: 'live',
});
for (const [dir, source, map] of [
  [
    'lending',
    'risk-lending collector rows (Solana RPC getMultipleAccounts)',
    lendingRowObservation,
  ],
  ['assets', 'risk-pools collector asset rows (Solana RPC pool reads)', assetRowObservation],
] as const)
  for (let d = 0; d < P.fileDays; d++) {
    const day = new Date((now - d * 86400) * 1000).toISOString().slice(0, 10);
    const f = join(RISK_HOME, dir, `${day}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // the collector may be writing the last line
        badLines++;
        continue;
      }
      const o = map(row);
      if (o) fromFiles.push(stored(o, source));
    }
  }

// ------------------------------------------------------------------------------------------------- 2. the window
const inDb = await db
  .select()
  .from(riskPriceObservations)
  .where(gte(riskPriceObservations.observedAt, new Date((now - P.windowSec) * 1000)));
const window = new Map<string, StoredObservation>();
const flagInDb = new Map<string, boolean>();
for (const r of inDb) {
  const o: StoredObservation = {
    chain: r.chain,
    mint: r.mint,
    priceSource: r.priceSource as PriceSourceId,
    t: Math.floor(r.observedAt.getTime() / 1000),
    slot: r.slot,
    price: r.price,
    quote: r.quote,
    ref: r.ref,
    market: r.market,
    method: r.method,
    ...(r.failedChecks ? { failedChecks: r.failedChecks.split(',') } : {}),
    source: r.source,
    fetchedAt: r.fetchedAt.toISOString(),
    methodVersion: r.methodVersion,
    provenance: 'live',
  };
  window.set(observationKey(o), o);
  flagInDb.set(observationKey(o), r.live);
}
const fresh: StoredObservation[] = [];
for (const o of fromFiles) {
  if (o.t < now - P.windowSec) continue;
  const k = observationKey(o);
  if (window.has(k)) continue;
  window.set(k, o);
  fresh.push(o);
}
const inputs = buildPriceInputs([...window.values()]);
// a flag already in the table wins over the one computed on six days of data
for (const o of inputs.observations) {
  const was = flagInDb.get(observationKey(o));
  if (was === true) delete o.live;
  else if (was === false) o.live = false;
}
const inserted = await upsertObservations(db, fresh, 'keep');

// ------------------------------------------------------------------------------------------------- reference prices
const symbolOf = new Map<string, string>();
const poolRegistry = join(RISK_HOME, 'registry.json');
if (existsSync(poolRegistry))
  for (const p of (
    JSON.parse(readFileSync(poolRegistry, 'utf8')) as {
      pools: Array<{ assetMint: string; assetSymbol: string }>;
    }
  ).pools)
    symbolOf.set(p.assetMint, p.assetSymbol);
for (const r of (
  JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
    rows: Array<{ venue: string; mint: string | null; symbol: string | null }>;
  }
).rows)
  if (r.venue === 'kamino' && r.mint && r.symbol) symbolOf.set(r.mint, r.symbol);

const lastHour = Math.floor(inputs.index.last / 3600) * 3600;
const quality: Record<string, number> = {};
const rows = [];
for (const [mint, first] of [...inputs.index.first].sort(([a], [b]) => a.localeCompare(b)))
  for (const r of hourlyReferencePrices(
    inputs.index,
    inputs.ctx,
    mint,
    Math.max(first, now - P.refreshSec),
    lastHour,
  )) {
    const q = r.quality ?? r.nullReason ?? 'none';
    quality[q] = (quality[q] ?? 0) + 1;
    rows.push(referenceRow(r, symbolOf.get(mint) ?? null, fetchedAt));
  }
const written = await upsertReferencePrices(db, rows);
await client.end();

const summary = {
  kind: 'prices-job',
  at: fetchedAt.toISOString(),
  seconds: Math.round((Date.now() - t0) / 100) / 10,
  lastHour: lastHour ? new Date(lastHour * 1000).toISOString() : null,
  observations: {
    fromFiles: fromFiles.length,
    inWindow: window.size,
    inserted,
    badLines,
  },
  referencePrices: { written, assets: inputs.index.first.size, byQuality: quality },
  methodVersion: PRICES_METHOD_VERSION,
  params: { job: P, price: inputs.ctx.params },
};
appendFileSync(join(RISK_HOME, 'prices-runs.jsonl'), `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify({ ...summary, params: undefined }));
