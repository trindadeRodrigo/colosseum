import { baskets, type Db, legs, orders, proposals, users, vaults } from '@colosseum/db';
import {
  type Address,
  BasketProposal,
  ChainError,
  type ChainId,
  chainFamily,
  type IntentRequest,
  type Principal,
  type Provenance,
  type VaultPlan,
  type VaultState,
} from '@colosseum/schemas';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { Refusal } from './errors';
import { familyBySlug } from './families';
import { type OrderDeps, planVault } from './legs';
import { basketIdOf, basketIdOfBuy } from './prepare';
import { isLinkedProposal, type StoredOrder } from './store';

// The goal join, on the server (DESIGN-VAULT section 4). A vault is joined to the plan it was opened
// for: `vaults.basket_id` names a row of `baskets`, the person's plan, and that row names the stored
// plan (`proposals`) or the shared portfolio the vault follows. Two answers already say a vault's plan,
// each worked out from the orders when it is asked: `GET /v1/me/plans` (API-PLANS) and the `planId` of
// `GET /v1/portfolio` (API-ADD-MONEY). What this file adds is the join kept in the database, which the
// snapshot worker (apps/snapshot) and the portfolio section's routes (PORT-2) read.
//
// The join is made when the step that opens the vault is confirmed, and by the portfolio's read for a
// vault that was missed then. From the first of the two the vault has a row in `vaults`, valued or not:
// the snapshot worker reads the vaults that table names.

/** The request's log, which hides node addresses in whatever it is handed (redact.ts). */
export type JoinLog = {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
};

/** What a buy opens a vault for: a stored plan, or a shared portfolio the vault follows. */
export type Bought =
  | { kind: 'personal'; proposalId: string }
  | { kind: 'follow'; familyId: string };

/** A vault's plan as `plansOf` answers it, for the portfolio section's routes (PORT-2). */
export type JoinedPlan = {
  /**
   * The id of the person's `baskets` row the vault is joined to. It is not the `planId` that
   * `GET /v1/portfolio` answers, which is the stored plan's id (`proposals.id`).
   */
  joinId: string;
  plan: VaultPlan;
};

/**
 * Writes a vault the cache does not have yet, as the chain has it now. Nobody has valued it, so
 * `value_usd` is null until the portfolio's read values it (`cacheVault`). A row that is there is left
 * as it is: it may be newer than this read, and it may be joined.
 */
export async function rememberVault(
  db: Db,
  state: VaultState,
  provenance: Provenance,
): Promise<void> {
  await db
    .insert(vaults)
    .values({
      chainId: state.chain,
      address: state.address,
      owner: state.owner,
      onchainBasketId: state.basketId,
      acceptedVersion: state.acceptedVersion,
      autoFollow: state.autoFollow,
      targets: state.positions
        .filter((p) => p.targetBps > 0)
        .map((p) => ({ asset: p.asset, weightBps: p.targetBps })),
      balances: {
        cash: state.cash,
        positions: state.positions.map(
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
      valueUsd: null,
      observedAt: new Date(state.observedAt),
      provenance,
    })
    .onConflictDoNothing({ target: [vaults.chainId, vaults.address] });
}

/**
 * Joins a vault in the cache to the person's plan, once. In one transaction: the vault's row is locked,
 * and if it names no plan yet, the person's user row is made where there is none, one `baskets` row is
 * written for the plan, and the vault names it. Two joins of one vault at the same moment wait for each
 * other on that lock, so the second finds the first one's plan and writes nothing.
 *
 * Answers the id of the plan the vault is joined to: the new one, or the one it already had, whoever
 * that is. Null when nothing was joined: the vault is not in the cache, or the stored plan is gone.
 */
export async function joinVault(
  db: Db,
  a: {
    chain: ChainId;
    address: Address;
    /** The person whose plan it is, by the Privy id of a verified sign-in. */
    privyId: string;
    plan: Bought;
    /** When the order that opened the vault was made: the goal's date counts from it. */
    placedAt: Date;
  },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [vault] = await tx
      .select({ id: vaults.id, basketId: vaults.basketId })
      .from(vaults)
      .where(and(eq(vaults.chainId, a.chain), eq(vaults.address, a.address)))
      .for('update');
    if (!vault) return null;
    if (vault.basketId) return vault.basketId;
    // A plan made from a link that nobody bought is deleted after a few days. One an order names stays,
    // so this is a plan somebody took away by hand: there is nothing to join the vault to.
    if (a.plan.kind === 'personal') {
      const [plan] = await tx
        .select({ id: proposals.id })
        .from(proposals)
        .where(eq(proposals.id, a.plan.proposalId));
      if (!plan) return null;
    }
    // A person has a user row only once something of theirs was stored: a picked chain, or this plan.
    await tx
      .insert(users)
      .values({ privyId: a.privyId })
      .onConflictDoNothing({ target: users.privyId });
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.privyId, a.privyId));
    if (!user) throw new Error('the user row vanished');
    const [basket] = await tx
      .insert(baskets)
      .values({
        userId: user.id,
        kind: a.plan.kind,
        ...(a.plan.kind === 'personal'
          ? { proposalId: a.plan.proposalId }
          : { familyId: a.plan.familyId }),
        createdAt: a.placedAt,
      })
      .returning({ id: baskets.id });
    if (!basket) throw new Error('basket insert');
    await tx.update(vaults).set({ basketId: basket.id }).where(eq(vaults.id, vault.id));
    return basket.id;
  });
}

/**
 * What a buy's request names, as a plan a vault can be joined to. Null for a request that is no buy, or
 * that names a shared portfolio the server no longer has.
 */
async function boughtOf(db: Db, request: IntentRequest): Promise<Bought | null> {
  if (request.type !== 'buy') return null;
  if (request.family) {
    const family = await familyBySlug(db, request.family);
    return family ? { kind: 'follow', familyId: family.familyId } : null;
  }
  return request.proposalId ? { kind: 'personal', proposalId: request.proposalId } : null;
}

/**
 * The number of the vault a buy is for, for an order made before the number was kept with it
 * (`orders.basket_id`). Worked out as a step's build works it out (`buildFor` in legs.ts), with the same
 * helpers: a shared portfolio's from the family's id, a plan's from its id, and from the buyer too for
 * a plan made from a link (gate AGENT-LINK).
 */
async function numberWorkedOut(db: Db, bought: Bought, buyer: string): Promise<string> {
  if (bought.kind === 'follow') return basketIdOf(bought.familyId);
  return basketIdOfBuy(bought.proposalId, await isLinkedProposal(db, bought.proposalId), buyer);
}

/** True when the cache holds this owner's vault with this number on the chain, joined to a plan. */
async function isJoined(db: Db, chain: ChainId, owner: Address, number: string): Promise<boolean> {
  const [row] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(
      and(
        eq(vaults.chainId, chain),
        eq(vaults.owner, owner),
        eq(vaults.onchainBasketId, number),
        isNotNull(vaults.basketId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * A buy whose step that opens the vault has confirmed: the vault goes into the cache, joined to the
 * plan it was opened for. Every route that answers such an order asks this, so it first looks in the
 * database whether the join is there, and reads the chain only when it is not.
 *
 * It never fails the order's answer and never changes it. A chain that does not answer, or does not
 * show the vault yet, leaves the join to the portfolio's read (`joinMissed`), and the log says why.
 *
 * An order past its time is not asked about: once a step has landed an order stays open for a day, and
 * a join still missing after that is the portfolio read's to make. Without this, an order whose vault
 * the chain no longer shows (a test network deployed again) would read the chain on every later answer.
 *
 * `readBefore` is for the build route, which holds the order as it was read before the build tracked
 * the steps sent earlier: a step that was sent then is asked for again, in case it settled since.
 */
export async function joinConfirmed(
  deps: OrderDeps,
  stored: StoredOrder,
  principal: Principal,
  log: JoinLog,
  readBefore = false,
): Promise<void> {
  const { order, request } = stored;
  const opening = order.legs.find((l) => l.kind === 'create_vault');
  if (request.type !== 'buy' || !opening || !principal.userId) return;
  if (Math.floor(deps.now().getTime() / 1000) > order.expiresAt) return;
  try {
    const confirmed =
      opening.status === 'confirmed' ||
      (readBefore && opening.status === 'sent' && (await confirmedNow(deps.db, opening.id)));
    const owner = order.owner[chainFamily(opening.chain)];
    if (!confirmed || !owner) return;
    // An order keeps its vault's number, so asking whether the join is there reads nothing else. Only
    // an order made before the number was kept has to read what it bought first.
    let bought: Bought | null = null;
    let number = order.basketId;
    if (!number) {
      bought = await boughtOf(deps.db, request);
      if (!bought) return;
      number = await numberWorkedOut(deps.db, bought, principal.userId);
    }
    if (await isJoined(deps.db, opening.chain, owner, number)) return;
    bought ??= await boughtOf(deps.db, request);
    if (!bought) return;
    const entry = deps.chains.get(opening.chain);
    const state = await planVault(entry, owner, number);
    if (!state) {
      log.warn(
        { orderId: order.id, chain: opening.chain },
        'the chain does not show the vault this order opened yet: its plan is joined when the portfolio is read',
      );
      return;
    }
    await rememberVault(deps.db, state, entry.provenance);
    await joinVault(deps.db, {
      chain: state.chain,
      address: state.address,
      privyId: principal.userId,
      plan: bought,
      placedAt: new Date(order.createdAt),
    });
  } catch (err) {
    // A chain's refusal is the chain's; anything else is ours, and is said louder.
    const ours = !(err instanceof ChainError) && !(err instanceof Refusal);
    log[ours ? 'error' : 'warn'](
      { err, orderId: order.id, chain: opening.chain },
      'the vault this order opened was not joined to its plan: it is joined when the portfolio is read',
    );
  }
}

/** True when the step is confirmed as the database has it now. */
async function confirmedNow(db: Db, legId: string): Promise<boolean> {
  const [row] = await db.select({ status: legs.status }).from(legs).where(eq(legs.id, legId));
  return row?.status === 'confirmed';
}

type Named = Pick<VaultState, 'chain' | 'address' | 'owner' | 'basketId'>;

/**
 * Joins a vault the confirm missed, from the orders: the newest buy of its owner on its chain whose
 * step that opens a vault is confirmed and whose vault number is this vault's. That order's request
 * names the plan, and its time is when the plan was placed. A vault no such order opened (one made
 * outside the app) is left as it is.
 */
async function joinFromOrders(db: Db, vault: Named, privyId: string): Promise<void> {
  const owner = chainFamily(vault.chain) === 'solana' ? orders.ownerSolana : orders.ownerEvm;
  const candidates = await db
    .select({
      request: orders.request,
      basketId: orders.basketId,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(legs, eq(legs.orderId, orders.id))
    .where(
      and(
        eq(orders.type, 'buy'),
        eq(owner, vault.owner),
        eq(legs.chainId, vault.chain),
        eq(legs.kind, 'create_vault'),
        eq(legs.status, 'confirmed'),
        // The number is text on the order. One made before it was kept has none, and is worked out.
        or(eq(orders.basketId, vault.basketId), isNull(orders.basketId)),
      ),
    )
    .orderBy(desc(orders.createdAt));
  for (const candidate of candidates) {
    const bought = await boughtOf(db, candidate.request);
    if (!bought) continue;
    const number = candidate.basketId ?? (await numberWorkedOut(db, bought, privyId));
    if (number !== vault.basketId) continue;
    await joinVault(db, {
      chain: vault.chain,
      address: vault.address,
      privyId,
      plan: bought,
      placedAt: candidate.createdAt,
    });
    return;
  }
}

/**
 * Joins the vaults the confirm missed, at the portfolio's read: the vaults are the ones just read from
 * the chain and written to the cache, and each that holds no plan yet is joined from the person's
 * orders (`joinFromOrders`). Only a vault of the person's own wallet is joined. It answers nothing and
 * never fails the read: what goes wrong is logged, and the next read tries again. That holds for the
 * whole of its work, the look for the vaults that hold no plan included; a vault that cannot be joined
 * is logged on its own and does not stop the ones after it.
 */
export async function joinMissed(
  db: Db,
  chain: ChainId,
  states: readonly Named[],
  principal: Principal,
  log: JoinLog,
): Promise<void> {
  try {
    const privyId = principal.userId;
    if (!privyId || states.length === 0) return;
    const addresses = states.map((v) => v.address);
    const unjoined = await db
      .select({ address: vaults.address })
      .from(vaults)
      .where(
        and(eq(vaults.chainId, chain), inArray(vaults.address, addresses), isNull(vaults.basketId)),
      );
    const mine = new Set(principal.wallets.map((w) => w.address));
    for (const { address } of unjoined) {
      const vault = states.find((v) => v.address === address);
      // Only a vault of the person's own wallet is joined to the person's plan.
      if (!vault || vault.chain !== chain || !mine.has(vault.owner)) continue;
      try {
        await joinFromOrders(db, vault, privyId);
      } catch (err) {
        // The portfolio is answered all the same: the join changes nothing in its answer.
        log.error({ err, chain, vault: address }, 'a vault could not be joined to its plan');
      }
    }
  } catch (err) {
    // The look itself failed, so no vault was tried. The portfolio is answered all the same.
    log.error({ err, chain }, 'the vaults that hold no plan could not be read: none was joined');
  }
}

/**
 * The plans of the person's vaults on one chain, by vault address, as the join holds them: for the
 * routes that answer a vault with the plan it was opened for (the portfolio section's, PORT-2). Read in
 * one query, and only the plans whose `baskets` row is this person's own: a vault joined to another
 * person's plan, a vault made outside the app and one whose order nobody finds have none.
 *
 * Whose goal is answered (the stored plan's sheet, card, verdict and observations) follows the rule a
 * stored plan is read back by, `loadReadablePlan` in store.ts, in both its halves. Whose it is: the
 * plan was made from a link, or its row names the same user as the `baskets` row. And whether it still
 * reads: the whole stored plan has to parse as a `BasketProposal` (`goalOf`), since `loadReadablePlan`
 * refuses to everybody a plan that does not. Any other vault is answered that the person holds the
 * plan (`kind`, `placedAt`, `proposalId`) and none of what it says: the goal it was made for is its
 * maker's, whoever that is, and a plan that no longer reads says nothing. So a plan's goal is answered
 * to nobody `loadReadablePlan` would refuse the plan to.
 *
 * A plan made from a link is anybody's who holds its id. The agent surface's flag is not asked here: it
 * closes the read by id (`GET /v1/baskets/{id}`) to anybody, not a holder's own vault, so a holder is
 * answered the goal of such a plan with the flag on or off.
 *
 * A person can hold a plan that is not theirs to read in two ways. A buy refuses a plan that names
 * another person (`loadBuyablePlan`), but a buy made before it did may have opened a vault for one.
 * And a plan that names no person and is not from a link is still bought by anybody holding its id:
 * buying is the looser of the two rules there, and holding the id does not read the plan back. Every
 * plan the app makes is stored after its person's user row is written, so those name their user; a row
 * with none is one stored another way (before plans named their person, a test's fixture, a row
 * written by hand).
 */
export async function plansOf(
  db: Db,
  chain: ChainId,
  addresses: readonly Address[],
  privyId: string | undefined,
): Promise<Map<Address, JoinedPlan>> {
  if (!privyId || addresses.length === 0) return new Map();
  const rows = await db
    .select({
      address: vaults.address,
      joinId: baskets.id,
      kind: baskets.kind,
      proposalId: baskets.proposalId,
      familyId: baskets.familyId,
      placedAt: baskets.createdAt,
      heldBy: baskets.userId,
      madeBy: proposals.userId,
      fromLink: proposals.fromLink,
      proposal: proposals.proposal,
    })
    .from(vaults)
    .innerJoin(baskets, eq(baskets.id, vaults.basketId))
    .innerJoin(users, eq(users.id, baskets.userId))
    .leftJoin(proposals, eq(proposals.id, baskets.proposalId))
    .where(
      and(
        eq(vaults.chainId, chain),
        inArray(vaults.address, [...addresses]),
        eq(users.privyId, privyId),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.address,
      {
        joinId: row.joinId,
        plan: {
          kind: row.kind,
          placedAt: row.placedAt.toISOString(),
          ...(row.proposalId ? { proposalId: row.proposalId } : {}),
          ...(row.familyId ? { familyId: row.familyId } : {}),
          // The rule of `loadReadablePlan` (store.ts): what a stored plan says is answered to the
          // person its row names, and to anybody for a plan made from a link, and only while the
          // whole stored plan still reads (`goalOf`). A plan that names another person, or nobody,
          // is held, and what it says is not this person's to read.
          ...(row.fromLink || (row.madeBy !== null && row.madeBy === row.heldBy)
            ? goalOf(row.proposal)
            : {}),
        },
      },
    ]),
  );
}

/**
 * The goal a stored plan was made for: its sheet, its card and, for an income goal, the engine's
 * verdict, as they were stored, with the plan's own observations. The card's range and exit cost and
 * the verdict's gap were worked out from those readings, so they leave together: each observation has
 * its source, time, method and provenance. A reading the engine had with no source or no time is not
 * among them (`sharedProposal` in personalize.ts), and its figure has none to show.
 *
 * Nothing where there is no stored plan, or where the stored plan no longer reads whole. The four are
 * taken from the plan parsed as a `BasketProposal`, the parse `loadReadablePlan` (store.ts) reads a
 * stored plan back by: a plan that read refuses, for lines that no longer add up to 10,000 as much as
 * for a sheet nobody takes today, says nothing here either. So a goal is not answered in part, nor a
 * card without the readings it stands on, nor any of the four from a plan that cannot be read back.
 * `verdict` is null for a plan that stored none: its goal is not an income.
 */
function goalOf(stored: unknown): Pick<VaultPlan, 'sheet' | 'card' | 'verdict' | 'observations'> {
  const plan = BasketProposal.safeParse(stored);
  if (!plan.success) return {};
  const { sheet, card, verdict, observations } = plan.data;
  return { sheet, card, verdict: verdict ?? null, observations };
}
