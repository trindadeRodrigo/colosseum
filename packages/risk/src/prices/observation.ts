/**
 * Step 11 — the oracle standard. A price observation is one price of one asset from one source at one time.
 * Every source writes this shape; the resolver (`resolve.ts`) reads nothing else. Sources are never blended.
 *
 * Unit: `price` is per whole token as held on-chain (raw amount ÷ 10^decimals), in `quote`: `'usd'`, or the mint
 * of the token the source quotes in (Jupiter Lend's oracle quotes the collateral in the vault's debt token).
 */
export type PriceSourceId =
  | 'pool_mid'
  | 'kamino_scope'
  | 'jupiter_lend_oracle'
  | `external:${string}`;

export type PriceSourceKind = 'dex' | 'lending_oracle' | 'external';

export const sourceKind = (s: PriceSourceId): PriceSourceKind =>
  s === 'pool_mid' ? 'dex' : s.startsWith('external:') ? 'external' : 'lending_oracle';

export type PriceObservation = {
  chain: string;
  /** Mint of the asset priced. */
  mint: string;
  /** Which price source this is. (`source` on a stored row names the data source, as everywhere else.) */
  priceSource: PriceSourceId;
  /** Unix seconds: block time of the transaction, or the time the collector read the account. */
  t: number;
  slot: number | null;
  price: number;
  quote: string;
  /** The account the price came from: pool, Kamino reserve, Jupiter Lend vault config. */
  ref: string;
  /** Lending market (Kamino) or vault (Jupiter Lend) for a lending oracle; null for other sources. */
  market: string | null;
  /** How the price was read, e.g. `klend_refresh_log`, `scope_feed_read`, `pool_hourly_mid`. */
  method: string;
  /** The source's own timestamp for the price, when it reports one (Unix seconds). */
  sourceTs?: number | null;
  /** False when the source was not pricing the asset at that time (`markLiveness`); absent means live. */
  live?: boolean;
  /** The venue's own checks this price failed when it was logged (klend: `twap`, `heuristic`); absent means none. */
  failedChecks?: string[];
  /** Jupiter Lend's market status for the feed, when read live. */
  marketStatus?: number | null;
};
