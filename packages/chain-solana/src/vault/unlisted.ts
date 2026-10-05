import type { AssetId } from '@colosseum/schemas';
import { type Address, getAddressDecoder, getAddressEncoder } from '@solana/kit';

// A token the app's asset list does not have, as the chain holds it: a target an author put in a shared
// portfolio, a line of a vault that follows it, a token sent to a vault. It is shown, never refused,
// under an id made from its mint, so one portfolio cannot break the app for everyone who follows it.

const PREFIX = 'solana:mint-';

/** 'solana:mint-' and the mint's 32 bytes in lower-case hex: an AssetId no listed asset can have. */
export function unlistedAssetId(mint: Address): AssetId {
  const bytes = getAddressEncoder().encode(mint);
  return `${PREFIX}${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The mint an unlisted asset's id was made from, or null for any other id. */
export function unlistedMint(id: string): Address | null {
  if (!id.startsWith(PREFIX)) return null;
  const hex = id.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return getAddressDecoder().decode(bytes);
}
