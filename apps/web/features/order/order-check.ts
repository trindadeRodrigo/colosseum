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

/** The steps an add of money to a vault is made of. */
const ADD_KINDS: readonly string[] = ['approve', 'deposit', 'swap'];

/**
 * More money into a vault the person has (add money): the deposit as for a plan, into the vault they
 * chose and no new one, once, and each trade the share its targets give: every trade buys a target with
 * the cash token, for exactly the share of the deposit that target's weight gives, and no target is
 * left out. The targets are the ones this app read from the chain itself where it could
 * (features/portfolio/chain-vault.ts): the guard holds every step's bytes to the vault of that number
 * and the person's own wallet, and a swap to the tokens the deployment lists, but not to the vault's
 * targets, so this is where an add's trades are held to them.
 */
export function checkVaultAdd(
  order: Pick<OrderDetail, 'depositRaw' | 'legs' | 'basketId'>,
  amountUsd: number,
  units: ChainUnits | null,
  terms: Extract<SharedTerms, { kind: 'vault' }>,
): DepositCheck | { ok: false; why: 'trades' | 'shape' } {
  // An add is an approval where the chain needs one, the deposit, and the swaps; with auto-follow on,
  // no swap. Any other step beside them (a new vault, a withdrawal, a change of targets or of a
  // setting) is not an add, whatever else the order does right.
  const kinds = order.legs.map((l) => l.kind);
  const allowed: readonly string[] = terms.keeper ? ['approve', 'deposit'] : ADD_KINDS;
  const count = (kind: string) => kinds.filter((k) => k === kind).length;
  if (kinds.some((k) => !allowed.includes(k)) || count('deposit') !== 1 || count('approve') > 1)
    return { ok: false, why: 'shape' };
  // An order that states the vault's number states the one of the vault chosen.
  if (order.basketId !== undefined && order.basketId !== terms.basketId)
    return { ok: false, why: 'shape' };
  return checkFamilyBuy(order, amountUsd, units, terms.targets);
}

/**
 * A follow or a publish moves no cash and trades nothing: no deposit, no cash on a step, no trade, and
 * only the steps its terms call for, each once. The guard holds each step's bytes to the terms; this
 * holds the order's shape to them before anything is offered for signing.
 */
export function sharedShapeOk(
  order: Pick<OrderDetail, 'depositRaw' | 'legs'>,
  terms: Extract<SharedTerms, { kind: 'follow' | 'publish' }>,
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
