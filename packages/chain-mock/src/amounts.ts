// Exact decimal arithmetic on strings and bigints. No float touches an amount.

const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

/** '2.55' to 2550000000000000000n. Digits past 18 places are cut. */
export function toScaled(decimal: string): bigint {
  const [whole = '0', frac = ''] = decimal.split('.');
  return BigInt(whole) * ONE + BigInt(frac.padEnd(SCALE, '0').slice(0, SCALE) || '0');
}

/** A bigint carrying `scale` decimal places, as a plain decimal string with no trailing zeros. */
export function fromScaled(value: bigint, scale: number = SCALE): string {
  const digits = value.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** DESIGN-VAULT 3.1: display = raw × multiplier / 10^decimals. Shares of the underlying, for display only. */
export function displayAmount(raw: string, multiplier: string, decimals: number): string {
  return fromScaled(BigInt(raw) * toScaled(multiplier), SCALE + decimals);
}

/**
 * Raw units received for `amountInRaw` at two reference prices (USD per whole token), less `costBps`.
 * Rounded down, as a pool would.
 */
export function swapOut(
  amountInRaw: bigint,
  sell: { usdPerToken: string; decimals: number },
  buy: { usdPerToken: string; decimals: number },
  costBps: number,
): bigint {
  const gross =
    (amountInRaw * toScaled(sell.usdPerToken) * 10n ** BigInt(buy.decimals)) /
    (toScaled(buy.usdPerToken) * 10n ** BigInt(sell.decimals));
  return (gross * BigInt(10_000 - costBps)) / 10_000n;
}

/** USD value of raw units, scaled by 1e18. value = raw × usdPerToken / 10^decimals, with no multiplier. */
export function valueScaled(raw: bigint, usdPerToken: string, decimals: number): bigint {
  return (raw * toScaled(usdPerToken)) / 10n ** BigInt(decimals);
}
