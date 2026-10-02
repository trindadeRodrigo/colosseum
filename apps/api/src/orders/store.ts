import { type Db, legAttempts, legs, orders, proposals, vaults } from '@colosseum/db';
import {
  type Attempt,
  BasketProposal,
  ChainId,
  type IntentRequest,
  type Leg,
  type Order,
  type Provenance,
  type VaultView,
} from '@colosseum/schemas';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Refusal } from './errors';

// The order tables (DESIGN-VAULT section 4), read and written through Drizzle. A leg row mirrors its
// latest attempt; every build is one row in leg_attempts.

type LegRow = typeof legs.$inferSelect;
type AttemptRow = typeof legAttempts.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

/** An order as the API holds it: the order, the request it came from, and every attempt at its legs. */
export type StoredOrder = { order: Order; request: IntentRequest; attempts: Attempt[] };

const toLeg = (r: LegRow): Leg => ({
  id: r.id,
  orderId: r.orderId,
  chain: r.chainId,
  seq: r.seq,
  kind: r.kind,
  signer: r.signer,
  description: r.description,
  trades: r.trades,
  expected: r.expected ?? null,
  status: r.status,
  attempt: r.attempt,
  txId: r.txId,
  explorerUrl: r.explorerUrl,
  validUntil: r.validUntil,
  error: r.error ?? null,
  trigger: r.trigger,
  provenance: r.provenance,
});

const toAttempt = (r: AttemptRow & { legId: string }): Attempt => ({
  id: r.id,
  legId: r.legId,
  n: r.n,
  messageHash: r.messageHash,
  nonce: r.nonce,
  status: r.status,
  txId: r.txId,
  explorerUrl: r.explorerUrl,
  validUntil: r.validUntil,
  builtAt: r.builtAt.toISOString(),
});

const chainOrder = (chain: ChainId) => ChainId.options.indexOf(chain);

function toOrder(r: OrderRow, legRows: LegRow[]): Order {
  return {
    id: r.id,
    type: r.type,
    owner: {
      ...(r.ownerSolana ? { solana: r.ownerSolana } : {}),
      ...(r.ownerEvm ? { evm: r.ownerEvm } : {}),
    },
    summary: r.summary,
    legs: legRows
      .map(toLeg)
      .sort((a, b) => chainOrder(a.chain) - chainOrder(b.chain) || a.seq - b.seq),
    warnings: r.warnings,
    needsConsent: r.needsConsent,
    fees: r.fees,
    preparedBy: r.preparedBy,
    ...(r.agentLabel ? { agentLabel: r.agentLabel } : {}),
    status: r.status,
    approvalUrl: `/orders/${r.id}`,
    expiresAt: Math.floor(r.expiresAt.getTime() / 1000),
    createdAt: r.createdAt.toISOString(),
    disclaimer: r.disclaimer,
  };
}

export async function insertOrder(db: Db, order: Order, request: IntentRequest): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: order.id,
      type: order.type,
      ownerSolana: order.owner.solana ?? null,
      ownerEvm: order.owner.evm ?? null,
      summary: order.summary,
      request,
      warnings: order.warnings,
      needsConsent: order.needsConsent,
      fees: order.fees,
      preparedBy: order.preparedBy,
      agentLabel: order.agentLabel ?? null,
      status: order.status,
      expiresAt: new Date(order.expiresAt * 1000),
      disclaimer: order.disclaimer,
      createdAt: new Date(order.createdAt),
    });
    await tx.insert(legs).values(
      order.legs.map((l) => ({
        id: l.id,
        orderId: order.id,
        chainId: l.chain,
        seq: l.seq,
        kind: l.kind,
        signer: l.signer,
        description: l.description,
        trades: l.trades,
        expected: l.expected,
        status: l.status,
        attempt: l.attempt,
        trigger: l.trigger,
        provenance: l.provenance,
      })),
    );
  });
}

export async function loadOrder(db: Db, id: string): Promise<StoredOrder | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) return null;
  const legRows = await db.select().from(legs).where(eq(legs.orderId, id));
  const attemptRows = legRows.length
    ? await db
        .select()
        .from(legAttempts)
        .where(
          inArray(
            legAttempts.legId,
            legRows.map((l) => l.id),
          ),
        )
        .orderBy(asc(legAttempts.builtAt), asc(legAttempts.n))
    : [];
  return {
    order: toOrder(row, legRows),
    request: row.request,
    attempts: attemptRows.flatMap((a) => (a.legId ? [toAttempt({ ...a, legId: a.legId })] : [])),
  };
}

export async function loadProposal(db: Db, id: string): Promise<BasketProposal | null> {
  const [row] = await db
    .select({ proposal: proposals.proposal })
    .from(proposals)
    .where(eq(proposals.id, id));
  return row ? BasketProposal.parse(row.proposal) : null;
}

/** The label and source of a figure, as the attempt row stores them. */
export type Stamp = { source: string; method: string; fetchedAt: string; provenance: Provenance };

/**
 * Records a build: a new attempt, and the leg mirroring it. The attempt before it, if it was never
 * sent, is closed as expired, so only the newest attempt can settle the leg. Refuses when the leg moved
 * on since the caller read it (two builds at once).
 */
export async function recordBuild(
  db: Db,
  leg: Leg,
  a: {
    messageHash: string;
    validUntil: string | null;
    expected: Leg['expected'];
    stamp: Stamp;
    builtAt: Date;
  },
): Promise<Attempt> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(legs)
      .set({
        status: 'built',
        attempt: leg.attempt + 1,
        txId: null,
        explorerUrl: null,
        validUntil: a.validUntil,
        error: null,
        expected: a.expected,
        updatedAt: a.builtAt,
      })
      .where(and(eq(legs.id, leg.id), eq(legs.attempt, leg.attempt), eq(legs.status, leg.status)))
      .returning({ id: legs.id });
    if (!moved.length)
      throw new Refusal(409, 'this step changed while it was being built: read the order again');
    await tx
      .update(legAttempts)
      .set({ status: 'expired' })
      .where(and(eq(legAttempts.legId, leg.id), eq(legAttempts.status, 'built')));
    const [row] = await tx
      .insert(legAttempts)
      .values({
        legId: leg.id,
        chainId: leg.chain,
        n: leg.attempt + 1,
        messageHash: a.messageHash,
        status: 'built',
        validUntil: a.validUntil,
        builtAt: a.builtAt,
        source: a.stamp.source,
        method: a.stamp.method,
        fetchedAt: new Date(a.stamp.fetchedAt),
        provenance: a.stamp.provenance,
      })
      .returning();
    if (!row?.legId) throw new Error('attempt insert');
    return toAttempt({ ...row, legId: row.legId });
  });
}

/** Stores a refused build on the leg. The leg keeps its status: nothing was built and nothing failed onchain. */
export async function recordRefusal(db: Db, legId: string, error: Leg['error']): Promise<void> {
  await db.update(legs).set({ error, updatedAt: new Date() }).where(eq(legs.id, legId));
}

/** What tracking a transaction found, written to the attempt and mirrored on its leg. */
export async function recordOutcome(
  db: Db,
  attempt: Attempt,
  a: {
    status: Extract<Attempt['status'], 'sent' | 'confirmed' | 'failed' | 'expired'>;
    txId: string;
    explorerUrl: string | null;
    validUntil: string | null;
    error: Leg['error'];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(legAttempts)
      .set({ status: a.status, txId: a.txId, explorerUrl: a.explorerUrl, validUntil: a.validUntil })
      .where(eq(legAttempts.id, attempt.id));
    await tx
      .update(legs)
      .set({
        status: a.status,
        txId: a.txId,
        explorerUrl: a.explorerUrl,
        validUntil: a.validUntil,
        error: a.error,
        updatedAt: new Date(),
      })
      // Only while the leg still mirrors this attempt.
      .where(and(eq(legs.id, attempt.legId), eq(legs.attempt, attempt.n)));
  });
}

export async function recordOrderState(
  db: Db,
  id: string,
  a: { status: Order['status']; expiresAt?: number },
): Promise<void> {
  await db
    .update(orders)
    .set({
      status: a.status,
      ...(a.expiresAt === undefined ? {} : { expiresAt: new Date(a.expiresAt * 1000) }),
    })
    .where(eq(orders.id, id));
}

/** Writes the last state read from a vault into the cache. The chain stays the truth. */
export async function cacheVault(db: Db, view: VaultView, provenance: Provenance): Promise<void> {
  const row = {
    chainId: view.chain,
    address: view.address,
    owner: view.owner,
    onchainBasketId: view.basketId,
    acceptedVersion: view.acceptedVersion,
    autoFollow: view.autoFollow,
    targets: view.positions
      .filter((p) => p.targetBps > 0)
      .map((p) => ({ asset: p.asset, weightBps: p.targetBps })),
    balances: {
      cash: view.cash,
      positions: view.positions.map(
        ({ asset, raw, multiplier, display, targetBps, lastKeeperAt }) => ({
          asset,
          raw,
          multiplier,
          display,
          targetBps,
          lastKeeperAt,
        }),
      ),
    },
    valueUsd: view.valueUsd,
    observedAt: new Date(view.observedAt),
    provenance,
  };
  await db
    .insert(vaults)
    .values(row)
    .onConflictDoUpdate({
      target: [vaults.chainId, vaults.address],
      set: {
        owner: row.owner,
        acceptedVersion: row.acceptedVersion,
        autoFollow: row.autoFollow,
        targets: row.targets,
        balances: row.balances,
        valueUsd: row.valueUsd,
        observedAt: row.observedAt,
        provenance: row.provenance,
      },
    });
}

/** True when another attempt already carries this transaction id on this chain. */
export async function txIdTaken(db: Db, chain: ChainId, txId: string, attemptId: string) {
  const [row] = await db
    .select({ id: legAttempts.id })
    .from(legAttempts)
    .where(
      and(
        eq(legAttempts.chainId, chain),
        eq(legAttempts.txId, txId),
        sql`${legAttempts.id} <> ${attemptId}`,
      ),
    );
  return Boolean(row);
}
