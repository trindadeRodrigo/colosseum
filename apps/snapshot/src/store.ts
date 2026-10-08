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
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
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

/**
 * Every address a worker has snapshotted on the chain under this label. Read once, at the first
 * pass.
 *
 * A vault has a row every ten minutes and the list wants each address once. Postgres has no skip
 * scan, so a DISTINCT would visit every row of the table at each start. This steps through the
 * unique key (chain_id, address, observed_at) instead, one address at a time: the first address of
 * the chain under the label, then the next one above the last, until there is none. A step is one
 * descent of the index where the chain's rows carry one label, as they do in a database that serves
 * one network, so the read costs by the addresses and not by their rows. Rows of another label that
 * lie between two addresses are still passed over one by one.
 */
export async function snapshottedAddresses(
  db: Db,
  chain: ChainId,
  provenance: Provenance,
): Promise<string[]> {
  const t = vaultSnapshots;
  const under = sql`${t.chainId} = ${chain} and ${t.provenance} = ${provenance}`;
  const rows = await db.execute<{ address: string }>(sql`
    with recursive seen (address) as (
      (select ${t.address} from ${t} where ${under} order by ${t.address} limit 1)
      union all
      select (
        select ${t.address} from ${t}
        where ${under} and ${t.address} > seen.address
        order by ${t.address} limit 1
      )
      from seen
      where seen.address is not null
    )
    select address from seen where address is not null
  `);
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

/**
 * What a run says when the pass that opened it never closed it: a start closed it, or a later pass
 * that found it older than any pass can be.
 */
export const LEFT_OPEN =
  'left open by a pass that never closed it; closed at a later start or pass';

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
 * Closes the runs left open on one chain that started before `before`, and answers how many. A
 * start closes what it finds (closeOpenRuns); this is for a worker that is running when another
 * process leaves a run open, which would otherwise refuse every run of that chain until someone
 * started the worker again. A run that started at or after `before` is left as it is: a pass may
 * still be in it.
 */
export async function closeStaleRuns(
  db: Db,
  chain: ChainId,
  before: Date,
  finishedAt: Date,
): Promise<number> {
  const closed = await db
    .update(snapshotRuns)
    .set({ finishedAt, error: LEFT_OPEN })
    .where(
      and(
        eq(snapshotRuns.chainId, chain),
        isNull(snapshotRuns.finishedAt),
        lt(snapshotRuns.startedAt, before),
      ),
    )
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
