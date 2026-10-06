import type { OrderRecord, PlacedGoal } from '../order/order-record';
import { basketOfPlan } from '../order/readiness';
import type { Vault } from './portfolio';

// Which goal a vault was bought for. The API's portfolio names a vault by its plan's number on chain
// (`basketId`) and does not join it to the plan; this browser keeps, with each order it placed, the
// plan's id and the goal it was built for (order-record.ts). The plan's id gives the number by the
// API's own rule (`basketOfPlan`), so a vault is joined to the newest order of its plan that kept a
// goal. A vault bought from another browser, or before goals were kept, is joined to nothing, and the
// screen says so: no target is made up for it.

export type VaultGoal = { goal: PlacedGoal; record: OrderRecord };

/** The orders this browser placed into this vault, newest first. */
export const ordersOfVault = (vault: Vault, records: readonly OrderRecord[]): OrderRecord[] =>
  records.filter((r) => r.chain === vault.chain && basketOfPlan(r.proposalId) === vault.basketId);

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

/** When the goal is due: the order's day, plus the plan's horizon in months. */
export function dueOf(goal: PlacedGoal): Date {
  const due = new Date(goal.placedAt);
  due.setUTCMonth(due.getUTCMonth() + goal.sheet.horizonMonths);
  return due;
}
