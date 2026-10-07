import { PersonPlan } from '@colosseum/schemas';
import type { OrderRecord } from '../order/order-record';

// The person's plans as the server keeps them (`GET /v1/me/plans`): each with the goal it was built
// for, its buys and the vault they opened. The portfolio reads them so a vault is joined to its goal,
// and its orders are listed, on a device that never placed them. What this browser kept about an
// order (order-record.ts) still comes first: it holds the order as the person approved it.

/** One plan of the list, as the API's own schema reads it (`PersonPlan` in packages/schemas). */
export type ServerPlan = PersonPlan;

/**
 * The list, or none: a server that has no such route, a call that fails, or an answer that is not the
 * list all read as no plans, and the portfolio stands on what this browser kept. A plan that does not
 * read is left out; the others stay.
 */
export async function readPersonPlans(
  apiFetch: (path: string) => Promise<Response>,
): Promise<ServerPlan[]> {
  const plans: ServerPlan[] = [];
  let before: string | null = null;
  // Page after page while the server names a next one, to a bound: what was read stays if one fails.
  for (let page = 0; page < MAX_PAGES; page += 1) {
    try {
      const res = await apiFetch(
        before ? `/v1/me/plans?before=${encodeURIComponent(before)}` : '/v1/me/plans',
      );
      if (!res.ok) break;
      const body = (await res.json()) as { plans?: unknown; next?: unknown };
      if (!Array.isArray(body.plans)) break;
      for (const plan of body.plans) {
        const read = PersonPlan.safeParse(plan);
        if (read.success) plans.push(read.data);
      }
      if (typeof body.next !== 'string' || body.next === before) break;
      before = body.next;
    } catch {
      break;
    }
  }
  return plans;
}

/** The most pages of the list one portfolio reads: 200 plans. */
export const MAX_PAGES = 4;

/**
 * Each buy of each plan as a record of the kind this browser keeps, for this person: the plan, the
 * amount, the goal as the plan was built (its date counts from the buy), and the vault's number. It
 * has no approved order and no lines: nothing is signed from it.
 */
export function recordsOfPlans(plans: readonly ServerPlan[], userId: string): OrderRecord[] {
  return plans.flatMap((plan) =>
    plan.orders.map((order) => ({
      orderId: order.id,
      userId,
      proposalId: plan.id,
      chain: plan.chain,
      amountUsd: order.amountUsd,
      lines: [],
      approved: null,
      goal: {
        sheet: plan.sheet,
        card: plan.card,
        verdict: plan.verdict,
        placedAt: order.createdAt,
      },
      ...(plan.fromLink ? { linked: true as const } : {}),
      ...(plan.vault ? { basketId: plan.vault.basketId } : {}),
    })),
  );
}

/**
 * What this browser kept and what the server lists, as one history, newest first. This browser's
 * record of an order stands; one it kept with no goal takes the server's. An order only the server
 * lists is added.
 */
export function mergeRecords(
  kept: readonly OrderRecord[],
  listed: readonly OrderRecord[],
): OrderRecord[] {
  const byId = new Map(listed.map((record) => [record.orderId, record]));
  const merged = kept.map((record) => {
    const server = byId.get(record.orderId);
    byId.delete(record.orderId);
    return record.goal || !server?.goal ? record : { ...record, goal: server.goal };
  });
  const at = (r: OrderRecord) => r.goal?.placedAt ?? r.approved?.at ?? '';
  return [...merged, ...byId.values()].sort((a, b) => at(b).localeCompare(at(a)));
}
