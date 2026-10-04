import { type ChainStatus, ConfigResponse } from '@colosseum/schemas';
import { apiUrl } from './api-url';
import type { WalletChains } from './chains';

/**
 * Pure: what is wrong when the browser's chain table and the API's GET /v1/config are not on the same
 * networks, as a sentence, or null when they agree. The browser reads NEXT_PUBLIC_CHAIN_NETWORK_<CHAIN>
 * and the API reads CHAIN_NETWORK_<CHAIN>; one set without the other would have the wallet sign for a
 * network the API did not build for. A chain the API has switched off is not compared: nothing is
 * built for it.
 */
export function compareWithApi(chains: WalletChains, body: unknown): string | null {
  const parsed = ConfigResponse.safeParse(body);
  if (!parsed.success) return 'the API answered /v1/config in a form this app cannot read';
  for (const id of ['solana', 'robinhood', 'base'] as const) {
    const mine = chains[id];
    const theirs = parsed.data.chains.find((c) => c.id === id);
    if (!theirs) return `${mine.config.name}: the API does not list this chain`;
    if (theirs.mode === 'off') continue;
    const upper = id.toUpperCase();
    if (theirs.network !== mine.network)
      return `${mine.config.name}: the API is on ${theirs.networkName} and this app on ${mine.config.networkName}. Set NEXT_PUBLIC_CHAIN_NETWORK_${upper} to match CHAIN_NETWORK_${upper}`;
    if (theirs.evmChainId !== mine.config.evmChainId)
      return `${mine.config.name}: the API is on chain id ${theirs.evmChainId} and this app on ${mine.config.evmChainId}`;
  }
  return null;
}

/**
 * `again` is true when the API could not be asked at all, so asking later may give another answer.
 * When all is well the API's own account of its chains comes along: how each is run (on the mock, on
 * a test network) is what a screen labels a chain with.
 */
export type ApiCheck =
  | { ok: true; chains: ChainStatus[] }
  | { ok: false; problem: string; again: boolean };

/**
 * Asks the API which networks it is on and compares. When the API cannot be reached the answer is a
 * problem too: the app does not fall back to its own table, because that is the case this guards.
 */
export async function checkApi(
  chains: WalletChains,
  api: string,
  get: typeof fetch = fetch,
): Promise<ApiCheck> {
  let body: unknown;
  try {
    const res = await get(apiUrl(api, '/v1/config'), { cache: 'no-store', redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch {
    const problem = `the API at ${new URL(api).host} cannot be reached, so its networks cannot be checked against this app's`;
    return { ok: false, problem, again: true };
  }
  const problem = compareWithApi(chains, body);
  if (problem) return { ok: false, problem, again: false };
  // compareWithApi has just read it in this form.
  return { ok: true, chains: ConfigResponse.parse(body).chains };
}
