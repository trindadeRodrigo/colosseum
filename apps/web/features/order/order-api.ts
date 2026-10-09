import {
  type ChainId,
  chainFamily,
  FundingResponse,
  OrderDetail,
  OrderError,
  type OrderErrorCode,
  TEST_FUNDS_LOW,
  TestFundsResponse,
} from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';

// The two calls the buy screen makes before anything is signed, with the shapes of API-2:
//
//   GET  /v1/funding?amountUsd=&proposalId=&wallet=   what the wallet is missing for this buy, cash and gas
//   POST /v1/orders { type: 'buy', owner, amountUsd, proposalId }   the order, its steps planned, nothing built
//   POST /v1/testnet/fund { amountUsd, proposalId | family | vault, wallet }   test network only: what is missing, sent
//
// Every answer is read with the shared schema. What the server says in a refusal is written for a
// developer: the screen has a sentence of its own for each thing the person can do about it.

/** Why a call did not give what was asked. */
export type CallFailure =
  /** 401 or 403: the server no longer knows this sign-in. */
  | 'signed-out'
  /** 409 with no order code: the server has no chain for this person. */
  | 'no-chain'
  /** 429. */
  | 'busy'
  /** No answer, or a 5xx. */
  | 'unreachable'
  /** An answer in a shape this app does not read. */
  | 'unreadable'
  /** 404: the server does not have this plan. */
  | 'no-plan'
  /** Any other refusal of what was sent. */
  | 'refused';

export type FundingOutcome = { kind: 'read'; funding: FundingResponse } | { kind: CallFailure };

export type OrderOutcome =
  | { kind: 'placed'; order: OrderDetail }
  /** The order codes of 3.3 the screen has a sentence for. */
  | { kind: 'code'; code: OrderErrorCode }
  | { kind: CallFailure };

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

/**
 * What a buy is of: a plan, a shared portfolio (by its slug), or a vault the person has, which the buy
 * adds to (its address and its chain, as GET /v1/funding and POST /v1/testnet/fund name it).
 */
export type BuyOf =
  | { proposalId: string }
  | { family: string }
  | { vault: string; vaultChain: ChainId };

/** Where the screen that adds money to a vault lives. */
export const addMoneyPath = (chain: ChainId, address: string) =>
  `/vaults/${chain}/${encodeURIComponent(address)}/add`;

/**
 * What the wallet is missing for a buy of this plan, of this shared portfolio or into this vault, and
 * amount, read from the wallet on its chain.
 */
export async function readFunding(
  apiFetch: ApiFetch,
  ask: BuyOf & { amountUsd: number; wallet: string },
): Promise<FundingOutcome> {
  const query = new URLSearchParams({
    amountUsd: String(ask.amountUsd),
    ...('vault' in ask
      ? { vault: ask.vault, vaultChain: ask.vaultChain }
      : 'family' in ask
        ? { family: ask.family }
        : { proposalId: ask.proposalId }),
    wallet: ask.wallet,
  });
  let res: Response;
  try {
    res = await apiFetch(`/v1/funding?${query}`);
  } catch {
    return { kind: 'unreachable' };
  }
  const body = await bodyOf(res);
  if (!res.ok) return { kind: failureOf(res.status, body.code) };
  const funding = FundingResponse.safeParse(body);
  return funding.success ? { kind: 'read', funding: funding.data } : { kind: 'unreadable' };
}

const CODES: readonly OrderErrorCode[] = [
  'NOT_FUNDED',
  'ASSET_NOT_ELIGIBLE',
  'VERSION_CHANGED',
  'ORDER_EXPIRED',
  'US_PERSON',
  'RATE_LIMITED',
  'CHAIN_UNAVAILABLE',
  'AMOUNT_OVER_REVIEW',
];

/**
 * POST /v1/orders: a buy of this plan for this amount, owned by the wallet of the plan's chain, or, with
 * `vault`, that amount added to a vault of that wallet's on the chain. The order that comes back is the
 * one the review screen shows; it is checked here only for being an order of this chain and this owner.
 * What it may sign is the guard's, later, from that same object.
 */
export async function placeOrder(
  apiFetch: ApiFetch,
  ask: ({ proposalId: string } | { vault: string }) & {
    amountUsd: number;
    chain: ChainId;
    owner: string;
  },
): Promise<OrderOutcome> {
  const family = chainFamily(ask.chain);
  let res: Response;
  try {
    res = await apiFetch('/v1/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'buy',
        owner: { [family]: ask.owner },
        amountUsd: ask.amountUsd,
        ...('vault' in ask
          ? { vault: { chain: ask.chain, address: ask.vault } }
          : { proposalId: ask.proposalId }),
      }),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  const body = await bodyOf(res);
  if (!res.ok) {
    const code = CODES.find((c) => c === body.code);
    if (code === 'RATE_LIMITED') return { kind: 'busy' };
    if (code) return { kind: 'code', code };
    return { kind: failureOf(res.status, body.code) };
  }
  const order = OrderDetail.safeParse(body);
  if (!order.success) return { kind: 'unreadable' };
  const legs = order.data.legs;
  if (
    order.data.owner[family] !== ask.owner ||
    legs.length === 0 ||
    legs.some((leg) => leg.chain !== ask.chain)
  )
    return { kind: 'unreadable' };
  return { kind: 'placed', order: order.data };
}

// Finishing a buy with the cash already in its vault (the flow audit, finding 24):
//
//   POST /v1/orders/{id}/continue   no body; the owner's alone
//   200  a new order with `continues: <the first order's id>`, no `depositRaw`, and only `swap` steps;
//        asked again while that order can still be signed, the same one
//   409  a sentence: the deposit has not landed, nothing is left, a step built before can still land
//        (`details.retryable`), or the vault's cash is short; `PRICE_MOVED` when a step can no longer
//        meet the least it states
//
// The route is not on every server yet. Nothing is offered until it is known to be there.

/** Not an order's id: asking to finish it tells whether the route is there, and can make nothing. */
const NO_ORDER = 'not-an-order';

const continuePath = (id: string) => `/v1/orders/${encodeURIComponent(id)}/continue`;

/**
 * Whether this server finishes buys. The route takes an order's id, a uuid (`OrderRouteParams`):
 * asked with something that is not one, a server with the route refuses the request as badly formed
 * (400) and says why in `error`, as every refusal of its routes does; one without it has no such
 * route (404). The status and that field together, and nothing of a 404's body: anything else, a
 * sign-in it does not know included, is read as no, and the button stays hidden.
 */
export async function continuesOrders(apiFetch: ApiFetch): Promise<boolean> {
  try {
    const res = await apiFetch(continuePath(NO_ORDER), { method: 'POST' });
    if (res.status !== 400) return false;
    const said = (await bodyOf(res)).error;
    return typeof said === 'string' && said.length > 0;
  } catch {
    return false;
  }
}

/**
 * Why the server would not make the order that finishes another, by the code its refusal carries
 * (`OrderErrorCode`, API-CONTINUE-CODES). A refusal with no code, or one this app does not know, is
 * `said`, shown in the server's own sentence.
 * - `other-order`: an order already finishes this one; `orderId` is that order (`details.continuedBy`).
 * - `working`: another request holds this order, and the wait for it ran out.
 * - `in-flight`: a transaction built for a step left can still land.
 * - `nothing-left`, `cash-short`, `not-deposited`: there is nothing to finish, or nothing to finish it with.
 * - `unsupported`: not an order this route finishes.
 * - `landed`: a step's transaction had landed unreported; the server has settled the step on it, so
 *   the order is read again and nothing is said.
 * `PRICE_MOVED` is not among them: this route quotes anew and builds nothing, so it never answers it.
 */
export type FinishRefusal =
  | 'other-order'
  | 'working'
  | 'in-flight'
  | 'nothing-left'
  | 'cash-short'
  | 'not-deposited'
  | 'unsupported'
  | 'landed'
  | 'said';

const REFUSALS: Partial<Record<OrderErrorCode, FinishRefusal>> = {
  ORDER_CONTINUED: 'other-order',
  ORDER_BUSY: 'working',
  STEP_IN_FLIGHT: 'in-flight',
  NOTHING_LEFT: 'nothing-left',
  VAULT_CASH_SHORT: 'cash-short',
  DEPOSIT_NOT_LANDED: 'not-deposited',
  CONTINUE_NOT_SUPPORTED: 'unsupported',
  STEP_LANDED: 'landed',
};

/**
 * The refusal's reason from its code, and for `ORDER_CONTINUED` the order that finishes this one, as
 * the shared schema has them (`OrderError`). A body that is not one, or a code this build does not
 * know, is `said`.
 */
export function refusalOf(body: unknown): { why: FinishRefusal; orderId?: string } {
  const refusal = OrderError.safeParse(body);
  if (!refusal.success) return { why: 'said' };
  const { code, details } = refusal.data;
  // Its own entries only: a code that names a member every object has (`constructor`) is not one.
  const why = (code && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined) ?? 'said';
  const by = details?.continuedBy;
  return { why, ...(why === 'other-order' && by ? { orderId: by } : {}) };
}

export type ContinueOutcome =
  | { kind: 'placed'; order: OrderDetail & { continues: string } }
  /** 409: why not (`refusalOf`), and the server's own sentence for a reason this app has no words for. */
  | { kind: 'refused'; why: FinishRefusal; sentence: string; orderId?: string }
  | { kind: 'signed-out' | 'busy' | 'unreachable' | 'unreadable' | 'unavailable' };

/**
 * Asks for the order that finishes `first` with the cash in its vault. Nothing is deposited. The
 * answer is taken only if it names that order, is another order, is the same owner's for the same
 * vault, deposits nothing and has only swap steps, all on the first order's chain.
 */
export async function continueOrder(
  apiFetch: ApiFetch,
  first: Pick<OrderDetail, 'id' | 'owner' | 'basketId' | 'legs'>,
): Promise<ContinueOutcome> {
  const id = first.id;
  let res: Response;
  try {
    res = await apiFetch(continuePath(id), { method: 'POST' });
  } catch {
    return { kind: 'unreachable' };
  }
  const body = await bodyOf(res);
  if (res.status === 409) {
    // Its sentence is kept for a reason this app has no words for.
    const sentence = typeof body.error === 'string' ? body.error : '';
    return { kind: 'refused', sentence, ...refusalOf(body) };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501)
    return { kind: 'unavailable' };
  if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };
  if (res.status === 429) return { kind: 'busy' };
  if (!res.ok) return { kind: 'unreachable' };
  const order = OrderDetail.safeParse(body);
  // The answer must say which order it finishes, and be another order than that one.
  if (!order.success || order.data.continues !== id || order.data.id === id)
    return { kind: 'unreadable' };
  const chain = first.legs[0]?.chain;
  const made = order.data;
  if (
    JSON.stringify(made.owner) !== JSON.stringify(first.owner) ||
    made.basketId !== first.basketId ||
    made.depositRaw !== undefined ||
    made.legs.length === 0 ||
    made.legs.some((leg) => leg.kind !== 'swap' || leg.chain !== chain)
  )
    return { kind: 'unreadable' };
  return { kind: 'placed', order: { ...made, continues: id } };
}

/** GET /v1/orders/{id}: the order as it stands. */
export async function readOrder(
  apiFetch: ApiFetch,
  id: string,
): Promise<{ kind: 'read'; order: OrderDetail } | { kind: CallFailure }> {
  let res: Response;
  try {
    res = await apiFetch(`/v1/orders/${encodeURIComponent(id)}`);
  } catch {
    return { kind: 'unreachable' };
  }
  const body = await bodyOf(res);
  if (!res.ok) return { kind: failureOf(res.status, body.code) };
  const order = OrderDetail.safeParse(body);
  return order.success && order.data.id === id
    ? { kind: 'read', order: order.data }
    : { kind: 'unreadable' };
}

/** MOCK only: POST /v1/mock/fund gives the signed-in wallets mock cash and mock gas on one chain. */
export async function fundMock(
  apiFetch: ApiFetch,
  ask: { chain: ChainId; cashUsd: number },
): Promise<boolean> {
  try {
    const res = await apiFetch('/v1/mock/fund', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ask),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * What one send of test funds gives, as our server has it (`TEST_FUNDS` in
 * apps/api/src/faucet/test-funds.ts): the most test dollars at once, the sends a person has a day,
 * and the margin it adds over what is missing. Said on the card before the ask; the server is what
 * holds to them.
 */
export const TEST_SEND = { maxUsd: 5_000, perDay: 3, marginBps: 100 } as const;

export type TestFundsOutcome =
  | { kind: 'sent'; sent: TestFundsResponse }
  /** 429: the person, or the faucet, has had its sends for the day. */
  | { kind: 'busy' }
  /** 422: more than one send gives. */
  | { kind: 'too-much' }
  /** 409: nothing is missing. */
  | { kind: 'enough' }
  /** 409: the faucet's float cannot cover this send, of test gas or of test dollars. */
  | { kind: 'low'; of: 'gas' | 'cash' }
  /** Refused, or the server could not be read. */
  | { kind: 'refused' }
  /** No answer, a 5xx, or the test network did not take it. */
  | { kind: 'unreachable' };

/**
 * Test network only: POST /v1/testnet/fund asks the server to send the wallet what this buy is missing.
 * The server works out the amounts itself; nothing here says how much.
 */
export async function requestTestFunds(
  apiFetch: ApiFetch,
  ask: BuyOf & { amountUsd: number; wallet: string },
): Promise<TestFundsOutcome> {
  let res: Response;
  try {
    res = await apiFetch('/v1/testnet/fund', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ask),
    });
  } catch {
    return { kind: 'unreachable' };
  }
  const body = await bodyOf(res);
  if (res.status === 429) return { kind: 'busy' };
  if (res.status === 422) return { kind: 'too-much' };
  if (res.status === 409)
    return body.error === TEST_FUNDS_LOW.gas
      ? { kind: 'low', of: 'gas' }
      : body.error === TEST_FUNDS_LOW.cash
        ? { kind: 'low', of: 'cash' }
        : { kind: 'enough' };
  if (res.status >= 500) return { kind: 'unreachable' };
  if (!res.ok) return { kind: 'refused' };
  const sent = TestFundsResponse.safeParse(body);
  return sent.success && sent.data.wallet === ask.wallet
    ? { kind: 'sent', sent: sent.data }
    : { kind: 'refused' };
}
