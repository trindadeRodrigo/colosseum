import type { ChainId } from '@colosseum/schemas';

// The platform's own creator addresses, per network and chain, committed here: the badge "From
// tenonfi" is shown only for a portfolio whose creator is one of them, never on the server's word
// (`SharedFamily.platform`). Who owns a slug stays the server's word; whose address a portfolio is
// published from is the chain's, and the page shows it in full. Empty until the launch portfolios are
// published from a platform key: then each network's key is added here in that pull request.

/** A network as `networkFor` names it (features/order/readiness.ts). */
type Network = 'mainnet' | 'testnet' | 'mock';

export const PLATFORM_CREATORS: Partial<
  Record<Network, Partial<Record<ChainId, readonly string[]>>>
> = {
  testnet: { solana: [] },
  mainnet: { solana: [] },
};

/** True when `creator` is a platform address of this network and chain. */
export const isPlatformCreator = (
  network: Network | null,
  chain: ChainId,
  creator: string,
): boolean => (network ? (PLATFORM_CREATORS[network]?.[chain] ?? []).includes(creator) : false);
