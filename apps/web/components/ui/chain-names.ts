import type { ChainId } from '@colosseum/schemas';

/** A chain's name is a name: the same in every language. */
export const CHAIN_NAMES: Record<ChainId, string> = {
  solana: 'Solana',
  robinhood: 'Robinhood Chain',
  base: 'Base',
};
