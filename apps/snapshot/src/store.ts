import {
  type Db,
  legs,
  orders,
  snapshotRuns,
  userWallets,
  vaultSnapshots,
  vaults,
} from '@colosseum/db';
import {
  type ChainId,
  chainFamily,
  type Price,
  type Provenance,
  type VaultView,
} from '@colosseum/schemas';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { ChainRules, ChainSource, KnownVault } from './source';

// What a pass reads from the database and writes to it (DESIGN-VAULT section 4), through Drizzle. The
// worker writes two tables and no other: `vault_snapshots` and `snapshot_runs`. `vaults`, `orders`,
// `legs` and `user_wallets` are the API's, and are only read here.

/**
 * The `vaults` rows of one chain that carry the source's label. A database can hold rows read from the
 * mock beside rows read from a test network, and a mock address is never asked of a real chain.
 */
export async function knownVaults(
  db: Db,
  chain: ChainId,
  provenance: Provenance,
): Promise<KnownVault[]> {
  return db
    .select({
      address: vaults.address,
      owner: vaults.owner,
      onchainBasketId: vaults.onchainBasketId,
      basketId: vaults.basketId,
      targets: vaults.targets,
      valueUsd: vaults.valueUsd,
    })
    .from(vaults)
    .where(and(eq(vaults.chainId, chain), eq(vaults.provenance, provenance)))
    .orderBy(asc(vaults.address));
}

/** Every address a worker has snapshotted on the chain under this label. Read once, at the first pass. */
export async function snapshottedAddresses(
  db: Db,
  chain: ChainId,
  provenance: Provenance,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ address: vaultSnapshots.address })
    .from(vaultSnapshots)
    .where(and(eq(vaultSnapshots.chainId, chain), eq(vaultSnapshots.provenance, provenance)));
  return rows.map((r) => r.address);
}

/**
 * Our people on the chain's wallet family, beside the owners the `vaults` rows name: every wallet a
 * person has, and whoever an order with a confirmed step on this chain, under this label, belongs to.
 * Nothing writes `user_wallets` yet; it is read all the same, so the day something does, its people
 * are found.
 */
export async function ownersOf(db: Db, chain: ChainId, provenance: Provenance): Promise<string[]> {
  const family = chainFamily(chain);
  const wallets = await db
    .select({ address: userWallets.address })
    .from(userWallets)
    .where(eq(userWallets.family, family));
  const owner = family === 'solana' ? orders.ownerSolana : orders.ownerEvm;
  const buyers = await db
    .selectDistinct({ address: owner })
    .from(orders)
    .innerJoin(legs, eq(legs.orderId, orders.id))
    .where(
      and(
        eq(legs.chainId, chain),
        eq(legs.status, 'confirmed'),
        eq(legs.provenance, provenance),
        isNotNull(owner),
      ),
    );
  const found = new Set(wallets.map((w) => w.address));
  for (const b of buyers) if (b.address) found.add(b.address);
  return [...found].sort();
}

/**
 * Opens the chain's run. Null when a run is already open on the chain: the partial unique index
 * refuses a second one, whoever holds the first.
 */
export async function openRun(
  db: Db,
  chain: ChainId,
  provenance: Provenance,
  startedAt: Date,
): Promise<string | null> {
  const [row] = await db
    .insert(snapshotRuns)
    .values({ chainId: chain, provenance, startedAt })
    .onConflictDoNothing()
    .returning({ id: snapshotRuns.id });
  return row?.id ?? null;
}

export type RunEnd = {
  finishedAt: Date;
  vaultsRead: number;
  vaultsFailed: number;
  /** Why the pass as a whole failed, with no node address in it; null when it went through. */
  error: string | null;
};

export async function closeRun(db: Db, id: string, end: RunEnd): Promise<void> {
  await db.update(snapshotRuns).set(end).where(eq(snapshotRuns.id, id));
}

/** What a run says when the worker that opened it never closed it. */
export const LEFT_OPEN = 'left open by a worker that stopped; closed when the next one started';

/**
 * Closes every run left open on these chains, and answers how many. A worker that is killed in the
 * middle of a pass leaves its run open, and an open run refuses the next one on its chain.
 */
export async function closeOpenRuns(db: Db, chains: ChainId[], finishedAt: Date): Promise<number> {
  if (chains.length === 0) return 0;
  const closed = await db
    .update(snapshotRuns)
    .set({ finishedAt, error: LEFT_OPEN })
    .where(and(inArray(snapshotRuns.chainId, chains), isNull(snapshotRuns.finishedAt)))
    .returning({ id: snapshotRuns.id });
  return closed.length;
}

/**
 * A dollar figure cut to cents, never rounded: '599.999999' is '599.99'. The column holds two places
 * and Postgres would round a longer figure up, so a vault a hair under $600 would be kept as $600.00.
 * A copy of the API's (apps/api/src/orders/store.ts): no app imports another.
 */
export function cutToCents(value: string): string {
  const [whole = '0', frac = ''] = value.split('.');
  return `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

/** How a row's figures were made: the row's `method`. */
export const SNAPSHOT_METHOD =
  "the vault's state as the chain's reader gave it; value, weights and drift by view() of packages/basket on the prices kept in this row, cash counted as one dollar; the dollar value cut to cents";

export type SnapshotRow = typeof vaultSnapshots.$inferInsert;

/** One vault at one time, as its row. Pure. */
export function snapshotRow(a: {
  source: Pick<ChainSource, 'chain' | 'provenance' | 'source'>;
  seen: VaultView;
  /** The prices of what this vault holds, exactly as the source gave them. */
  prices: Price[];
  rules: ChainRules;
  /** The chain's height at the start of the pass. */
  height: bigint | null;
  /** The plan's row the `vaults` cache joined the vault to, if any. */
  basketId: string | null;
}): SnapshotRow {
  const { seen } = a;
  return {
    chainId: a.source.chain,
    address: seen.address,
    observedAt: new Date(seen.observedAt),
    blockOrSlot: a.height === null ? null : a.height.toString(),
    owner: seen.owner,
    basketId: a.basketId,
    onchainBasketId: seen.basketId,
    recipeOnchainId: seen.recipeOnchainId,
    acceptedVersion: seen.acceptedVersion,
    autoFollow: seen.autoFollow,
    valueUsd: cutToCents(seen.valueUsd),
    cash: seen.cash,
    positions: seen.positions,
    pending: seen.pending,
    lossUsedBps: seen.lossUsedBps,
    bandBps: a.rules.bandBps,
    lossCapBps: a.rules.lossCapBps,
    paused: a.rules.paused,
    prices: a.prices,
    provenance: a.source.provenance,
    source: a.source.source,
    method: SNAPSHOT_METHOD,
  };
}

/**
 * Writes one snapshot. False when the vault already has a row for that time, which is left as it is:
 * the same read written twice is one row.
 */
export async function insertSnapshot(db: Db, row: SnapshotRow): Promise<boolean> {
  const written = await db
    .insert(vaultSnapshots)
    .values(row)
    .onConflictDoNothing({
      target: [vaultSnapshots.chainId, vaultSnapshots.address, vaultSnapshots.observedAt],
    })
    .returning({ id: vaultSnapshots.id });
  return written.length > 0;
}
