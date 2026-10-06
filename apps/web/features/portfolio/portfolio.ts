import {
  type ChainId,
  isStalePrice,
  PortfolioResponse,
  type Price,
  type Provenance,
} from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';
import { type ApiFetch, signInRefusal } from '../account/person';

// What the monitor and the home page read of a person's vaults: GET /v1/portfolio, the one route the
// API has for it (DESIGN-VAULT 3.3). It answers for the one chain the person's plans live on, with
// each vault's holdings, their value, weight and drift, and the prices they were valued at. Nothing
// here works a figure out: value, weight and drift are the API's (packages/basket), and a figure's
// source, time and method are handed on to its pin as they came.
//
//   GET /v1/portfolio
//   200     { chains: [{ chain, name, mode, provenance, vaults, prices }], disclaimer }
//   401/403 the server does not know this sign-in, or was sent no identity token
//   409     no chain is chosen yet (or the chain refused the read: `details.chainCode`)
//   429     it asked for fewer requests
//   503     the chain is switched off here, or did not answer
//
// A server without the route answers 404, and the screen says it cannot read vaults: it shows no
// holdings in their place.

export const PORTFOLIO_PATH = '/v1/portfolio';

export type PortfolioChain = PortfolioResponse['chains'][number];
export type Vault = PortfolioChain['vaults'][number];
export type Position = Vault['positions'][number];

export type PortfolioOutcome =
  | { kind: 'read'; chain: PortfolioChain }
  /** The route is not there: this server cannot read vaults. */
  | { kind: 'unavailable' }
  /** The server does not know this sign-in any more (401), or does not let it read (403). */
  | { kind: 'signed-out' }
  /** The server was sent no identity token (401). */
  | { kind: 'no-identity' }
  /** The server has no chain for this person yet (409). */
  | { kind: 'no-chain' }
  /** The chain is switched off here, or did not answer: the plan's chain is unavailable. */
  | { kind: 'chain-down' }
  | { kind: 'busy' }
  | { kind: 'unreachable' }
  /** An answer that is not a portfolio in the frozen shape, or not for the person's chain. */
  | { kind: 'unreadable' };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * The person's vaults on `chain`. The API answers for every chain the person holds a wallet for
 * (CHAIN-SWITCH); this reads that chain's entry. An answer with no entry for it, two entries for it, or
 * a vault of another chain inside it is not shown.
 */
export async function readPortfolio(apiFetch: ApiFetch, chain: ChainId): Promise<PortfolioOutcome> {
  let res: Response;
  try {
    res = await apiFetch(PORTFOLIO_PATH);
  } catch {
    return { kind: 'unreachable' };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501)
    return { kind: 'unavailable' };
  if (res.status === 429) return { kind: 'busy' };
  if (res.status === 401)
    return (await signInRefusal(res)) === 'no_identity'
      ? { kind: 'no-identity' }
      : { kind: 'signed-out' };
  if (res.status === 403) return { kind: 'signed-out' };
  if (res.status === 503) return { kind: 'chain-down' };
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 409)
    // The person route's 409 names no chain code; a refusal that came from the chain does.
    return 'chainCode' in record(record(body).details)
      ? { kind: 'chain-down' }
      : { kind: 'no-chain' };
  if (!res.ok) return { kind: 'unreachable' };
  const parsed = PortfolioResponse.safeParse(body);
  if (!parsed.success) return { kind: 'unreadable' };
  const [only, ...more] = parsed.data.chains.filter((entry) => entry.chain === chain);
  if (!only || more.length > 0) return { kind: 'unreadable' };
  if (only.vaults.some((vault) => vault.chain !== chain)) return { kind: 'unreadable' };
  return { kind: 'read', chain: only };
}

/**
 * Not live wins: two labels that are both live are live, one that is not is that one, and two that
 * differ and are not live are MOCK.
 */
export function worst(a: Provenance, b: Provenance): Provenance {
  if (a === 'live') return b;
  if (b === 'live' || a === b) return a;
  return 'mock';
}

/** The price the API valued an asset at, if it gave one. */
export const priceOf = (chain: PortfolioChain, asset: string): Price | null =>
  chain.prices.find((price) => price.asset === asset) ?? null;

/**
 * The pin of one holding's value: its price's source and time, the price's method with the words that
 * say it was multiplied by the amount, and the label of the vault or the price, whichever is not live.
 * Stale when the price is: the API states that (`isStalePrice`), nothing here reads a clock.
 */
export function positionValueSource(
  vault: Vault,
  price: Price,
  method: (priceMethod: string) => string,
): PinSource {
  return {
    source: price.source,
    fetchedAt: price.fetchedAt,
    method: method(price.method),
    provenance: worst(vault.provenance, price.provenance),
    staleAgeSec: isStalePrice(price) ? price.ageSeconds : null,
  };
}

/**
 * The pin of a vault's whole value. It stands on every price of a holding that has one, and on the
 * read of the vault: the sources of those prices, the oldest of their times and the vault's, the
 * method in the view's words, the label that is not live if any is, and the age of the oldest stale
 * price, when one is stale. With no priced holding (only cash), the source is the chain's read.
 */
export function vaultValueSource(chain: PortfolioChain, vault: Vault, method: string): PinSource {
  const used = vault.positions
    .map((position) => (position.valueUsd === null ? null : priceOf(chain, position.asset)))
    .filter((price): price is Price => price !== null);
  const sources = [...new Set(used.map((price) => price.source))];
  const times = [vault.observedAt, ...used.map((price) => price.fetchedAt)];
  const oldest = times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  const stale = used.filter(isStalePrice).map((price) => price.ageSeconds);
  return {
    source: sources.length > 0 ? sources.join(' + ') : chain.name,
    fetchedAt: oldest,
    method,
    provenance: used.reduce((label, price) => worst(label, price.provenance), vault.provenance),
    staleAgeSec: stale.length > 0 ? Math.max(...stale) : null,
  };
}

/** How many holdings the value leaves out, because the API had no price for them. */
export const unpriced = (vault: Vault): number =>
  vault.positions.filter((position) => position.valueUsd === null).length;

/** How an asset is named in a row: the part of its id after the chain, as a ticker. */
export const assetName = (asset: string): string => (asset.split(':')[1] ?? asset).toUpperCase();
