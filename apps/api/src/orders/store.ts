import {
  baskets,
  type Db,
  indexFamilies,
  legAttempts,
  legs,
  orders,
  proposals,
  recipes,
  recipeVersions,
  users,
  vaults,
} from '@colosseum/db';
import {
  type Address,
  type Attempt,
  BasketProposal,
  ChainId,
  type IntentRequest,
  type Leg,
  type Order,
  type Principal,
  type Provenance,
  type Shelf,
  type VaultView,
} from '@colosseum/schemas';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { Refusal } from './errors';

// The order tables (DESIGN-VAULT section 4), read and written through Drizzle. A leg row mirrors its
// latest attempt; every build is one row in leg_attempts.

type LegRow = typeof legs.$inferSelect;
type AttemptRow = typeof legAttempts.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

/** An order as the API holds it: the order, the request it came from, and every attempt at its legs. */
export type StoredOrder = { order: Order; request: IntentRequest; attempts: Attempt[] };

/**
 * A row written before `Leg.expected` was one entry per trade holds one figure or none. It reads as
 * the list it would be now: the one figure of a leg with one trade, and nothing otherwise.
 */
function expectedOfRow(stored: unknown): Leg['expected'] {
  if (Array.isArray(stored)) return stored;
  return stored && typeof stored === 'object' ? [stored as Leg['expected'][number]] : [];
}

const toLeg = (r: LegRow): Leg => ({
  id: r.id,
  orderId: r.orderId,
  chain: r.chainId,
  seq: r.seq,
  kind: r.kind,
  signer: r.signer,
  description: r.description,
  ...(r.cashRaw === null ? {} : { cashRaw: r.cashRaw }),
  trades: r.trades,
  expected: expectedOfRow(r.expected),
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
  // What the order deposits is on the step that deposits. The approval repeats it and is not counted.
  const deposit = legRows.find(
    (l) => (l.kind === 'create_vault' || l.kind === 'deposit') && l.cashRaw !== null,
  )?.cashRaw;
  return {
    id: r.id,
    type: r.type,
    owner: {
      ...(r.ownerSolana ? { solana: r.ownerSolana } : {}),
      ...(r.ownerEvm ? { evm: r.ownerEvm } : {}),
    },
    summary: r.summary,
    ...(deposit ? { depositRaw: deposit } : {}),
    ...(r.basketId ? { basketId: r.basketId } : {}),
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
      basketId: order.basketId ?? null,
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
        cashRaw: l.cashRaw ?? null,
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
  if (!row) return null;
  const parsed = BasketProposal.safeParse(row.proposal);
  if (!parsed.success)
    throw new Refusal(409, 'the stored plan cannot be read: make the plan again');
  return parsed.data;
}

/** How many plans were made from a link since this time: what the daily cap counts. */
export async function countLinkedSince(db: Db, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(proposals)
    .where(and(sql`${proposals.fromLink}`, gte(proposals.createdAt, since)));
  return row?.n ?? 0;
}

/**
 * Deletes the plans made from a link before this time that nobody bought: no order names them and no
 * plan of a person keeps them. Answers how many went. A plan somebody bought stays.
 */
export async function forgetUnboughtLinked(db: Db, before: Date): Promise<number> {
  const gone = await db
    .delete(proposals)
    .where(
      and(
        // Written as the column itself, not `= $1`, so the planner can always use the partial index.
        sql`${proposals.fromLink}`,
        lt(proposals.createdAt, before),
        sql`not exists (select 1 from ${orders} where ${orders.request}->>'proposalId' = ${proposals.id}::text)`,
        sql`not exists (select 1 from ${baskets} where ${baskets.proposalId} = ${proposals.id})`,
      ),
    )
    .returning({ id: proposals.id });
  return gone.length;
}

/** True when a plan with this id is stored, without reading it. */
export async function proposalExists(db: Db, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const rows = await db.execute(
    sql`select 1 from ${proposals} where ${proposals.id} = ${id} limit 1`,
  );
  return rows.length > 0;
}

/** True when the plan with this id was made from a link (`from_link`, gate `AGENT-LINK`). */
export async function isLinkedProposal(db: Db, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const [row] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.id, id), eq(proposals.fromLink, true)));
  return row !== undefined;
}

/**
 * A stored plan as one caller may read it back, by its id: the person who made it (the row names
 * them), or anybody for a plan made from a link (`fromLink`; the route decides whether those are
 * served). Another person's plan is null here, as an id that names no plan is.
 */
export async function loadReadablePlan(
  db: Db,
  id: string,
  privyId: string | null,
): Promise<{ proposal: BasketProposal; fromLink: boolean } | null> {
  const [row] = await db
    .select({ proposal: proposals.proposal, fromLink: proposals.fromLink, owner: users.privyId })
    .from(proposals)
    .leftJoin(users, eq(users.id, proposals.userId))
    .where(eq(proposals.id, id));
  if (!row) return null;
  const mine = privyId !== null && row.owner === privyId;
  if (!row.fromLink && !mine) return null;
  const parsed = BasketProposal.safeParse(row.proposal);
  if (!parsed.success)
    throw new Refusal(409, 'the stored plan cannot be read: make the plan again');
  return { proposal: parsed.data, fromLink: row.fromLink };
}

/** A buy of a plan, as the list of a person's plans names it. */
export type PlanOrder = {
  id: string;
  createdAt: string;
  amountUsd: number;
  status: Order['status'];
  /** Its deposit is confirmed on chain: the vault holds what this order put in. */
  deposited: boolean;
};

/** A plan of a person's, with the buys of it and the vault they opened. */
export type PersonPlan = {
  id: string;
  createdAt: string;
  fromLink: boolean;
  proposal: BasketProposal;
  orders: PlanOrder[];
  /** The vault's number on chain, from the buys; null while nothing was ordered. */
  basketId: string | null;
};

/** The most plans and buys one answer lists, newest first. */
export const PERSON_PLANS = { plans: 50, orders: 200 } as const;

/**
 * The plans a person made, and the plans made from a link that they bought, newest first, each with
 * its buys. A plan is the person's by its row; a buy is theirs by the wallets of the verified token,
 * as an order is everywhere (`holds`). Another person's plan is never listed, bought or not: a buy
 * that names one lists nothing of it. A stored plan that no longer reads is left out.
 */
export async function listPersonPlans(db: Db, principal: Principal): Promise<PersonPlan[]> {
  const privyId = principal.userId ?? null;
  const [user] = privyId
    ? await db.select({ id: users.id }).from(users).where(eq(users.privyId, privyId))
    : [];
  const addresses = (family: 'solana' | 'evm') =>
    principal.wallets.filter((w) => w.family === family).map((w) => w.address);
  const [solana, evm] = [addresses('solana'), addresses('evm')];
  const owned = [
    ...(solana.length ? [inArray(orders.ownerSolana, solana)] : []),
    ...(evm.length ? [inArray(orders.ownerEvm, evm)] : []),
  ];
  const buys = owned.length
    ? await db
        .select()
        .from(orders)
        .where(and(eq(orders.type, 'buy'), or(...owned)))
        .orderBy(desc(orders.createdAt))
        .limit(PERSON_PLANS.orders)
    : [];
  // An order is the caller's only when every address it names is theirs, as on its own route.
  const mine = buys.filter((o) => {
    const has = (family: 'solana' | 'evm', address: string | null) =>
      address === null ||
      principal.wallets.some((w) => w.family === family && w.address === address);
    return has('solana', o.ownerSolana) && has('evm', o.ownerEvm);
  });
  const planOf = (o: OrderRow) =>
    o.request.type === 'buy' ? (o.request.proposalId ?? null) : null;
  const bought = [
    ...new Set(mine.map(planOf).filter((id): id is string => id !== null && UUID.test(id))),
  ];

  const made = user
    ? await db
        .select()
        .from(proposals)
        .where(eq(proposals.userId, user.id))
        .orderBy(desc(proposals.createdAt))
        .limit(PERSON_PLANS.plans)
    : [];
  const known = new Set(made.map((p) => p.id));
  const rest = bought.filter((id) => !known.has(id));
  // Of the plans bought and not in the list above: the person's own older ones, and those from a link.
  const more = rest.length
    ? await db
        .select()
        .from(proposals)
        .where(
          and(
            inArray(proposals.id, rest),
            user
              ? or(eq(proposals.fromLink, true), eq(proposals.userId, user.id))
              : eq(proposals.fromLink, true),
          ),
        )
    : [];

  const confirmed = mine.length
    ? await db
        .select({ orderId: legs.orderId })
        .from(legs)
        .where(
          and(
            inArray(
              legs.orderId,
              mine.map((o) => o.id),
            ),
            inArray(legs.kind, ['create_vault', 'deposit']),
            eq(legs.status, 'confirmed'),
          ),
        )
    : [];
  const deposited = new Set(confirmed.map((l) => l.orderId));

  return [...made, ...more]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .flatMap((row) => {
      const parsed = BasketProposal.safeParse(row.proposal);
      if (!parsed.success) return [];
      const named = mine.filter((o) => planOf(o) === row.id);
      // The vault the plan's buys opened, and with them the buys that added to that vault by its
      // address (add money): they name no plan, and are the plan's by its vault's number and chain.
      const basketId = named.find((o) => o.basketId !== null)?.basketId ?? null;
      const chain = parsed.data.sheet.chains[0] ?? parsed.data.recipes[0]?.chain;
      const of = mine.filter(
        (o) =>
          planOf(o) === row.id ||
          (basketId !== null &&
            o.request.type === 'buy' &&
            o.request.vault !== undefined &&
            o.request.vault.chain === chain &&
            o.basketId === basketId),
      );
      return [
        {
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          fromLink: row.fromLink,
          proposal: parsed.data,
          orders: of.map((o) => ({
            id: o.id,
            createdAt: o.createdAt.toISOString(),
            amountUsd: o.request.type === 'buy' ? o.request.amountUsd : 0,
            status: o.status,
            deposited: deposited.has(o.id),
          })),
          basketId,
        },
      ];
    });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stores a plan made for a person and answers its id, which `POST /v1/orders` buys by. The row names
 * the person where they have a user row. The same plan stored again by the same person answers the id
 * it has; a plan identical to one another person stored at the same moment is not shared with them:
 * the answer says to try again, which makes a plan at another time.
 */
export async function insertProposal(
  db: Db,
  proposal: BasketProposal,
  privyId: string | null,
  /** Made from a link (gate `AGENT-LINK`): stored with no person, and marked so. */
  fromLink = false,
): Promise<string> {
  const [user] = privyId
    ? await db.select({ id: users.id }).from(users).where(eq(users.privyId, privyId))
    : [];
  const userId = user?.id ?? null;
  const [row] = await db
    .insert(proposals)
    .values({
      inputsHash: proposal.inputsHash,
      userId,
      fromLink,
      proposal,
      engineVersion: proposal.engineVersion,
      shelfVersion: proposal.shelfVersion,
      paramsHash: proposal.paramsHash,
    })
    .onConflictDoNothing({ target: proposals.inputsHash })
    .returning({ id: proposals.id });
  if (row) return row.id;
  const [same] = await db
    .select({ id: proposals.id, userId: proposals.userId, fromLink: proposals.fromLink })
    .from(proposals)
    .where(eq(proposals.inputsHash, proposal.inputsHash));
  if (same && same.userId === userId && same.fromLink === fromLink) return same.id;
  throw new Refusal(503, 'the plan could not be stored: make it again in a moment', {
    details: { retryable: true },
  });
}

/**
 * The shared portfolios that have a recipe on `chain`, each with the version of it in effect: what a
 * plan that holds one as a single line is opened with. Read from the cache tables; the chain stays the
 * truth, and a plan whose lines no longer match what this gives is refused when it is bought.
 */
export async function loadFamilies(db: Db, chain: ChainId): Promise<Shelf['families']> {
  const rows = await db
    .select({ family: indexFamilies, recipe: recipes, version: recipeVersions })
    .from(recipeVersions)
    .innerJoin(recipes, eq(recipeVersions.recipeId, recipes.id))
    .innerJoin(indexFamilies, eq(recipes.familyId, indexFamilies.familyId))
    .where(and(eq(recipes.chainId, chain), eq(recipeVersions.status, 'active')));
  const families = new Map<string, Shelf['families'][number]>();
  for (const { family, recipe, version } of rows) {
    const entry = families.get(family.familyId) ?? {
      meta: {
        familyId: family.familyId,
        slug: family.slug,
        name: family.name,
        copy: family.copy,
        kind: family.kind,
        chains: [chain],
      },
      recipes: [],
    };
    entry.recipes.push({
      schemaVersion: 1,
      familyId: family.familyId,
      chain,
      onchainId: recipe.onchainId,
      creator: recipe.creator,
      kind: recipe.kind,
      version: version.version,
      effectiveAt: Math.floor(version.effectiveAt.getTime() / 1000),
      components: version.components,
      metaHash: version.metaHash,
      maxFeeBps: 0,
      flags: 0,
    });
    families.set(family.familyId, entry);
  }
  return [...families.values()];
}

/** The label and source of a figure, as the attempt row stores them. */
export type Stamp = { source: string; method: string; fetchedAt: string; provenance: Provenance };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** An attempt of another order, with the step it is at. */
export type Elsewhere = { attempt: Attempt; orderId: string; legId: string };

/**
 * EVM. The attempts of this wallet's other orders on one chain that can still land: built or sent, in
 * an order that is still running. An order that expired is not built again, so its attempts do not
 * count: a later build shares their nonce, and at most one of the two can land. Newest first.
 */
export async function liveElsewhere(
  db: Db | Tx,
  a: { chain: ChainId; owner: Address; orderId: string; now: Date },
): Promise<Elsewhere[]> {
  const rows = await db
    .select({ attempt: legAttempts, orderId: legs.orderId })
    .from(legAttempts)
    .innerJoin(legs, eq(legAttempts.legId, legs.id))
    .innerJoin(orders, eq(legs.orderId, orders.id))
    .where(
      and(
        eq(legAttempts.chainId, a.chain),
        inArray(legAttempts.status, ['built', 'sent']),
        isNotNull(legAttempts.nonce),
        eq(orders.ownerEvm, a.owner),
        ne(orders.id, a.orderId),
        gte(orders.expiresAt, a.now),
        notInArray(orders.status, ['done', 'expired']),
      ),
    )
    .orderBy(desc(legAttempts.builtAt));
  return rows.flatMap(({ attempt, orderId }) =>
    attempt.legId
      ? [
          {
            attempt: toAttempt({ ...attempt, legId: attempt.legId }),
            orderId,
            legId: attempt.legId,
          },
        ]
      : [],
  );
}

/**
 * EVM. The step of another leg that stated this very pair (message, nonce), if there is one. A
 * transaction that landed on that nonce with that call is that step's, whatever leg it is reported to.
 */
export async function pairElsewhere(
  db: Db,
  a: { chain: ChainId; messageHash: string; nonce: number; legId: string },
): Promise<{ legId: string } | null> {
  const [row] = await db
    .select({ legId: legAttempts.legId })
    .from(legAttempts)
    .where(
      and(
        eq(legAttempts.chainId, a.chain),
        eq(legAttempts.messageHash, a.messageHash),
        eq(legAttempts.nonce, a.nonce),
        isNotNull(legAttempts.legId),
        ne(legAttempts.legId, a.legId),
      ),
    )
    .limit(1);
  return row?.legId ? { legId: row.legId } : null;
}

/** Thrown when a step is built while another order of the same wallet has one that can still land. */
export function blockedBy(chainName: string, other: Elsewhere): Refusal {
  return new Refusal(
    409,
    `another order of this wallet has a transaction on ${chainName} that can still land`,
    {
      fix: 'Report that step or cancel it, then build this one again.',
      details: { retryable: true, blocking: { orderId: other.orderId, legId: other.legId } },
    },
  );
}

/**
 * A transaction that is already recorded against another step. One transaction settles one step: the
 * attempt it was reported for here can no longer land, since its nonce is used.
 */
export class TakenElsewhere extends Refusal {
  constructor() {
    super(409, 'that transaction is already recorded for another step');
    this.name = 'TakenElsewhere';
  }
}

/**
 * The leg row, then its attempts, both locked. Every writer takes them in this order, so two of them
 * wait for each other instead of deadlocking.
 */
async function lockLeg(tx: Tx, legId: string) {
  const [leg] = await tx.select().from(legs).where(eq(legs.id, legId)).for('update');
  if (!leg) throw new Error('the leg vanished');
  const attempts = await tx
    .select()
    .from(legAttempts)
    .where(eq(legAttempts.legId, legId))
    .orderBy(asc(legAttempts.n))
    .for('update');
  return { leg, attempts };
}

/** An attempt whose outcome the chain has given: it landed, and either went through or reverted. */
const final = (status: Attempt['status']) => status === 'confirmed' || status === 'failed';

/** Postgres's unique violation, wherever the driver or Drizzle put its code. */
const isUnique = (e: unknown) =>
  [e, (e as { cause?: unknown })?.cause].some((x) => (x as { code?: string })?.code === '23505');

/**
 * Records a build: a new attempt, and the leg mirroring it. The attempt before it, if it was never
 * sent, is closed as expired. Refuses when the leg moved on since the caller read it: another build,
 * or a landing that was recorded meanwhile.
 */
export async function recordBuild(
  db: Db,
  leg: Leg,
  a: {
    messageHash: string;
    /** EVM: the nonce the build stated. With the message hash it names the attempt. Null on Solana. */
    nonce: number | null;
    validUntil: string | null;
    expected: Leg['expected'];
    stamp: Stamp;
    builtAt: Date;
    /**
     * EVM. One wallet has one next nonce on a chain, so only one of its orders may hold a transaction
     * that can still land there. With this set, the build is recorded under a lock on (chain, wallet)
     * and refused if another order got there first. `clear` are attempts the caller has already seen
     * can no longer land.
     */
    exclusive?: { owner: Address; orderId: string; chainName: string; clear: string[] };
  },
): Promise<Attempt> {
  return db.transaction(async (tx) => {
    const { exclusive } = a;
    if (exclusive) {
      // Held until this transaction ends. Every build of this wallet on this chain takes it first.
      const key = `nonce:${leg.chain}:${exclusive.owner}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const others = await liveElsewhere(tx, {
        chain: leg.chain,
        owner: exclusive.owner,
        orderId: exclusive.orderId,
        now: a.builtAt,
      });
      const other = others.find((o) => !exclusive.clear.includes(o.attempt.id));
      if (other) throw blockedBy(exclusive.chainName, other);
    }
    const now = await lockLeg(tx, leg.id);
    if (now.leg.attempt !== leg.attempt || now.leg.status !== leg.status)
      throw new Refusal(409, 'this step changed while it was being built: read the order again');
    const n = Math.max(0, ...now.attempts.map((x) => x.n)) + 1;
    await tx
      .update(legs)
      .set({
        status: 'built',
        attempt: n,
        txId: null,
        explorerUrl: null,
        validUntil: a.validUntil,
        error: null,
        expected: a.expected,
        updatedAt: a.builtAt,
      })
      .where(eq(legs.id, leg.id));
    await tx
      .update(legAttempts)
      .set({ status: 'expired' })
      .where(and(eq(legAttempts.legId, leg.id), eq(legAttempts.status, 'built')));
    const [row] = await tx
      .insert(legAttempts)
      .values({
        legId: leg.id,
        chainId: leg.chain,
        n,
        messageHash: a.messageHash,
        nonce: a.nonce,
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

export type Outcome = {
  status: Extract<Attempt['status'], 'sent' | 'confirmed' | 'failed' | 'expired'>;
  /** Null only for an attempt closed before any transaction was seen. */
  txId: string | null;
  explorerUrl: string | null;
  validUntil: string | null;
  error: Leg['error'];
  /**
   * EVM: the nonce of record, read from the transaction itself. An outside wallet may sign with
   * another nonce than the build stated; the attempt then carries the one that was used. Left out or
   * null, the attempt keeps the nonce it has.
   */
  nonce?: number | null;
};

/**
 * What became of an attempt, written to it and, where it decides the leg, to the leg.
 * - An attempt that already holds the chain's outcome (confirmed, or failed) is left as it is: the
 *   answer is `kept`, and what is stored is what the caller reads back.
 * - A confirmed attempt settles the leg whichever attempt it is, and closes any other that was built
 *   and not sent. A leg that is already settled stays on the attempt that settled it.
 * - Any other outcome moves the leg only when the attempt is the one the leg mirrors.
 */
export async function recordOutcome(
  db: Db,
  attempt: Pick<Attempt, 'id' | 'legId'>,
  a: Outcome,
): Promise<'recorded' | 'kept'> {
  try {
    return await db.transaction(async (tx) => {
      const { leg, attempts } = await lockLeg(tx, attempt.legId);
      const row = attempts.find((x) => x.id === attempt.id);
      if (!row) throw new Error('the attempt vanished');
      if (final(row.status)) return 'kept';
      await tx
        .update(legAttempts)
        .set({
          status: a.status,
          txId: a.txId,
          explorerUrl: a.explorerUrl,
          validUntil: a.validUntil,
          ...(a.nonce === undefined || a.nonce === null ? {} : { nonce: a.nonce }),
        })
        .where(eq(legAttempts.id, row.id));
      const settles = a.status === 'confirmed' && leg.status !== 'confirmed';
      if (settles)
        await tx
          .update(legAttempts)
          .set({ status: 'expired' })
          .where(and(eq(legAttempts.legId, leg.id), eq(legAttempts.status, 'built')));
      if (settles || (row.n === leg.attempt && leg.status !== 'confirmed'))
        await tx
          .update(legs)
          .set({
            status: a.status,
            attempt: row.n,
            txId: a.txId,
            explorerUrl: a.explorerUrl,
            validUntil: a.validUntil,
            error: a.error,
            updatedAt: new Date(),
          })
          .where(eq(legs.id, leg.id));
      return 'recorded';
    });
  } catch (e) {
    if (isUnique(e)) throw new TakenElsewhere();
    throw e;
  }
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

/**
 * A dollar figure cut to cents, never rounded: '599.999999' is '599.99'. The cache column holds two
 * places and Postgres would round a longer figure up, so a vault a hair under $600 would be stored as
 * $600.00. The view's own figure, to six places, is what a response carries.
 */
export function cutToCents(value: string): string {
  const [whole = '0', frac = ''] = value.split('.');
  return `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

/** The names the owners of these vaults of one chain gave them, by address. A vault with none is left out. */
export async function vaultNames(
  db: Db,
  chain: ChainId,
  addresses: readonly string[],
): Promise<Map<string, string>> {
  if (!addresses.length) return new Map();
  const rows = await db
    .select({ address: vaults.address, name: vaults.name })
    .from(vaults)
    .where(and(eq(vaults.chainId, chain), inArray(vaults.address, [...addresses])));
  return new Map(rows.flatMap((r) => (r.name === null ? [] : [[r.address, r.name]])));
}

/**
 * Sets the name of a vault whose row is in the cache (the caller has just read it from its chain and
 * written it there), or clears it with null. Nothing else of the row changes.
 */
export async function nameVault(
  db: Db,
  chain: ChainId,
  address: string,
  name: string | null,
): Promise<void> {
  await db
    .update(vaults)
    .set({ name })
    .where(and(eq(vaults.chainId, chain), eq(vaults.address, address)));
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
    valueUsd: cutToCents(view.valueUsd),
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
