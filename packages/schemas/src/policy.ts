import { z } from 'zod';
import { PolicyMechanism } from './enums';
import { LiquidityTrigger } from './liquidity';

export const WeightBand = z.object({
  assetId: z.string(),
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
});
export type WeightBand = z.infer<typeof WeightBand>;

/** Delegated-execution config (mechanism A): the agent key and the on-chain approvals it may spend, per asset, in base units. */
export const Delegation = z.object({
  agent: z.string().min(32),
  approvedBase: z.record(z.string(), z.string()),
});
export type Delegation = z.infer<typeof Delegation>;

/**
 * The stored policy: allowed assets, weight bands, trigger, withdrawals only to the owner.
 * `mechanism` is the default; `mechanismByAsset` overrides per asset (Kamino and xStocks stay `user_signed`).
 */
export const Policy = z.object({
  id: z.string(),
  planId: z.string(),
  wallet: z.string(),
  allowedAssets: z.array(z.string()).min(1),
  bands: z.array(WeightBand),
  trigger: z.object({
    driftPct: z.number().positive(),
    minIntervalHours: z.number().positive(),
    /** Optional liquidity trigger (risk layer). */
    liquidity: LiquidityTrigger.optional(),
  }),
  withdrawalDestination: z.string(),
  mechanism: PolicyMechanism,
  mechanismByAsset: z.record(z.string(), PolicyMechanism).default({}),
  delegation: Delegation.optional(),
  createdAt: z.string().datetime(),
});
export type Policy = z.infer<typeof Policy>;

/** What the rebalance engine proposes: one swap per order, always delivered to the owner. */
export const LegOrder = z.object({
  fromAssetId: z.string(),
  toAssetId: z.string(),
  amountUsd: z.number().positive(),
  mechanism: PolicyMechanism,
  destination: z.string(),
  reason: z.string(),
});
export type LegOrder = z.infer<typeof LegOrder>;
