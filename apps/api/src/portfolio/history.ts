import { type Db, vaultSnapshots, vaults } from '@colosseum/db';
import {
  HISTORY_MAX_POINTS,
  HISTORY_STEP_SECONDS,
  type HistoryPoint,
  type HistorySeries,
  HistoryStep,
  isAddressOf,
  type PortfolioHistoryQuery,
} from '@colosseum/schemas';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Refusal } from '../orders/errors';
import { ownedOn, type ScopedChain } from './scope';

// A person's vaults over time (GET /v1/portfolio/history, PORT-2): the window one read covers, and the
// query that answers it. The snapshot worker keeps a row a vault about every ten minutes
// (`vault_snapshots`). A history is those rows thinned to one a step, and the thinning is done by the
// database, in the query: no job keeps a second table, and the server never holds more rows than the
// points it answers.

/** How far back a history starts, at the most, when the request names no `from`. */
export const HISTORY_DEFAULT_DAYS = 90;

/**
 * The earliest instant a window may start at. The query's schema reads the year 0000 as an instant and
 * the database's clock has no such year, so a window that reaches before the year 1 is refused here
 * rather than fail in the query.
 */
const FIRST_INSTANT = new Date('0001-01-01T00:00:00.000Z');

/** The window of one read, as the answer says it back. */
export type HistoryWindow = { from: Date; to: Date; step: HistoryStep };

const millisOf = (step: HistoryStep) => HISTORY_STEP_SECONDS[step] * 1000;
/**
 * The longest window one read answers at a step: `HISTORY_MAX_POINTS` steps. A window of exactly that
 * length touches one step more than that, the one it starts in and the one it ends in being two: a
 * vault read in both has `HISTORY_MAX_POINTS` points and one.
 */
const longestAt = (step: HistoryStep) => HISTORY_MAX_POINTS * millisOf(step);

/**
 * The window a request asks for. Left out, `to` is now, and `from` is `HISTORY_MAX_POINTS` steps before
 * `to` and never more than ninety days before it.
 *
 * Refused, each with what to change: a window whose `from` is not before its `to`, a window longer
 * than `HISTORY_MAX_POINTS` steps, and one that starts before the year 1. A window is never cut to
 * fit: the person asked for all of it, and an answer that left part of it out would read as a vault
 * with no history there.
 */
export function historyWindow(
  query: Pick<PortfolioHistoryQuery, 'from' | 'to' | 'step'>,
  now: Date,
): HistoryWindow {
  const { step } = query;
  const to = query.to === undefined ? now : new Date(query.to);
  const furthest = Math.min(longestAt(step), HISTORY_DEFAULT_DAYS * 86_400_000);
  const from = query.from === undefined ? new Date(to.getTime() - furthest) : new Date(query.from);
  const length = to.getTime() - from.getTime();
  if (length <= 0)
    throw new Refusal(
      400,
      `\`from\` (${from.toISOString()}) is not before \`to\` (${to.toISOString()})`,
      { fix: 'Ask a `from` that is earlier than `to`. Left out, `to` is now.' },
    );
  if (length > longestAt(step)) {
    // The steps that answer a window this long: each is longer than the one asked.
    const fitting = HistoryStep.options.filter((s) => length <= longestAt(s));
    throw new Refusal(
      400,
      `this window asks for ${Math.ceil(length / millisOf(step))} steps of ${step}, and one read answers ${HISTORY_MAX_POINTS} at most`,
      {
        fix: fitting.length
          ? `Ask a shorter window, or a longer step: this one is answered at ${fitting.map((s) => `\`${s}\``).join(' or ')}.`
          : 'Ask a shorter window: no step answers one this long.',
      },
    );
  }
  if (from.getTime() < FIRST_INSTANT.getTime())
    throw new Refusal(400, 'this window starts before the year 1, and no time is kept before it', {
      fix: 'Ask a window that starts later.',
    });
  return { from, to, step };
}

/**
 * Where the steps are counted from: the Unix epoch, which is a midnight in UTC. So every step starts on
 * a UTC boundary (the ten minutes, the hour, the day) whatever the window is, and a step's point is
 * the same snapshot in every read that covers the whole step.
 */
const STEP_ORIGIN = sql.raw("timestamptz '1970-01-01 00:00:00+00'");

/**
 * The last snapshot of each step, for the person's vaults on one chain in the window, both ends
 * included: one row a vault a step, a vault's rows together and oldest first. `address` narrows it to
 * one vault. Only the columns a point is made of are read: `prices` is large and is not answered here.
 *
 * `distinct on` keeps the first row of each vault and step, and the order puts the newest snapshot of
 * the step first. The step is a `date_bin` of the step's seconds from `STEP_ORIGIN`. Its seconds are
 * written into the statement, not bound: they come from `HISTORY_STEP_SECONDS`, never from the
 * request, and `distinct on` must name the expression the `order by` starts with, which two bound
 * values would not be.
 *
 * The rows of the window are found through an index: the one on `(owner, observed_at)`, or the unique
 * key `(chain_id, address, observed_at)` where one vault is named. Postgres reads the table instead
 * only where the person's rows in the window are most of it. The sort that follows is over the
 * window's rows of the person's vaults, each with its positions: it is what a long window costs.
 */
export function lastOfEachStep(
  db: Db,
  scoped: ScopedChain,
  a: HistoryWindow & { address?: string },
) {
  const t = vaultSnapshots;
  const stride = sql.raw(`interval '${HISTORY_STEP_SECONDS[a.step]} seconds'`);
  const stepStart = sql`date_bin(${stride}, ${t.observedAt}, ${STEP_ORIGIN})`;
  return db
    .selectDistinctOn([t.address, stepStart], {
      address: t.address,
      observedAt: t.observedAt,
      valueUsd: t.valueUsd,
      cash: t.cash,
      positions: t.positions,
      lossUsedBps: t.lossUsedBps,
      source: t.source,
      method: t.method,
    })
    .from(t)
    .where(
      and(
        ownedOn(t, scoped),
        gte(t.observedAt, a.from),
        lte(t.observedAt, a.to),
        ...(a.address === undefined ? [] : [eq(t.address, a.address)]),
      ),
    )
    .orderBy(t.address, stepStart, desc(t.observedAt));
}

type StepRow = Awaited<ReturnType<typeof lastOfEachStep>>[number];

/**
 * The names the person gave these vaults of theirs on the chain, by address. A vault with no name, and
 * one the cache does not hold as theirs, is left out.
 */
async function namesOf(
  db: Db,
  scoped: ScopedChain,
  addresses: string[],
): Promise<Map<string, string>> {
  if (!addresses.length) return new Map();
  const rows = await db
    .select({ address: vaults.address, name: vaults.name })
    .from(vaults)
    .where(and(ownedOn(vaults, scoped), inArray(vaults.address, addresses)));
  return new Map(rows.flatMap((r) => (r.name === null ? [] : [[r.address, r.name] as const])));
}

/**
 * One snapshot as a point of its vault's series. The value is the row's, in cents as it was kept; the
 * cash is what the vault held of the chain's cash token, which counts as one dollar each. A point says
 * where it was read from and how it was made only where that differs from what the series says.
 */
function pointOf(row: StepRow, series: Pick<HistorySeries, 'source' | 'method'>): HistoryPoint {
  return {
    observedAt: row.observedAt.toISOString(),
    valueUsd: row.valueUsd,
    cashUsd: row.cash.display,
    positions: row.positions.map(({ asset, valueUsd, weightBps, targetBps, driftBps }) => ({
      asset,
      valueUsd,
      weightBps,
      targetBps,
      driftBps,
    })),
    lossUsedBps: row.lossUsedBps,
    ...(row.source === series.source ? {} : { source: row.source }),
    ...(row.method === series.method ? {} : { method: row.method }),
  };
}

/**
 * The history of the person's vaults on one chain: a series for each vault with a snapshot in the
 * window, ordered by address, its points oldest first. A series is read from where its newest point was
 * and made as that point was. A vault with no snapshot in the window is not listed.
 *
 * An `address` that is not in the form of the chain's addresses names no vault there, and nothing is
 * asked of the database for it: the query takes any text for an address, and some text the database
 * refuses to read at all.
 */
export async function chainHistory(
  db: Db,
  scoped: ScopedChain,
  a: HistoryWindow & { address?: string },
): Promise<HistorySeries[]> {
  if (a.address !== undefined && !isAddressOf(scoped.entry.config.family, a.address)) return [];
  const rows = await lastOfEachStep(db, scoped, a);
  const byVault = new Map<string, StepRow[]>();
  for (const row of rows) {
    const sofar = byVault.get(row.address);
    if (sofar) sofar.push(row);
    else byVault.set(row.address, [row]);
  }
  const names = await namesOf(db, scoped, [...byVault.keys()]);
  // Sorted here, as `knownVaults` sorts its vaults: the database orders text by its collation, which
  // is not the order of the addresses as strings.
  return [...byVault.keys()].sort().flatMap((address) => {
    const points = byVault.get(address) ?? [];
    const newest = points.at(-1);
    if (!newest) return [];
    const series = { source: newest.source, method: newest.method };
    return [
      {
        address,
        name: names.get(address) ?? null,
        ...series,
        points: points.map((row) => pointOf(row, series)),
      },
    ];
  });
}
