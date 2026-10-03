import { type Db, riskPriceObservations, riskReferencePrices } from '@colosseum/db';
import type { ReferencePrice } from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { PRICES_METHOD_VERSION, type StoredObservation } from './lib';

// Step 11 item 5 — the writes of the price tables, shared by the import (`import.ts`) and the hourly job (`job.ts`).
export const REFERENCE_SOURCE =
  'price observations (Step 11 item 1), resolved by packages/risk/src/prices';
export const REFERENCE_METHOD = 'prices-resolve';
const CHUNK = 2000;

type ObservationInsert = typeof riskPriceObservations.$inferInsert;
type ReferenceInsert = typeof riskReferencePrices.$inferInsert;

export const observationKey = (o: {
  priceSource: string;
  ref: string;
  mint: string;
  t: number;
  slot: number | null;
  price: number;
}) => `${o.priceSource}|${o.ref}|${o.mint}|${o.t}|${o.slot ?? 0}|${o.price}`;

const observationRow = (o: StoredObservation): ObservationInsert => ({
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

/**
 * Writes observations. A row that exists keeps everything but its flags: with `flags: 'update'` its `live` and
 * `failed_checks` are replaced, with `flags: 'keep'` it is left as it is. Returns the rows written.
 */
export async function upsertObservations(
  db: Db,
  observations: Iterable<StoredObservation>,
  flags: 'update' | 'keep',
): Promise<number> {
  let written = 0;
  let buf: StoredObservation[] = [];
  const flush = async () => {
    if (!buf.length) return;
    // one statement cannot touch a key twice
    const seen = new Set<string>();
    const rows = buf
      .filter((o) => {
        const k = observationKey(o);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(observationRow);
    const target = [
      riskPriceObservations.priceSource,
      riskPriceObservations.ref,
      riskPriceObservations.mint,
      riskPriceObservations.observedAt,
      riskPriceObservations.slot,
      riskPriceObservations.price,
    ];
    const q = db.insert(riskPriceObservations).values(rows);
    const res = await (flags === 'update'
      ? q.onConflictDoUpdate({
          target,
          set: { live: sql`excluded.live`, failedChecks: sql`excluded.failed_checks` },
        })
      : q.onConflictDoNothing({ target })
    ).returning({ m: riskPriceObservations.mint });
    written += res.length;
    buf = [];
  };
  for (const o of observations) {
    buf.push(o);
    if (buf.length >= CHUNK) await flush();
  }
  await flush();
  return written;
}

export const referenceRow = (
  r: ReferencePrice,
  symbol: string | null,
  fetchedAt: Date,
): ReferenceInsert => ({
  mint: r.mint,
  observedAt: new Date(r.t * 1000),
  chain: 'solana',
  symbol,
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
  source: REFERENCE_SOURCE,
  method: REFERENCE_METHOD,
  fetchedAt,
  provenance: 'live',
});

/** Writes reference prices; an hour that exists is replaced. Returns the rows written. */
export async function upsertReferencePrices(db: Db, rows: ReferenceInsert[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await db
      .insert(riskReferencePrices)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [
          riskReferencePrices.mint,
          riskReferencePrices.observedAt,
          riskReferencePrices.methodVersion,
        ],
        set: {
          symbol: sql`excluded.symbol`,
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
    written += res.length;
  }
  return written;
}
