import {
  type ChainId,
  chainFamily,
  FamilyResponse,
  OrderDetail,
  type OrderErrorCode,
  PortfolioResponse,
  ShelfResponse,
  VaultResponse,
  VersionsResponse,
} from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import type { CallFailure, OrderOutcome } from '../order/order-api';

// The calls the shared-portfolio screens make (API-3, WEB-4), each answer read with the shared schema:
//
//   GET  /v1/shelf?chain=                       the shared portfolios, from the server's store
//   GET  /v1/indexes/{slug}?chain=              one, its recipes read from their chains by the server
//   GET  /v1/indexes/{slug}/versions?chain=     every version the server has seen
//   GET  /v1/portfolio                          the person's vaults, for following and the prompt
//   GET  /v1/vaults/{chain}/{address}           any vault, for the public page
//   POST /v1/orders                             a publish, a buy of a portfolio, a follow
//
// What any of these answers is the API's word. A screen shows it, and holds what is signed to its own
// terms (terms.ts): the form's text, and the chain as this app reads it where it can.

const failureOf = (status: number, code: unknown): CallFailure => {
  if (status === 401 || status === 403) return 'signed-out';
  if (status === 404) return 'no-plan';
  if (status === 409 && code === undefined) return 'no-chain';
  if (status === 429) return 'busy';
  if (status >= 500) return 'unreachable';
  return 'refused';
};

const bodyOf = async (res: Response): Promise<Record<string, unknown>> => {
  const body: unknown = await res.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
};

type Read<T> = { kind: 'read'; value: T } | { kind: CallFailure };

async function getAs<T>(
  apiFetch: ApiFetch,
  path: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): Promise<Read<T>> {
  let res: Response;
  try {
    res = await apiFetch(path);
  } catch {
    return { kind: 'unreachable' };
  }
  const body = await bodyOf(res);
  if (!res.ok) return { kind: failureOf(res.status, body.code) };
  const read = schema.safeParse(body);
  return read.success ? { kind: 'read', value: read.data } : { kind: 'unreadable' };
}

const chainQuery = (chain: ChainId | null) => (chain ? `?chain=${encodeURIComponent(chain)}` : '');

export const readShelf = (apiFetch: ApiFetch, chain: ChainId | null) =>
  getAs(apiFetch, `/v1/shelf${chainQuery(chain)}`, ShelfResponse);

export const readFamily = (apiFetch: ApiFetch, slug: string, chain: ChainId | null) =>
  getAs(apiFetch, `/v1/indexes/${encodeURIComponent(slug)}${chainQuery(chain)}`, FamilyResponse);

export const readVersions = (apiFetch: ApiFetch, slug: string, chain: ChainId | null) =>
  getAs(
    apiFetch,
    `/v1/indexes/${encodeURIComponent(slug)}/versions${chainQuery(chain)}`,
    VersionsResponse,
  );

export const readPortfolio = (apiFetch: ApiFetch) =>
  getAs(apiFetch, '/v1/portfolio', PortfolioResponse);

export const readVault = (apiFetch: ApiFetch, chain: ChainId, address: string) =>
  getAs(
    apiFetch,
    `/v1/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,
    VaultResponse,
  );

const CODES: readonly OrderErrorCode[] = [
  'NOT_FUNDED',
  'ASSET_NOT_ELIGIBLE',
  'VERSION_CHANGED',
  'CREATOR_LIMIT',
  'ORDER_EXPIRED',
  'US_PERSON',
  'RATE_LIMITED',
  'CHAIN_UNAVAILABLE',
];

/** What a refusal said, when the screen shows the server's own sentence beside its code. */
export type Placed =
  | OrderOutcome
  | {
      kind: 'said';
      status: number;
      error: string;
      fix: string | null;
      /** The order code the refusal carried, where it is one this app knows. */
      code?: OrderErrorCode;
    };

/**
 * POST /v1/orders for a publish, a buy of a shared portfolio or a follow. The order that comes back is
 * checked for being one of this owner on this chain; what it may sign is held to the screen's terms
 * later. A refusal with no code the screen knows keeps the server's sentence: a creator limit, a name
 * taken or another creator's slug is the server's to explain.
 */
export async function placeShared(
  apiFetch: ApiFetch,
  body: Record<string, unknown>,
  expect: { chain: ChainId; owner: string; type: OrderDetail['type'] },
): Promise<Placed> {
  const family = chainFamily(expect.chain);
  let res: Response;
  try {
    res = await apiFetch('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  const answer = await bodyOf(res);
  if (!res.ok) {
    const code = CODES.find((c) => c === answer.code);
    if (code === 'RATE_LIMITED' || res.status === 429) return { kind: 'busy' };
    if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
    if (res.status >= 500) return { kind: 'unreachable' };
    if (typeof answer.error === 'string')
      return {
        kind: 'said',
        status: res.status,
        error: answer.error,
        fix: typeof answer.fix === 'string' ? answer.fix : null,
        ...(code ? { code } : {}),
      };
    if (code) return { kind: 'code', code };
    return { kind: failureOf(res.status, answer.code) };
  }
  const order = OrderDetail.safeParse(answer);
  if (!order.success) return { kind: 'unreadable' };
  const legs = order.data.legs;
  if (
    order.data.type !== expect.type ||
    order.data.owner[family] !== expect.owner ||
    legs.length === 0 ||
    legs.some((leg) => leg.chain !== expect.chain)
  )
    return { kind: 'unreadable' };
  return { kind: 'placed', order: order.data };
}
