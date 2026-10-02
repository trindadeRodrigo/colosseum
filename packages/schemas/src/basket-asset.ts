import { z } from 'zod';
import { Address, AssetId, Bps, ChainId, chainFamily, isAddressOf } from './chain';
import { Provenance } from './enums';

// DESIGN-VAULT 3.1. The structurer's `Asset` in asset.ts is untouched.

export const AssetClass = z.enum([
  'stock',
  'etf',
  'gold',
  'commodity',
  'dollar_yield',
  'crypto',
  'cash',
]);
export type AssetClass = z.infer<typeof AssetClass>;

export const AssetTier = z.enum(['A', 'B', 'C']);
export type AssetTier = z.infer<typeof AssetTier>;

/** Where an asset's reference price comes from. `none` means the keeper never trades it. */
export const PriceKind = z.enum(['scope', 'chainlink', 'none']);
export type PriceKind = z.infer<typeof PriceKind>;

export const BasketAssetBase = z.object({
  id: AssetId,
  chain: ChainId,
  address: Address,
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(18),
  cls: AssetClass,
  /** 'NVDA' for NVDAx, NVDAc and NVDA. */
  underlying: z.string().min(1),
  issuer: z.string().min(1),
  tier: AssetTier,
  priceKind: PriceKind,
  priceRef: z.string(),
  session: z.enum(['always', 'us_equity']),
  autoFollowEligible: z.boolean(),
  /** Creator cap, section 6. */
  maxWeightBps: Bps,
  /** ISO two-letter codes. */
  blockedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)),
  /** The risk sheet this asset points to, under content/risk-sheets/. */
  sheet: z.string(),
  provenance: Provenance,
});

/** An asset belongs to one chain: its id starts with that chain and its address is in that chain's form. */
export const BasketAsset = BasketAssetBase.refine((a) => a.id.startsWith(`${a.chain}:`), {
  message: "the id starts with the asset's chain",
  path: ['id'],
}).refine((a) => isAddressOf(chainFamily(a.chain), a.address), {
  message: "the address is in the form of the asset's chain",
  path: ['address'],
});
export type BasketAsset = z.infer<typeof BasketAsset>;
