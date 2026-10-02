import type { PriceObservation } from './observation';

/**
 * Step 11 item 1 — price observations from the rows the collectors already write. Nothing is read from the chain
 * here: the 5-minute lending rows carry each venue's oracle price, the 5-minute asset rows carry the reference
 * pool's mid, and Step 5b's hourly rows carry the reconstructed mid of each value pool.
 */
const unix = (iso: unknown) => Math.floor(Date.parse(String(iso)) / 1000);
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** A `kamino_reserve` or `jl_vault` row of `~/.colosseum/risk/lending/<day>.jsonl`. Other kinds give nothing. */
export function lendingRowObservation(r: Record<string, unknown>): PriceObservation | null {
  const t = unix(r.fetchedAt);
  if (!Number.isFinite(t)) return null;
  if (r.kind === 'kamino_reserve') {
    // the Scope feed as read now, not the reserve's price at its last refresh (which can be a day old)
    const price = num(r.scopePriceUsd);
    if (!price || !(price > 0) || !r.mint) return null;
    return {
      chain: String(r.chain ?? 'solana'),
      mint: String(r.mint),
      priceSource: 'kamino_scope',
      t,
      slot: num(r.slot),
      price,
      quote: 'usd',
      ref: String(r.account),
      market: String(r.market),
      method: 'scope_feed_read',
      sourceTs: num(r.scopePriceTs),
    };
  }
  if (r.kind === 'jl_vault') {
    const price = num(r.oraclePrice);
    if (!price || !(price > 0) || !r.collateralMint || !r.debtMint) return null;
    return {
      chain: String(r.chain ?? 'solana'),
      mint: String(r.collateralMint),
      priceSource: 'jupiter_lend_oracle',
      t,
      slot: num(r.slot),
      price,
      quote: String(r.debtMint),
      ref: String(r.account),
      market: String(r.account),
      method: 'chainlink_cache_read',
      sourceTs: num(r.oraclePriceTs),
      marketStatus: num(r.oracleMarketStatus),
    };
  }
  return null;
}

/** A row of `~/.colosseum/risk/assets/<day>.jsonl`: the asset's reference pool mid at a collector run. */
export function assetRowObservation(r: Record<string, unknown>): PriceObservation | null {
  const t = unix(r.fetchedAt);
  const price = num(r.refMidUsd);
  if (!Number.isFinite(t) || !price || !(price > 0) || !r.assetMint || !r.refPool) return null;
  return {
    chain: 'solana',
    mint: String(r.assetMint),
    priceSource: 'pool_mid',
    t,
    slot: num(r.slot),
    price,
    quote: 'usd',
    ref: String(r.refPool),
    market: null,
    method: 'pool_live_mid',
  };
}

/** A row of Step 5b's `hourly/<pool>.jsonl`: the pool's reconstructed mid at an hour boundary. */
export function hourlyPoolRowObservation(
  r: Record<string, unknown>,
  assetMint: string,
): PriceObservation | null {
  const t = unix(r.hour);
  const price = num(r.midUsd);
  if (!Number.isFinite(t) || !price || !(price > 0) || !r.pool) return null;
  return {
    chain: 'solana',
    mint: assetMint,
    priceSource: 'pool_mid',
    t,
    slot: num(r.slot),
    price,
    quote: 'usd',
    ref: String(r.pool),
    market: null,
    method: 'pool_hourly_mid',
  };
}
