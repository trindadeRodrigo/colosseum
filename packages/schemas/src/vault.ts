import { z } from 'zod';
import {
  Address,
  AssetId,
  BasketId,
  Bps,
  ChainId,
  DecimalString,
  RawAmount,
  Sourced,
} from './chain';

// DESIGN-VAULT 3.1.

export const Price = Sourced.extend({
  asset: AssetId,
  /** USD for one whole token (10^decimals raw units). It already includes the multiplier. */
  usdPerToken: DecimalString,
  /** How old the price is on the chain's own clock. A stale price is still returned, with its age. */
  ageSeconds: z.number().nonnegative(),
  /**
   * The oldest a price of this asset may be for the chain's vault to trade on it (DESIGN-VAULT section
   * 5, check 8), read from the chain: `Config.max_price_age_s` on Solana, the asset's `maxAge` on EVM.
   * It travels with the price so a caller that holds only the price can tell stale from fresh.
   */
  maxAgeSeconds: z.number().int().nonnegative(),
  market: z.enum(['open', 'closed', 'unknown']),
});
export type Price = z.infer<typeof Price>;

/** True when the price is older than the chain's vault accepts: the keeper will not trade on it. */
export function isStalePrice(price: Pick<Price, 'ageSeconds' | 'maxAgeSeconds'>): boolean {
  return price.ageSeconds > price.maxAgeSeconds;
}

export const Holding = z.object({
  asset: AssetId,
  raw: RawAmount,
  /** The multiplier in force now. '1' for a token that has none. */
  multiplier: DecimalString,
  /** raw × multiplier / 10^decimals: shares of the underlying, for display only. */
  display: DecimalString,
  /**
   * A multiplier the token's issuer has scheduled and that is not in force yet: its value, and the unix
   * second from which it applies. Present only when the mint has one waiting. The keeper does not trade
   * the asset within 24 hours of that time (section 5, check 10).
   */
  scheduled: z
    .object({ multiplier: DecimalString, effectiveAt: z.number().int().nonnegative() })
    .optional(),
});
export type Holding = z.infer<typeof Holding>;

export const VaultPosition = Holding.extend({
  targetBps: Bps,
  /** Unix seconds of the last keeper trade on this asset. */
  lastKeeperAt: z.number().int().nonnegative().nullable(),
});
export type VaultPosition = z.infer<typeof VaultPosition>;

/** The most characters a vault's name has. */
export const VAULT_NAME_MAX = 60;
/**
 * A vault's name, as its owner wrote it: trimmed, one to sixty characters, on one line, with no
 * control character (a tab, a line break, a bidirectional override). It is text and is shown as text.
 */
export const VaultName = z
  .string()
  .trim()
  .min(1, 'a name has at least one character')
  .max(VAULT_NAME_MAX, `a name has at most ${VAULT_NAME_MAX} characters`)
  .refine((s) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s), 'a name has no control character');
export type VaultName = z.infer<typeof VaultName>;

/**
 * A vault's number among its owner's vaults, from 1 (gate `VAULT-NUMBER`): a vault with no name is
 * called "Vault #N". It is the owner's own count across every chain, given once in the order the
 * server came to hold their vaults and never changed after. Only the owner is answered it.
 */
export const VaultNumber = z.number().int().positive();
export type VaultNumber = z.infer<typeof VaultNumber>;

export const VaultState = z.object({
  chain: ChainId,
  address: Address,
  owner: Address,
  basketId: BasketId,
  recipeOnchainId: z.string().min(1).nullable(),
  acceptedVersion: z.number().int().nonnegative(),
  autoFollow: z.boolean(),
  keeper: Address,
  cash: Holding,
  positions: z.array(VaultPosition),
  lossUsedBps: Bps,
  observedAt: z.string().datetime(),
  /** A published version of the followed shared portfolio that is not yet applied. */
  pending: z
    .object({
      version: z.number().int().min(1),
      effectiveAt: z.number().int().nonnegative(),
      newAssets: z.array(AssetId),
    })
    .nullable(),
});
export type VaultState = z.infer<typeof VaultState>;

/** Filled by `view()` in packages/basket, never by an adapter. */
export const VaultView = VaultState.extend({
  valueUsd: DecimalString,
  positions: z.array(
    VaultPosition.extend({
      /** Null when the asset has no price. */
      valueUsd: DecimalString.nullable(),
      weightBps: Bps,
      /** weightBps minus targetBps. */
      driftBps: z.number().int().min(-10_000).max(10_000),
    }),
  ),
});
export type VaultView = z.infer<typeof VaultView>;

export const TradeBase = z.object({ sell: AssetId, buy: AssetId, amountInRaw: RawAmount });

/** One side is the chain's cash token; both sides are on one chain. */
export const Trade = TradeBase.refine(
  (t) => t.sell !== t.buy,
  'a trade has two different sides',
).refine(
  (t) => t.sell.split(':')[0] === t.buy.split(':')[0],
  'both sides of a trade are on one chain',
);
export type Trade = z.infer<typeof Trade>;

export const Quote = Sourced.extend({
  trade: Trade,
  outRaw: RawAmount,
  minOutRaw: RawAmount,
  costBps: z.number(),
  against: z.enum(['reference', 'pool_mid']),
  venue: z.string().min(1),
});
export type Quote = z.infer<typeof Quote>;

/** What a wallet has and what an order needs on one chain: cash plus native gas. */
export const Funding = z.object({
  chain: ChainId,
  cashHaveRaw: RawAmount,
  cashNeedRaw: RawAmount,
  gasHaveRaw: RawAmount,
  gasNeedRaw: RawAmount,
  ok: z.boolean(),
});
export type Funding = z.infer<typeof Funding>;

export const TxStatus = z.object({
  status: z.enum(['pending', 'confirmed', 'reverted', 'expired']),
  /** Empty on a network with no explorer (a local copy). */
  explorerUrl: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type TxStatus = z.infer<typeof TxStatus>;
