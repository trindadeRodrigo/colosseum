import type { AssetId, Quote, RiskRollUp, RollUpContext, Share } from '@colosseum/schemas';
import { apportion } from './amounts';

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
/** Two stored quotes are "the same size" when their sizes are within this ratio of each other. */
const SAME_SIZE = 1.1;

export const ROLL_UP_FLAGS = {
  /** One issuer holds more than half of the plan. */
  issuer: 'issuer_concentration',
  /** A line's asset is not on the shelf, so it could not be classed. */
  unlisted: 'asset_not_on_shelf',
  /** No part of the plan has a measured exit cost. */
  notMeasured: 'exit_not_measured',
  /** Part of the plan has a measured exit cost and part has not. */
  partlyMeasured: 'exit_partly_measured',
  /** A line is larger than the largest size measured for its asset. */
  beyondMeasured: 'exit_beyond_measured_size',
  /** A line is larger than what can be sold at 1% or less in the worst regime. */
  capacityShort: 'exit_capacity_short',
  /** No line has a stored quote. */
  noQuote: 'exit_quote_missing',
  /** Some lines have a stored quote and some have not; the quoted cost covers only those that do. */
  partQuote: 'exit_quote_partial',
  /** An exit number comes from a source that is not live: `provenance:mock`, `provenance:fixture`. */
  provenance: 'provenance:',
} as const;

type Line = { asset: AssetId; micro: bigint; usd: number };

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

/**
 * Concentration by issuer, chain and class, the two exit numbers, and flags.
 *
 * - `byIssuer`, `byChain`, `byClass`: each line's dollars by its asset's issuer, chain and class, as
 *   bps of the plan, largest first. An asset that is not on the shelf goes under `unknown`.
 * - `exit.quotedBps`: for each line, the stored quote that sells that asset for cash at the size
 *   nearest the line (a quote's size is the cash it pays out), the latest one at that size. The
 *   number is the average of those costs weighted by dollars, over the lines that have a quote.
 *   `exit.quotedAt` is the oldest of the quotes used.
 * - `exit.measuredWorstBps`: `LiquidityProvider.exitCost` at each line's size, worst regime, averaged
 *   the same way over the lines it has a number for. `exit.measuredShareBps` is how much of the plan
 *   that is, rounded down.
 * - A cash line costs nothing to leave and counts as quoted and as measured.
 * - Null means not measured, never zero.
 *
 * Lines for one asset are added together; a line of zero or less is ignored.
 */
export function rollUp(
  lines: { asset: AssetId; amountUsd: number }[],
  ctx: RollUpContext,
): RiskRollUp {
  const byAsset = new Map(ctx.shelf.assets.map((a) => [a.id, a]));
  const merged = new Map<AssetId, number>();
  for (const l of lines) {
    if (!Number.isFinite(l.amountUsd) || l.amountUsd <= 0) continue;
    merged.set(l.asset, (merged.get(l.asset) ?? 0) + l.amountUsd);
  }
  const plan: Line[] = [...merged]
    .map(([asset, usd]) => ({ asset, usd, micro: BigInt(Math.round(usd * 1e6)) }))
    .filter((l) => l.micro > 0n);
  const totalMicro = plan.reduce((n, l) => n + l.micro, 0n);
  const flags = new Set<string>();

  const field = (pick: 'issuer' | 'chain' | 'cls') => (asset: AssetId) =>
    byAsset.get(asset)?.[pick] ?? 'unknown';
  if (plan.some((l) => !byAsset.has(l.asset))) flags.add(ROLL_UP_FLAGS.unlisted);
  const byIssuer = shares(plan, field('issuer'));
  if ((byIssuer[0]?.bps ?? 0) > ISSUER_FLAG_BPS) flags.add(ROLL_UP_FLAGS.issuer);

  let quotedUsd = 0;
  let quotedCost = 0;
  let quotedAt: string | null = null;
  let unquoted = 0;
  let measuredMicro = 0n;
  let measuredUsd = 0;
  let measuredCost = 0;
  const liquidity = ctx.liquidity;

  for (const l of plan) {
    const asset = byAsset.get(l.asset);
    if (asset?.cls === 'cash') {
      quotedUsd += l.usd;
      measuredUsd += l.usd;
      measuredMicro += l.micro;
      continue;
    }

    const quote = nearestQuote(l, ctx);
    if (quote) {
      quotedUsd += l.usd;
      quotedCost += l.usd * quote.costBps;
      if (quotedAt === null || Date.parse(quote.fetchedAt) < Date.parse(quotedAt))
        quotedAt = quote.fetchedAt;
      if (quote.provenance !== 'live') flags.add(`${ROLL_UP_FLAGS.provenance}${quote.provenance}`);
    } else unquoted += 1;

    if (!liquidity?.covers(l.asset)) continue;
    if (liquidity.provenance !== 'live')
      flags.add(`${ROLL_UP_FLAGS.provenance}${liquidity.provenance}`);
    const cost = liquidity.exitCost(l.asset, l.usd, EXIT_WINDOW_DAYS);
    if (cost === null) flags.add(ROLL_UP_FLAGS.beyondMeasured);
    else {
      measuredUsd += l.usd;
      measuredMicro += l.micro;
      measuredCost += l.usd * cost * 10_000;
    }
    const entry = liquidity.entry(l.asset, {
      tau: EXIT_TAU,
      windowDays: EXIT_WINDOW_DAYS,
      legAmountUsd: l.usd,
    });
    if (entry && entry.score < 1) flags.add(ROLL_UP_FLAGS.capacityShort);
  }

  // A plan that is all cash has nothing to quote and nothing to measure: it costs nothing to leave.
  const tradable = plan.filter((l) => byAsset.get(l.asset)?.cls !== 'cash').length;
  const measuredShareBps = totalMicro === 0n ? 0 : Number((measuredMicro * 10_000n) / totalMicro);
  if (tradable > 0) {
    if (unquoted === tradable) flags.add(ROLL_UP_FLAGS.noQuote);
    else if (unquoted > 0) flags.add(ROLL_UP_FLAGS.partQuote);
    if (measuredShareBps === 0) flags.add(ROLL_UP_FLAGS.notMeasured);
    else if (measuredShareBps < 10_000) flags.add(ROLL_UP_FLAGS.partlyMeasured);
  }
  const anyQuote = tradable === 0 ? plan.length > 0 : unquoted < tradable;
  const anyMeasured = measuredMicro > 0n;

  return {
    byIssuer,
    byChain: shares(plan, field('chain')),
    byClass: shares(plan, field('cls')),
    flags: [...flags].sort(),
    exit: {
      quotedBps: anyQuote && quotedUsd > 0 ? round2(quotedCost / quotedUsd) : null,
      quotedAt,
      measuredWorstBps: anyMeasured && measuredUsd > 0 ? round2(measuredCost / measuredUsd) : null,
      measuredShareBps,
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

function nearestQuote(line: Line, ctx: RollUpContext): Quote | null {
  const sized = ctx.quotes
    .filter((q) => q.trade.sell === line.asset)
    .flatMap((q) => {
      const size = sizeUsd(q, ctx);
      return size !== null && size > 0 ? [{ q, size }] : [];
    });
  let nearest: { q: Quote; size: number } | null = null;
  for (const s of sized)
    if (!nearest || Math.abs(s.size - line.usd) < Math.abs(nearest.size - line.usd)) nearest = s;
  if (!nearest) return null;
  const at = nearest.size;
  return sized
    .filter((s) => s.size <= at * SAME_SIZE && s.size >= at / SAME_SIZE)
    .reduce((a, b) => (Date.parse(b.q.fetchedAt) > Date.parse(a.q.fetchedAt) ? b : a)).q;
}
