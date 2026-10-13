import { type Db, snapshotRuns, vaultSnapshots, vaults } from '@colosseum/db';
import type { TrackSnapshot } from '@colosseum/schemas';
import { and, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { ChainEntry } from '../orders/chains';
import { addressOn, ownedOn, type ScopedChain } from './scope';

// The reads of the snapshot worker's tables that the portfolio section's routes share (PORT-2). The
// worker (apps/snapshot) writes `vault_snapshots` and `snapshot_runs`; the API only reads them, and
// only a person's own rows (scope.ts).

export type SnapshotRow = typeof vaultSnapshots.$inferSelect;
export type CachedVault = typeof vaults.$inferSelect;

/** A vault of the person's: its cache row where the API has one, and its newest snapshot where the worker has read it. */
export type KnownVault = {
  address: string;
  cached: CachedVault | null;
  newest: SnapshotRow | null;
};

/**
 * How far back a vault that the cache does not name is still looked for among the snapshots. The
 * cache names every vault a buy of ours opened and every vault a portfolio read saw; a vault the
 * worker alone found (opened outside the app, never read through the API) is listed while it has a
 * snapshot this recent.
 */
export const SNAPSHOT_LOOKBACK_DAYS = 7;

/**
 * The person's vaults on one chain, each with its newest snapshot: every vault the cache names for
 * their wallets, and every vault of theirs the worker snapshotted in the last week. `address` narrows
 * it to one vault, as a query wrote it (`addressOn`). Ordered by address.
 */
export async function knownVaults(
  db: Db,
  scoped: ScopedChain,
  a: { now: Date; address?: string },
): Promise<KnownVault[]> {
  // An address that is not one of the chain's family names no vault here.
  const only = a.address === undefined ? undefined : addressOn(scoped, a.address);
  if (only === null) return [];
  const cached = await db
    .select()
    .from(vaults)
    .where(and(ownedOn(vaults, scoped), ...(only ? [eq(vaults.address, only)] : [])));
  const since = new Date(a.now.getTime() - SNAPSHOT_LOOKBACK_DAYS * 86_400_000);
  const seen = await db
    .selectDistinct({ address: vaultSnapshots.address })
    .from(vaultSnapshots)
    .where(
      and(
        ownedOn(vaultSnapshots, scoped),
        gt(vaultSnapshots.observedAt, since),
        ...(only ? [eq(vaultSnapshots.address, only)] : []),
      ),
    );
  const byAddress = new Map(cached.map((row) => [row.address, row]));
  const addresses = [...new Set([...byAddress.keys(), ...seen.map((s) => s.address)])].sort();
  return Promise.all(
    addresses.map(async (address) => ({
      address,
      cached: byAddress.get(address) ?? null,
      newest: await newestSnapshot(db, scoped, address),
    })),
  );
}

/** The newest snapshot of one vault of the person's, or null. One descent of the table's unique key. */
export async function newestSnapshot(
  db: Db,
  scoped: ScopedChain,
  address: string,
): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(vaultSnapshots)
    .where(and(ownedOn(vaultSnapshots, scoped), eq(vaultSnapshots.address, address)))
    .orderBy(desc(vaultSnapshots.observedAt))
    .limit(1);
  return row ?? null;
}

/**
 * When a pass of the worker last went through on a chain, under the chain's label here: the end of
 * its newest run that closed with no error. Null when none has.
 */
export async function chainAnsweredAt(db: Db, entry: ChainEntry): Promise<Date | null> {
  const [row] = await db
    .select({ finishedAt: snapshotRuns.finishedAt })
    .from(snapshotRuns)
    .where(
      and(
        eq(snapshotRuns.chainId, entry.chain),
        eq(snapshotRuns.provenance, entry.provenance),
        isNotNull(snapshotRuns.finishedAt),
        isNull(snapshotRuns.error),
      ),
    )
    .orderBy(desc(snapshotRuns.startedAt))
    .limit(1);
  return row?.finishedAt ?? null;
}

/** A snapshot row as the status rule reads it (`statusOf` of packages/basket). */
export function trackSnapshotOf(row: SnapshotRow): TrackSnapshot {
  return {
    observedAt: row.observedAt.toISOString(),
    cash: { raw: row.cash.raw },
    positions: row.positions.map(({ asset, raw, targetBps, valueUsd, driftBps }) => ({
      asset,
      raw,
      targetBps,
      valueUsd,
      driftBps,
    })),
    lossUsedBps: row.lossUsedBps,
    bandBps: row.bandBps,
    lossCapBps: row.lossCapBps,
  };
}
