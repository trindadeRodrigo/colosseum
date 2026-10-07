import type { OrderDetail, Target } from '@colosseum/schemas';
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

/** A trade an order may make: what it buys and the cash it spends on it. */
export type AllowedTrade = { buy: string; amountInRaw: string };

/** The trades of an order's steps that have not confirmed: what a continuation may still make. */
export function tradesLeft(
  approved: Pick<OrderDetail, 'legs'>,
  now: Pick<OrderDetail, 'legs'>,
): AllowedTrade[] {
  return approved.legs
    .filter((leg) => now.legs.find((l) => l.id === leg.id)?.status !== 'confirmed')
    .flatMap((leg) => leg.trades.map((t) => ({ buy: t.buy, amountInRaw: t.amountInRaw })));
}

/**
 * An order that finishes another with the cash already in the vault (`POST /v1/orders/{id}/continue`):
 * it deposits nothing, every step is a swap, and every trade is one the first order left unmade, the
 * same token for the same cash, each at most once. `depositRaw` in the answer is what it spends.
 */
export function checkContinuation(
  order: Pick<OrderDetail, 'depositRaw' | 'legs'>,
  left: readonly AllowedTrade[],
  units: ChainUnits | null,
): DepositCheck | { ok: false; why: 'trades' } {
  const cash = units?.tokens[units.cash];
  if (!units || !cash) return { ok: false, why: 'units' };
  if (order.depositRaw !== undefined) return { ok: false, why: 'deposit' };
  if (order.legs.length === 0) return { ok: false, why: 'steps' };
  const open = [...left];
  let spent = 0n;
  for (const leg of order.legs) {
    if (leg.kind !== 'swap' || leg.cashRaw !== undefined || leg.trades.length === 0)
      return { ok: false, why: 'steps' };
    for (const trade of leg.trades) {
      if (!RAW.test(trade.amountInRaw) || trade.sell !== units.cash || trade.buy === units.cash)
        return { ok: false, why: 'steps' };
      const at = open.findIndex((t) => t.buy === trade.buy && t.amountInRaw === trade.amountInRaw);
      if (at < 0) return { ok: false, why: 'trades' };
      open.splice(at, 1);
      spent += BigInt(trade.amountInRaw);
    }
  }
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
