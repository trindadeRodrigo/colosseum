import type { ChainId } from '@colosseum/schemas';
import { type RpcCall, rpcAt } from '@colosseum/sdk';

// This app's own node per chain family, for the reads it makes itself instead of taking the API's
// word: the executor's look at a step that may have landed (run-order.ts), and the shared portfolio a
// follow is held to (features/shared/chain-recipe.ts). One node per chain, from this app's variables:
// a URL that balances calls across nodes is not one node.

const READ_RPC: Partial<Record<ChainId, string | undefined>> = {
  solana: process.env.NEXT_PUBLIC_CHAIN_READ_RPC_SOLANA,
  robinhood: process.env.NEXT_PUBLIC_CHAIN_READ_RPC_ROBINHOOD,
  base: process.env.NEXT_PUBLIC_CHAIN_READ_RPC_BASE,
};

/** The node of a chain, over HTTPS (or HTTP on this machine), or none. Redirects are refused. */
export function chainNode(chain: ChainId): RpcCall | undefined {
  const url = READ_RPC[chain];
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return undefined;
  } catch {
    return undefined;
  }
  return rpcAt(url, (input, init) => fetch(input, { ...init, redirect: 'error' }));
}
