import type { AssetId, BasketAsset, Price, VaultState, VaultView } from '@colosseum/schemas';
import {
  apportion,
  BasketInputError,
  checkDecimals,
  formatDecimal,
  ONE_USD,
  parseDecimal,
  parseRaw,
  usdValue,
} from './amounts';

// The one place that turns what a vault holds, at prices, into dollars, weights and drift
// (DESIGN-VAULT 3.1). value = raw × usdPerToken / 10^decimals, with no multiplier: the reference price
// is for one whole token and already includes it.

/**
 * LOCAL TYPE. Neither `VaultState` nor `Price` says how many decimals a token has, and a value cannot
 * be worked out without it, so `view` and `planRebalance` take the chain's asset list as one more
 * argument than DESIGN-VAULT 3.6 writes. A `BasketAsset[]` fits.
 */
export type AssetUnits = Pick<BasketAsset, 'id' | 'decimals'>;

export type Measured = {
  asset: AssetId;
  raw: bigint;
  decimals: number | null;
  /** USD per whole token scaled by 1e18, or null when the asset has no price above zero. */
  price: bigint | null;
  /** Dollars scaled by 1e18, or null when the price or the decimals are missing. */
  value: bigint | null;
};

/**
 * Decimals by asset, and every price above zero by asset, scaled by 1e18. Two prices for one asset,
 * a price that is not a plain decimal and decimals that are not a whole number are refused.
 */
export function lookups(prices: readonly Price[], assets: readonly AssetUnits[]) {
  const decimalsOf = new Map<string, number>();
  for (const a of assets) decimalsOf.set(a.id, checkDecimals(a.decimals, a.id));
  const priceOf = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const p of prices) {
    if (seen.has(p.asset))
      throw new BasketInputError('DuplicatePrice', `${p.asset} has two prices; it takes one`);
    seen.add(p.asset);
    const scaled = parseDecimal(p.usdPerToken);
    if (scaled > 0n) priceOf.set(p.asset, scaled);
  }
  return { decimalsOf, priceOf };
}

/**
 * The vault's cash and each position, valued. The total counts what could be valued.
 *
 * Cash is one dollar, always, whatever a feed says: that is how the vaults count it (DESIGN-VAULT
 * section 5), and a weight worked out any other way would not be the weight the vault checks. A
 * price given for the cash token is ignored. A vault whose cash token is not on the asset list is
 * refused, since its cash could not be counted at all.
 */
export function measureVault(
  v: VaultState,
  prices: readonly Price[],
  assets: readonly AssetUnits[],
): { cash: Measured; positions: Measured[]; total: bigint } {
  const { decimalsOf, priceOf } = lookups(prices, assets);
  const cashDecimals = decimalsOf.get(v.cash.asset);
  if (cashDecimals === undefined)
    throw new BasketInputError(
      'CashNotListed',
      `${v.cash.asset}, the vault's cash token, is not on the asset list`,
    );
  const cashRaw = parseRaw(v.cash.raw);
  const cash: Measured = {
    asset: v.cash.asset,
    raw: cashRaw,
    decimals: cashDecimals,
    price: ONE_USD,
    value: usdValue(cashRaw, ONE_USD, cashDecimals),
  };
  const positions = v.positions.map((p): Measured => {
    const raw = parseRaw(p.raw);
    const decimals = decimalsOf.get(p.asset) ?? null;
    const price = priceOf.get(p.asset) ?? null;
    const value = price === null || decimals === null ? null : usdValue(raw, price, decimals);
    return { asset: p.asset, raw, decimals, price, value };
  });
  const total = [cash, ...positions].reduce((n, m) => n + (m.value ?? 0n), 0n);
  return { cash, positions, total };
}

/**
 * A vault with its dollar value, and each position's value, weight and drift against its target.
 *
 * - A weight is a share of everything the vault holds that has a price, cash included, in whole bps.
 *   Cash is one dollar, always.
 *   The weights of the positions and of the cash add up to exactly 10,000: each share is rounded down
 *   and the bps left over go to the largest remainders.
 * - A position with no price (or not on the asset list) has `valueUsd: null` and a weight of 0, and
 *   counts for nothing in the total. Its drift is then minus its target and means "unknown".
 * - Dollar strings are cut to six places.
 * - `driftBps` is `weightBps − targetBps`.
 */
export function view(
  v: VaultState,
  prices: readonly Price[],
  assets: readonly AssetUnits[],
): VaultView {
  const { cash, positions, total } = measureVault(v, prices, assets);
  const [, ...weights] = apportion(
    [cash, ...positions].map((m) => m.value ?? 0n),
    total === 0n ? 0n : 10_000n,
  );
  return {
    ...v,
    valueUsd: formatDecimal(total),
    positions: v.positions.map((p, i) => {
      const value = positions[i]?.value ?? null;
      const weightBps = Number(weights[i] ?? 0n);
      return {
        ...p,
        valueUsd: value === null ? null : formatDecimal(value),
        weightBps,
        driftBps: weightBps - p.targetBps,
      };
    }),
  };
}
