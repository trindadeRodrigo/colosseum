import { type Db, legAttempts, legs, orders, vaults } from '@colosseum/db';
import {
  chainFamily,
  type IntentRequest,
  type RebalanceEntry,
  type TradeExpected,
} from '@colosseum/schemas';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { boughtOf, numberWorkedOut } from '../orders/plan-join';
import {
  KEEPER_LOOKBACK_DAYS,
  keeperTrades,
  type SnapshotPoint,
  snapshotsNear,
} from './rebalances-snapshots';
import { addressOn, ownedOn, type ScopedChain } from './scope';
import { knownVaults } from './snapshots';

// The list behind GET /v1/portfolio/rebalances (PORT-2): the steps that reached a chain for a person's
// vaults and traded or adopted a version, read from the database alone. Two kinds of entry. The
// owner's own steps are in the order tables, one entry an attempt that landed. The keeper's trades
// are in no table (apps/keeper writes none), and are worked out from the snapshots
// (rebalances-snapshots.ts). Whose rows are read is scope.ts's to say: the wallets of the identity
// token, on a chain this server runs, under that chain's label here.

/**
 * A step's stored quote as one figure a trade. The column holds a list, one entry a trade; a row
 * written before that holds one figure, which is the figure of a step with one trade (`expectedOfRow`
 * in orders/store.ts). Nothing where the figures are not one a trade.
 */
function quotesOf(stored: unknown, trades: number): TradeExpected[] {
  const list = Array.isArray(stored)
    ? stored
    : stored && typeof stored === 'object'
      ? [stored]
      : [];
  return list.length === trades ? list : [];
}

/** A step of the owner's as it is listed, with the two times its drift is read around. */
type OwnerStep = {
  entry: RebalanceEntry;
  builtAt: Date;
  /** When the step settled, as near as a row says it. */
  settledAt: Date;
};

/**
 * The attempts of the person's own steps on one chain that reached it: an attempt that confirmed or
 * failed (a transaction that reverted is `failed`), of a step that carries a trade or adopts a
 * version, in an order that is no publish. The list is driven by the attempts, not the steps: a step
 * that reverted and was built again keeps the reverted transaction only in its attempt.
 *
 * The order is the person's by its owner on the chain's family, and the label is the attempt's own.
 * `address` narrows the list to the steps of one vault.
 */
async function ownerSteps(
  db: Db,
  scoped: ScopedChain,
  a: { cash: string; privyId: string | undefined; address?: string },
): Promise<OwnerStep[]> {
  const { chain, provenance } = scoped.entry;
  const owner = chainFamily(chain) === 'solana' ? orders.ownerSolana : orders.ownerEvm;
  const rows = await db
    .select({
      builtAt: legAttempts.builtAt,
      // Confirmed or failed and nothing else: the `where` below says so.
      outcome: sql<RebalanceEntry['outcome']>`${legAttempts.status}`,
      txId: legAttempts.txId,
      explorerUrl: legAttempts.explorerUrl,
      source: legAttempts.source,
      method: legAttempts.method,
      fetchedAt: legAttempts.fetchedAt,
      provenance: legAttempts.provenance,
      kind: legs.kind,
      trigger: legs.trigger,
      trades: legs.trades,
      expected: legs.expected,
      updatedAt: legs.updatedAt,
      // The attempt the step mirrors: the step's row is this attempt's, and so is its last change.
      mirrored: sql<boolean>`${legAttempts.n} = ${legs.attempt}`,
      // The step's latest build, whose quote the step's row holds: every build writes its own over
      // the one before, and nothing else writes it.
      latestBuild: sql<boolean>`${legAttempts.n} = (select max(x.n) from ${legAttempts} as x where x.leg_id = ${legs.id})`,
      orderId: orders.id,
      type: orders.type,
      owner,
      number: orders.basketId,
      request: orders.request,
    })
    .from(legAttempts)
    .innerJoin(legs, eq(legs.id, legAttempts.legId))
    .innerJoin(orders, eq(orders.id, legs.orderId))
    .where(
      and(
        inArray(legAttempts.status, ['confirmed', 'failed']),
        eq(legAttempts.provenance, provenance),
        eq(legs.chainId, chain),
        inArray(owner, scoped.owners),
        ne(orders.type, 'publish'),
        // A rebalance trades, or adopts a version: an approval, or a deposit with no trade, is neither.
        or(sql`jsonb_array_length(${legs.trades}) > 0`, eq(legs.kind, 'accept_version')),
      ),
    )
    // How steps built at one moment follow each other: kept together by order, and within an order
    // the later step first, and the later attempt of a step. The list is put newest first where it
    // is joined with the keeper's trades (`chainRebalances`), by a sort that keeps this order.
    .orderBy(desc(orders.id), desc(legs.seq), desc(legAttempts.n));
  if (rows.length === 0) return [];

  // The person's vaults on the chain as the cache names them: a step's vault is one of these or none.
  const cached = await db
    .select({ address: vaults.address, owner: vaults.owner, number: vaults.onchainBasketId })
    .from(vaults)
    .where(ownedOn(vaults, scoped));
  /** The numbers worked out so far, by order: an order's attempts share one. */
  const worked = new Map<string, string | null>();
  /**
   * The vault a step was for, where the cache names it as the person's. A follow order names its
   * vault. A buy names the vault's number: the one kept with the order, or worked out for an order
   * made before it was kept. An order of any other kind names no single vault, and no step says
   * which vault it trades in: its steps are answered with none.
   */
  const vaultOf = async (row: (typeof rows)[number]): Promise<string | null> => {
    if (row.type === 'follow') {
      const named = row.request.type === 'follow' ? row.request.vault : null;
      return cached.some((v) => v.address === named) ? named : null;
    }
    if (row.type !== 'buy') return null;
    if (row.number === null && !worked.has(row.orderId))
      worked.set(row.orderId, await workedOut(db, row.request, a.privyId));
    const number = row.number ?? worked.get(row.orderId) ?? null;
    // The vault of that wallet with that number. The cache has no rule that there is only one (a
    // test network deployed again makes a second, at another address): two are answered as none,
    // since no row says which of them the step traded in.
    const found = cached.filter((v) => v.owner === row.owner && v.number === number);
    return found.length === 1 ? (found[0]?.address ?? null) : null;
  };

  const steps: OwnerStep[] = [];
  for (const row of rows) {
    const vault = await vaultOf(row);
    if (a.address !== undefined && vault !== a.address) continue;
    const quotes = row.latestBuild ? quotesOf(row.expected, row.trades.length) : [];
    steps.push({
      builtAt: row.builtAt,
      settledAt: row.mirrored ? row.updatedAt : row.builtAt,
      entry: {
        chain,
        vault,
        at: row.builtAt.toISOString(),
        by: 'owner',
        derived: false,
        kind: row.kind,
        why: row.trigger,
        outcome: row.outcome,
        trades: row.trades.map((trade, i) => {
          const quote = quotes[i];
          return {
            sell: trade.sell,
            buy: trade.buy,
            asset: trade.sell === a.cash ? trade.buy : trade.sell,
            amountInRaw: trade.amountInRaw,
            ...(quote ? { expected: quote } : {}),
          };
        }),
        orderId: row.orderId,
        txId: row.txId || null,
        explorerUrl: row.explorerUrl,
        source: row.source,
        method: row.method,
        fetchedAt: row.fetchedAt.toISOString(),
        provenance: row.provenance,
      },
    });
  }
  return steps;
}

/**
 * The number of the vault a buy made before the number was kept with it (`orders.basket_id`) is for,
 * worked out as the goal join works it out (orders/plan-join.ts). Null where the order names nothing
 * the number can be worked out from.
 */
async function workedOut(
  db: Db,
  request: IntentRequest,
  privyId: string | undefined,
): Promise<string | null> {
  if (!privyId) return null;
  const bought = await boughtOf(db, request);
  return bought ? numberWorkedOut(db, bought, privyId) : null;
}

/**
 * Fills in what the snapshots say around each step of the owner's: for every trade, the asset's price
 * in the vault's newest snapshot at or before the step was built (`reference`) with the asset's drift
 * in that same snapshot (`before`), and its drift in the oldest snapshot at or after the step settled
 * (`after`). Each stays out where there is no such snapshot, where the step's vault is not known, and
 * where the snapshot does not list the asset. Two queries for all the steps, one a side.
 */
async function addDrift(db: Db, scoped: ScopedChain, steps: readonly OwnerStep[]): Promise<void> {
  const trades = steps.flatMap((step) => {
    const address = step.entry.vault;
    return address === null ? [] : step.entry.trades.map((trade) => ({ step, trade, address }));
  });
  const at = (pick: (step: OwnerStep) => Date): SnapshotPoint[] =>
    trades.map(({ step, trade, address }) => ({ address, at: pick(step), asset: trade.asset }));
  const before = await snapshotsNear(
    db,
    scoped,
    'before',
    at((step) => step.builtAt),
  );
  const after = await snapshotsNear(
    db,
    scoped,
    'after',
    at((step) => step.settledAt),
  );
  for (const [i, { trade }] of trades.entries()) {
    const [earlier, later] = [before[i], after[i]];
    if (earlier?.price) trade.reference = earlier.price;
    if (earlier?.drift) trade.before = earlier.drift;
    if (later?.drift) trade.after = later.drift;
  }
}

/**
 * The rebalances of one chain for one person, newest first, cut to `limit`: the attempts of their own
 * steps that landed, and the keeper's trades in their vaults worked out from the snapshots of the
 * last thirty days. `address` narrows both to one vault: an address that is not a vault of theirs
 * narrows them to nothing.
 */
export async function chainRebalances(
  db: Db,
  scoped: ScopedChain,
  a: { privyId: string | undefined; now: Date; address?: string; limit: number },
): Promise<RebalanceEntry[]> {
  // The one place the query's address is read (`addressOn`): everything below compares and binds
  // `only`.
  const only = a.address === undefined ? undefined : addressOn(scoped, a.address);
  // Text that is no address of this chain names no vault here: the chain answers nothing.
  if (only === null) return [];
  const narrowed = only === undefined ? {} : { address: only };
  // One side of every trade is the chain's cash token: the other is the asset the trade is about.
  const cash = (await scoped.entry.adapter.listAssets()).find((x) => x.cls === 'cash');
  if (!cash) throw new Error(`${scoped.entry.chain} lists no cash token`);
  const steps = await ownerSteps(db, scoped, { cash: cash.id, privyId: a.privyId, ...narrowed });
  const known = await knownVaults(db, scoped, { now: a.now, ...narrowed });
  const derived = await keeperTrades(db, scoped, {
    addresses: known.map((vault) => vault.address),
    since: new Date(a.now.getTime() - KEEPER_LOOKBACK_DAYS * 86_400_000),
    cash: cash.id,
    limit: a.limit,
  });
  // Newest first across both kinds. The sort keeps what it is given in order where two times are
  // equal: an owner's step ahead of a keeper's trade, and each kind as its own read ordered it.
  const listed = [
    ...steps.map((step) => ({ at: step.builtAt.getTime(), entry: step.entry, step })),
    ...derived.map((entry) => ({ at: Date.parse(entry.at), entry, step: null })),
  ]
    .sort((x, y) => y.at - x.at)
    .slice(0, a.limit);
  // Only for the steps that are answered: a person's older steps are not looked up.
  await addDrift(
    db,
    scoped,
    listed.flatMap((item) => (item.step ? [item.step] : [])),
  );
  return listed.map((item) => item.entry);
}
