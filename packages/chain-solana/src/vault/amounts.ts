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
 * A multiplier as the token program stores it (a 64-bit float) in the plain decimal form the schemas
 * take. JavaScript prints the shortest digits that read back as the same float, so 1.003909 stays
 * '1.003909'. Throws on anything that is not a positive, finite number with a plain decimal form.
 */
export function multiplierString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error('a multiplier is a positive number');
  const text = value.toString();
  // Exponent form ('1e-7', '1e+21') only appears far from any real multiplier.
  const plain = /e/i.test(text) ? value.toFixed(SCALE).replace(/\.?0+$/, '') : text;
  if (!/^\d+(\.\d+)?$/.test(plain) || toScaled(plain) === 0n)
    throw new Error('a multiplier outside the range a decimal string holds');
  return plain;
}
