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
  /**
   * Where the price is, by `priceKind`.
   * - `scope`: the entry index as a decimal string, 0 to 511, in the chain's price account
   *   (`ChainConfig.priceSource.address`).
   * - `chainlink`: the address of the asset's feed.
   * - `none`: empty.
   */
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
  /**
   * ISO 4217: the currency a cash token is counted in, when it is not dollars. A goal in that
   * currency holds its near withdrawals in it (the matching leg, gate SOLVER). Left out: dollars.
   * Only cash tokens carry it. No token on the shelf has one yet, so the database has no column for
   * it: the column comes with the first such token.
   */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

/** An asset belongs to one chain: its id starts with that chain and its address is in that chain's form. */
export const BasketAsset = BasketAssetBase.refine((a) => a.id.startsWith(`${a.chain}:`), {
  message: "the id starts with the asset's chain",
  path: ['id'],
})
  .refine((a) => isAddressOf(chainFamily(a.chain), a.address), {
    message: "the address is in the form of the asset's chain",
    path: ['address'],
  })
  .refine((a) => a.currency === undefined || a.cls === 'cash', {
    message: 'only a cash token is counted in a currency of its own',
    path: ['currency'],
  });
export type BasketAsset = z.infer<typeof BasketAsset>;
