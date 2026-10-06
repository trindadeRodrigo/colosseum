import { shorten } from '../../components/ui/format';

// How Bearing writes its figures (Rodrigo's Analytics 2.0, assets/analytics.js): en-US, two decimals
// on a percentage, a true minus (U+2212), dollars compact above a thousand. Words for the reasons a
// figure is missing, and for the times of week, are the API's codes in plain English.

const NF = new Map<string, Intl.NumberFormat>();
export function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let format = NF.get(key);
  if (!format) {
    format = new Intl.NumberFormat('en-US', options);
    NF.set(key, format);
  }
  return format;
}

export const minus = (s: string) => s.replace(/-/g, '−');

export const pct = (v: number) =>
  `${minus(nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v * 100))}%`;
export const pct0 = (v: number) => `${minus(nf({ maximumFractionDigits: 0 }).format(v * 100))}%`;

export function usd(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '$0';
  if (a < 1)
    return minus(nf({ style: 'currency', currency: 'USD', maximumSignificantDigits: 2 }).format(v));
  if (a < 100)
    return minus(
      nf({
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(v),
    );
  return minus(nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v));
}

/** Capacity and dollar columns: compact, one decimal, above a thousand. */
export const usd1 = (v: number) =>
  Math.abs(v) < 1000
    ? usd(v)
    : minus(
        nf({
          style: 'currency',
          currency: 'USD',
          notation: 'compact',
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(v),
      );

/** A capacity of 0 is measured: not even the smallest size measured ($100) sells within the tolerance. */
export const capW = (v: number) => (v === 0 ? '< $100' : usd1(v));

export const num = (v: number, digits = 0) =>
  minus(nf({ maximumFractionDigits: digits }).format(v));

/** `2026-10-03T15:58:40Z`, or the words when there is no time. */
export const iso = (t: string | number | null | undefined) =>
  t == null || t === '' ? 'no time given' : `${new Date(t).toISOString().slice(0, 19)}Z`;

export const hhmm = (t: string | number) => {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};

export const short = (address: string) => shorten(address);

const VENUES: Record<string, string> = {
  kamino: 'Kamino',
  jupiter_lend: 'Jupiter Lend',
  orca_whirlpool: 'Orca',
  raydium_clmm: 'Raydium CLMM',
  raydium_cpmm: 'Raydium CPMM',
  raydium_amm: 'Raydium AMM',
  meteora_dlmm: 'Meteora DLMM',
  meteora_damm: 'Meteora DAMM',
  meteora_damm_v2: 'Meteora DAMM v2',
};
export const venueW = (v: string | null | undefined) =>
  VENUES[v ?? ''] ?? String(v ?? '').replace(/_/g, ' ');

export const REGIMES = ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'] as const;
export type Regime = (typeof REGIMES)[number];
export const RW: Record<Regime, string> = {
  us_market_hours: 'market hours',
  us_offhours_weekday: 'off-hours',
  weekend: 'weekend',
  us_holiday: 'holiday',
};
export const regimeW = (r: string) => RW[r as Regime] ?? r;

export const REASON: Record<string, string> = {
  no_samples_in_regime: 'no samples in this regime yet',
  insufficient_samples: 'too few samples to fit',
  beyond_measured_size: 'beyond the largest size measured',
  no_reference_price: 'no reference price',
  no_external_source: 'no external source for this',
  chain_not_covered: 'chain not covered',
  not_collected: 'not collected yet',
  not_imported: 'not imported yet',
  not_followed: 'not followed',
  before_routed_curves: 'from before routed curves',
  gate_open: 'waiting on an open gate',
  not_applicable: 'does not apply here',
  not_served: 'not served by the API',
  api_error: 'the API returned no answer',
  nothing_selected: 'nothing selected',
};
export const reasonW = (code: string | null | undefined) =>
  REASON[code ?? ''] ?? String(code || 'not served').replace(/_/g, ' ');
