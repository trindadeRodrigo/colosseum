import { ROUTE_CHUNKS, type RouteLeg, type RoutePool, routeTrade } from '@colosseum/risk';
import { type BuiltSplit, readWholeIn, type SplitCapture, twoHopWholeFor } from './lib-split';

// PLAN-UNIVERSE RU.11 — the router's own gap to Jupiter (`pnpm risk:routing-gap --router`): each stored Jupiter quote
// against `routeTrade` on the pools of the capture nearest in time, once with one hop and once with two. Both routes
// run on the same frozen pools and the same amount, so what separates them is the two hops and nothing else.
//
// What a gap contains. Our side counts a SOL pool's dollars as the SOL at the capture's SOL price, with no cost for the
// SOL to USDC step; Jupiter's side is USDC delivered (a sale) or tokens for USDC paid (a purchase). Where our route
// uses SOL pools our side is overstated, so the gap reads lower than it is, and it can read negative. A gap also holds
// the price move between the quote and the capture, up to the window. The gain is two hops against one hop on the same
// pools at the same SOL price, both counted our way: it is not a comparison with Jupiter. Jupiter's amount only scales
// it, by one part in ten thousand for each basis point of gap.
//
// Pure: no file, no environment, no clock. The captures are built by the caller (`buildSplit`), once each.

export const ROUTING_GAP_ROUTER_METHOD = 'routing-gap-router-0.1';
/** A quote is compared with a capture taken at most this long before or after it. */
export const PAIR_WINDOW_MS = 300_000;
// the collector asks Jupiter for the stock against USDC, which has 6 decimals
const USDC_DECIMALS = 6;
// a route with more hops than this is not split into its stock hops (2^n sets of hops are tried)
const MAX_HOPS = 12;

/** One hop of a stored Jupiter route. The collector keeps no mints: amounts are raw units of the hop's own tokens. */
export type QuoteHop = {
  pool: string;
  label?: string | null;
  percent?: number | null;
  inAmount?: string | null;
  outAmount?: string | null;
};

/** One row of the collector's quotes (`RISK_HOME/quotes/<day>.jsonl`), as far as this report reads it. */
export type StoredQuote = {
  asset: string;
  assetMint: string;
  side: string;
  notionalUsd: number;
  /** Raw units sent: the stock for a sale, USDC for a purchase. */
  amountIn: string;
  /** Raw units received: USDC for a sale, the stock for a purchase. Null when Jupiter returned no quote. */
  outAmount: string | null;
  route: QuoteHop[] | null;
  error?: string | null;
  fetchedAt: string;
  /** What the row says it is (`live` from the collector); a row may say nothing. */
  provenance?: string | null;
};

/** Stored quotes from a file's text: the collector's `.jsonl` (one row a line), or one JSON with them under `quotes`. */
export function parseQuotes(text: string): StoredQuote[] {
  const t = text.trim();
  if (!t) return [];
  let whole: unknown;
  try {
    whole = JSON.parse(t);
  } catch {
    return t
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StoredQuote);
  }
  if (Array.isArray(whole)) return whole as StoredQuote[];
  if (whole && typeof whole === 'object') {
    const inner = (whole as { quotes?: unknown }).quotes;
    return Array.isArray(inner) ? (inner as StoredQuote[]) : [whole as StoredQuote];
  }
  throw new Error('quotes: neither rows nor an object with the rows under "quotes"');
}

export const ROUTER_USAGE =
  'usage: routing-gap.ts --router <capture file or folder> [more ...] [--quotes <file>] [--chunks <n>]';

/**
 * The arguments of `--router`: the captures named, the quotes file if one is named, and the number of chunks both
 * routes are cut in (`--chunks`, an integer of 1 or more; the router's own `ROUTE_CHUNKS` when not given). A pool
 * wins a whole chunk or none: at $100,000 one chunk of 32 is $3,125, and a stock-to-stock pool too small to take that
 * much at a better price wins nothing. Another number of chunks shows how much of a measured gain depends on it.
 * Throws the usage on anything else: no capture, a flag with no value, a flag it does not know.
 */
export function parseRouterArgs(args: readonly string[]): {
  paths: string[];
  quotesFile: string | null;
  chunks: number;
} {
  const paths: string[] = [];
  let quotesFile: string | null = null;
  let chunks = ROUTE_CHUNKS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    // pnpm hands the script the bare "--" that separates its own arguments
    if (a === '--router' || a === '--') continue;
    if (a === '--quotes' || a === '--chunks') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(ROUTER_USAGE);
      if (a === '--quotes') quotesFile = value;
      else {
        chunks = /^\d+$/.test(value) ? Number(value) : 0;
        if (!Number.isSafeInteger(chunks) || chunks < 1)
          throw new Error(
            `--chunks takes an integer of 1 or more, not "${value}"\n${ROUTER_USAGE}`,
          );
      }
    } else if (a.startsWith('--')) throw new Error(`${a}: not a flag of --router\n${ROUTER_USAGE}`);
    else paths.push(a);
  }
  if (!paths.length) throw new Error(ROUTER_USAGE);
  return { paths, quotesFile, chunks };
}

/** A capture the report leaves out, with the reason. */
export type CaptureNotUsed = { file: string; reason: 'taken_without_two_hops' };

/**
 * The captures a quote may be paired with: those taken with two hops. A capture taken without them holds no
 * stock-to-stock pool, so its two routes are one route and its gain would read as a measured zero. It is named and
 * left out, and no quote is paired with it.
 */
export function usableCaptures<C extends { file: string; twoHop: boolean }>(
  captures: readonly C[],
): { usable: C[]; notUsed: CaptureNotUsed[] } {
  return {
    usable: captures.filter((c) => c.twoHop),
    notUsed: captures
      .filter((c) => !c.twoHop)
      .map((c) => ({ file: c.file, reason: 'taken_without_two_hops' })),
  };
}

/**
 * Each quote that holds an amount and no error goes to the capture nearest in time, when that capture is within the
 * window (the earlier capture in the list keeps a tie). `unpaired` counts the quotes with no capture in the window,
 * `withoutAQuote` the rows Jupiter answered with an error or no amount: those are never paired.
 */
export function pairQuotes<C extends { fetchedAt: string }>(
  quotes: readonly StoredQuote[],
  captures: readonly C[],
  windowMs = PAIR_WINDOW_MS,
): { pairs: Array<{ quote: StoredQuote; capture: C }>; unpaired: number; withoutAQuote: number } {
  const times = captures.map((c) => Date.parse(c.fetchedAt));
  const pairs: Array<{ quote: StoredQuote; capture: C }> = [];
  let unpaired = 0;
  let withoutAQuote = 0;
  for (const quote of quotes) {
    if (quote.error || !(Number(quote.outAmount) > 0)) {
      withoutAQuote++;
      continue;
    }
    const tq = Date.parse(quote.fetchedAt);
    let best = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    times.forEach((t, i) => {
      const gap = Math.abs(t - tq);
      if (gap <= windowMs && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    });
    if (best < 0) unpaired++;
    else pairs.push({ quote, capture: captures[best] as C });
  }
  return { pairs, unpaired, withoutAQuote };
}

/** One hop of Jupiter's route, as this capture sees it. */
export type JupiterHop = {
  pool: string;
  label: string;
  /**
   * Percent of the quote through this hop when it trades the stock itself: of the stock sold (sale) or of the stock
   * received (purchase). Null on an onward hop of a path (SOL to dollars, say), and on every hop of a route whose
   * stock hops could not be told apart.
   */
  sharePct: number | null;
  /** The pool is one this capture models for the asset: its dollar and SOL pools, its stock-to-stock pools, and the via tokens' own pools. */
  modelled: boolean;
};

export type GapRow = {
  asset: string;
  assetMint: string;
  side: 'sell' | 'buy';
  /** The size the collector asked for; the amount routed is the quote's own `amountIn`, to a few raw units. */
  notionalUsd: number;
  /** When Jupiter gave the quote, and when the capture it is compared with was read. */
  quoteFetchedAt: string;
  captureFetchedAt: string;
  /** What the quote row and the capture say they are; null for a quote row that says nothing. */
  quoteProvenance: string | null;
  captureProvenance: string;
  /** What `jupiter`, `oneHop` and `twoHop` count: USD received for a sale, whole tokens received for a purchase. */
  unit: 'usd' | 'tokens';
  /** USDC delivered for a sale, tokens for the USDC paid for a purchase. */
  jupiter: number;
  /** Our router on the capture's dollar and SOL pools. A SOL pool's dollars are the SOL at the capture's SOL price. */
  oneHop: number;
  /** The same route, free to send chunks through the asset's stock-to-stock pools as well. */
  twoHop: number;
  /**
   * (jupiter ÷ ours − 1) × 10,000: positive when Jupiter returns more than our router. Ours has no cost for the SOL
   * to USDC step, so where our route uses SOL pools the gap reads lower than it is, and it can read negative.
   */
  gapOneHopBp: number;
  gapTwoHopBp: number;
  /**
   * gapOneHopBp − gapTwoHopBp: positive when the two-hop route returns more than the one-hop route. That closes part
   * of a positive gap; where the gap is already negative (ours above Jupiter) it moves it further from zero. It
   * compares our two routes, not ours with Jupiter's: zero when the two return the same, whatever Jupiter returns.
   */
  gainBp: number;
  /** The legs of the two-hop route that go through a stock-to-stock pool; empty when none took an amount. */
  twoHopLegs: RouteLeg[];
  /**
   * Every pool of Jupiter's route is one this capture models for the asset. False for a quote stored with no route,
   * and for every route with a SOL leg: the venue Jupiter uses for SOL to USDC is never modelled. It says where
   * Jupiter went, not that both sides used the same pools: our router still splits over all its pools.
   */
  jupiterWithinModelledPools: boolean;
  jupiterRoute: JupiterHop[];
};

/** A paired quote that gives no gap, with the reason. */
export type GapSkipped = {
  skipped:
    | 'asset_not_in_capture'
    | 'asset_outside_the_capture_selection'
    | 'two_hop_pools_not_read'
    | 'asset_pools_not_read_whole'
    | 'side_not_sell_or_buy'
    | 'quote_has_no_amount'
    | 'our_route_returns_nothing';
  asset: string;
};

export const isGap = (g: GapRow | GapSkipped): g is GapRow => !('skipped' in g);

/** The reference pool as `routeTrade` picks it: the largest by TVL, the earlier one on a tie. */
const largest = (pools: readonly RoutePool[]) =>
  [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0] as RoutePool;

/**
 * The share of the quote through each hop that trades the stock itself, null for the other hops. The stored hop has
 * no mints, so the stock's hops are found by amount: a sale's are the hops whose `inAmount` add up to the quote's
 * `amountIn`, a purchase's the hops whose `outAmount` add up to its `outAmount` (raw units, exactly). Null when no
 * set of hops adds up, or more than one does: nothing is guessed.
 */
export function stockShares(q: StoredQuote): Array<number | null> | null {
  const route = q.route ?? [];
  if (!route.length || route.length > MAX_HOPS) return null;
  const sell = q.side === 'sell';
  const raw = [
    sell ? q.amountIn : q.outAmount,
    ...route.map((h) => (sell ? h.inAmount : h.outAmount)),
  ];
  if (!raw.every((s): s is string => typeof s === 'string' && /^\d+$/.test(s))) return null;
  const [target, ...amounts] = raw.map((s) => BigInt(s)) as [bigint, ...bigint[]];
  if (target <= 0n) return null;
  let found = 0;
  let sets = 0;
  for (let mask = 1; mask < 1 << amounts.length; mask++) {
    let sum = 0n;
    amounts.forEach((a, i) => {
      if (mask & (1 << i)) sum += a;
    });
    if (sum === target) {
      found = mask;
      sets++;
    }
  }
  if (sets !== 1) return null;
  return amounts.map((a, i) => (found & (1 << i) ? (Number(a) / Number(target)) * 100 : null));
}

/**
 * One paired quote against the router on one capture and what `buildSplit` built from it, both routes cut in `chunks`
 * chunks. A sale routes the quote's own amount of the stock and compares dollars; a purchase routes the quote's
 * dollars and compares tokens, ours being the route's USD at the reference mid it was valued at. The sale's amount is
 * exact to a few raw units, not to the unit: it goes in as a float notional (the amount at the capture's reference
 * mid, which the router divides by the same mid) and each leg is floored to raw units.
 *
 * A capture cut to some stocks holds only part of the stock-to-stock pools of the others, so their two-hop route is
 * not the whole one: a quote of a stock outside the selection gives no gap (`twoHopWholeFor`, by the capture's own
 * symbol for the mint).
 *
 * What the gap contains is said at the top of this file: our side has no cost for the SOL to USDC step, Jupiter's is
 * USDC, so the gap reads lower than it is wherever our route uses SOL pools. The gain compares our two routes, both
 * counted our way: it is not a comparison with Jupiter, whose amount only scales it.
 */
export function gapOf(
  q: StoredQuote,
  capture: SplitCapture,
  built: BuiltSplit,
  chunks = ROUTE_CHUNKS,
): GapRow | GapSkipped {
  const a = built.byAsset.get(q.assetMint);
  if (!a?.pools.length) return { skipped: 'asset_not_in_capture', asset: q.asset };
  if (!twoHopWholeFor(capture, a.symbol))
    return { skipped: 'asset_outside_the_capture_selection', asset: q.asset };
  // A stock-to-stock pool of this stock that was not read, or whose second hop was not, is not a pool that gained
  // nothing: the two-hop route of this pair was not measured. A via token that is not tracked is the rule, and stays.
  if (built.notRouted.some((n) => n.assetMint === q.assetMint && n.reason !== 'via_not_tracked'))
    return { skipped: 'two_hop_pools_not_read', asset: q.asset };
  // One of the stock's own dollar or SOL pools came back without an array or its fee config: it is still routed, as
  // the snapshot always has, with depth or a fee it does not have. That is no figure to set against Jupiter.
  if (!readWholeIn(capture, a.pools))
    return { skipped: 'asset_pools_not_read_whole', asset: q.asset };
  if (q.side !== 'sell' && q.side !== 'buy')
    return { skipped: 'side_not_sell_or_buy', asset: q.asset };
  const sell = q.side === 'sell';
  const ref = largest(a.pools);
  const dec = ref.decAsset;
  const jupiter = Number(q.outAmount) / 10 ** (sell ? USDC_DECIMALS : dec);
  if (!(jupiter > 0)) return { skipped: 'quote_has_no_amount', asset: q.asset };
  const notional = sell
    ? (Number(q.amountIn) / 10 ** dec) * ref.midUsd
    : Number(q.amountIn) / 10 ** USDC_DECIMALS;
  const one = routeTrade(a.pools, notional, q.side, chunks);
  const two = routeTrade(a.pools, notional, q.side, chunks, { pools: a.twoHop, via: built.via });
  // a sale's amount is the notional over the router's own reference mid: it has to be the pool taken here
  if (one.refPool !== ref.pool || two.refPool !== ref.pool)
    throw new Error(`routing-gap: ${q.asset}: the router's reference pool is not ${ref.pool}`);
  const oneHop = sell ? one.outUsd : one.outUsd / one.refMidUsd;
  const twoHop = sell ? two.outUsd : two.outUsd / two.refMidUsd;
  if (!(oneHop > 0) || !(twoHop > 0))
    return { skipped: 'our_route_returns_nothing', asset: q.asset };
  const gapOneHopBp = (jupiter / oneHop - 1) * 10_000;
  const gapTwoHopBp = (jupiter / twoHop - 1) * 10_000;

  const modelled = new Set([
    ...a.pools.map((p) => p.pool),
    ...a.twoHop.map((p) => p.pool),
    ...a.twoHop.flatMap((p) => (built.via.get(p.via) ?? []).map((v) => v.pool)),
  ]);
  const route = q.route ?? [];
  const shares = stockShares(q);
  return {
    asset: q.asset,
    assetMint: q.assetMint,
    side: q.side,
    notionalUsd: q.notionalUsd,
    quoteFetchedAt: q.fetchedAt,
    captureFetchedAt: capture.fetchedAt,
    quoteProvenance: q.provenance ?? null,
    captureProvenance: capture.provenance,
    unit: sell ? 'usd' : 'tokens',
    jupiter,
    oneHop,
    twoHop,
    gapOneHopBp,
    gapTwoHopBp,
    gainBp: gapOneHopBp - gapTwoHopBp,
    twoHopLegs: two.legs.filter((l) => l.via),
    jupiterWithinModelledPools: route.length > 0 && route.every((h) => modelled.has(h.pool)),
    jupiterRoute: route.map((h, i) => ({
      pool: h.pool,
      label: h.label ?? 'unknown',
      sharePct: shares ? (shares[i] ?? null) : null,
      modelled: modelled.has(h.pool),
    })),
  };
}

/** The middle value; of an even count, the mean of the two middle values. Null for no values. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export const mean = (xs: readonly number[]): number | null =>
  xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null;

const round = (x: number | null, digits: number) => (x === null ? null : Number(x.toFixed(digits)));

/** One figure over a set of pairs: the median and the mean, and the smallest and the largest beside them. */
export type Spread = {
  median: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
};

/** The gaps of one set of pairs, in basis points to two decimals. */
export type GapStats = {
  pairs: number;
  gapOneHopBp: Spread;
  gapTwoHopBp: Spread;
  gainBp: Spread;
  /** Share (0 to 1) of the pairs whose two-hop route sent an amount through a stock-to-stock pool. */
  twoHopUsedShare: number | null;
};

/** Where Jupiter's routes of one side and size go. */
export type RouteShares = {
  side: 'sell' | 'buy';
  notionalUsd: number;
  quotes: number;
  /** Quotes whose stock hops were told apart; the shares are means over these. */
  resolved: number;
  /** The stock's own hops by Jupiter's label and by whether we model the pool; `sharePct` adds up to 100. */
  byLabel: Array<{ label: string; modelled: boolean; sharePct: number; pools: string[] }>;
  /** Percent of the quoted amount that trades the stock in pools we do not model. */
  notModelledPct: number | null;
  /** The other hops of a path (the second hop of a route through SOL, say): how many quotes hold one. */
  onwardHops: Array<{ label: string; modelled: boolean; quotes: number; pools: string[] }>;
};

export type GapSummary = {
  bySideAndSize: Array<
    { side: 'sell' | 'buy'; notionalUsd: number } & GapStats & {
        /**
         * The same figures over the pairs where every pool of Jupiter's route is one we model. Not a comparison on
         * the same pools (our router still splits over all its pools), and no Jupiter route with a SOL leg is in it.
         */
        jupiterWithinModelledPools: GapStats;
      }
  >;
  byAsset: Array<{ asset: string; side: 'sell' | 'buy'; notionalUsd: number } & GapStats>;
  jupiterRoutes: RouteShares[];
};

const spread = (xs: readonly number[], digits: number): Spread => ({
  median: round(median(xs), digits),
  mean: round(mean(xs), digits),
  min: round(xs.length ? xs.reduce((m, x) => Math.min(m, x)) : null, digits),
  max: round(xs.length ? xs.reduce((m, x) => Math.max(m, x)) : null, digits),
});

const statsOf = (rows: readonly GapRow[]): GapStats => ({
  pairs: rows.length,
  gapOneHopBp: spread(
    rows.map((r) => r.gapOneHopBp),
    2,
  ),
  gapTwoHopBp: spread(
    rows.map((r) => r.gapTwoHopBp),
    2,
  ),
  gainBp: spread(
    rows.map((r) => r.gainBp),
    2,
  ),
  twoHopUsedShare: rows.length
    ? round(rows.filter((r) => r.twoHopLegs.length > 0).length / rows.length, 4)
    : null,
});

function routeShares(
  side: 'sell' | 'buy',
  notionalUsd: number,
  rows: readonly GapRow[],
): RouteShares {
  const resolved = rows.filter((r) => r.jupiterRoute.some((h) => h.sharePct !== null));
  const stock = new Map<
    string,
    { label: string; modelled: boolean; sum: number; pools: Set<string> }
  >();
  const onward = new Map<
    string,
    { label: string; modelled: boolean; quotes: number; pools: Set<string> }
  >();
  for (const r of resolved) {
    const seen = new Set<string>();
    for (const h of r.jupiterRoute) {
      const key = `${h.label}|${h.modelled}`;
      if (h.sharePct !== null) {
        const e = stock.get(key) ?? {
          label: h.label,
          modelled: h.modelled,
          sum: 0,
          pools: new Set(),
        };
        e.sum += h.sharePct;
        e.pools.add(h.pool);
        stock.set(key, e);
      } else {
        const e = onward.get(key) ?? {
          label: h.label,
          modelled: h.modelled,
          quotes: 0,
          pools: new Set(),
        };
        if (!seen.has(key)) e.quotes++;
        seen.add(key);
        e.pools.add(h.pool);
        onward.set(key, e);
      }
    }
  }
  const byLabel = [...stock.values()]
    .map((e) => ({
      label: e.label,
      modelled: e.modelled,
      sharePct: e.sum / resolved.length,
      pools: [...e.pools].sort(),
    }))
    .sort((x, y) => y.sharePct - x.sharePct || x.label.localeCompare(y.label));
  return {
    side,
    notionalUsd,
    quotes: rows.length,
    resolved: resolved.length,
    byLabel: byLabel.map((e) => ({ ...e, sharePct: round(e.sharePct, 2) as number })),
    notModelledPct: resolved.length
      ? round(
          byLabel.filter((e) => !e.modelled).reduce((t, e) => t + e.sharePct, 0),
          2,
        )
      : null,
    onwardHops: [...onward.values()]
      .map((e) => ({
        label: e.label,
        modelled: e.modelled,
        quotes: e.quotes,
        pools: [...e.pools].sort(),
      }))
      .sort((x, y) => y.quotes - x.quotes || x.label.localeCompare(y.label)),
  };
}

/**
 * The gaps by side and size (all pairs, and the pairs where Jupiter used only pools we model), by asset at each side
 * and size, and where Jupiter's routes go. Sales come before purchases, sizes smallest first, assets by name. Each
 * figure is the median and the mean with the smallest and the largest beside them.
 */
export function summarize(rows: readonly GapRow[]): GapSummary {
  const sides = ['sell', 'buy'] as const;
  const sizes = [...new Set(rows.map((r) => r.notionalUsd))].sort((a, b) => a - b);
  const assets = [...new Set(rows.map((r) => r.asset))].sort();
  const bySideAndSize: GapSummary['bySideAndSize'] = [];
  const byAsset: GapSummary['byAsset'] = [];
  const jupiterRoutes: RouteShares[] = [];
  for (const side of sides)
    for (const notionalUsd of sizes) {
      const group = rows.filter((r) => r.side === side && r.notionalUsd === notionalUsd);
      if (!group.length) continue;
      bySideAndSize.push({
        side,
        notionalUsd,
        ...statsOf(group),
        jupiterWithinModelledPools: statsOf(group.filter((r) => r.jupiterWithinModelledPools)),
      });
      jupiterRoutes.push(routeShares(side, notionalUsd, group));
    }
  for (const asset of assets)
    for (const side of sides)
      for (const notionalUsd of sizes) {
        const group = rows.filter(
          (r) => r.asset === asset && r.side === side && r.notionalUsd === notionalUsd,
        );
        if (group.length) byAsset.push({ asset, side, notionalUsd, ...statsOf(group) });
      }
  return { bySideAndSize, byAsset, jupiterRoutes };
}

/** What a row that states no provenance counts as: it is never read as live. */
export const PROVENANCE_NOT_STATED = 'not_stated';

/**
 * The distinct provenance values as one string, in alphabetical order: `live` only when every value is `live`. A
 * value that is missing counts as `not_stated`. Null for no values.
 */
export function provenanceOf(values: readonly (string | null | undefined)[]): string | null {
  const distinct = [...new Set(values.map((v) => v || PROVENANCE_NOT_STATED))].sort();
  return distinct.length ? distinct.join(', ') : null;
}

/** When the compared quotes were taken, how far from their captures, and what both say they are. */
export type Pairing = {
  /** `fetchedAt` of the first and of the last quote compared; null when none was. */
  first: string | null;
  last: string | null;
  /** Seconds between a compared quote and its capture, whichever came first: each gap holds the price move over them. */
  secondsApart: Spread;
  quotesBeforeCapture: number;
  quotesAfterCapture: number;
  /** Quotes taken at the capture's own millisecond: neither before nor after. */
  quotesAtCaptureTime: number;
  /** Of the quotes compared and of the captures they were compared with. */
  provenance: string | null;
};

/** The time span and the provenance of the pairs that gave a gap. Seconds are to the millisecond. */
export function pairingOf(rows: readonly GapRow[]): Pairing {
  const byTime = [...rows].sort(
    (a, b) => Date.parse(a.quoteFetchedAt) - Date.parse(b.quoteFetchedAt),
  );
  const quoteLessCaptureMs = rows.map(
    (r) => Date.parse(r.quoteFetchedAt) - Date.parse(r.captureFetchedAt),
  );
  return {
    first: byTime[0]?.quoteFetchedAt ?? null,
    last: byTime[byTime.length - 1]?.quoteFetchedAt ?? null,
    secondsApart: spread(
      quoteLessCaptureMs.map((ms) => Math.abs(ms) / 1000),
      3,
    ),
    quotesBeforeCapture: quoteLessCaptureMs.filter((ms) => ms < 0).length,
    quotesAfterCapture: quoteLessCaptureMs.filter((ms) => ms > 0).length,
    quotesAtCaptureTime: quoteLessCaptureMs.filter((ms) => ms === 0).length,
    provenance: provenanceOf(rows.flatMap((r) => [r.quoteProvenance, r.captureProvenance])),
  };
}
