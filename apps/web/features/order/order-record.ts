import {
  type BasketLine,
  ChainId as Chain,
  type ChainId,
  ConsentKind as Consent,
  type ConsentKind,
  BasketLine as Line,
  OrderDetail as Order,
  type OrderDetail,
  type TRUST_STATUS,
} from '@colosseum/schemas';

// What this browser keeps about an order, so the order screen survives a reload and a second tab:
//
//   placed     the plan it buys, as the plan screen showed it: its id and its lines, which the vault's
//              targets are worked out from. Written when the order is made.
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

export type OrderRecord = {
  orderId: string;
  userId: string;
  proposalId: string;
  chain: ChainId;
  amountUsd: number;
  lines: BasketLine[];
  approved: ApprovedOrder | null;
};

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A record as it was written, or null when any part of it does not read. */
function readRecord(value: unknown): OrderRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const chain = Chain.safeParse(r.chain);
  const lines = Line.array().safeParse(r.lines);
  if (
    !text(r.orderId) ||
    !text(r.userId) ||
    !text(r.proposalId) ||
    !chain.success ||
    !lines.success ||
    typeof r.amountUsd !== 'number' ||
    !(r.amountUsd > 0)
  )
    return null;
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
    approved,
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

// The trust notice (TRUST_STATUS), accepted once per person and version of its text, before the first
// deposit. The API's consent route is not built (apps/api/src/orders/README.md, item 12), so the
// acceptance is kept in this browser, with the version of the text and the time.

const TRUST_KEY = (userId: string) => `tf-trust:${userId}`;

export function trustAccepted(userId: string | null, version: string): boolean {
  if (!userId) return false;
  try {
    const raw = window.localStorage.getItem(TRUST_KEY(userId));
    const read = raw ? (JSON.parse(raw) as { textVersion?: unknown }) : null;
    return read?.textVersion === version;
  } catch {
    return false;
  }
}

export function acceptTrust(userId: string, version: (typeof TRUST_STATUS)['textVersion']): void {
  try {
    window.localStorage.setItem(
      TRUST_KEY(userId),
      JSON.stringify({ textVersion: version, acceptedAt: new Date().toISOString() }),
    );
  } catch {
    // Not kept: the notice is asked again next time.
  }
}
