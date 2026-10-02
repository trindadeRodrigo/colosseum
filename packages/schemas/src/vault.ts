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
  ageSeconds: z.number().nonnegative(),
  market: z.enum(['open', 'closed', 'unknown']),
});
export type Price = z.infer<typeof Price>;

export const Holding = z.object({
  asset: AssetId,
  raw: RawAmount,
  multiplier: DecimalString,
  /** raw × multiplier / 10^decimals: shares of the underlying, for display only. */
  display: DecimalString,
});
export type Holding = z.infer<typeof Holding>;

export const VaultPosition = Holding.extend({
  targetBps: Bps,
  /** Unix seconds of the last keeper trade on this asset. */
  lastKeeperAt: z.number().int().nonnegative().nullable(),
});
export type VaultPosition = z.infer<typeof VaultPosition>;

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

/** One side is the chain's cash token. */
export const Trade = z.object({ sell: AssetId, buy: AssetId, amountInRaw: RawAmount });
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
  explorerUrl: z.string().min(1),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type TxStatus = z.infer<typeof TxStatus>;
