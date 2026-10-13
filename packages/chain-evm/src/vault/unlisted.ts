import type { AssetId, ChainId } from '@colosseum/schemas';

// A token the app's asset list does not have, as the chain holds it: a target an author put in a shared
// portfolio, a line of a vault that follows it. It is shown, never refused, under an id made from its
// address, so one portfolio cannot break the app for everyone who follows it (the Solana adapter's
// `solana:mint-<hex>`, on EVM).

const MARK = ':token-';

/** '<chain>:token-' and the token's 20 bytes in lower-case hex: an AssetId no listed asset can have. */
export function unlistedAssetId(chain: ChainId, token: string): AssetId {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('not a 0x address');
  return `${chain}${MARK}${token.slice(2).toLowerCase()}`;
}

/** The token an unlisted asset's id was made from, lower-case 0x, or null for any other id. */
export function unlistedToken(id: string): string | null {
  const at = id.indexOf(MARK);
  if (at < 0) return null;
  const hex = id.slice(at + MARK.length);
  return /^[0-9a-f]{40}$/.test(hex) ? `0x${hex}` : null;
}
