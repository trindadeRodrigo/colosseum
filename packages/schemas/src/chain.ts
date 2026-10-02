import { z } from 'zod';
import { type Chain, Provenance } from './enums';

// DESIGN-VAULT 3.1. `Chain` ('solana' | 'evm') in enums.ts stays and means the wallet family.

/** A chain a vault lives on. A new chain is a new value here and a row in `chains`. */
export const ChainId = z.enum(['solana', 'base', 'robinhood']);
export type ChainId = z.infer<typeof ChainId>;

export function chainFamily(chain: ChainId): Chain {
  return chain === 'solana' ? 'solana' : 'evm';
}

/** base58 on Solana; lower-case 0x on EVM, so an address compares equal as a string. */
export const Address = z
  .string()
  .regex(
    /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-f]{40})$/,
    'expected a base58 address or a lower-case 0x address',
  );
export type Address = z.infer<typeof Address>;

/** Raw token units as a decimal string. Never a float. */
export const RawAmount = z
  .string()
  .max(78)
  .regex(/^(?:0|[1-9]\d*)$/, 'expected raw units as a decimal string');
export type RawAmount = z.infer<typeof RawAmount>;

/** A change in raw units: a RawAmount with an optional minus sign. */
export const RawDelta = z
  .string()
  .max(79)
  .regex(/^(?:0|-?[1-9]\d*)$/, 'expected a signed decimal string');
export type RawDelta = z.infer<typeof RawDelta>;

/** A non-negative decimal number as a string ('2.55', '250'). Used for prices, multipliers and display amounts. */
export const DecimalString = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'expected a decimal');
export type DecimalString = z.infer<typeof DecimalString>;

/** `${ChainId}:${slug}`, for example 'solana:spyx'. */
export const AssetId = z
  .string()
  .regex(/^(?:solana|base|robinhood):[a-z0-9][a-z0-9-]*$/, 'expected chain:slug');
export type AssetId = z.infer<typeof AssetId>;

/** Integer basis points of a whole: 0 to 10,000. */
export const Bps = z.number().int().min(0).max(10_000);
export type Bps = z.infer<typeof Bps>;

/** Where a figure came from. Every price, quote and preview carries it. */
export const Sourced = z.object({
  source: z.string().min(1),
  method: z.string().min(1),
  fetchedAt: z.string().datetime(),
  provenance: Provenance,
});
export type Sourced = z.infer<typeof Sourced>;

/** The decimal string of a 64-bit number, chosen by the client per owner. Solana seed and EVM salt. */
export const BasketId = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,19})$/, 'expected a 64-bit number as a decimal string')
  .refine((s) => BigInt(s) <= 0xffff_ffff_ffff_ffffn, 'larger than 64 bits');
export type BasketId = z.infer<typeof BasketId>;

/** 32 bytes in lower-case hex, no prefix: a family id or a meta hash. */
export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 32 bytes in lower-case hex');
export type Hex32 = z.infer<typeof Hex32>;
