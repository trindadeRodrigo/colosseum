// Raw amounts as a person reads them. A chain counts a token in whole units of its smallest part, as a
// string of digits; the screen shows it with the token's decimals, grouped as the language groups
// figures, and never through a float.

const DIGITS = /^\d+$/;

/**
 * `raw` with `decimals` places, cut to `places` of them (never rounded up: an amount shown is never
 * more than the amount), grouped for `locale`. Null when `raw` is not a raw amount.
 */
export function formatRaw(
  raw: string,
  decimals: number,
  locale: string,
  places = Math.min(decimals, 6),
): string | null {
  if (typeof raw !== 'string' || !DIGITS.test(raw) || !Number.isInteger(decimals) || decimals < 0)
    return null;
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  let fraction = padded.slice(padded.length - decimals).slice(0, places);
  fraction = fraction.replace(/0+$/, '');
  const parts = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).formatToParts(
    BigInt(whole),
  );
  const grouped = parts.map((p) => p.value).join('');
  if (!fraction) return grouped;
  const point =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ??
    '.';
  return `${grouped}${point}${fraction}`;
}

/** Basis points as a percentage: 75 → `0.75%`. */
export function formatBps(bps: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(bps / 10_000);
}

/**
 * How far under the quote a minimum is, in basis points, to the nearest one: what the trade may give
 * up. A minimum is the quote less a whole percentage, rounded down to a raw unit, so the gap is a
 * hair over that percentage: rounded up it read "1.01%" where the buy screen said 1%. Null when
 * either is not an amount or the quote is zero.
 */
export function shortfallBps(outRaw: string, minOutRaw: string): number | null {
  if (!DIGITS.test(outRaw) || !DIGITS.test(minOutRaw)) return null;
  const out = BigInt(outRaw);
  const min = BigInt(minOutRaw);
  if (out === 0n) return null;
  if (min >= out) return 0;
  const gap = (out - min) * 10_000n;
  return Number((gap + out / 2n) / out);
}

/**
 * A chain's dollar goes by that chain's name for it, whatever its id: Robinhood Chain's is tUSDG,
 * also where the mock stands in for it (`robinhood:usdc`). A Robinhood vault never says USDC.
 */
const NAMED: Readonly<Record<string, string>> = {
  'robinhood:usdc': 'tUSDG',
  'robinhood:tusdg': 'tUSDG',
};

/** An asset as a plan on one chain names it: its id without the chain it is on. */
export const assetName = (id: string) => NAMED[id] ?? id.slice(id.indexOf(':') + 1);

/** The same name as a ticker: upper case, except a name the chain gives in its own case (tUSDG). */
export const assetTicker = (id: string) => NAMED[id] ?? assetName(id).toUpperCase();
