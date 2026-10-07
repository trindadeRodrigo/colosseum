import type { PinSource } from '../../components/ui/provenance';
import type { OrderRecord, PlacedGoal } from '../order/order-record';
import { basketOfPlan } from '../order/readiness';
import { addDecimals, type Vault, worst } from './portfolio';
import type { ServerWithdrawal } from './server-withdrawals';

// Which goal a vault was bought for. The API's portfolio names a vault by its plan's number on chain
// (`basketId`) and does not join it to the plan. The join is the server's list of the person's plans
// (`GET /v1/me/plans`, server-plans.ts), which gives each plan's goal, its buys and that number; this
// browser also keeps, with each order it placed, the plan's id and the goal it was built for
// (order-record.ts), where the plan's id gives the number by the API's own rule (`basketOfPlan`). A
// vault is joined to the newest order of its plan that has a goal. One the server's list does not
// name and this browser did not place (a buy of a shared portfolio, which has no goal) is joined to
// nothing, and the screen says so: no target is made up for it. What was taken out of a vault is the
// server's list of the person's withdrawals (`GET /v1/me/withdrawals`, server-withdrawals.ts), joined
// by the vault's own address.

export type VaultGoal = { goal: PlacedGoal; record: OrderRecord };

/** The orders this browser placed into this vault, newest first. */
export const ordersOfVault = (vault: Vault, records: readonly OrderRecord[]): OrderRecord[] =>
  records.filter(
    (r) =>
      r.chain === vault.chain &&
      (r.basketId ??
        r.approved?.order.basketId ??
        basketOfPlan(r.proposalId, r.linked ? r.userId : null)) === vault.basketId,
  );

/** The goal of the newest of those orders that kept one, or null. */
export function goalOfVault(vault: Vault, records: readonly OrderRecord[]): VaultGoal | null {
  for (const record of ordersOfVault(vault, records))
    if (record.goal) return { goal: record.goal, record };
  return null;
}

/**
 * What was put into the vault: the amounts of the orders of its plan whose deposit is confirmed on
 * chain. An order kept before it was signed, or never signed, counts nothing. Null when none is.
 */
export function putInto(
  vault: Vault,
  records: readonly OrderRecord[],
  deposited: ReadonlySet<string>,
): number | null {
  const counted = ordersOfVault(vault, records).filter((r) => deposited.has(r.orderId));
  return counted.length === 0 ? null : counted.reduce((sum, r) => sum + r.amountUsd, 0);
}

/**
 * What was taken out of the vault, in dollars: the withdrawals of it that are confirmed on chain, each
 * token at its value when the withdrawal was ordered (the server's figure, with its source), added
 * up exactly. `unvalued` counts the tokens taken out that had no price then: they are in no sum, and
 * the screen says how many. Null when nothing confirmed left the vault.
 */
export function takenOut(
  vault: Vault,
  withdrawals: readonly ServerWithdrawal[],
  method: (count: number) => string,
): TakenOut | null {
  const taken = withdrawals
    .filter((w) => w.chain === vault.chain && w.vault === vault.address)
    .flatMap((w) => w.steps.filter((s) => s.status === 'confirmed'))
    .flatMap((s) => s.withdrawals.map((w) => ({ valued: w.valued, provenance: s.provenance })));
  if (taken.length === 0) return null;
  const valued = taken.flatMap((w) => (w.valued ? [w.valued] : []));
  const [first] = valued;
  if (!first) return { usd: null, obs: null, unvalued: taken.length };
  return {
    usd: addDecimals(valued.map((v) => v.usd)),
    obs: {
      source: [...new Set(valued.map((v) => v.source))].join(' + '),
      fetchedAt: valued.reduce(
        (oldest, v) => (Date.parse(v.fetchedAt) < Date.parse(oldest) ? v.fetchedAt : oldest),
        first.fetchedAt,
      ),
      method: method(valued.length),
      provenance: valued.reduce((label, v) => worst(label, v.provenance), vault.provenance),
    },
    unvalued: taken.length - valued.length,
  };
}

/** `takenOut`'s answer: the sum with its pin, or neither when no token taken out had a price. */
export type TakenOut =
  | { usd: string; obs: PinSource; unvalued: number }
  | { usd: null; obs: null; unvalued: number };

/** When the goal is due: the order's day, plus the plan's horizon in months. */
export function dueOf(goal: PlacedGoal): Date {
  const due = new Date(goal.placedAt);
  due.setUTCMonth(due.getUTCMonth() + goal.sheet.horizonMonths);
  return due;
}
