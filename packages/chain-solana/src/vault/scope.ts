import { fromScaled } from './amounts';

// Kamino Scope's price account, read by hand: its crate is BUSL-licensed (DESIGN-VAULT section 5).
// 28,712 bytes: a 40-byte header (Anchor's 8-byte discriminator and the address of the mappings
// account), then 512 entries of 56 bytes. Entry i starts at 40 + 56·i:
//   value u64 | exponent u64 | last updated slot u64 | unix time u64 | 24 bytes of the source's own data
// The price is value / 10^exponent, in USD for one whole token (10^decimals raw units). On a stock
// token it already includes the multiplier. On devnet the account is our test program's, with the same
// layout (GATES, SHOW).

export const SCOPE_HEADER_BYTES = 40;
export const SCOPE_ENTRY_BYTES = 56;
export const SCOPE_ENTRIES = 512;
export const SCOPE_PRICES_BYTES = SCOPE_HEADER_BYTES + SCOPE_ENTRY_BYTES * SCOPE_ENTRIES;

/** A price never needs more decimal places than this; a larger exponent is not a Scope entry. */
const MAX_EXPONENT = 30n;

export type ScopeEntry = {
  index: number;
  value: bigint;
  exponent: bigint;
  /** The slot of the update, on the cluster that wrote it. */
  slot: bigint;
  /** Unix seconds of the update. */
  unixTimestamp: bigint;
};

/**
 * `BasketAsset.priceRef` for `priceKind: 'scope'`: the entry's index in the price account named by the
 * chain config, as a decimal number from 0 to 511. Null for anything else.
 */
export function scopeIndex(priceRef: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})$/.test(priceRef)) return null;
  const index = Number(priceRef);
  return index < SCOPE_ENTRIES ? index : null;
}

/** Reads entry `index` out of a price account's data. Throws when the data is not that size. */
export function decodeScopeEntry(data: Uint8Array, index: number): ScopeEntry {
  if (data.length !== SCOPE_PRICES_BYTES)
    throw new Error(
      `not a Scope price account: ${data.length} bytes, expected ${SCOPE_PRICES_BYTES}`,
    );
  if (!Number.isInteger(index) || index < 0 || index >= SCOPE_ENTRIES)
    throw new Error(`a Scope index runs from 0 to ${SCOPE_ENTRIES - 1}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = SCOPE_HEADER_BYTES + SCOPE_ENTRY_BYTES * index;
  return {
    index,
    value: view.getBigUint64(at, true),
    exponent: view.getBigUint64(at + 8, true),
    slot: view.getBigUint64(at + 16, true),
    unixTimestamp: view.getBigUint64(at + 24, true),
  };
}

/** An entry nobody has written, or one that cannot be a price: no value, no time, or an absurd exponent. */
export function isScopeEntrySet(entry: ScopeEntry): boolean {
  return entry.value > 0n && entry.unixTimestamp > 0n && entry.exponent <= MAX_EXPONENT;
}

/** value / 10^exponent as an exact decimal string. */
export function scopePrice(entry: ScopeEntry): string {
  if (!isScopeEntrySet(entry)) throw new Error(`Scope entry ${entry.index} holds no price`);
  return fromScaled(entry.value, Number(entry.exponent));
}
