import { type Db, vaultSnapshots } from '@colosseum/db';
import type { Price, RebalanceDrift, RebalanceEntry } from '@colosseum/schemas';
import { and, gt, inArray, type SQL, sql } from 'drizzle-orm';
import { ownedOn, type ScopedChain } from './scope';
import type { SnapshotRow } from './snapshots';

// What the rebalances route reads from the snapshots (PORT-2): a position and its price in the snapshot
// nearest a time, for the drift before and after a step, and the keeper's trades, which no table
// records and which are worked out from the snapshots themselves. A vault has a row every ten minutes,
// so both are found in the database and only the rows that answer come back: a vault's history is
// never read into memory. Every read is of the person's own rows (scope.ts).

/** One position of a snapshot, as `view()` of packages/basket gave it and the row kept it. */
type Position = SnapshotRow['positions'][number];

/** A position against its target, as the snapshot read at `observedAt` has it. */
const driftOf = (position: Position, observedAt: string): RebalanceDrift => ({
  observedAt,
  weightBps: position.weightBps,
  targetBps: position.targetBps,
  driftBps: position.driftBps,
});

/**
 * A time of the database as the ISO instant an answer carries, to the millisecond. These reads are
 * written out as SQL, and a time comes back from such a query as the database prints it, which is
 * another form.
 */
const iso = (time: SQL) =>
  sql`to_char(${time} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** An asset of a vault at a time: what a snapshot is asked for. */
export type SnapshotPoint = { address: string; at: Date; asset: string };

/** What the snapshot nearest a point says of the asset. */
export type SnapshotNear = {
  /** The asset's weight, target and drift; absent when it is not among the snapshot's positions. */
  drift?: RebalanceDrift;
  /** The asset's price with its own source, time and method; absent when the snapshot has none. */
  price?: Price;
};

/**
 * For each point, the vault's snapshot nearest its time on one side: the newest at or before it
 * (`before`), or the oldest at or after it (`after`). One query for all the points, with one descent
 * of the table's unique key a point, and only the asset's own position and price come back. The
 * answer has an entry a point, in the order given: undefined where the vault has no such snapshot.
 */
export async function snapshotsNear(
  db: Db,
  scoped: ScopedChain,
  side: 'before' | 'after',
  points: readonly SnapshotPoint[],
): Promise<(SnapshotNear | undefined)[]> {
  if (points.length === 0) return [];
  const t = vaultSnapshots;
  const wanted = sql.join(
    points.map(
      (p, i) =>
        sql`(${i}::int, ${p.address}::text, ${p.at.toISOString()}::timestamptz, ${p.asset}::text)`,
    ),
    sql`, `,
  );
  const [reaches, nearestFirst] = side === 'before' ? [sql`<=`, sql`desc`] : [sql`>=`, sql`asc`];
  const rows = await db.execute<{
    i: number;
    observed_at: string;
    position: Position | null;
    price: Price | null;
  }>(sql`
    select wanted.i, ${iso(sql`near.observed_at`)} as observed_at,
      (select p.value from jsonb_array_elements(near.positions) as p(value)
        where p.value->>'asset' = wanted.asset limit 1) as position,
      (select p.value from jsonb_array_elements(near.prices) as p(value)
        where p.value->>'asset' = wanted.asset limit 1) as price
    from (values ${wanted}) as wanted(i, address, at, asset)
    cross join lateral (
      select ${t.observedAt} as observed_at, ${t.positions} as positions, ${t.prices} as prices
      from ${t}
      where ${ownedOn(t, scoped)} and ${t.address} = wanted.address
        and ${t.observedAt} ${reaches} wanted.at
      order by ${t.observedAt} ${nearestFirst}
      limit 1
    ) as near
  `);
  const found: (SnapshotNear | undefined)[] = points.map(() => undefined);
  for (const row of rows)
    found[row.i] = {
      ...(row.position ? { drift: driftOf(row.position, row.observed_at) } : {}),
      ...(row.price ? { price: row.price } : {}),
    };
  return found;
}

/** How far back the keeper's trades are looked for among a vault's snapshots. */
export const KEEPER_LOOKBACK_DAYS = 30;

/** How an entry worked out from snapshots was made: its `method`. */
export const KEEPER_METHOD =
  "worked out from two snapshots of the vault between which the vault's last keeper time on the asset changed: the amounts are what the vault held of the asset in each snapshot, the time is the chain's time of the keeper's last trade on the asset, and every trade of the asset between the two snapshots is in this one entry. It is not read from a record of the trade: the keeper's own log is not in the database, so there is no transaction id, no quote and no reason";

/**
 * The keeper's trades in these vaults since `since`, newest first, at most `limit`. The keeper's own
 * log is not in the database, so they are worked out: a vault stamps the time of the keeper's last
 * trade on each asset (`lastKeeperAt`), and a trade lies between two consecutive snapshots of the
 * vault where that time is later in the second than in the first. One entry a changed asset.
 *
 * An asset that had no keeper time in the earlier snapshot, or was not held in it, counts only when
 * its time is later than that snapshot's own: a vault on an EVM chain keeps an asset's keeper time
 * while the asset is no target, so an old time can come back with no trade behind it. An asset the
 * earlier snapshot does not list was not held, and its amount there is nothing.
 *
 * The pairs are found in the database, by a window over each vault's rows. Only a row's keeper times
 * go through the window, and the first comparison is of those as a whole: the two snapshots of a pair
 * are read back by their key, and opened into their positions, only where one changed, and only those
 * pairs come back. Both snapshots of a pair are newer than `since`.
 */
export async function keeperTrades(
  db: Db,
  scoped: ScopedChain,
  a: { addresses: readonly string[]; since: Date; cash: string; limit: number },
): Promise<RebalanceEntry[]> {
  if (a.addresses.length === 0) return [];
  const t = vaultSnapshots;
  // The person's own rows, on every read of the table below: the one the window runs over, and the
  // two that read a pair's snapshots back by their key.
  const mine = ownedOn(t, scoped);
  const searched = and(mine, inArray(t.address, [...a.addresses]), gt(t.observedAt, a.since));
  const rows = await db.execute<{
    address: string;
    observed_at: string;
    earlier_at: string;
    source: string;
    later: Position & { lastKeeperAt: number };
    earlier: Position | null;
    price: Price | null;
  }>(sql`
    with reads as (
      select ${t.address} as address, ${t.observedAt} as observed_at,
        jsonb_path_query_array(${t.positions}, '$[*].lastKeeperAt') as keeper_times
      from ${t}
      where ${searched}
    ),
    pairs as (
      select reads.*,
        lag(observed_at) over vault as earlier_at,
        lag(keeper_times) over vault as earlier_times
      from reads
      window vault as (partition by address order by observed_at)
    )
    select pairs.address, later_read.source,
      ${iso(sql`pairs.observed_at`)} as observed_at,
      ${iso(sql`pairs.earlier_at`)} as earlier_at,
      later.position as later, earlier.position as earlier,
      (select p.value from jsonb_array_elements(earlier_read.prices) as p(value)
        where p.value->>'asset' = later.position->>'asset' limit 1) as price
    from pairs
    cross join lateral (
      select ${t.source} as source, ${t.positions} as positions
      from ${t}
      where ${mine} and ${t.address} = pairs.address and ${t.observedAt} = pairs.observed_at
    ) as later_read
    cross join lateral (
      select ${t.positions} as positions, ${t.prices} as prices
      from ${t}
      where ${mine} and ${t.address} = pairs.address and ${t.observedAt} = pairs.earlier_at
    ) as earlier_read
    cross join lateral jsonb_array_elements(later_read.positions) as later(position)
    left join lateral (
      select e.position from jsonb_array_elements(earlier_read.positions) as e(position)
      where e.position->>'asset' = later.position->>'asset'
      limit 1
    ) as earlier on true
    where pairs.earlier_at is not null
      and pairs.keeper_times is distinct from pairs.earlier_times
      and (later.position->>'lastKeeperAt')::numeric > coalesce(
        (earlier.position->>'lastKeeperAt')::numeric,
        extract(epoch from pairs.earlier_at)
      )
    order by (later.position->>'lastKeeperAt')::numeric desc, pairs.observed_at desc,
      pairs.address, later.position->>'asset'
    limit ${a.limit}
  `);
  return rows.map((row): RebalanceEntry => {
    const { later, earlier } = row;
    const rawBefore = earlier?.raw ?? '0';
    // More of the asset, or as much: the keeper bought it with cash. Less: it sold it for cash.
    const bought = BigInt(later.raw) >= BigInt(rawBefore);
    return {
      chain: scoped.entry.chain,
      vault: row.address,
      // The chain's own time of the trade, which a vault keeps in unix seconds.
      at: new Date(later.lastKeeperAt * 1000).toISOString(),
      by: 'keeper',
      derived: true,
      kind: 'keeper_leg',
      why: null,
      outcome: 'confirmed',
      trades: [
        {
          sell: bought ? a.cash : later.asset,
          buy: bought ? later.asset : a.cash,
          asset: later.asset,
          rawBefore,
          rawAfter: later.raw,
          ...(row.price ? { reference: row.price } : {}),
          ...(earlier ? { before: driftOf(earlier, row.earlier_at) } : {}),
          after: driftOf(later, row.observed_at),
        },
      ],
      orderId: null,
      txId: null,
      explorerUrl: null,
      source: row.source,
      method: KEEPER_METHOD,
      fetchedAt: row.observed_at,
      provenance: scoped.entry.provenance,
    };
  });
}
