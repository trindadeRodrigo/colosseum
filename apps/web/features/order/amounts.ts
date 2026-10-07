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
 * How far under the quote a minimum is, in basis points, rounded up: what the trade may give up, never
 * said smaller than it is. One case is not a gap of its own: a minimum is the quote less a tolerance in
 * whole basis points, cut down to a raw unit of the token, so 1% of a quote that does not divide reads
 * a hair over 1%. Where the minimum is exactly what the next basis point down gives once cut to a raw
 * unit, that is the tolerance the order states, and it is the one said ("1%", not "1.01%"): the
 * difference is under one raw unit. Null when either is not an amount or the quote is zero.
 */
export function shortfallBps(outRaw: string, minOutRaw: string): number | null {
  if (!DIGITS.test(outRaw) || !DIGITS.test(minOutRaw)) return null;
  const out = BigInt(outRaw);
  const min = BigInt(minOutRaw);
  if (out === 0n) return null;
  if (min >= out) return 0;
  const gap = (out - min) * 10_000n;
  const up = gap / out + (gap % out === 0n ? 0n : 1n);
  // the minimum's own rounding: quote × (1 − tolerance), cut down to a raw unit
  const stated = up - 1n;
  return Number(up > 0n && (out * (10_000n - stated)) / 10_000n === min ? stated : up);
}

/** Names a person reads, by the token's symbol written in lower case: the shelf's symbols. */
export const SYMBOLS: Record<string, string> = Object.fromEntries(
  [
    'USDC',
    'USDG',
    'USDY',
    'jlUSDC',
    'syrupUSDC',
    'SGOV',
    'SPYx',
    'QQQx',
    'NVDAx',
    'TSLAx',
    'AAPLx',
    'GOOGLx',
    'METAx',
    'MSFTx',
    'AMZNx',
    'SPCXx',
    'MSTRx',
    'CRCLx',
    'HOODx',
    'COINx',
    'PLTRx',
    'GLDx',
    'SOL',
    'JitoSOL',
    'cbBTC',
    'cbETH',
    'SPY',
    'QQQ',
    'NVDA',
    'TSLA',
    'AAPL',
    'META',
    'GLD',
    'SPCX',
    'MSTR',
    'CRCL',
    'GOOGL',
    'MSFT',
    'AMZN',
    'PAXG',
  ].map((s) => [s.toLowerCase(), s]),
);

/** The cash tokens: shown as cash, with the token named after it. */
export const CASH = new Set(['usdc', 'usdg', 'tusdc', 'tusdg']);

/** An asset's id without the chain it is on, in lower case. */
export const tail = (id: string) => id.slice(id.indexOf(':') + 1).toLowerCase();

/**
 * A chain's dollar goes by that chain's name for it, whatever its id: Robinhood Chain's is tUSDG,
 * also where the mock stands in for it (`robinhood:usdc`). A Robinhood vault never says USDC.
 */
const NAMED: Readonly<Record<string, string>> = {
  'robinhood:usdc': 'tUSDG',
  'robinhood:tusdg': 'tUSDG',
};

/**
 * A token's name, the one every screen writes beside an amount: "USDC", "syrupUSDC", "SPYx", "tUSDG".
 * One convention for a test network (the flow audit, finding 13): a test token goes by the token it
 * stands in for ("tSPYx" is SPYx, "tUSDC" is USDC), on the plan, the order, the portfolio and the vault
 * alike, and the card says it is a test network. A token this app does not know goes by its id's own
 * name in capitals, never by the id.
 */
export function tokenName(id: string): string {
  const named = NAMED[id];
  if (named) return named;
  const name = tail(id);
  const bare = name.replace(/^t(?=[a-z])/, '');
  return SYMBOLS[name] ?? SYMBOLS[bare] ?? (name === 'gold' ? 'Gold' : name.toUpperCase());
}
