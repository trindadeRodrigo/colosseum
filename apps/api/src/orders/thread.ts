import type { Db } from '@colosseum/db';
import { orders, planThreads, planTurns, proposals, users, vaults } from '@colosseum/db';
import {
  type IntentRequest,
  type Order,
  THREAD_LIMITS,
  type ThreadEvent,
  ThreadKey,
  type ThreadReply,
  type ThreadTurn,
  type ThreadTurnRequest,
} from '@colosseum/schemas';
import { and, asc, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { StoredOrder } from './store';

// A thread (gate PLAN-THREAD; `packages/schemas/src/plan-thread.ts`): the store of its turns.
//
// A thread is a conversation's, and the plans built in it share it: a plan built again from the same
// conversation joins the thread of the plan before it, so the person reads one thread from the first
// sentence through every rebuild to the buy, and then on the vault, whose thread is that of the plan
// that funded it. A plan names its thread (`proposals.thread_id`), and only the server sets it.
//
// Who reads and writes it is decided here once: the thread's own person, by the row of a plan of
// theirs, and nobody else. A plan joins a thread only from another plan of the same person. A plan
// made from a link is stored with no person, so it has no thread: what an agent proposed for
// somebody is not a conversation that somebody had. The person's words are never handed to a logger
// from this file, and no function here answers them to a caller that is not that person.
//
// Events are written here by the server, from a plan as it is stored and an order as the database
// has it. Nothing a browser sends becomes one.

type Row = typeof planTurns.$inferSelect;

const toTurn = (row: Row): ThreadTurn | null => {
  const base = { id: row.id, at: row.createdAt.toISOString() };
  if (row.who === 'person' && row.text !== null) return { ...base, who: 'person', text: row.text };
  if (row.who === 'app' && row.reply !== null) return { ...base, who: 'app', reply: row.reply };
  if (row.who === 'event' && row.event !== null) return { ...base, who: 'event', event: row.event };
  return null;
};

/** A plan of a person's own, as the thread needs it: whose it is, and the thread it is in, if any. */
export type OwnPlan = { id: string; userId: string; threadId: string | null };

/** Where a turn is written: the thread, and the plan the conversation had reached. */
export type ThreadPlace = { threadId: string; planId: string };

/**
 * The plan when it is this person's own: a plan they made, by its row. Null for another person's,
 * for a plan made from a link, and for an id that names nothing, with nothing to tell the three
 * apart.
 */
export async function ownPlan(db: Db, id: string, privyId: string | null): Promise<OwnPlan | null> {
  if (privyId === null) return null;
  const [row] = await db
    .select({ id: proposals.id, userId: users.id, threadId: proposals.threadId })
    .from(proposals)
    .innerJoin(users, eq(users.id, proposals.userId))
    .where(and(eq(proposals.id, id), eq(users.privyId, privyId), eq(proposals.fromLink, false)));
  return row ?? null;
}

const lock = (tx: Pick<Db, 'execute'>, what: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`thread:${what}`}, 0))`);

/**
 * The thread a plan is in, started when it has none: a plan made before threads were kept, or one
 * just stored. `join` names the thread to take instead of a new one (a plan built again in a
 * conversation). A plan that is in a thread stays in it: the answer is the thread it has.
 */
export async function threadOf(
  db: Db,
  plan: Pick<OwnPlan, 'id' | 'userId'>,
  join?: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    // One at a time for a plan: two requests at once would each start a thread.
    await lock(tx, plan.id);
    const [now] = await tx
      .select({ threadId: proposals.threadId })
      .from(proposals)
      .where(eq(proposals.id, plan.id));
    if (now?.threadId) return now.threadId;
    let threadId = join;
    if (!threadId) {
      const [made] = await tx
        .insert(planThreads)
        .values({ userId: plan.userId })
        .returning({ id: planThreads.id });
      if (!made) throw new Error('a thread was not stored');
      threadId = made.id;
    }
    await tx
      .update(proposals)
      .set({ threadId })
      .where(and(eq(proposals.id, plan.id), isNull(proposals.threadId)));
    return threadId;
  });
}

/**
 * A page of a thread: the newest `limit` turns before `before` (a turn's place in the thread),
 * oldest first. `before` in the answer is the place to ask the older page with, or null when the page
 * starts at the first turn. A plan with no thread yet has no turns.
 */
export async function listTurns(
  db: Db,
  threadId: string | null,
  page: { limit: number; before?: number },
): Promise<{ turns: ThreadTurn[]; before: string | null }> {
  if (threadId === null) return { turns: [], before: null };
  const rows = await db
    .select()
    .from(planTurns)
    .where(
      and(
        eq(planTurns.threadId, threadId),
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

const turnRows = (at: ThreadPlace, turn: { text: string; reply: ThreadReply }) => [
  { threadId: at.threadId, proposalId: at.planId, who: 'person' as const, text: turn.text },
  { threadId: at.threadId, proposalId: at.planId, who: 'app' as const, reply: turn.reply },
];

/** Appends a person's turn and the app's reply to it, in that order. Answers the two as stored. */
export async function appendTurn(
  db: Db,
  at: ThreadPlace,
  turn: ThreadTurnRequest,
): Promise<ThreadTurn[]> {
  const rows = await db.insert(planTurns).values(turnRows(at, turn)).returning();
  return rows.sort((a, b) => a.seq - b.seq).flatMap((row) => toTurn(row) ?? []);
}

/**
 * Stores the turns of a conversation begun before any plan of it was stored (signed out, in the
 * tab), once: only while the thread holds no turn of a person's. Sent again, or sent with a plan
 * built again in a thread that has its turns, it is not written a second time.
 */
export async function attachThread(
  db: Db,
  at: ThreadPlace,
  turns: readonly ThreadTurnRequest[],
): Promise<void> {
  if (turns.length === 0) return;
  await db.transaction(async (tx) => {
    // One at a time for a thread: two requests at once would both find it empty.
    await lock(tx, at.threadId);
    const [said] = await tx
      .select({ id: planTurns.id })
      .from(planTurns)
      .where(and(eq(planTurns.threadId, at.threadId), eq(planTurns.who, 'person')))
      .limit(1);
    if (said) return;
    await tx.insert(planTurns).values(turns.flatMap((turn) => turnRows(at, turn)));
  });
}

/** What makes an event a row once: its kind and the plan or the order it is about. */
const keyOf = (event: ThreadEvent) =>
  `${event.type}:${'orderId' in event ? event.orderId : event.planId}`;

/** Writes events to a thread, each once however often it is seen. */
export async function appendEvents(
  db: Db,
  at: ThreadPlace,
  events: readonly ThreadEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await db
    .insert(planTurns)
    .values(
      events.map((event) => ({
        threadId: at.threadId,
        proposalId: at.planId,
        who: 'event' as const,
        event,
        eventKey: keyOf(event),
      })),
    )
    .onConflictDoNothing({ target: [planTurns.threadId, planTurns.eventKey] });
}

/**
 * The names of the sheet's fields that differ between two plans' sheets, in order: what a plan built
 * again changed. Names only, never a value.
 */
export function changedFields(before: object, after: object): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .filter((key) => ThreadKey.safeParse(key).success)
    .sort()
    .slice(0, THREAD_LIMITS.changedMax);
}

/**
 * Puts a plan that was just stored in its thread, and says so there. A plan built in a conversation
 * that already has one (`previousPlanId`, honoured only when that plan is this person's own) joins
 * that plan's thread, with a `plan_rebuilt` event naming both and what changed. Any other plan starts
 * a thread, takes the conversation so far where one was sent, and gets `plan_built`. A plan that is
 * in a thread already (the same plan stored again) is left as it is. Nothing happens for a plan that
 * is not this person's own, which is every plan made from a link.
 */
export async function placePlan(
  db: Db,
  a: {
    planId: string;
    privyId: string | null;
    previousPlanId?: string;
    turns?: readonly ThreadTurnRequest[];
  },
): Promise<void> {
  const plan = await ownPlan(db, a.planId, a.privyId);
  if (!plan || plan.threadId) return;
  const previous =
    a.previousPlanId && a.previousPlanId !== plan.id
      ? await ownPlan(db, a.previousPlanId, a.privyId)
      : null;
  const joined = previous ? await threadOf(db, previous) : undefined;
  const threadId = await threadOf(db, plan, joined);
  const at = { threadId, planId: plan.id };
  await attachThread(db, at, a.turns ?? []);
  if (!previous || threadId !== joined) {
    await appendEvents(db, at, [{ type: 'plan_built', planId: plan.id }]);
    return;
  }
  const sheets = await db
    .select({ id: proposals.id, sheet: sql<object | null>`${proposals.proposal}->'sheet'` })
    .from(proposals)
    .where(or(eq(proposals.id, plan.id), eq(proposals.id, previous.id)));
  const sheetOf = (id: string) => sheets.find((row) => row.id === id)?.sheet ?? {};
  await appendEvents(db, at, [
    {
      type: 'plan_rebuilt',
      planId: plan.id,
      previousPlanId: previous.id,
      changed: changedFields(sheetOf(previous.id), sheetOf(plan.id)),
    },
  ]);
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
): Promise<Pick<OwnPlan, 'id' | 'userId'> | null> {
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
    .select({ id: proposals.id, userId: proposals.userId })
    .from(proposals)
    .where(
      and(eq(proposals.id, planId), eq(proposals.fromLink, false), isNotNull(proposals.userId)),
    );
  return plan?.userId ? { id: plan.id, userId: plan.userId } : null;
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
    const plan = await planOfOrder(db, stored.order, stored.request);
    if (plan)
      await appendEvents(db, { threadId: await threadOf(db, plan), planId: plan.id }, events);
  } catch (e) {
    o.onError?.(e);
  }
}
