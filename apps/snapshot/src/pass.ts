import { BasketInputError, view } from '@colosseum/basket';
import type { Db } from '@colosseum/db';
import {
  type AssetId,
  ChainError,
  type Price,
  type Provenance,
  type VaultState,
} from '@colosseum/schemas';
import { DrizzleQueryError } from 'drizzle-orm';
import { type ChainState, ownersDue, startDiscovery } from './discover';
import type { RoundFailure } from './loop';
import type { ChainSource } from './source';
import {
  closeRun,
  closeStaleRuns,
  insertSnapshot,
  knownVaults,
  openRun,
  ownersOf,
  type RunEnd,
  snapshotRow,
  snapshottedAddresses,
} from './store';

// One pass of the worker over one chain (DESIGN-VAULT section 10): every vault of our people that the
// worker knows of is read as the chain has it now, valued by view() of packages/basket on the chain's
// own prices, and kept as one row of `vault_snapshots`. Nothing is built, signed or sent: a ChainSource
// has no way to.
//
// What fails a pass: the chain not answering (its rules or its asset list could not be read, no
// vault at all could be read, or no price at all), the database not answering, and no vault read
// while at least one failed, whatever the reason. The loop then backs off (loop.ts). One vault that
// cannot be read, valued or written beside one that was is a `failed` line for that vault, and the
// others go on. The height fails nothing: a chain that cannot say it gives null (chains.ts), and
// the row carries none.

/** How many reads of a chain are in flight at once. Small, for the free allowance of a public node. */
export const READS_AT_ONCE = 4;

/** The longest reason a line carries. */
const REASON_MAX = 300;

export type PassContext = {
  db: Db;
  /** Reads and prints, writes nothing and opens no run. The lines are the same. */
  dryRun: boolean;
  /** What every reason is said with: it takes node addresses and the database's out. */
  hide: (text: string) => string;
  /** Where each JSON line goes. */
  out: (line: string) => void;
  now: () => Date;
  /**
   * How long ago an open run on the chain must have started for a pass to take it as left open and
   * close it. run.ts gives it: longer than any pass can take. A younger run may be another worker's
   * pass, and is left alone.
   */
  staleRunMs: number;
};

/** One line per vault per pass: what was read, or why nothing was. */
export type VaultLine =
  | {
      vault: string;
      outcome: 'read';
      reason: string;
      observedAt: string;
      /** Dollars cut to cents, as the row holds them. */
      valueUsd: string;
      blockOrSlot: string | null;
      provenance: Provenance;
    }
  | { vault: string; outcome: 'failed' | 'skipped'; reason: string };

/** An owner whose vaults the chain could not be asked for. The owner is asked again at the next pass. */
export type OwnerLine = { owner: string; outcome: 'failed'; reason: string };

/**
 * One line per pass. The counts are vaults, as `snapshot_runs` holds them. `skipped` as a pass is one
 * that did not start, because another worker's run was open on the chain.
 */
export type PassLine =
  | { pass: 'done'; read: number; failed: number; skipped: number; dryRun: boolean }
  | { pass: 'skipped'; reason: string; alert: true };

export type Line = VaultLine | OwnerLine | PassLine | RoundFailure;

export type PassResult =
  | { outcome: 'done'; read: number; failed: number; skipped: number }
  | { outcome: 'skipped' };

/** Says a line of one chain: every line carries its time, the chain and the chain's name. */
export function sayer(
  ctx: Pick<PassContext, 'out' | 'now'>,
  source: Pick<ChainSource, 'chain' | 'name'>,
): (line: Line) => void {
  return (line) =>
    ctx.out(
      JSON.stringify({
        at: ctx.now().toISOString(),
        chain: source.chain,
        name: source.name,
        ...line,
      }),
    );
}

/**
 * An error in words: its code where it has one, and its message. Never the error itself, its cause or
 * its stack, which is where a transport error keeps the address of the node it called. A query the
 * database did not take is said by its code alone, since its message is the whole query and what it
 * carried.
 */
export function reasonOf(e: unknown): string {
  if (e instanceof ChainError || e instanceof BasketInputError) return `${e.code}: ${e.message}`;
  if (e instanceof DrizzleQueryError) {
    const code = (e.cause as { code?: unknown } | undefined)?.code;
    return typeof code === 'string'
      ? `the database did not take a query (${code})`
      : 'the database did not take a query';
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * A reason as a line or a row carries it: through `hide`, then its first line, then cut to length. In
 * that order, so a cut never leaves half an address behind for `hide` to miss. Only the first line is
 * kept because a library's error names what it called on the lines after it.
 */
export function said(ctx: Pick<PassContext, 'hide'>, e: unknown): string {
  const [line = ''] = ctx.hide(reasonOf(e)).split('\n');
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX)}...` : line;
}

/** The chain did not answer: the one refusal worth asking again. */
const isDown = (e: unknown) => e instanceof ChainError && e.code === 'Unavailable';

/** The chain has no price for the asset. That is an answer, and the asset is shown with no value. */
const isUnpriced = (e: unknown) => e instanceof ChainError && e.code === 'AssetNotPriced';

type Tried<T> = { value: T } | { error: unknown };

async function attempt<T>(work: () => Promise<T>): Promise<Tried<T>> {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  }
}

/** Runs `work` over `items`, at most `atOnce` at a time, and answers in the order of `items`. */
async function inTurns<T, R>(
  items: readonly T[],
  atOnce: number,
  work: (item: T) => Promise<Tried<R>>,
): Promise<Tried<R>[]> {
  const out = new Array<Tried<R>>(items.length);
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, lane));
  return out;
}

const holdings = (v: VaultState): AssetId[] => [v.cash.asset, ...v.positions.map((p) => p.asset)];

/**
 * The prices of `wanted`, which are all on the chain's list: one read for all of them, and where that
 * is refused, one read an asset. An adapter refuses the whole call for one asset it cannot price, and
 * the others still have a price. `unread` holds each asset whose own read failed for any reason but
 * the chain having no price for it. Throws when no price at all was read and the chain did not answer.
 */
async function pricesOf(
  source: ChainSource,
  wanted: AssetId[],
): Promise<{ prices: Price[]; unread: Map<AssetId, unknown> }> {
  const unread = new Map<AssetId, unknown>();
  if (wanted.length === 0) return { prices: [], unread };
  const together = await attempt(() => source.getPrices(wanted));
  if ('value' in together) return { prices: together.value, unread };
  const prices: Price[] = [];
  let down: unknown = null;
  const apart = await inTurns(wanted, READS_AT_ONCE, (id) => attempt(() => source.getPrices([id])));
  for (const [i, answer] of apart.entries()) {
    const id = wanted[i] as AssetId;
    if ('value' in answer) prices.push(...answer.value);
    else if (!isUnpriced(answer.error)) {
      unread.set(id, answer.error);
      if (isDown(answer.error)) down ??= answer.error;
    }
  }
  if (prices.length === 0 && down !== null)
    throw new Error(`no price could be read: ${reasonOf(down)}`);
  return { prices, unread };
}

/**
 * Opens the run of this pass, after writing the end of the last one where the database did not take
 * it then. Where a run is already open on the chain and started longer ago than any pass can take,
 * the process that opened it is gone and nothing else would close it while this worker runs: it is
 * closed as left open, and the run is opened once more. Null when the open run is younger than
 * that: another worker's pass may be in it.
 */
async function openOwnRun(
  ctx: PassContext,
  source: ChainSource,
  state: ChainState,
): Promise<string | null> {
  if (state.unclosed !== null) {
    await closeRun(ctx.db, state.unclosed.id, state.unclosed.end);
    state.unclosed = null;
  }
  const now = ctx.now();
  const run = await openRun(ctx.db, source.chain, source.provenance, now);
  if (run !== null) return run;
  const before = new Date(now.getTime() - ctx.staleRunMs);
  const closed = await closeStaleRuns(ctx.db, source.chain, before, now);
  return closed === 0 ? null : openRun(ctx.db, source.chain, source.provenance, now);
}

/**
 * The reads and the writes of a pass. Throws when the chain did not answer. `counts` is kept up as it
 * goes, so a pass that fails half way still says what it had read.
 */
async function readChain(
  ctx: PassContext,
  source: ChainSource,
  state: ChainState,
  counts: { read: number; failed: number; skipped: number },
  say: (line: Line) => void,
): Promise<void> {
  const { db } = ctx;
  const { chain, provenance } = source;
  const started = ctx.now();

  // What the database names, first: the mock's sample world is made from it.
  const known = await knownVaults(db, chain, provenance);
  state.addresses ??= new Set(await snapshottedAddresses(db, chain, provenance));
  const addresses = state.addresses;
  const owners = [
    ...new Set([...(await ownersOf(db, chain, provenance)), ...known.map((k) => k.owner)]),
  ];
  // The mock's sample world, and what it holds that the database does not name: read like the rest.
  for (const address of (await source.prepare?.(known, started)) ?? []) addresses.add(address);

  // The chain itself. The height comes first, so every vault of the pass is read at or after it; a
  // chain that cannot say its height gives null, and the row carries none. The rules or the asset
  // list failing is the chain not answering, and the pass fails.
  const height = await source.height();
  const rules = await source.rules();
  const listed = await source.listAssets();

  // The first failure, in either kind of read, that was the chain not answering.
  let down: unknown = null;
  const found = new Map<string, VaultState>();
  const keep = (v: VaultState) => {
    found.set(v.address, v);
    addresses.add(v.address);
    state.empty.delete(v.address);
  };

  // By owner, the heavy read: every owner at the first pass and once an hour, a new one at once.
  const { all, due } = ownersDue(state, owners, started);
  if (all) startDiscovery(state, started);
  const asked = await inTurns(due, READS_AT_ONCE, (owner) =>
    attempt(() => source.getVaults(owner)),
  );
  for (const [i, answer] of asked.entries()) {
    const owner = due[i] as string;
    if ('value' in answer) {
      state.owners.add(owner);
      for (const v of answer.value) keep(v);
      continue;
    }
    // Not remembered as asked, so the next pass asks again.
    state.owners.delete(owner);
    if (isDown(answer.error)) down ??= answer.error;
    say({ owner, outcome: 'failed', reason: said(ctx, answer.error) });
  }

  // By address, the cheap read: every vault the worker knows of that an owner's read did not just give.
  const byAddress = [...new Set([...known.map((k) => k.address), ...addresses])].filter(
    (a) => !found.has(a) && !state.empty.has(a),
  );
  const reads = await inTurns(byAddress, READS_AT_ONCE, (address) =>
    attempt(() => source.getVault(address)),
  );
  for (const [i, answer] of reads.entries()) {
    const vault = byAddress[i] as string;
    if ('error' in answer) {
      counts.failed++;
      if (isDown(answer.error)) down ??= answer.error;
      say({ vault, outcome: 'failed', reason: said(ctx, answer.error) });
    } else if (answer.value === null) {
      // Not asked again until every owner is: a vault can be opened there later.
      counts.skipped++;
      state.empty.add(vault);
      say({ vault, outcome: 'skipped', reason: `no vault at this address on ${source.name}` });
    } else keep(answer.value);
  }
  if (found.size === 0 && down !== null)
    throw new Error(`no vault could be read: ${reasonOf(down)}`);

  // Prices for the listed assets these vaults hold. A token the chain shows that the list does not
  // have has no price: it is kept with no value, and does not stop the read.
  const onList = new Set<string>(listed.map((a) => a.id));
  const wanted = [...new Set([...found.values()].flatMap(holdings))].filter((id) => onList.has(id));
  const { prices, unread } = await pricesOf(source, wanted);

  const basketOf = new Map(known.map((k) => [k.address, k.basketId]));
  const blockOrSlot = height === null ? null : height.toString();
  for (const v of found.values()) {
    try {
      const held = new Set<string>(holdings(v));
      // A price the chain did not answer for is not a price of nothing: a row written without it
      // would say the vault is worth less than it is.
      const lost = [...held].find((id) => unread.has(id));
      if (lost !== undefined)
        throw new Error(
          `the price of ${lost} could not be read (${reasonOf(unread.get(lost))}), so the vault was not valued`,
        );
      const mine = prices.filter((p) => held.has(p.asset));
      const seen = view(v, mine, listed);
      const row = snapshotRow({
        source,
        seen,
        prices: mine,
        rules,
        height,
        basketId: basketOf.get(v.address) ?? null,
      });
      if (!ctx.dryRun) await insertSnapshot(db, row);
      counts.read++;
      const priced = seen.positions.filter((p) => p.valueUsd !== null).length;
      say({
        vault: v.address,
        outcome: 'read',
        reason: `${priced} of ${seen.positions.length} positions priced`,
        observedAt: v.observedAt,
        valueUsd: row.valueUsd,
        blockOrSlot,
        provenance,
      });
    } catch (e) {
      counts.failed++;
      say({ vault: v.address, outcome: 'failed', reason: said(ctx, e) });
    }
  }
}

/**
 * One pass over one chain. Throws when the pass failed, with a reason that has been through `hide`;
 * the run, if one was opened, is closed with that reason first.
 */
export async function snapshotChain(
  ctx: PassContext,
  source: ChainSource,
  state: ChainState,
): Promise<PassResult> {
  const say = sayer(ctx, source);
  const counts = { read: 0, failed: 0, skipped: 0 };
  let run: string | null = null;
  let failure: string | null = null;
  try {
    if (!ctx.dryRun) {
      run = await openOwnRun(ctx, source, state);
      if (run === null) {
        say({
          pass: 'skipped',
          reason: `another worker holds the open run on ${source.name}; nothing was read`,
          alert: true,
        });
        return { outcome: 'skipped' };
      }
    }
    await readChain(ctx, source, state, counts, say);
    // No vault was read and at least one vault failed (its read by address, its value or its row):
    // that is a failed pass whatever the refusal was called, or a chain that writes no row would
    // look well for good. A pass with nothing to read (no vault known, or none at the addresses
    // asked) failed nothing, and is a good one. An owner whose vaults could not be asked for is a
    // line, is asked again at the next pass, and fails nothing by itself: `user_wallets` carries no
    // label, so one wallet a chain cannot read must not fail that chain for good.
    if (counts.read === 0 && counts.failed > 0)
      throw new Error(`no vault was read: ${counts.failed} failed`);
  } catch (e) {
    failure = said(ctx, e);
  }
  if (run !== null) {
    const end: RunEnd = {
      finishedAt: ctx.now(),
      vaultsRead: counts.read,
      vaultsFailed: counts.failed,
      error: failure,
    };
    try {
      await closeRun(ctx.db, run, end);
    } catch (e) {
      // Kept, and written before the next run is opened.
      state.unclosed = { id: run, end };
      failure ??= said(ctx, e);
    }
  }
  if (failure !== null) throw new Error(failure);
  say({ pass: 'done', ...counts, dryRun: ctx.dryRun });
  return { outcome: 'done', ...counts };
}
