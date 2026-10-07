import type { Db } from '@colosseum/db';
import { orders, planTurns, proposals, users, vaults } from '@colosseum/db';
import type {
  IntentRequest,
  Order,
  ThreadEvent,
  ThreadReply,
  ThreadTurn,
  ThreadTurnRequest,
} from '@colosseum/schemas';
import { and, asc, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { StoredOrder } from './store';

// A plan's thread (gate PLAN-THREAD; `packages/schemas/src/plan-thread.ts`): the store of its turns.
//
// Who reads and writes it is decided here once: a plan's own person, by the plan's row, and nobody
// else. A plan made from a link is stored with no person, so it has no thread: what an agent proposed
// for somebody is not a conversation that somebody had. The person's words are never handed to a
// logger from this file, and no function here answers them to a caller that is not that person.
//
// Events are written here by the server, from an order as the database has it. Nothing a browser
// sends becomes one.

type Row = typeof planTurns.$inferSelect;

const toTurn = (row: Row): ThreadTurn | null => {
  const base = { id: row.id, at: row.createdAt.toISOString() };
  if (row.who === 'person' && row.text !== null) return { ...base, who: 'person', text: row.text };
  if (row.who === 'app' && row.reply !== null) return { ...base, who: 'app', reply: row.reply };
  if (row.who === 'event' && row.event !== null) return { ...base, who: 'event', event: row.event };
  return null;
};

/**
 * The id of the plan when it is this person's own: a plan they made, by its row. Null for another
 * person's, for a plan made from a link, and for an id that names nothing, with nothing to tell the
 * three apart.
 */
export async function ownPlanId(
  db: Db,
  id: string,
  privyId: string | null,
): Promise<string | null> {
  if (privyId === null) return null;
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .innerJoin(users, eq(users.id, proposals.userId))
    .where(and(eq(proposals.id, id), eq(users.privyId, privyId), eq(proposals.fromLink, false)));
  return row?.id ?? null;
}

/**
 * A page of a plan's thread: the newest `limit` turns before `before` (a turn's place in the thread),
 * oldest first. `before` in the answer is the place to ask the older page with, or null when the page
 * starts at the first turn.
 */
export async function listTurns(
  db: Db,
  planId: string,
  page: { limit: number; before?: number },
): Promise<{ turns: ThreadTurn[]; before: string | null }> {
  const rows = await db
    .select()
    .from(planTurns)
    .where(
      and(
        eq(planTurns.proposalId, planId),
        ...(page.before === undefined ? [] : [lt(planTurns.seq, page.before)]),
      ),
    )
    .orderBy(desc(planTurns.seq))
    .limit(page.limit + 1);
  const shown = rows.slice(0, page.limit).reverse();
  const more = rows.length > page.limit;
  return {
    turns: shown.flatMap((row) => toTurn(row) ?? []),
    before: more && shown[0] ? String(shown[0].seq) : null,
  };
}

const turnRows = (planId: string, turn: { text: string; reply: ThreadReply }) => [
  { proposalId: planId, who: 'person' as const, text: turn.text },
  { proposalId: planId, who: 'app' as const, reply: turn.reply },
];

/** Appends a person's turn and the app's reply to it, in that order. Answers the two as stored. */
export async function appendTurn(
  db: Db,
  planId: string,
  turn: ThreadTurnRequest,
): Promise<ThreadTurn[]> {
  const rows = await db.insert(planTurns).values(turnRows(planId, turn)).returning();
  return rows.sort((a, b) => a.seq - b.seq).flatMap((row) => toTurn(row) ?? []);
}

/**
 * Stores the turns of a thread started before the plan was made (signed out, in the tab), once: only
 * while the plan's thread holds no turn of a person's. Sent again for the same plan, it is not written
 * a second time.
 */
export async function attachThread(
  db: Db,
  planId: string,
  turns: readonly ThreadTurnRequest[],
): Promise<void> {
  if (turns.length === 0) return;
  await db.transaction(async (tx) => {
    // One at a time for a plan: two requests at once would both find the thread empty.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`thread:${planId}`}, 0))`);
    const [said] = await tx
      .select({ id: planTurns.id })
      .from(planTurns)
      .where(and(eq(planTurns.proposalId, planId), eq(planTurns.who, 'person')))
      .limit(1);
    if (said) return;
    await tx.insert(planTurns).values(turns.flatMap((turn) => turnRows(planId, turn)));
  });
}

/** What makes an event a row once: its kind and the plan or the order it is about. */
const keyOf = (event: ThreadEvent) =>
  `${event.type}:${event.type === 'plan_built' ? event.planId : event.orderId}`;

/** Writes events to a plan's thread, each once however often it is seen. */
export async function appendEvents(
  db: Db,
  planId: string,
  events: readonly ThreadEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await db
    .insert(planTurns)
    .values(
      events.map((event) => ({
        proposalId: planId,
        who: 'event' as const,
        event,
        eventKey: keyOf(event),
      })),
    )
    .onConflictDoNothing({ target: [planTurns.proposalId, planTurns.eventKey] });
}

/** What kind of order it is, as the thread says it. */
export function orderKind(
  order: Pick<Order, 'continues'>,
  request: IntentRequest,
): 'buy' | 'add' | 'finish' | 'withdraw' | null {
  if (request.type === 'withdraw') return 'withdraw';
  if (request.type !== 'buy') return null;
  if (order.continues) return 'finish';
  return request.vault ? 'add' : 'buy';
}

/** The event of an order having been made, or null for an order the thread does not tell of. */
export function madeEvent(order: Order, request: IntentRequest): ThreadEvent | null {
  const kind = orderKind(order, request);
  if (!kind) return null;
  return {
    type: 'order_made',
    orderId: order.id,
    kind,
    // An order that finishes another, or takes money out, moves none in.
    amountUsd: request.type === 'buy' && kind !== 'finish' ? request.amountUsd : null,
  };
}

const settled = (status: string) => status === 'confirmed' || status === 'skipped';

/**
 * What an order's state says has happened, as events: its deposit landed, the buy is done or has
 * stopped with its cash in the vault, the withdrawal is done. Read from the order as the database
 * has it, every time: an event already written is not written again (`appendEvents`).
 */
export function stateEvents(order: Order, request: IntentRequest): ThreadEvent[] {
  const kind = orderKind(order, request);
  if (!kind) return [];
  const orderId = order.id;
  if (kind === 'withdraw')
    return order.status === 'done' ? [{ type: 'withdrawal_done', orderId }] : [];
  const deposits = order.legs.filter((l) => l.kind === 'create_vault' || l.kind === 'deposit');
  const landed = deposits.length > 0 && deposits.every((l) => l.status === 'confirmed');
  const events: ThreadEvent[] = [];
  if (landed) events.push({ type: 'deposit_landed', orderId });
  if (order.status === 'done') events.push({ type: 'buy_done', orderId });
  // Stopped: the cash is in the vault (or, for an order that finishes one, was already there) and the
  // order can no longer finish as it is.
  const cashIn = landed || kind === 'finish';
  const stopped = order.status === 'failed' || order.status === 'expired';
  if (stopped && cashIn && !order.legs.every((l) => settled(l.status)))
    events.push({ type: 'buy_stopped', orderId });
  return events;
}

/**
 * The plan an order is about, for its thread. A buy names its plan. An add, a withdrawal and a
 * finish reach it through the vault: the plan of the first buy, by the same wallet, that opened the
 * vault with that number. Null when there is none (a vault that follows a shared portfolio has no plan
 * of the person's), and for a plan made from a link, which has no thread.
 */
export async function planOfOrder(
  db: Db,
  order: Order,
  request: IntentRequest,
): Promise<string | null> {
  const direct = request.type === 'buy' ? request.proposalId : undefined;
  let planId = direct ?? null;
  if (!planId) {
    let number = order.basketId ?? null;
    const chain = order.legs[0]?.chain;
    if (!number && request.type === 'withdraw' && chain) {
      const [vault] = await db
        .select({ number: vaults.onchainBasketId })
        .from(vaults)
        .where(and(eq(vaults.chainId, chain), eq(vaults.address, request.vaults[0] ?? '')));
      number = vault?.number ?? null;
    }
    const owners = [
      ...(order.owner.solana ? [eq(orders.ownerSolana, order.owner.solana)] : []),
      ...(order.owner.evm ? [eq(orders.ownerEvm, order.owner.evm)] : []),
    ];
    if (!number || owners.length === 0) return null;
    const named = sql<string | null>`${orders.request}->>'proposalId'`;
    const [first] = await db
      .select({ planId: named })
      .from(orders)
      .where(and(eq(orders.basketId, number), or(...owners), isNotNull(named)))
      .orderBy(asc(orders.createdAt))
      .limit(1);
    planId = first?.planId ?? null;
  }
  if (!planId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId))
    return null;
  // A thread is a person's: a plan with no person (one from a link) has none.
  const [plan] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(eq(proposals.id, planId), eq(proposals.fromLink, false), isNotNull(proposals.userId)),
    );
  return plan?.id ?? null;
}

/**
 * Tells the thread of the order's plan what the order's state says, and, when the order was just
 * made, that it was; `stopped` says so of a buy another order now finishes, whatever its own status.
 * The thread is a record beside the order: a failure to write it never fails what the order was
 * doing, and is reported to `onError` with no word of the thread in it.
 */
export async function noteOrder(
  db: Db,
  stored: Pick<StoredOrder, 'order' | 'request'>,
  o: { made?: boolean; stopped?: boolean; onError?: (e: unknown) => void } = {},
): Promise<void> {
  try {
    const made = o.made ? madeEvent(stored.order, stored.request) : null;
    const events = [...(made ? [made] : []), ...stateEvents(stored.order, stored.request)];
    if (o.stopped && !events.some((e) => e.type === 'buy_stopped'))
      events.push({ type: 'buy_stopped', orderId: stored.order.id });
    if (events.length === 0) return;
    const planId = await planOfOrder(db, stored.order, stored.request);
    if (planId) await appendEvents(db, planId, events);
  } catch (e) {
    o.onError?.(e);
  }
}
