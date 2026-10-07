import {
  BasketCard,
  type BasketLine,
  BasketSheet,
  ChainId as Chain,
  type ChainId,
  ConsentKind as Consent,
  type ConsentKind,
  BasketLine as Line,
  OrderDetail as Order,
  type OrderDetail,
  type TRUST_STATUS,
  type Trade,
  Trade as TradeSchema,
  Verdict,
} from '@colosseum/schemas';
import { readTerms, type SharedTerms } from '../shared/terms';

// What this browser keeps about an order, so the order screen survives a reload and a second tab:
//
//   placed     the plan it buys, as the plan screen showed it: its id and its lines, which the vault's
//              targets are worked out from. Written when the order is made. For an order about a
//              shared portfolio (a buy that follows one, a follow, a publish: WEB-4), and for more
//              money into a vault (add money), the terms its screen showed take the plan's place
//              (features/shared/terms.ts).
//   approved   the order exactly as the review screen showed it when the person pressed the button,
//              with the consents they ticked. From then on it is what every run of the order is handed:
//              it is never read again from the API to decide what a step may do.
//
// In local storage: a reload, a closed tab and a second tab all find it. It is one person's, and is
// read back only for them.

export type ApprovedOrder = {
  order: OrderDetail;
  consents: ConsentKind[];
  /** When the person approved it, as an ISO instant. */
  at: string;
};

/**
 * The goal the plan was built for, as the plan screen had it when the order was placed: the limits,
 * the plan's card and, for an income goal, the engine's verdict. The portfolio's goal card is drawn
 * from it (features/portfolio). Records kept before it was written have none.
 */
export type PlacedGoal = {
  sheet: BasketSheet;
  card: BasketCard;
  verdict: Verdict | null;
  /** When the order was placed, as an ISO instant: the goal's date counts from it. */
  placedAt: string;
};

export type OrderRecord = {
  orderId: string;
  userId: string;
  /** The plan a buy buys. Empty for an order about a shared portfolio. */
  proposalId: string;
  chain: ChainId;
  /** The amount typed for a buy. Zero for a follow or a publish, which deposit nothing. */
  amountUsd: number;
  lines: BasketLine[];
  /** For an order about a shared portfolio: what its screen showed. */
  terms?: SharedTerms;
  approved: ApprovedOrder | null;
  goal?: PlacedGoal | null;
  /**
   * The plan was made from a link (gate `AGENT-LINK`): its vault's number takes this record's person
   * too (`basketIdOfLinkedPlan`), so the link alone does not lead to the vault.
   */
  linked?: true;
  /**
   * For an order that finishes another with the cash already in its vault (`POST
   * /v1/orders/{id}/continue`): that order's id, and the trades it left undone, as this browser's
   * record of it had them. The order is held to these, and deposits nothing (order-check.ts).
   */
  continues?: {
    orderId: string;
    trades: Trade[];
    /**
     * This browser never reviewed the first order: the trades are the ones the server lists as left,
     * held to the plan's lines read from the server, and the review says so.
     */
    unseen?: true;
  };
  /**
   * The vault's number on chain as the server's list of plans gave it (`GET /v1/me/plans`), for a
   * record made from that list and not kept in this browser (features/portfolio/server-plans.ts).
   */
  basketId?: string;
};

function readGoal(value: unknown): PlacedGoal | null {
  if (typeof value !== 'object' || value === null) return null;
  const g = value as Record<string, unknown>;
  const sheet = BasketSheet.safeParse(g.sheet);
  const card = BasketCard.safeParse(g.card);
  const verdict = g.verdict == null ? null : Verdict.safeParse(g.verdict);
  if (!sheet.success || !card.success || verdict?.success === false || !text(g.placedAt))
    return null;
  return {
    sheet: sheet.data,
    card: card.data,
    verdict: verdict?.success ? verdict.data : null,
    placedAt: g.placedAt,
  };
}

/** True when the order deposits cash: a buy of a plan or of a shared portfolio, or an add to a vault. */
export const isBuy = (record: Pick<OrderRecord, 'terms'>): boolean =>
  !record.terms || record.terms.kind === 'family' || record.terms.kind === 'vault';

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A record as it was written, or null when any part of it does not read. */
function readRecord(value: unknown): OrderRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const chain = Chain.safeParse(r.chain);
  const lines = Line.array().safeParse(r.lines);
  const terms = r.terms === undefined ? undefined : readTerms(r.terms);
  if (terms === null) return null;
  // A buy names its plan and an amount, or its portfolio or its vault and an amount; a follow and a
  // publish neither.
  const buy = isBuy({ terms });
  if (
    !text(r.orderId) ||
    !text(r.userId) ||
    (!terms && !text(r.proposalId)) ||
    typeof r.proposalId !== 'string' ||
    !chain.success ||
    !lines.success ||
    typeof r.amountUsd !== 'number' ||
    (buy ? !(r.amountUsd > 0) : r.amountUsd !== 0)
  )
    return null;
  let continues: OrderRecord['continues'];
  if (r.continues !== undefined) {
    const c = (typeof r.continues === 'object' ? r.continues : null) as Record<
      string,
      unknown
    > | null;
    const trades = TradeSchema.array().min(1).safeParse(c?.trades);
    // A record that says it finishes an order and does not say which, or with what, is not read.
    if (!c || !text(c.orderId) || !trades.success) return null;
    continues = {
      orderId: c.orderId,
      trades: trades.data,
      ...(c.unseen === true ? { unseen: true as const } : {}),
    };
  }
  let approved: ApprovedOrder | null = null;
  if (r.approved !== null) {
    const a = (typeof r.approved === 'object' ? r.approved : null) as Record<
      string,
      unknown
    > | null;
    const order = Order.safeParse(a?.order);
    const consents = Consent.array().safeParse(a?.consents);
    if (!a || !order.success || !consents.success || !text(a.at)) return null;
    approved = { order: order.data, consents: consents.data, at: a.at };
  }
  return {
    orderId: r.orderId,
    userId: r.userId,
    proposalId: r.proposalId,
    chain: chain.data,
    amountUsd: r.amountUsd,
    lines: lines.data,
    ...(terms ? { terms } : {}),
    approved,
    goal: readGoal(r.goal),
    ...(r.linked === true ? { linked: true as const } : {}),
    ...(continues ? { continues } : {}),
  };
}

const KEY = (id: string) => `tf-order:${id}`;

/** Writes the record. False when this browser keeps nothing, and then nothing is signed. */
export function keepOrder(record: OrderRecord): boolean {
  try {
    window.localStorage.setItem(KEY(record.orderId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** The record of this order, for this person, if it is here and reads. */
export function recallOrder(orderId: string, userId: string | null): OrderRecord | null {
  if (!userId) return null;
  try {
    const raw = window.localStorage.getItem(KEY(orderId));
    if (!raw) return null;
    const read = readRecord(JSON.parse(raw));
    if (!read || read.orderId !== orderId || read.userId !== userId) return null;
    // The approved order is the one this record is about, or the record is not used.
    if (read.approved && read.approved.order.id !== orderId) return null;
    return read;
  } catch {
    return null;
  }
}

/** Every order this person placed in this browser, newest first. */
export function recallOrders(userId: string | null): OrderRecord[] {
  if (!userId) return [];
  const found: OrderRecord[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith('tf-order:')) continue;
      const record = recallOrder(key.slice('tf-order:'.length), userId);
      if (record) found.push(record);
    }
  } catch {
    return [];
  }
  const at = (r: OrderRecord) => r.goal?.placedAt ?? r.approved?.at ?? '';
  return found.sort((a, b) => at(b).localeCompare(at(a)));
}

/**
 * Forgets the order records this browser kept for a person: they signed out, or another person signed
 * in. The orders stay on the server. What was signed for a step is kept apart (run-order.ts) and is
 * not touched: it is what stops a step being signed twice. The trust acceptance stays too: it holds
 * no figure, and is read only for the person it names.
 */
export function forgetOrders(userId: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith('tf-order:') && recallOrder(key.slice('tf-order:'.length), userId))
        keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

// The trust notice (TRUST_STATUS), accepted once per person and version of its text, before the first
// deposit. The API's consent route is not built (apps/api/src/orders/README.md, item 12), so the
// acceptance is kept in this browser, with the version of the text and the time, and whether the
// keeper's limits were among the short points shown (a plan's own vault leaves them out): a buy that
// the keeper may trade asks again of someone who accepted without them.

const TRUST_KEY = (userId: string) => `tf-trust:${userId}`;

export function trustAccepted(
  userId: string | null,
  version: string,
  /** This buy's vault may be traded by the keeper: the acceptance must have shown its limits. */
  keeper = true,
): boolean {
  if (!userId) return false;
  try {
    const raw = window.localStorage.getItem(TRUST_KEY(userId));
    const read = raw ? (JSON.parse(raw) as { textVersion?: unknown; keeperShown?: unknown }) : null;
    // An acceptance kept before this was recorded was of the notice with every point.
    return read?.textVersion === version && (!keeper || read.keeperShown !== false);
  } catch {
    return false;
  }
}

export function acceptTrust(
  userId: string,
  version: (typeof TRUST_STATUS)['textVersion'],
  keeperShown = true,
): void {
  try {
    // An acceptance that showed the keeper's limits is not written over by one that did not.
    const before = keeperShown ? false : trustAccepted(userId, version, true);
    window.localStorage.setItem(
      TRUST_KEY(userId),
      JSON.stringify({
        textVersion: version,
        acceptedAt: new Date().toISOString(),
        keeperShown: keeperShown || before,
      }),
    );
  } catch {
    // Not kept: the notice is asked again next time.
  }
}
