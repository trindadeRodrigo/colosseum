import type { ChainId } from '@colosseum/schemas';

// The chain Bearing's figures are read for: Solana or Robinhood Chain, one at a time, named in the
// address (`?chain=robinhood`) so a link opens on it. With none named it follows the chain the app's bar
// is on, else the one this browser was last on (the bar's own memory, `recallChain` of
// features/account/chain-choice.ts, gate CHAIN-SWITCH), else Solana. Choosing one here is remembered
// the same way (`rememberChain`), so the bar of someone signed out opens on it next time. It does not
// move a signed-in person's chain: that is where their plans are made, and the bar's to change.

export const BEARING_CHAINS = ['solana', 'robinhood'] as const satisfies readonly ChainId[];
export type BearingChain = (typeof BEARING_CHAINS)[number];
export const FIRST: BearingChain = 'solana';

export const isBearingChain = (v: unknown): v is BearingChain =>
  BEARING_CHAINS.some((c) => c === v);

/** The chain the address names, or null. */
export const chainInSearch = (search: string): BearingChain | null => {
  const v = new URLSearchParams(search).get('chain');
  return isBearingChain(v) ? v : null;
};

/** The chain to read: the address's, else the bar's, else this browser's, else Solana. */
export function pickChain(
  search: string,
  bar: ChainId | null | undefined,
  stored: string | null,
): BearingChain {
  return (
    chainInSearch(search) ??
    (isBearingChain(bar) ? bar : null) ??
    (isBearingChain(stored) ? stored : null) ??
    FIRST
  );
}

/** The address with the chain named in it, the rest of its query kept. */
export function withChain(pathname: string, search: string, chain: BearingChain): string {
  const q = new URLSearchParams(search);
  q.set('chain', chain);
  return `${pathname}?${q.toString()}`;
}

/** A Bearing page's address on a chain. */
export const onChain = (path: string, chain: BearingChain) =>
  `${path}${path.includes('?') ? '&' : '?'}chain=${chain}`;

/**
 * The key an asset's own routes are read by: on Solana its symbol, as Rodrigo's prototype reads them; on
 * Robinhood Chain its address, which every route resolves (the symbol alone names no row there).
 */
export const readKey = (
  asset: { symbol: string; assetMint?: string; chain?: string } | undefined,
  symbol: string,
): string => (asset?.chain === 'robinhood' && asset.assetMint ? asset.assetMint : symbol);
