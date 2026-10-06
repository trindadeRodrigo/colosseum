import type { OrderDetail } from '@colosseum/schemas';
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
