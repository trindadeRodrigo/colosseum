import {
  type ChainId,
  chainFamily,
  FundingResponse,
  OrderDetail,
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
