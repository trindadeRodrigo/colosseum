import {
  type BasketCard,
  type BasketSheet,
  BasketCard as Card,
  ChainId as Chain,
  type ChainId,
  Verdict as PlanVerdict,
  BasketSheet as Sheet,
  type Verdict,
} from '@colosseum/schemas';
import type { OrderRecord } from '../order/order-record';

// The person's plans as the server keeps them (`GET /v1/me/plans`): each with the goal it was built
// for, its buys and the vault they opened. The portfolio reads them so a vault is joined to its goal,
// and its orders are listed, on a device that never placed them. What this browser kept about an
// order (order-record.ts) still comes first: it holds the order as the person approved it.

/** A buy of a plan, as the list names it. */
type ServerBuy = { id: string; createdAt: string; amountUsd: number; deposited: boolean };

export type ServerPlan = {
  id: string;
  createdAt: string;
  fromLink: boolean;
  chain: ChainId;
  sheet: BasketSheet;
  card: BasketCard;
  verdict: Verdict | null;
  orders: ServerBuy[];
  vault: { chain: ChainId; basketId: string } | null;
};

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const fields = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

function readBuy(value: unknown): ServerBuy | null {
  const o = fields(value);
  if (!o || !text(o.id) || !text(o.createdAt) || typeof o.deposited !== 'boolean') return null;
  if (typeof o.amountUsd !== 'number' || !(o.amountUsd >= 0)) return null;
  return { id: o.id, createdAt: o.createdAt, amountUsd: o.amountUsd, deposited: o.deposited };
}

/** One plan of the list, or null when it is not one: every part is read, none is taken on trust. */
function readPlan(value: unknown): ServerPlan | null {
  const p = fields(value);
  if (!p || !text(p.id) || !text(p.createdAt) || typeof p.fromLink !== 'boolean') return null;
  const chain = Chain.safeParse(p.chain);
  const sheet = Sheet.safeParse(p.sheet);
  const card = Card.safeParse(p.card);
  const verdict = p.verdict == null ? null : PlanVerdict.safeParse(p.verdict);
  if (!chain.success || !sheet.success || !card.success || verdict?.success === false) return null;
  if (!Array.isArray(p.orders)) return null;
  const orders = p.orders.map(readBuy);
  if (orders.some((order) => order === null)) return null;
  const v = p.vault == null ? null : fields(p.vault);
  const vaultChain = v ? Chain.safeParse(v.chain) : null;
  if (p.vault != null && (!v || !vaultChain?.success || !text(v.basketId))) return null;
  return {
    id: p.id,
    createdAt: p.createdAt,
    fromLink: p.fromLink,
    chain: chain.data,
    sheet: sheet.data,
    card: card.data,
    verdict: verdict ? verdict.data : null,
    orders: orders as ServerBuy[],
    vault:
      v && vaultChain?.success && text(v.basketId)
        ? { chain: vaultChain.data, basketId: v.basketId }
        : null,
  };
}

/**
 * The list, or none: a server that has no such route, a call that fails, or an answer that is not the
 * list all read as no plans, and the portfolio stands on what this browser kept. A plan that does not
 * read is left out; the others stay.
 */
export async function readPersonPlans(
  apiFetch: (path: string) => Promise<Response>,
): Promise<ServerPlan[]> {
  try {
    const res = await apiFetch('/v1/me/plans');
    if (!res.ok) return [];
    const body = (await res.json()) as { plans?: unknown };
    if (!Array.isArray(body.plans)) return [];
    return body.plans.flatMap((plan) => {
      const read = readPlan(plan);
      return read ? [read] : [];
    });
  } catch {
    return [];
  }
}

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
