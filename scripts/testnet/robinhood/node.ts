// The node a Robinhood Chain test network script talks to is the test network (46630), asked, never
// assumed from a file: a mainnet's chain id is refused before anything is read or signed.
import { MAINNET_CHAIN_IDS } from '@colosseum/chain-evm/vault';

export const TESTNET_CHAIN_ID = 46630;

/** Throws unless `chainId` is Robinhood Chain's test network. */
export function assertTestnetChainId(chainId: number): void {
  if (Object.values(MAINNET_CHAIN_IDS).includes(chainId))
    throw new Error(`the node answers chain id ${chainId}, a mainnet's: test network only`);
  if (chainId !== TESTNET_CHAIN_ID)
    throw new Error(`the node answers chain id ${chainId}, not ${TESTNET_CHAIN_ID}`);
}

/** What the node at `url` answers `eth_chainId` with. The URL is never quoted in an error. */
export async function nodeChainId(url: string): Promise<number> {
  let body: { result?: string };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    body = (await response.json()) as { result?: string };
  } catch {
    throw new Error('the test network RPC did not answer eth_chainId');
  }
  if (!body.result) throw new Error('the test network RPC gave no chain id');
  return Number(BigInt(body.result));
}

/** Asks the node and refuses anything but the test network. */
export async function assertTestnetNode(url: string): Promise<void> {
  assertTestnetChainId(await nodeChainId(url));
}
