import type { AssetId, Quote, RiskRollUp, RollUpContext, Share } from '@colosseum/schemas';
import { apportion, BasketInputError } from './amounts';

// The roll-up of a plan's risk sheet (DESIGN-VAULT section 8): where the money is concentrated, and
// what it costs to get out at the person's size, as two numbers that are never merged.
//
// Everything here is a figure to show, not an amount that moves, so dollars and costs are numbers.
// Shares are worked out on whole millionths of a dollar, so they add up to exactly 10,000 bps.

/** The provider takes a window and ignores it today: every answer is the worst measured regime. */
export const EXIT_WINDOW_DAYS = 7;
/** The cost at which exit capacity is read, as in section 3.4: 1%. */
export const EXIT_TAU = 0.01;
/** One issuer holding more than this share of a plan is flagged. A starting value. */
export const ISSUER_FLAG_BPS = 5000;
/**
 * A stored quote older than this is flagged as stale: three hours, which is three missed runs of the
 * hourly EVM collector and twelve of the 15-minute Solana snapshots.
 */
export const QUOTE_STALE_SECONDS = 3 * 3600;
/**
 * A stored quote is flagged as far from a line's size when its size is under the line divided by
 * this, or over the line times this. Cost grows with size, so a quote for much less understates it.
 */
export const QUOTE_SIZE_RATIO = 2;
/** Two stored quotes are "the same size" when their sizes are within this ratio of each other. */
const SAME_SIZE = 1.1;

export const ROLL_UP_FLAGS = {
  /** One issuer holds more than half of the plan. */
  issuer: 'issuer_concentration',
  /** A line's asset is not on the shelf, so it could not be classed. */
  unlisted: 'asset_not_on_shelf',
  /** No line that would have to be sold has a measured exit cost. */
  notMeasured: 'exit_not_measured',
  /** Some lines that would have to be sold have a measured exit cost and some have not. */
  partlyMeasured: 'exit_partly_measured',
  /** A line is larger than the largest size measured for its asset. */
  beyondMeasured: 'exit_beyond_measured_size',
  /** A line is larger than what can be sold at 1% or less in the worst regime. */
  capacityShort: 'exit_capacity_short',
  /** No line that would have to be sold has a stored quote. */
  noQuote: 'exit_quote_missing',
  /** Some lines have a stored quote and some have not; the quoted cost covers only those that do. */
  partQuote: 'exit_quote_partial',
  /** A quote used is older than `QUOTE_STALE_SECONDS` at `now`. */
  staleQuote: 'exit_quote_stale',
  /** A quote used is for a size more than `QUOTE_SIZE_RATIO` times off the line's. */
  farQuote: 'exit_quote_far_from_size',
  /** The quoted number rests on a source that is not live: `quoted_provenance:mock`. */
  quotedProvenance: 'quoted_provenance:',
  /** The measured number rests on a source that is not live: `measured_provenance:fixture`. */
  measuredProvenance: 'measured_provenance:',
} as const;

/**
 * LOCAL TYPE. `RollUpContext` in packages/schemas has no time, and a stored quote cannot be called
 * fresh or stale without one. `now` is an ISO time, passed in like every other time in this package.
 */
export type RollUpInput = RollUpContext & { now: string };

type Line = { asset: AssetId; micro: bigint; usd: number };
type Sized = { quote: Quote; size: number; at: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

function shares(lines: Line[], keyOf: (asset: AssetId) => string): Share[] {
  const sums = new Map<string, bigint>();
  for (const l of lines) sums.set(keyOf(l.asset), (sums.get(keyOf(l.asset)) ?? 0n) + l.micro);
  const keys = [...sums.keys()].sort();
  const bps = apportion(
    keys.map((k) => sums.get(k) ?? 0n),
    10_000n,
  );
  return keys
    .map((key, i) => ({ key, bps: Number(bps[i] ?? 0n) }))
    .sort((a, b) => b.bps - a.bps || (a.key < b.key ? -1 : 1));
}

function time(iso: string, what: string): number {
  const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) throw new BasketInputError('BadTime', `${what} is not an ISO time`);
  return at;
}

/**
 * Concentration by issuer, chain and class, the two exit numbers, and flags.
 *
 * - `byIssuer`, `byChain`, `byClass`: each line's dollars by its asset's issuer, chain and class, as
 *   bps of the plan, largest first. An asset that is not on the shelf goes under `unknown`.
 * - `exit.quotedBps`: for each line, the stored quote that sells that asset for cash at the size
 *   nearest the line (a quote's size is the cash it pays out; of two equally near, the larger), and
 *   the latest one at that size. The number is the average of those costs weighted by dollars, over
 *   the lines that have a quote. `exit.quotedAt` is the oldest of the quotes used. A quote that is
 *   stale at `ctx.now`, or for a size far from the line's, is still used, and flagged.
 * - `exit.measuredWorstBps`: `LiquidityProvider.exitCost` at each line's size, worst regime, averaged
 *   the same way over the lines it has a number for. `exit.measuredShareBps` is how much of the plan
 *   that number covers, rounded down.
 * - A cash line costs nothing to leave. It counts at zero in a number that exists, and never makes
 *   one: each number is null until a line that would have to be sold has a quote, or a measure.
 *   Null means not measured, never zero.
 * - A source that is not live is named, per number: `quoted_provenance:mock`,
 *   `measured_provenance:fixture`.
 *
 * Lines for one asset are added together; a line of zero or less is ignored. The result does not
 * depend on the order of the lines or of the quotes.
 */
export function rollUp(
  lines: { asset: AssetId; amountUsd: number }[],
  ctx: RollUpInput,
): RiskRollUp {
  const now = time(ctx.now, 'now');
  const byAsset = new Map(ctx.shelf.assets.map((a) => [a.id, a]));
  const merged = new Map<AssetId, number>();
  for (const l of lines) {
    if (!Number.isFinite(l.amountUsd) || l.amountUsd <= 0) continue;
    merged.set(l.asset, (merged.get(l.asset) ?? 0) + l.amountUsd);
  }
  const plan: Line[] = [...merged]
    .map(([asset, usd]) => ({ asset, usd, micro: BigInt(Math.round(usd * 1e6)) }))
    .filter((l) => l.micro > 0n)
    .sort((a, b) => (a.asset < b.asset ? -1 : 1));
  const totalMicro = plan.reduce((n, l) => n + l.micro, 0n);
  const flags = new Set<string>();

  const field = (pick: 'issuer' | 'chain' | 'cls') => (asset: AssetId) =>
    byAsset.get(asset)?.[pick] ?? 'unknown';
  if (plan.some((l) => !byAsset.has(l.asset))) flags.add(ROLL_UP_FLAGS.unlisted);
  const byIssuer = shares(plan, field('issuer'));
  if ((byIssuer[0]?.bps ?? 0) > ISSUER_FLAG_BPS) flags.add(ROLL_UP_FLAGS.issuer);

  const cashLines = plan.filter((l) => byAsset.get(l.asset)?.cls === 'cash');
  const tradable = plan.filter((l) => byAsset.get(l.asset)?.cls !== 'cash');
  const cashUsd = cashLines.reduce((n, l) => n + l.usd, 0);
  const cashMicro = cashLines.reduce((n, l) => n + l.micro, 0n);

  const quoted = { lines: 0, usd: 0, cost: 0, at: null as Sized | null };
  const measured = { lines: 0, usd: 0, cost: 0, micro: 0n };
  const liquidity = ctx.liquidity;

  for (const l of tradable) {
    const used = nearestQuote(l, ctx);
    if (used) {
      quoted.lines += 1;
      quoted.usd += l.usd;
      quoted.cost += l.usd * used.quote.costBps;
      if (quoted.at === null || used.at < quoted.at.at) quoted.at = used;
      if (now - used.at > QUOTE_STALE_SECONDS * 1000) flags.add(ROLL_UP_FLAGS.staleQuote);
      if (used.size * QUOTE_SIZE_RATIO < l.usd || used.size > l.usd * QUOTE_SIZE_RATIO)
        flags.add(ROLL_UP_FLAGS.farQuote);
      if (used.quote.provenance !== 'live')
        flags.add(`${ROLL_UP_FLAGS.quotedProvenance}${used.quote.provenance}`);
    }

    if (!liquidity?.covers(l.asset)) continue;
    const cost = liquidity.exitCost(l.asset, l.usd, EXIT_WINDOW_DAYS);
    if (cost === null) flags.add(ROLL_UP_FLAGS.beyondMeasured);
    else {
      measured.lines += 1;
      measured.usd += l.usd;
      measured.micro += l.micro;
      measured.cost += l.usd * cost * 10_000;
      if (liquidity.provenance !== 'live')
        flags.add(`${ROLL_UP_FLAGS.measuredProvenance}${liquidity.provenance}`);
    }
    const entry = liquidity.entry(l.asset, {
      tau: EXIT_TAU,
      windowDays: EXIT_WINDOW_DAYS,
      legAmountUsd: l.usd,
    });
    if (entry && entry.score < 1) flags.add(ROLL_UP_FLAGS.capacityShort);
  }

  if (tradable.length > 0) {
    if (quoted.lines === 0) flags.add(ROLL_UP_FLAGS.noQuote);
    else if (quoted.lines < tradable.length) flags.add(ROLL_UP_FLAGS.partQuote);
    if (measured.lines === 0) flags.add(ROLL_UP_FLAGS.notMeasured);
    else if (measured.lines < tradable.length) flags.add(ROLL_UP_FLAGS.partlyMeasured);
  }

  return {
    byIssuer,
    byChain: shares(plan, field('chain')),
    byClass: shares(plan, field('cls')),
    flags: [...flags].sort(),
    exit: {
      quotedBps: quoted.lines > 0 ? round2(quoted.cost / (quoted.usd + cashUsd)) : null,
      quotedAt: quoted.at?.quote.fetchedAt ?? null,
      measuredWorstBps:
        measured.lines > 0 ? round2(measured.cost / (measured.usd + cashUsd)) : null,
      measuredShareBps:
        measured.lines > 0 ? Number(((measured.micro + cashMicro) * 10_000n) / totalMicro) : 0,
    },
  };
}

/** Dollars a quote pays out: its size. Null when its cash side is not a cash token on the shelf. */
function sizeUsd(quote: Quote, ctx: RollUpContext): number | null {
  const cash = ctx.shelf.assets.find((a) => a.id === quote.trade.buy);
  if (cash?.cls !== 'cash') return null;
  // A size to compare with, not an amount that moves: a float is fine here.
  return Number(quote.outRaw) / 10 ** cash.decimals;
}

function nearestQuote(line: Line, ctx: RollUpContext): Sized | null {
  const sized = ctx.quotes
    .filter((q) => q.trade.sell === line.asset)
    .flatMap((quote): Sized[] => {
      const size = sizeUsd(quote, ctx);
      return size !== null && size > 0
        ? [{ quote, size, at: time(quote.fetchedAt, 'the time of a quote') }]
        : [];
    });
  const [first] = sized;
  if (!first) return null;
  const gap = (s: Sized) => Math.abs(s.size - line.usd);
  // The nearest size; of two equally near, the larger, which costs more.
  const nearest = sized.reduce(
    (a, b) => (gap(b) < gap(a) || (gap(b) === gap(a) && b.size > a.size) ? b : a),
    first,
  );
  // The latest at that size; then the larger, then the dearer, so the order of the list never decides.
  return sized
    .filter((s) => s.size <= nearest.size * SAME_SIZE && s.size >= nearest.size / SAME_SIZE)
    .reduce((a, b) => {
      if (b.at !== a.at) return b.at > a.at ? b : a;
      if (b.size !== a.size) return b.size > a.size ? b : a;
      return b.quote.costBps > a.quote.costBps ? b : a;
    }, nearest);
}
