import type { ChainId } from '@colosseum/schemas';

// The chain someone is looking at before they sign in (gate CHAIN-SWITCH): the shelf shows that
// chain's portfolios, and a passkey sign-in starts there. It is remembered in this browser, and named
// in the address of a page that shows one chain (`?chain=robinhood`), so a link opens on it.

/** The chains the switcher offers: one per wallet family, while Base is not deployed. */
export const SWITCHABLE: readonly ChainId[] = ['solana', 'robinhood'];

/** Where someone who has chosen nothing starts. */
export const FIRST_CHAIN: ChainId = 'solana';

const KEY = 'tf-chain';

/** A chain the switcher offers, from a stored value or an address; null for anything else. */
export function switchable(value: unknown): ChainId | null {
  return SWITCHABLE.find((chain) => chain === value) ?? null;
}

/** The chain this browser was last on, or null. Storage may be off: nothing is assumed then. */
export function recallChain(): ChainId | null {
  try {
    return switchable(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function rememberChain(chain: ChainId): void {
  try {
    window.localStorage.setItem(KEY, chain);
  } catch {
    // Storage is off: the choice holds for this page only.
  }
}

/** The chain the address names (`?chain=`), or null. */
export function chainInAddress(search: string): ChainId | null {
  return switchable(new URLSearchParams(search).get('chain'));
}
