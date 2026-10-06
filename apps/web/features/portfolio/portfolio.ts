import {
  type ChainId,
  isStalePrice,
  PortfolioResponse,
  type Price,
  type Provenance,
} from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';
import { type ApiFetch, signInRefusal } from '../account/person';
import { assetTicker } from '../order/amounts';

// What the monitor and the home page read of a person's vaults: GET /v1/portfolio, the one route the
// API has for it (DESIGN-VAULT 3.3). It answers an entry per chain, the person's own chain among them,
// with each vault's holdings, their value, weight and drift, and the prices they were valued at.
// Today the API answers the person's chain alone; a person with vaults on two chains is read the same
// way, and the screens keep each chain's figures apart. Nothing
// here works a figure out: value, weight and drift are the API's (packages/basket), and a figure's
// source, time and method are handed on to its pin as they came.
//
//   GET /v1/portfolio
//   200     { chains: [{ chain, name, mode, provenance, vaults, prices }], unavailable, disclaimer }
//           `unavailable`: the person's chains that could not be read this time, each with why; the
//           others are answered all the same
//   401/403 the server does not know this sign-in, or was sent no identity token
//   409     no chain is chosen yet (or the chain refused the read: `details.chainCode`)
//   429     it asked for fewer requests
//   503     none of the person's chains could be read
//
// A server without the route answers 404, and the screen says it cannot read vaults: it shows no
// holdings in their place.

export const PORTFOLIO_PATH = '/v1/portfolio';

export type PortfolioChain = PortfolioResponse['chains'][number];
export type UnavailableChain = PortfolioResponse['unavailable'][number];
export type Vault = PortfolioChain['vaults'][number];
export type Position = Vault['positions'][number];

export type PortfolioOutcome =
  /**
   * Every chain the API could read, the person's current chain first when it is among them; the
   * chains it could not read, with why; and where the current chain stands: read, unavailable this
   * time, or not held in this sign-in (no wallet of theirs signs there, so nothing was asked of it).
   */
  | {
      kind: 'read';
      chains: PortfolioChain[];
      unavailable: UnavailableChain[];
      current: 'read' | 'unavailable' | 'not-held';
    }
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
 * The person's vaults on `chain`, the chain their plan lives on. An answer that names another chain,
 * or more than one, is not shown: a plan lives on one chain (gate ONE-CHAIN).
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
  const entries = parsed.data.chains;
  const { unavailable } = parsed.data;
  // A chain twice, read and unavailable at once, or a vault filed under a chain it is not on.
  const named = [...entries.map((entry) => entry.chain), ...unavailable.map((u) => u.chain)];
  if (new Set(named).size !== named.length) return { kind: 'unreadable' };
  if (entries.some((entry) => entry.vaults.some((vault) => vault.chain !== entry.chain)))
    return { kind: 'unreadable' };
  // The chains that were read are shown, whatever happened to the current one.
  const own = entries.find((entry) => entry.chain === chain);
  return {
    kind: 'read',
    chains: own ? [own, ...entries.filter((entry) => entry !== own)] : entries,
    unavailable,
    current: own ? 'read' : unavailable.some((u) => u.chain === chain) ? 'unavailable' : 'not-held',
  };
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

/**
 * Decimal strings added up exactly, as a decimal string: `1040` and `20.5` make `1060.5`. A chain's
 * total is its vaults' values added; nothing is added across chains unless a screen says so.
 */
export function addDecimals(values: readonly string[]): string {
  const places = Math.max(0, ...values.map((v) => v.split('.')[1]?.length ?? 0));
  const sum = values.reduce((total, v) => {
    const [whole = '0', part = ''] = v.split('.');
    return total + BigInt(whole + part.padEnd(places, '0'));
  }, 0n);
  if (places === 0) return sum.toString();
  const digits = sum.toString().padStart(places + 1, '0');
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return fraction ? `${digits.slice(0, -places)}.${fraction}` : digits.slice(0, -places);
}

/**
 * The pin of a sum of values: the sources of every part, the oldest of their times, the label that
 * is not live if any is, the age of the oldest stale part, and the sum's own method.
 */
export function sumSource(parts: readonly PinSource[], method: string): PinSource {
  const sources = [...new Set(parts.flatMap((p) => p.source.split(' + ')))];
  const times = parts.map((p) => p.fetchedAt);
  const stale = parts.flatMap((p) => (p.staleAgeSec == null ? [] : [p.staleAgeSec]));
  return {
    source: sources.join(' + '),
    fetchedAt: times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)),
    method,
    provenance: parts.reduce<Provenance>((label, p) => worst(label, p.provenance), 'live'),
    staleAgeSec: stale.length > 0 ? Math.max(...stale) : null,
  };
}

/** A chain's vaults, worth: their values added, with the pin of that sum. */
export function chainTotal(
  chain: PortfolioChain,
  valueMethod: string,
  method: string,
): { valueUsd: string; obs: PinSource } {
  return {
    valueUsd: addDecimals(chain.vaults.map((vault) => vault.valueUsd)),
    obs: sumSource(
      chain.vaults.map((vault) => vaultValueSource(chain, vault, valueMethod)),
      method,
    ),
  };
}

/** How many holdings the value leaves out, because the API had no price for them. */
export const unpriced = (vault: Vault): number =>
  vault.positions.filter((position) => position.valueUsd === null).length;

/** How an asset is named in a row: the part of its id after the chain, as a ticker (amounts.ts). */
export const assetName = assetTicker;
