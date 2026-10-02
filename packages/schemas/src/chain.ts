import { z } from 'zod';
import { type Chain, Provenance } from './enums';

// DESIGN-VAULT 3.1. `Chain` ('solana' | 'evm') in enums.ts stays and means the wallet family.

/** A chain a vault lives on. A new chain is a new value here and a row in `chains`. */
export const ChainId = z.enum(['solana', 'base', 'robinhood']);
export type ChainId = z.infer<typeof ChainId>;

export function chainFamily(chain: ChainId): Chain {
  return chain === 'solana' ? 'solana' : 'evm';
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** How many bytes a base58 string stands for, or -1 when a character is not base58. */
function base58ByteLength(text: string): number {
  let n = 0n;
  let zeros = 0;
  let leading = true;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) return -1;
    if (leading && digit === 0) zeros += 1;
    else leading = false;
    n = n * 58n + BigInt(digit);
  }
  return zeros + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2));
}

/** A Solana address: base58 that decodes to exactly 32 bytes. */
export const SolanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'expected a base58 address')
  .refine((s) => base58ByteLength(s) === 32, 'expected 32 bytes in base58');
export type SolanaAddress = z.infer<typeof SolanaAddress>;

/** An EVM address in its one canonical form here: lower-case 0x. Use normalizeAddress() on outside input. */
export const EvmAddress = z.string().regex(/^0x[0-9a-f]{40}$/, 'expected a lower-case 0x address');
export type EvmAddress = z.infer<typeof EvmAddress>;

/** base58 on Solana; lower-case 0x on EVM, so an address compares equal as a string. */
export const Address = z.union([SolanaAddress, EvmAddress]);
export type Address = z.infer<typeof Address>;

/** The address schema of one wallet family. */
export const AddressOf = { solana: SolanaAddress, evm: EvmAddress } as const;

/** True when `address` is in the form of `family`. For cross-field checks. */
export function isAddressOf(family: Chain, address: string): boolean {
  return AddressOf[family].safeParse(address).success;
}

/**
 * An address from outside (a wallet provider, a config value) in the form used here: an EVM address is
 * lower-cased, whatever its checksum case; a Solana address is left as it is. Throws when it is not an
 * address of that family. The message never repeats the value.
 */
export function normalizeAddress(family: Chain, value: string): Address {
  const trimmed = value.trim();
  const candidate = family === 'evm' ? trimmed.toLowerCase() : trimmed;
  const parsed = AddressOf[family].safeParse(candidate);
  if (!parsed.success)
    throw new Error(family === 'evm' ? 'not a 0x address' : 'not a base58 address of 32 bytes');
  return parsed.data;
}

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
