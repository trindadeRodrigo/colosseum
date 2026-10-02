import type { Holding, Price, VaultState, VaultView } from '@colosseum/schemas';

// TEMPORARY, until BAS-1: `view(vault, prices)` in packages/basket is the one place that computes
// value, weight and drift (DESIGN-VAULT 3.1), and it does not exist yet. This is the smallest version
// of it, behind the same signature, so the portfolio route changes one import when it lands.
//
// value = raw × usdPerToken / 10^decimals, with no multiplier: the price is for one whole token. A
// holding carries no decimals, so the same value is reached as display × usdPerToken / multiplier.
// Exact: integers only, never a float.

type Fraction = { n: bigint; d: bigint };

/** '2.55' as 255/100. */
function fraction(decimal: string): Fraction {
  const [whole = '0', frac = ''] = decimal.split('.');
  return { n: BigInt(whole + frac), d: 10n ** BigInt(frac.length) };
}

/** Dollars scaled by 1e18, or null when the holding cannot be valued. */
function valueScaled(holding: Holding, price: Price | undefined): bigint | null {
  if (!price) return null;
  const display = fraction(holding.display);
  const usd = fraction(price.usdPerToken);
  const multiplier = fraction(holding.multiplier);
  if (multiplier.n === 0n) return null;
  return (display.n * usd.n * multiplier.d * 10n ** 18n) / (display.d * usd.d * multiplier.n);
}

/** Dollars scaled by 1e18 as a figure with two decimals, cut and not rounded. */
function dollars(scaled: bigint): string {
  const cents = scaled / 10n ** 16n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/**
 * A vault with what it is worth. An asset with no price has a null value and counts for nothing in the
 * total. `weightBps` is the share of the total, rounded down; `driftBps` is weight minus target.
 */
export function view(vault: VaultState, prices: Price[]): VaultView {
  const byAsset = new Map(prices.map((p) => [p.asset, p]));
  const cash = valueScaled(vault.cash, byAsset.get(vault.cash.asset)) ?? 0n;
  const values = vault.positions.map((p) => valueScaled(p, byAsset.get(p.asset)));
  const total = values.reduce<bigint>((sum, v) => sum + (v ?? 0n), cash);
  return {
    ...vault,
    valueUsd: dollars(total),
    positions: vault.positions.map((p, i) => {
      const value = values[i] ?? null;
      const weightBps = value === null || total === 0n ? 0 : Number((value * 10_000n) / total);
      return {
        ...p,
        valueUsd: value === null ? null : dollars(value),
        weightBps,
        driftBps: weightBps - p.targetBps,
      };
    }),
  };
}
