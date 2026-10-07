import type { OrderDetail, Target, Trade } from '@colosseum/schemas';
import { type SharedTerms, tradesOf } from '../shared/terms';
import type { ChainUnits } from './units';

// Before an order is offered for signing: does it move the money the person asked for, in the units
// this repository committed? The guard holds each step to the order, and the order only to itself, so
// this is the one place the order is held to what the person typed. An API that answered a deposit of
// 40,000 dollars to a buy of 40 is caught here, and the order is shown and never signed.

export type DepositCheck =
  | { ok: true; depositRaw: bigint; decimals: number }
  /**
   * - `units`: no units are committed for this chain's cash token on this network.
   * - `deposit`: the order deposits another amount than the one typed.
   * - `steps`: a step is about another amount of cash than the deposit, or spends more than it.
   */
  | { ok: false; why: 'units' | 'deposit' | 'steps' };

const RAW = /^\d+$/;

/** The raw amount of the cash token a buy of `amountUsd` deposits: the API's own rounding, in cents. */
export function depositRawOf(amountUsd: number, decimals: number): bigint {
  const cents = BigInt(Math.round(amountUsd * 100));
  return (cents * 10n ** BigInt(decimals)) / 100n;
}

export function checkDeposit(
  order: Pick<OrderDetail, 'depositRaw' | 'legs'>,
  amountUsd: number,
  units: ChainUnits | null,
): DepositCheck {
  const cash = units?.tokens[units.cash];
  if (!units || !cash) return { ok: false, why: 'units' };
  const stated = order.depositRaw;
  if (stated === undefined || !RAW.test(stated)) return { ok: false, why: 'deposit' };
  const deposit = BigInt(stated);
  if (deposit !== depositRawOf(amountUsd, cash.decimals)) return { ok: false, why: 'deposit' };
  let spent = 0n;
  for (const leg of order.legs) {
    if (leg.cashRaw !== undefined && leg.cashRaw !== stated) return { ok: false, why: 'steps' };
    for (const trade of leg.trades) {
      if (!RAW.test(trade.amountInRaw)) return { ok: false, why: 'steps' };
      if (trade.sell === units.cash) spent += BigInt(trade.amountInRaw);
      else if (trade.buy !== units.cash) return { ok: false, why: 'steps' };
    }
  }
  if (spent > deposit) return { ok: false, why: 'steps' };
  return { ok: true, depositRaw: deposit, decimals: cash.decimals };
}

type Standing = Pick<OrderDetail, 'status' | 'legs'>;

/** The order's deposit is confirmed on its chain: the cash is in the vault whatever came after. */
export const depositLanded = (order: Pick<OrderDetail, 'legs'>): boolean =>
  order.legs.some(
    (leg) => (leg.kind === 'create_vault' || leg.kind === 'deposit') && leg.status === 'confirmed',
  );

/** The order goes no further, with a step not done: it failed or ran out of time, or a step did. */
export const stoppedShort = (order: Standing): boolean =>
  order.status !== 'done' &&
  (order.status === 'failed' ||
    order.status === 'expired' ||
    order.legs.some((leg) => leg.status === 'failed' || leg.status === 'expired'));

const undone = (status: string | undefined) => status !== 'confirmed' && status !== 'skipped';

/**
 * The swaps an order left undone, for the order that finishes it to be held to. The trades are the
 * approved order's own, step by step, by step id: of the API's later answer only where each step
 * stands is read, so an answer that changed a trade cannot widen what the next order may buy.
 */
export function leftOfApproved(approved: Pick<OrderDetail, 'legs'>, now: Standing): Trade[] {
  const standing = new Map(now.legs.map((leg) => [leg.id, leg.status]));
  return approved.legs
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .filter((leg) => leg.kind === 'swap' && undone(standing.get(leg.id) ?? leg.status))
    .flatMap((leg) => leg.trades);
}

/**
 * The same for an order this browser never reviewed: there is no approved copy, so the swaps left are
 * the server's, and each is held to the plan's lines as the server stores them. Every one sells cash
 * for a token the plan holds, no token twice, and together they spend no more than the order
 * deposited. Null when one does not: nothing is offered then.
 */
export function leftOfPlan(
  order: Pick<OrderDetail, 'depositRaw' | 'legs'> & Standing,
  targets: readonly Target[],
  cash: string,
): Trade[] | null {
  if (order.depositRaw === undefined || !RAW.test(order.depositRaw)) return null;
  const trades = order.legs
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .filter((leg) => leg.kind === 'swap' && undone(leg.status))
    .flatMap((leg) => leg.trades);
  const held = new Set(targets.filter((t) => t.weightBps > 0).map((t) => t.asset));
  const bought = new Set<string>();
  let spent = 0n;
  for (const trade of trades) {
    if (trade.sell !== cash || !held.has(trade.buy) || bought.has(trade.buy)) return null;
    if (!RAW.test(trade.amountInRaw)) return null;
    bought.add(trade.buy);
    spent += BigInt(trade.amountInRaw);
  }
  return spent > BigInt(order.depositRaw) ? null : trades;
}

/**
 * An order that finishes another with the cash already in its vault: it deposits nothing, opens
 * nothing, and only buys. It says which order it finishes; it has no `depositRaw` and no cash on a
 * step; every step is a swap; and its trades are, one for one, trades the first order left undone
 * (the same token, the same amount of cash), none of them twice. A server that answered a deposit, or
 * a buy of something else, or of more, is caught here and nothing is offered for signing.
 */
export function checkContinuation(
  order: Pick<OrderDetail, 'depositRaw' | 'legs'> & { continues?: unknown },
  first: { orderId: string; trades: readonly { sell: string; buy: string; amountInRaw: string }[] },
  units: ChainUnits | null,
  /**
   * The order as the server just answered it, not yet approved: it must say which order it finishes.
   * The approved copy this browser kept was held to that when it was reviewed.
   */
  fresh = true,
): DepositCheck | { ok: false; why: 'trades' | 'shape' } {
  const cash = units?.tokens[units.cash];
  if (!units || !cash) return { ok: false, why: 'units' };
  if (order.depositRaw !== undefined) return { ok: false, why: 'shape' };
  if (
    fresh ? order.continues !== first.orderId : (order.continues ?? first.orderId) !== first.orderId
  )
    return { ok: false, why: 'shape' };
  if (
    order.legs.length === 0 ||
    order.legs.some((l) => l.kind !== 'swap' || l.cashRaw !== undefined)
  )
    return { ok: false, why: 'shape' };
  const left = first.trades.map((t) => `${t.sell}>${t.buy}:${t.amountInRaw}`);
  let spent = 0n;
  for (const trade of order.legs.flatMap((l) => l.trades)) {
    if (trade.sell !== units.cash || !RAW.test(trade.amountInRaw))
      return { ok: false, why: 'trades' };
    const at = left.indexOf(`${trade.sell}>${trade.buy}:${trade.amountInRaw}`);
    if (at < 0) return { ok: false, why: 'trades' };
    left.splice(at, 1);
    spent += BigInt(trade.amountInRaw);
  }
  if (order.legs.every((l) => l.trades.length === 0)) return { ok: false, why: 'shape' };
  // What it spends of the vault's cash, for the button's amount: nothing is deposited.
  return { ok: true, depositRaw: spent, decimals: cash.decimals };
}

/**
 * A buy of a shared portfolio (WEB-4): the deposit as for a plan, and each trade the share of the
 * deposit that the portfolio's weight gives, in the order its screen read them (`tradesOf`). An API that
 * planned other weights than the version read from the chain is caught here.
 */
export function checkFamilyBuy(
  order: Pick<OrderDetail, 'depositRaw' | 'legs'>,
  amountUsd: number,
  units: ChainUnits | null,
  targets: readonly Target[],
): DepositCheck | { ok: false; why: 'trades' } {
  const deposit = checkDeposit(order, amountUsd, units);
  if (!deposit.ok || !units) return deposit;
  const want = tradesOf(targets, deposit.depositRaw);
  const made = order.legs
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .flatMap((leg) => leg.trades);
  const same =
    made.length === want.length &&
    made.every(
      (t, i) =>
        t.sell === units.cash && t.buy === want[i]?.asset && t.amountInRaw === want[i]?.amountInRaw,
    );
  return same ? deposit : { ok: false, why: 'trades' };
}

/**
 * A follow or a publish moves no cash and trades nothing: no deposit, no cash on a step, no trade, and
 * only the steps its terms call for, each once. The guard holds each step's bytes to the terms; this
 * holds the order's shape to them before anything is offered for signing.
 */
export function sharedShapeOk(
  order: Pick<OrderDetail, 'depositRaw' | 'legs'>,
  terms: Exclude<SharedTerms, { kind: 'family' }>,
): boolean {
  if (order.depositRaw !== undefined || order.legs.length === 0) return false;
  if (order.legs.some((l) => l.cashRaw !== undefined || l.trades.length > 0)) return false;
  const kinds = order.legs.map((l) => l.kind);
  if (terms.kind === 'publish') return kinds.length === 1 && kinds[0] === 'publish';
  const allowed = new Set(['accept_version', 'set_auto_follow']);
  return (
    kinds.every((k) => allowed.has(k)) &&
    new Set(kinds).size === kinds.length &&
    kinds.includes('accept_version') === (terms.follow !== null)
  );
}
