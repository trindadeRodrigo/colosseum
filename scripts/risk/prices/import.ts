import 'dotenv/config';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskPriceObservations, riskReferencePrices } from '@colosseum/db';
import { hourlyReferencePrices } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { latestRegistryFile, type RegistryPool } from '../lib-history';
import { RISK_HOME } from '../lib-lending';
import { loadPriceInputs, PRICES_DIR, PRICES_METHOD_VERSION } from './lib';

// Step 11 item 5 — `pnpm risk:prices-import`. Fills risk_price_observations from the observation files of item 1
// and risk_reference_prices with the resolver's valuation per asset and hour. Run `pnpm risk:prices-extract` first
// (`--only=live` refreshes the collectors' rows in seconds). Idempotent: an observation that exists keeps
// everything but its `live` and `failed_checks` flags; a reference hour that exists is replaced.
//   default    every observation, and every hour of every asset from its first observation to the last whole
//              hour that has any observation (about a minute). Always right, whatever was added or backfilled.
//   --recent   only what is newer than the newest stored row per price source and method (per asset for the
//              reference prices), minus `overlapSec`: seconds instead of a minute. The overlap is there because a
//              trading day is judged live or frozen only once it is over. It does NOT pick up older rows added
//              later (a backfilled pool history, a new reserve, an external source): run the default after those.
// The run, with the price parameters it used, is appended to data/risk/prices/import-runs.jsonl.
// Usage: tsx scripts/risk/prices/import.ts [--recent]
const FULL = !process.argv.includes('--recent');
const P = { overlapSec: 2 * 86400, chunk: 2000 };
const SOURCE = 'price observations (Step 11 item 1), resolved by packages/risk/src/prices';
const METHOD = 'prices-resolve';
const t0 = Date.now();
const fetchedAt = new Date();
const { db, client } = createDb();
const counts: Record<string, number> = {};
const bump = (k: string, n = 1) => {
  counts[k] = (counts[k] ?? 0) + n;
};

const inputs = loadPriceInputs();

// ------------------------------------------------------------------------------------------------- observations
const newest = new Map<string, number>();
if (!FULL)
  for (const r of await db
    .select({
      s: riskPriceObservations.priceSource,
      m: riskPriceObservations.method,
      t: sql<string>`max(${riskPriceObservations.observedAt})`,
    })
    .from(riskPriceObservations)
    .groupBy(riskPriceObservations.priceSource, riskPriceObservations.method))
    newest.set(`${r.s}|${r.m}`, Date.parse(r.t) / 1000);
let buf: Array<typeof riskPriceObservations.$inferInsert> = [];
const flush = async () => {
  if (!buf.length) return;
  // one statement cannot touch a key twice
  const seen = new Set<string>();
  const rows = buf.filter((r) => {
    const k = `${r.priceSource}|${r.ref}|${r.mint}|${(r.observedAt as Date).getTime()}|${r.slot}|${r.price}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const res = await db
    .insert(riskPriceObservations)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        riskPriceObservations.priceSource,
        riskPriceObservations.ref,
        riskPriceObservations.mint,
        riskPriceObservations.observedAt,
        riskPriceObservations.slot,
        riskPriceObservations.price,
      ],
      set: { live: sql`excluded.live`, failedChecks: sql`excluded.failed_checks` },
    })
    .returning({ m: riskPriceObservations.mint });
  bump('observationsWritten', res.length);
  buf = [];
};
for (const o of inputs.observations) {
  bump('observationsRead');
  const since = newest.get(`${o.priceSource}|${o.method}`);
  if (since !== undefined && o.t < since - P.overlapSec) continue;
  buf.push({
    chain: o.chain,
    mint: o.mint,
    priceSource: o.priceSource,
    observedAt: new Date(o.t * 1000),
    slot: o.slot ?? 0,
    price: o.price,
    quote: o.quote,
    ref: o.ref,
    market: o.market,
    live: o.live !== false,
    failedChecks: o.failedChecks?.length ? o.failedChecks.join(',') : null,
    sourceTs: o.sourceTs ? new Date(o.sourceTs * 1000) : null,
    marketStatus: o.marketStatus ?? null,
    methodVersion: o.methodVersion,
    source: o.source,
    method: o.method,
    fetchedAt: new Date(o.fetchedAt),
    provenance: 'live',
  });
  if (buf.length >= P.chunk) await flush();
}
await flush();

// ------------------------------------------------------------------------------------------------- reference prices
const symbolOf = new Map<string, string>();
const dreg = JSON.parse(readFileSync(latestRegistryFile(), 'utf8')) as { pools: RegistryPool[] };
for (const p of dreg.pools) symbolOf.set(p.assetMint, p.assetSymbol);
const lreg = JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
  rows: Array<{ venue: string; mint: string | null; symbol: string | null }>;
};
for (const r of lreg.rows)
  if (r.venue === 'kamino' && r.mint && r.symbol) symbolOf.set(r.mint, r.symbol);

const stored = new Map<string, number>();
if (!FULL)
  for (const r of await db
    .select({
      mint: riskReferencePrices.mint,
      t: sql<string>`max(${riskReferencePrices.observedAt})`,
    })
    .from(riskReferencePrices)
    .where(sql`${riskReferencePrices.methodVersion} = ${PRICES_METHOD_VERSION}`)
    .groupBy(riskReferencePrices.mint))
    stored.set(r.mint, Date.parse(r.t) / 1000);
const first = inputs.index.first;
const lastHour = Math.floor(inputs.index.last / 3600) * 3600;
const quality: Record<string, number> = {};
for (const [mint, firstT] of [...first].sort(([a], [b]) => a.localeCompare(b))) {
  const have = stored.get(mint);
  const from = have === undefined ? firstT : Math.max(firstT, have - P.overlapSec);
  let rows: Array<typeof riskReferencePrices.$inferInsert> = [];
  const put = async () => {
    if (!rows.length) return;
    const res = await db
      .insert(riskReferencePrices)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          riskReferencePrices.mint,
          riskReferencePrices.observedAt,
          riskReferencePrices.methodVersion,
        ],
        set: {
          priceUsd: sql`excluded.price_usd`,
          priceSource: sql`excluded.price_source`,
          ref: sql`excluded.ref`,
          quality: sql`excluded.quality`,
          regime: sql`excluded.regime`,
          ageSec: sql`excluded.age_sec`,
          priceObservedAt: sql`excluded.price_observed_at`,
          nullReason: sql`excluded.null_reason`,
          others: sql`excluded.others`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      })
      .returning({ m: riskReferencePrices.mint });
    bump('referencePricesWritten', res.length);
    rows = [];
  };
  for (const r of hourlyReferencePrices(inputs.index, inputs.ctx, mint, from, lastHour)) {
    const q = r.quality ?? r.nullReason ?? 'none';
    quality[q] = (quality[q] ?? 0) + 1;
    rows.push({
      mint,
      observedAt: new Date(r.t * 1000),
      chain: 'solana',
      symbol: symbolOf.get(mint) ?? null,
      priceUsd: r.priceUsd,
      priceSource: r.priceSource,
      ref: r.ref,
      quality: r.quality,
      regime: r.regime,
      ageSec: r.ageSec,
      priceObservedAt: r.obsT === null ? null : new Date(r.obsT * 1000),
      nullReason: r.nullReason,
      others: r.others,
      methodVersion: PRICES_METHOD_VERSION,
      source: SOURCE,
      method: METHOD,
      fetchedAt,
      provenance: 'live',
    });
    if (rows.length >= P.chunk) await put();
  }
  await put();
  bump('assets');
}
await client.end();

const summary = {
  kind: 'prices-import',
  at: fetchedAt.toISOString(),
  full: FULL,
  seconds: Math.round((Date.now() - t0) / 100) / 10,
  lastHour: new Date(lastHour * 1000).toISOString(),
  counts,
  referenceHoursByQuality: quality,
  observationFiles: inputs.counts,
  notLiveObservations: Object.values(inputs.notLive).reduce((s, n) => s + n, 0),
  methodVersion: PRICES_METHOD_VERSION,
  params: { import: P, price: inputs.ctx.params },
};
appendFileSync(join(PRICES_DIR, 'import-runs.jsonl'), `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify({ ...summary, params: undefined }));
