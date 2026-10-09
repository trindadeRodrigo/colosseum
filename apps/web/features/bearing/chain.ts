import type { ChainId } from '@colosseum/schemas';

// The chain Bearing's figures are read for: Solana or Robinhood Chain, one at a time, named in the
// address (`?chain=robinhood`) so a link opens on it. With none named it is the one chosen on these
// pages last, kept in this browser, else Solana. It is a filter of these pages and nothing else (gate
// CHAIN-AT-THE-PLAN): it does not follow the chain a person's new plans start on, and choosing one
// here does not move that.

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

const KEY = 'tf-bearing-chain';

/** The chain chosen on these pages last, in this browser, or null. Storage may be off. */
export function recallBearingChain(): BearingChain | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    return isBearingChain(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function rememberBearingChain(chain: BearingChain): void {
  try {
    window.localStorage.setItem(KEY, chain);
  } catch {
    // Storage is off: the choice holds for this page only.
  }
}

/** The chain to read: the address's, else the one chosen here last, else Solana. */
export function pickChain(search: string, stored: string | null): BearingChain {
  return chainInSearch(search) ?? (isBearingChain(stored) ? stored : null) ?? FIRST;
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
