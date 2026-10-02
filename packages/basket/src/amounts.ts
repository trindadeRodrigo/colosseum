// Exact arithmetic for money. A token amount is a bigint of raw units; a price and a dollar value are
// bigints scaled by 1e18. No float touches either. Where a float does come in (a dust threshold in
// dollars, a display figure), the function that takes it says so.

export const USD_SCALE = 18;
export const ONE_USD = 10n ** BigInt(USD_SCALE);

/** What every function here throws when a number it is handed is not in the form it must be. */
export class BasketInputError extends Error {
  readonly code: 'BadDecimal' | 'BadAmount' | 'BadDecimals' | 'DuplicatePrice' | 'CashNotListed';
  constructor(code: BasketInputError['code'], message: string) {
    super(message);
    this.name = 'BasketInputError';
    this.code = code;
  }
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const RAW = /^(?:0|[1-9]\d*)$/;

/**
 * '2.55' to 2550000000000000000n. Digits past 18 places are cut. Only plain decimals: no sign, no
 * exponent, no hex, no spaces, nothing empty (the `DecimalString` of packages/schemas).
 */
export function parseDecimal(decimal: string): bigint {
  if (typeof decimal !== 'string' || !DECIMAL.test(decimal))
    throw new BasketInputError('BadDecimal', 'expected a plain decimal such as 2.55');
  const [whole = '0', frac = ''] = decimal.split('.');
  return BigInt(whole) * ONE_USD + BigInt(frac.padEnd(USD_SCALE, '0').slice(0, USD_SCALE) || '0');
}

/** Raw token units from their decimal string (the `RawAmount` of packages/schemas). */
export function parseRaw(raw: string): bigint {
  if (typeof raw !== 'string' || !RAW.test(raw))
    throw new BasketInputError('BadAmount', 'expected raw units as a string of digits');
  return BigInt(raw);
}

/** How many decimals a token has, checked: a whole number from 0 to 36. */
export function checkDecimals(decimals: number, asset: string): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new BasketInputError('BadDecimals', `${asset}: decimals must be a whole number, 0 to 36`);
  return decimals;
}

/**
 * A value scaled by 1e18 as a decimal string, cut (not rounded) to `places` and with no trailing
 * zeros: 250000000000000000000n is '250'.
 */
export function formatDecimal(scaled: bigint, places = 6): string {
  const cut = scaled / 10n ** BigInt(USD_SCALE - places);
  const digits = cut.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** Dollars, scaled by 1e18, for raw units at a price per whole token. Rounded down. No multiplier. */
export function usdValue(raw: bigint, priceScaled: bigint, decimals: number): bigint {
  return (raw * priceScaled) / pow10(decimals);
}

/** The most raw units whose value is at most `valueScaled`. */
export function rawFor(valueScaled: bigint, priceScaled: bigint, decimals: number): bigint {
  return (valueScaled * pow10(decimals)) / priceScaled;
}

/** What one raw unit is worth, rounded up: the most a conversion to whole units can lose. */
export function unitValue(priceScaled: bigint, decimals: number): bigint {
  return (priceScaled + pow10(decimals) - 1n) / pow10(decimals);
}

/**
 * A dollar figure given as a number (a policy threshold such as "no trade under $1") as a scaled
 * bigint, to the millionth of a dollar. Safe because it is a setting to compare against, never an
 * amount that moves.
 */
export function usdFromNumber(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0)
    throw new RangeError('expected a dollar figure of 0 or more');
  return BigInt(Math.round(usd * 1e6)) * 10n ** BigInt(USD_SCALE - 6);
}

/**
 * Splits `total` over `parts` in proportion, in whole units that add up to exactly `total`: each part
 * gets its share rounded down, and the units left over go to the largest remainders, ties to the
 * earlier part. With every part zero, every share is zero.
 */
export function apportion(parts: readonly bigint[], total: bigint): bigint[] {
  const sum = parts.reduce((n, p) => n + p, 0n);
  if (sum === 0n) return parts.map(() => 0n);
  const shares = parts.map((p) => (p * total) / sum);
  const rest = parts.map((p, i) => ({ i, rem: (p * total) % sum }));
  rest.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  let left = total - shares.reduce((n, s) => n + s, 0n);
  for (const { i } of rest) {
    if (left === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares;
}
