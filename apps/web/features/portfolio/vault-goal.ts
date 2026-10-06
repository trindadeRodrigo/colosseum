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

/** When the goal is due: the order's day, plus the plan's horizon in months. */
export function dueOf(goal: PlacedGoal): Date {
  const due = new Date(goal.placedAt);
  due.setUTCMonth(due.getUTCMonth() + goal.sheet.horizonMonths);
  return due;
}
