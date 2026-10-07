import {
  type ChainId,
  type HistoryStep,
  PortfolioExposureResponse,
  PortfolioHistoryResponse,
  PortfolioPlansResponse,
  PortfolioRebalancesResponse,
} from '@colosseum/schemas';
import { type ApiFetch, signInRefusal } from '../account/person';

// What the portfolio section reads: the four routes of PORT-2 (DESIGN-VAULT 3.3, "The portfolio
// section's routes"; shapes in packages/schemas/src/portfolio-api.ts). Each answers the signed-in
// person's own vaults on every chain this server runs, from what the snapshot worker kept and the
// order tables, never from a chain. One fetcher a route. Nothing here works a figure out: an answer
// is parsed with the contract's schema and handed on as it came, or it is not shown.
//
//   200     the answer, with `chains`, `unavailable` and the disclaimer
//   400     a `chain` that is none, an `address` that is empty or too long, a window not served
//   401/403 the server does not know this sign-in, or was sent no identity token
//   429     it asked for fewer requests
//
// A server from before the section answers 404, and a page says it keeps no history: it shows no
// figure in its place.

export const PLANS_PATH = '/v1/portfolio/plans';
export const EXPOSURE_PATH = '/v1/portfolio/exposure';
export const REBALANCES_PATH = '/v1/portfolio/rebalances';
export const HISTORY_PATH = '/v1/portfolio/history';

export type PlansAnswer = PortfolioPlansResponse;
export type PlansChain = PlansAnswer['chains'][number];
export type Plan = PlansChain['plans'][number];
export type ExposureAnswer = PortfolioExposureResponse;
export type ExposureChain = ExposureAnswer['chains'][number];
export type RebalancesAnswer = PortfolioRebalancesResponse;
export type RebalancesChain = RebalancesAnswer['chains'][number];
export type HistoryAnswer = PortfolioHistoryResponse;
export type HistoryChain = HistoryAnswer['chains'][number];
/** A chain of the person's that an answer could not cover. The same shape in all four. */
export type ChainOut = PlansAnswer['unavailable'][number];

/** What came of one read. */
export type SectionRead<T> =
  | { kind: 'read'; answer: T }
  /** The route is not there: this server keeps no history yet. */
  | { kind: 'unavailable' }
  /** The server does not know this sign-in any more (401), or does not let it read (403). */
  | { kind: 'signed-out' }
  /** The server was sent no identity token (401). */
  | { kind: 'no-identity' }
  | { kind: 'busy' }
  /** The server would not take what was asked (400, 422). */
  | { kind: 'refused' }
  | { kind: 'unreachable' }
  /** An answer that is not the contract's shape, or not about what was asked. */
  | { kind: 'unreadable' };

/** One vault of the person's, or all of them: the query the four routes share. */
export type VaultFilter = { chain?: ChainId; address?: string };
export type RebalancesQuery = VaultFilter & { limit?: number };
export type HistoryQuery = VaultFilter & { from?: string; to?: string; step?: HistoryStep };

type Query = Record<string, string | number | undefined>;

/** A route's address with its query, the parts that were left out left out. */
export function pathOf(path: string, query: Query = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

/** The part of a zod schema this file uses: the app's screens import no parser of their own. */
type Schema<T> = { safeParse(body: unknown): { success: true; data: T } | { success: false } };

type Named = { chains: { chain: ChainId }[]; unavailable: { chain: ChainId }[] };

/** An EVM address compares in any case, as the API reads one; a Solana address as it is written. */
const sameAddress = (a: string, b: string) =>
  a === b || (a.startsWith('0x') && a.toLowerCase() === b.toLowerCase());

/**
 * An answer names each chain once, as read or as unavailable and never both, and names no chain but
 * the one that was asked for, when one was.
 */
function chainsSound(answer: Named, asked: VaultFilter): boolean {
  const named = [...answer.chains, ...answer.unavailable].map((entry) => entry.chain);
  if (new Set(named).size !== named.length) return false;
  return asked.chain === undefined || named.every((chain) => chain === asked.chain);
}

async function ask<T extends Named>(
  apiFetch: ApiFetch,
  path: string,
  schema: Schema<T>,
  asked: VaultFilter,
  /** What the answer holds is filed under its own chain, and is the vault that was asked for. */
  filed: (answer: T, own: (address: string | null) => boolean) => boolean,
): Promise<SectionRead<T>> {
  let res: Response;
  try {
    res = await apiFetch(path);
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
  if (res.status === 400 || res.status === 422) return { kind: 'refused' };
  if (!res.ok) return { kind: 'unreachable' };
  const body: unknown = await res.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { kind: 'unreadable' };
  const { address } = asked;
  const own = (found: string | null) =>
    address === undefined || (found !== null && sameAddress(address, found));
  if (!chainsSound(parsed.data, asked) || !filed(parsed.data, own)) return { kind: 'unreadable' };
  return { kind: 'read', answer: parsed.data };
}

/** GET /v1/portfolio/plans: one entry a vault, with its plan, what was put in, its newest snapshot and its status. */
export const readPlans = (
  apiFetch: ApiFetch,
  query: VaultFilter = {},
): Promise<SectionRead<PlansAnswer>> =>
  ask(apiFetch, pathOf(PLANS_PATH, query), PortfolioPlansResponse, query, (answer, own) =>
    answer.chains.every((entry) =>
      entry.plans.every((plan) => plan.chain === entry.chain && own(plan.address)),
    ),
  );

/** GET /v1/portfolio/exposure: the holdings added up by underlying and by issuer, with what selling each would cost. */
export const readExposure = (
  apiFetch: ApiFetch,
  query: VaultFilter = {},
): Promise<SectionRead<ExposureAnswer>> =>
  ask(apiFetch, pathOf(EXPOSURE_PATH, query), PortfolioExposureResponse, query, (answer, own) =>
    // asked for one vault, the sums are that vault's alone: no chain adds up more than one
    answer.chains.every(
      (entry) =>
        (query.address === undefined || entry.vaults <= 1) &&
        entry.unvalued.every((held) => own(held.vault)),
    ),
  );

/** GET /v1/portfolio/rebalances: the steps that reached the chain and traded or adopted a version, newest first. */
export const readRebalances = (
  apiFetch: ApiFetch,
  query: RebalancesQuery = {},
): Promise<SectionRead<RebalancesAnswer>> =>
  ask(apiFetch, pathOf(REBALANCES_PATH, query), PortfolioRebalancesResponse, query, (answer, own) =>
    answer.chains.every((entry) =>
      entry.entries.every((step) => step.chain === entry.chain && own(step.vault)),
    ),
  );

/** GET /v1/portfolio/history: each vault's points in a window, oldest first, one a step. */
export const readHistory = (
  apiFetch: ApiFetch,
  query: HistoryQuery = {},
): Promise<SectionRead<HistoryAnswer>> =>
  ask(apiFetch, pathOf(HISTORY_PATH, query), PortfolioHistoryResponse, query, (answer, own) =>
    answer.chains.every((entry) => entry.vaults.every((series) => own(series.address))),
  );

/**
 * The vault an address names, in an answer of the plans: its chain's entry and its plan. `chain` and
 * `address` are a route's own words, as written: a chain the answer does not have, or an address that
 * is no vault of the person's there, is null. An EVM address is read in any case.
 */
export function planIn(
  answer: PlansAnswer,
  chain: string,
  address: string,
): { chain: PlansChain; plan: Plan } | null {
  const entry = answer.chains.find((c) => c.chain === chain);
  const plan = entry?.plans.find((p) => sameAddress(address, p.address));
  return entry && plan ? { chain: entry, plan } : null;
}
