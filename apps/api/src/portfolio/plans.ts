import { type Db, indexFamilies, legs, orders, recipes } from '@colosseum/db';
import {
  type ChainId,
  chainFamily,
  type IntentRequest,
  type PlanFollows,
  type PlanNewest,
  type PlanPutIn,
} from '@colosseum/schemas';
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { boughtOf, type JoinedPlan, numberWorkedOut } from '../orders/plan-join';
import type { ScopedChain } from './scope';
import type { SnapshotRow } from './snapshots';

// What GET /v1/portfolio/plans answers of a vault beside its plan and its status (PORT-2): what the
// person put in, from the order tables; the newest snapshot, as the answer carries it; the shared
// portfolio the vault follows; and the one it was opened to follow. Read from the database alone, and
// only the person's own rows.

/**
 * How old a snapshot may be before it is stale: the hour of the status rule's `stale` line
 * (`statusOf` of packages/basket). Exactly an hour is not stale, as the rule has it.
 */
export const STALE_AFTER_SECONDS = 3600;

/**
 * Raw units of a dollar token as dollars: the amount over ten to the token's decimals, worked out in
 * whole numbers and never as a float. It is exact and not rounded: every digit the amount has is
 * there, and at least the two of the cents ('100.00', '0.000001').
 */
export function dollarsOf(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw / unit}.${fraction.padEnd(2, '0')}`;
}

/** How a `putIn` was made: its `method`. */
export const PUT_IN_METHOD =
  'the cash of each order whose deposit confirmed, counted once an order and added up, at one dollar a cash token; gross: a withdrawal is not taken off, and money that reached the vault any other way is not in it';

/** A vault as a deposit is matched to it: by its owner and the plan's number on the chain. */
export type NumberedVault = { address: string; owner: string; basketId: string };

/** One order's deposit: the first of its steps that deposits. */
type Deposit = { orderId: string; at: Date; raw: bigint };

const vaultKey = (owner: string, basketId: string) => `${owner}:${basketId}`;

/**
 * The number of the vault a buy was for, for an order stored without it, as the goal join works it out
 * (`numberWorkedOut` in orders/plan-join.ts): from what the buy names, and from the signed-in person
 * too for a plan made from a link. Null where it cannot be: the request names no plan and no shared
 * portfolio the server still has.
 */
async function numberOfOlder(
  db: Db,
  request: IntentRequest,
  privyId: string | undefined,
): Promise<string | null> {
  if (!privyId) return null;
  const bought = await boughtOf(db, request);
  return bought ? numberWorkedOut(db, bought, privyId) : null;
}

/**
 * What the person put into each of these vaults of one chain through this app, by vault address: the
 * cash of every buy of theirs whose deposit is confirmed there. A vault with no such buy is left out.
 *
 * The orders are the person's by the wallet that owns them on the chain's family, as the goal join
 * reads an order, and the steps are the chain's under the label it has on this server: a step
 * recorded on the mock is never counted as a test network's. A step counts when it is the one that
 * deposits (it opens the vault, or adds to it), is confirmed and holds its cash. The approval of the
 * same order holds the same cash and is no deposit, so an order counts once, by its first such step,
 * as `toOrder` in orders/store.ts reads an order's deposit.
 *
 * An order is its vault's by the owner and the plan's number it was made for: a person with two
 * wallets may hold a vault of one number under each. An order made before the number was kept with it
 * has none, and its number is worked out; where that cannot be done it is counted for no vault.
 *
 * All the chain's deposits are read in one query. The figure is gross: nothing records a withdrawal.
 * Each deposit's time, and `fetchedAt`, the newest of them, is when the server learned that the step
 * had confirmed: no column says when it confirmed on the chain. Dollars are the raw cash over ten to
 * the decimals of the chain's cash token, cash being one dollar, always.
 */
export async function putInOf(
  db: Db,
  scoped: ScopedChain,
  vaults: readonly NumberedVault[],
  privyId: string | undefined,
): Promise<Map<string, PlanPutIn>> {
  if (vaults.length === 0) return new Map();
  const { entry } = scoped;
  const owner = chainFamily(entry.chain) === 'solana' ? orders.ownerSolana : orders.ownerEvm;
  const steps = await db
    .select({
      orderId: orders.id,
      owner,
      number: orders.basketId,
      request: orders.request,
      cashRaw: legs.cashRaw,
      at: legs.updatedAt,
    })
    .from(orders)
    .innerJoin(legs, eq(legs.orderId, orders.id))
    .where(
      and(
        eq(orders.type, 'buy'),
        inArray(owner, scoped.owners),
        eq(legs.chainId, entry.chain),
        inArray(legs.kind, ['create_vault', 'deposit']),
        eq(legs.status, 'confirmed'),
        isNotNull(legs.cashRaw),
        eq(legs.provenance, entry.provenance),
      ),
    )
    .orderBy(asc(legs.seq));

  // An order counts once, by the first of its steps that deposits.
  const counted = new Map<string, (typeof steps)[number]>();
  for (const step of steps) if (!counted.has(step.orderId)) counted.set(step.orderId, step);

  const deposits = new Map<string, Deposit[]>();
  for (const step of counted.values()) {
    if (step.owner === null || step.cashRaw === null) continue;
    const number = step.number ?? (await numberOfOlder(db, step.request, privyId));
    if (number === null) continue;
    const key = vaultKey(step.owner, number);
    const deposit = { orderId: step.orderId, at: step.at, raw: BigInt(step.cashRaw) };
    deposits.set(key, [...(deposits.get(key) ?? []), deposit]);
  }
  if (deposits.size === 0) return new Map();

  // The chain's asset list is held in memory: no node is asked.
  const cash = (await entry.adapter.listAssets()).find((asset) => asset.cls === 'cash');
  if (!cash) throw new Error(`${entry.chain} lists no cash token`);
  const usd = (raw: bigint) => dollarsOf(raw, cash.decimals);

  const answers = new Map<string, PlanPutIn>();
  for (const vault of vaults) {
    // Oldest first, and by the order's id where two were learned of at the same instant.
    const mine = [...(deposits.get(vaultKey(vault.owner, vault.basketId)) ?? [])].sort(
      (a, b) => a.at.getTime() - b.at.getTime() || (a.orderId < b.orderId ? -1 : 1),
    );
    const newest = mine.at(-1);
    if (!newest) continue;
    answers.set(vault.address, {
      usd: usd(mine.reduce((sum, deposit) => sum + deposit.raw, 0n)),
      orders: mine.length,
      deposits: mine.map((deposit) => ({
        orderId: deposit.orderId,
        at: deposit.at.toISOString(),
        usd: usd(deposit.raw),
      })),
      source: `the person's confirmed deposits in this app's order record on ${entry.config.name}`,
      method: PUT_IN_METHOD,
      fetchedAt: newest.at.toISOString(),
      provenance: entry.provenance,
    });
  }
  return answers;
}

/**
 * A snapshot as the answer carries it: the row whole, with how old it is at the answer. The age is
 * in whole seconds and never below zero (a worker's clock may run ahead of this server's). `stale` is
 * read off the same two instants as the status rule reads them, to the millisecond, so the two never
 * disagree: a snapshot a fraction of a second past the hour is stale, at `ageSeconds` 3600.
 */
export function newestOf(row: SnapshotRow, now: Date): PlanNewest {
  const ageMs = Math.max(0, now.getTime() - row.observedAt.getTime());
  return {
    observedAt: row.observedAt.toISOString(),
    ageSeconds: Math.floor(ageMs / 1000),
    stale: ageMs > STALE_AFTER_SECONDS * 1000,
    blockOrSlot: row.blockOrSlot,
    valueUsd: row.valueUsd,
    cash: row.cash,
    positions: row.positions,
    lossUsedBps: row.lossUsedBps,
    bandBps: row.bandBps,
    lossCapBps: row.lossCapBps,
    paused: row.paused,
    prices: row.prices,
    source: row.source,
    method: row.method,
    provenance: row.provenance,
  };
}

/** What the server holds of a shared portfolio: its family's id, slug and name. */
export type FamilyNamed = Required<Pick<PlanFollows, 'familyId' | 'slug' | 'name'>>;

/**
 * The families of the shared portfolios with these ids on one chain, by the id, in one query: a
 * portfolio's id on its chain names its recipe, and the recipe its family. An id the server holds no
 * recipe for on that chain is left out (Robinhood Chain's test network has none).
 */
export async function familiesOf(
  db: Db,
  chain: ChainId,
  recipeOnchainIds: readonly string[],
): Promise<Map<string, FamilyNamed>> {
  const ids = [...new Set(recipeOnchainIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      onchainId: recipes.onchainId,
      familyId: indexFamilies.familyId,
      slug: indexFamilies.slug,
      name: indexFamilies.name,
    })
    .from(recipes)
    .innerJoin(indexFamilies, eq(indexFamilies.familyId, recipes.familyId))
    .where(and(eq(recipes.chainId, chain), inArray(recipes.onchainId, ids)));
  return new Map(
    rows.flatMap(({ onchainId, ...family }) => (onchainId === null ? [] : [[onchainId, family]])),
  );
}

/**
 * The shared portfolio a vault follows, as its newest snapshot says: the portfolio's id on the chain,
 * the version the vault accepted and whether it follows new versions by itself, with the family's id,
 * slug and name where the server holds them, never guessed. Null for a vault that follows none, or
 * that the worker has not read.
 */
export function followsOf(
  newest: SnapshotRow | null,
  families: ReadonlyMap<string, FamilyNamed>,
): PlanFollows | null {
  if (!newest?.recipeOnchainId) return null;
  return {
    recipeOnchainId: newest.recipeOnchainId,
    acceptedVersion: newest.acceptedVersion,
    autoFollow: newest.autoFollow,
    ...families.get(newest.recipeOnchainId),
  };
}

/**
 * The shared portfolio each of these vaults was opened to follow, by vault address, as the goal join
 * holds it: the family of a plan that follows one, named from the server's own row, in one query.
 *
 * It is read off the plans as they were answered to the person (`plansOf`) and off nothing else, so it
 * says no more than `plan` does, and to nobody `plan` is not answered to. Only a plan that follows a
 * shared portfolio has one: a vault with a plan made to measure, a vault with no plan, and one whose
 * family the server holds no row for are left out. A name is never guessed.
 *
 * It says what a vault was opened as. What the chain shows a vault following now is its snapshot's to
 * say (`followsOf`), and the two can differ: a follow order makes a vault follow a portfolio it was
 * not opened for, and the snapshot worker's mock makes its vaults with no portfolio at all
 * (apps/snapshot/src/mock-world.ts).
 */
export async function openedForOf(
  db: Db,
  plans: ReadonlyMap<string, JoinedPlan>,
): Promise<Map<string, FamilyNamed>> {
  const followed = [...plans].flatMap(([address, { plan }]) =>
    plan.kind === 'follow' && plan.familyId ? [{ address, familyId: plan.familyId }] : [],
  );
  if (followed.length === 0) return new Map();
  const rows = await db
    .select({
      familyId: indexFamilies.familyId,
      slug: indexFamilies.slug,
      name: indexFamilies.name,
    })
    .from(indexFamilies)
    .where(inArray(indexFamilies.familyId, [...new Set(followed.map((f) => f.familyId))]));
  const named = new Map(rows.map((row) => [row.familyId, row]));
  return new Map(
    followed.flatMap(({ address, familyId }) => {
      const family = named.get(familyId);
      return family ? [[address, family]] : [];
    }),
  );
}
