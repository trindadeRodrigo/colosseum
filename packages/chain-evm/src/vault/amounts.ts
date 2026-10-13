// Exact decimal arithmetic on strings and bigints. No float touches an amount or a price.

const SCALE = 18;

/** '2.55' to 2550000000000000000n. Digits past 18 places are cut. */
export function toScaled(decimal: string): bigint {
  const [whole = '0', frac = ''] = decimal.split('.');
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(frac.padEnd(SCALE, '0').slice(0, SCALE));
}

/** A bigint carrying `scale` decimal places, as a plain decimal string with no trailing zeros. */
export function fromScaled(value: bigint, scale: number): string {
  if (value < 0n) throw new Error('fromScaled takes no negative value');
  const digits = value.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** DESIGN-VAULT 3.1: display = raw × multiplier / 10^decimals. Shares of the underlying, for display only. */
export function displayAmount(raw: bigint, multiplier: string, decimals: number): string {
  return fromScaled(raw * toScaled(multiplier), SCALE + decimals);
}

/**
 * A stock token's multiplier as the issuer's contract answers it (`uiMultiplier()`, 18 decimals, as
 * ERC-8056 has it) in the plain decimal form the schemas take. Zero is no multiplier at all, refused.
 */
export function multiplierString(word: bigint): string {
  if (word <= 0n) throw new Error('a multiplier is above zero');
  return fromScaled(word, SCALE);
}
