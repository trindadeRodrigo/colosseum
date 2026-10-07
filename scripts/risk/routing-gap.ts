import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GapRow, StoredQuote } from './lib-routing-gap';

// Step 3 report: Jupiter quote vs our best single-pool simulation at the nearest pool snapshot (≤ 5 min).
// gap = Jupiter output ÷ simulated output − 1 (sell side, USD). gap > 0: routing across pools adds depth
// (our curves are a lower bound, as documented). gap < −FLAG: the simulation overstates depth → investigate.
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const FLAG = Number(process.env.RISK_GAP_FLAG ?? 0.002);
const read = (dir: string) =>
  existsSync(join(HOME, dir))
    ? readdirSync(join(HOME, dir))
        .filter((n) => n.endsWith('.jsonl'))
        .flatMap((n) =>
          readFileSync(join(HOME, dir, n), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        )
    : [];
// `--router`: the router's own gap on frozen pools (PLAN-UNIVERSE RU.11), at the end of this file. It prints its one
// JSON and ends here; without the flag nothing below is changed and nothing more is loaded.
if (process.argv.includes('--router')) {
  await routerReport();
  process.exit(0);
}
type Snap = {
  pool: string;
  assetMint: string;
  fetchedAt: string;
  exitPath: string;
  midUsd: number | null;
  sell: Array<{ notionalUsd: number; outUsd: number }> | null;
};
const snaps = (read('pools') as Snap[]).filter(
  (s) => s.sell && s.midUsd && s.exitPath === 'direct_usd',
);
// per asset and snapshot time: each pool's mid and sell curve
const byAssetTime = new Map<string, Map<string, Snap[]>>();
for (const s of snaps) {
  const a = byAssetTime.get(s.assetMint) ?? new Map<string, Snap[]>();
  a.set(s.fetchedAt, [...(a.get(s.fetchedAt) ?? []), s]);
  byAssetTime.set(s.assetMint, a);
}
// USD out of selling `units` through one pool: notional at the pool's own mid, cost interpolated in ln n
const outVia = (s: Snap, units: number): number | null => {
  const n = units * (s.midUsd as number);
  const pts = (s.sell ?? [])
    .map((p) => ({ n: p.notionalUsd, c: 1 - p.outUsd / p.notionalUsd }))
    .sort((x, y) => x.n - y.n);
  const hi = pts.findIndex((p) => p.n >= n);
  if (hi < 0) return null;
  let c: number;
  if (hi === 0 || pts[hi]?.n === n) c = pts[hi]?.c as number;
  else {
    const a = pts[hi - 1] as { n: number; c: number };
    const b = pts[hi] as { n: number; c: number };
    c = a.c + ((Math.log(n) - Math.log(a.n)) / (Math.log(b.n) - Math.log(a.n))) * (b.c - a.c);
  }
  return n * (1 - c);
};
type Q = {
  asset: string;
  assetMint: string;
  side: string;
  notionalUsd: number;
  amountIn: string;
  outAmount: string | null;
  fetchedAt: string;
  route: Array<{ pool: string; percent: number }> | null;
};
const quotes = (read('quotes') as Q[]).filter((q) => q.side === 'sell' && q.outAmount);
const rows: Array<{ asset: string; n: number; gap: number; pools: number }> = [];
for (const q of quotes) {
  const a = byAssetTime.get(q.assetMint);
  if (!a) continue;
  const tq = Date.parse(q.fetchedAt);
  let nearest: string | null = null;
  for (const t of a.keys())
    if (
      Math.abs(Date.parse(t) - tq) <= 5 * 60_000 &&
      (!nearest || Math.abs(Date.parse(t) - tq) < Math.abs(Date.parse(nearest) - tq))
    )
      nearest = t;
  if (!nearest) continue;
  const units = Number(q.amountIn) / 1e8;
  const outs = (a.get(nearest) as Snap[])
    .map((s) => outVia(s, units))
    .filter((x): x is number => x !== null);
  if (!outs.length) continue;
  const simUsd = Math.max(...outs);
  rows.push({
    asset: q.asset,
    n: q.notionalUsd,
    gap: Number(q.outAmount) / 1e6 / simUsd - 1,
    pools: new Set((q.route ?? []).map((r) => r.pool)).size,
  });
}
const byAsset = new Map<string, number[]>();
for (const r of rows)
  byAsset.set(`${r.asset} $${r.n}`, [...(byAsset.get(`${r.asset} $${r.n}`) ?? []), r.gap]);
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] as number;
const report = [...byAsset.entries()].sort().map(([k, xs]) => ({
  key: k,
  samples: xs.length,
  medianGapPct: Number((median(xs) * 100).toFixed(3)),
  minGapPct: Number((Math.min(...xs) * 100).toFixed(3)),
}));
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      comparisons: rows.length,
      flagged: rows.filter((r) => r.gap < -FLAG).length,
      flagThresholdPct: FLAG * 100,
      note: 'xStocks have 8 decimals (amountIn / 1e8). gap > 0 = routing beats our best single pool (curves are conservative).',
      byAssetAndSize: report,
    },
    null,
    1,
  ),
);

/**
 * `pnpm risk:routing-gap --router <capture file or folder> [more ...] [--quotes <file>] [--chunks <n>]`
 * (PLAN-UNIVERSE RU.11). Each stored Jupiter quote against `routeTrade` on the pools of the capture nearest in time (a
 * file written by `pnpm risk:split-capture`; a folder means every capture in it), once with one hop and once with two.
 * Reads files only: no network, no database. The quotes are the collector's (RISK_HOME/quotes) unless `--quotes`
 * names a file. `--chunks` is the number of chunks both routes are cut in (the router's own when not given): it is
 * there to show how much of a measured gain depends on the chunk size.
 *
 * What is compared, and what is not:
 * - A capture taken without two hops is not used at all. Its two routes would be one route, and a gain of zero that
 *   nobody measured. It is named under `captures.notUsed` and no quote is paired with it.
 * - A capture cut to some stocks (`split-capture --only`) measures two hops for those stocks only. A quote of another
 *   stock is counted under `quotes.notCompared`, not compared.
 * - What a gap contains. Our side counts a SOL pool's dollars as the SOL at the capture's SOL price, with no cost for
 *   the SOL to USDC step; Jupiter's side is USDC delivered (a sale) or tokens for USDC paid (a purchase). Where our
 *   route uses SOL pools our side is overstated, so the gap reads lower than it is, and it can read negative. The gain
 *   (two hops against one hop on the same pools at the same price) is not a comparison with Jupiter: Jupiter's amount
 *   only scales it, by one part in ten thousand for each basis point of gap.
 */
async function routerReport() {
  const lib = await import('./lib-routing-gap');
  const { buildSplit, loadCapture } = await import('./lib-split');
  const { paths, quotesFile, chunks } = lib.parseRouterArgs(process.argv.slice(2));

  // first pass: when each capture was taken. A capture holds a few thousand accounts, so none is kept in memory here.
  const captures: Array<{ file: string; fetchedAt: string; twoHop: boolean }> = [];
  const notCaptures: string[] = [];
  for (const p of paths) {
    const inFolder = statSync(p).isDirectory();
    const files = inFolder
      ? readdirSync(p)
          .filter((n) => n.endsWith('.json.gz'))
          .sort()
          .map((n) => join(p, n))
      : [p];
    for (const file of files)
      try {
        const c = loadCapture(file);
        captures.push({ file, fetchedAt: c.fetchedAt, twoHop: c.twoHop });
      } catch (e) {
        // a file named on the command line has to be a capture; in a folder, anything else is passed over and named
        if (!inFolder) throw e;
        notCaptures.push(file);
      }
  }
  // a capture taken without two hops is named and left out: no quote is paired with it
  const { usable, notUsed } = lib.usableCaptures(captures);
  const quotes = quotesFile
    ? lib.parseQuotes(readFileSync(quotesFile, 'utf8'))
    : (read('quotes') as StoredQuote[]);
  const paired = lib.pairQuotes(quotes, usable, lib.PAIR_WINDOW_MS);

  // second pass: each capture that has quotes is read again and built once
  const rows: GapRow[] = [];
  const notCompared = new Map<string, number>();
  let poolsNotBuilt = 0;
  let twoHopDirectionsNotRouted = 0;
  let used = 0;
  for (const cap of usable) {
    const own = paired.pairs.filter((p) => p.capture === cap);
    if (!own.length) continue;
    used++;
    const capture = loadCapture(cap.file);
    const built = buildSplit(capture);
    poolsNotBuilt += built.failures.length;
    twoHopDirectionsNotRouted += built.notRouted.length;
    for (const { quote } of own) {
      const g = lib.gapOf(quote, capture, built, chunks);
      if (lib.isGap(g)) rows.push(g);
      else notCompared.set(g.skipped, (notCompared.get(g.skipped) ?? 0) + 1);
    }
  }
  const times = usable.map((c) => c.fetchedAt).sort();
  const pairing = lib.pairingOf(rows);
  const report = {
    checkedAt: new Date().toISOString(),
    method: lib.ROUTING_GAP_ROUTER_METHOD,
    source: `Jupiter quotes stored by the collector (${quotesFile ?? join(HOME, 'quotes')}); pools frozen by pnpm risk:split-capture, routed by routeTrade`,
    provenance: pairing.provenance,
    positiveGap:
      'Jupiter returns more than our router. gapBp = (Jupiter ÷ ours − 1) × 10,000: dollars received for a sale, tokens received for a purchase. gainBp = one-hop gap − two-hop gap: positive when the two-hop route returns more than the one-hop route. That closes part of a positive gap; where the gap is already negative it moves it further from zero.',
    jupiterWithinModelledPools:
      'In summary.bySideAndSize: the same figures over the pairs where every pool of Jupiter’s route is one we model. It is not a comparison on the same pools: our router still splits over all its pools. It leaves out every Jupiter route with a SOL leg, since the venue Jupiter uses for SOL to USDC is never modelled.',
    captures: {
      count: captures.length,
      first: times[0] ?? null,
      last: times[times.length - 1] ?? null,
      withQuotes: used,
      takenWithTwoHops: usable.length,
      poolsNotBuilt,
      twoHopDirectionsNotRouted,
      notCaptures,
      notUsed,
    },
    quotes: {
      read: quotes.length,
      withoutAQuote: paired.withoutAQuote,
      paired: paired.pairs.length,
      unpaired: paired.unpaired,
      compared: rows.length,
      notCompared: [...notCompared].map(([reason, n]) => ({ reason, quotes: n })),
      first: pairing.first,
      last: pairing.last,
    },
    pairing: {
      secondsApart: pairing.secondsApart,
      quotesBeforeCapture: pairing.quotesBeforeCapture,
      quotesAfterCapture: pairing.quotesAfterCapture,
      quotesAtCaptureTime: pairing.quotesAtCaptureTime,
    },
    windowMinutes: lib.PAIR_WINDOW_MS / 60_000,
    chunks,
    summary: lib.summarize(rows),
    note: 'Both routes use the same frozen pools, the same SOL price and the same amount, cut in the same number of chunks, so the difference between them (gainBp) is the two hops alone. What a gap contains: our side counts a SOL pool’s dollars as the SOL at the capture’s SOL price, with no cost for the SOL to USDC step, while Jupiter’s side is USDC delivered (a sale) or tokens for USDC paid (a purchase). Where our route uses SOL pools our side is overstated, so the gap reads lower than it is, and it can read negative. Each gap also holds the price move between the quote and the capture, up to the window: pairing.secondsApart says how far apart they were, and quotes.first and quotes.last when the quotes were taken. The gain is two hops against one hop on the same pools at the same price, both counted our way: it is not a comparison with Jupiter, and Jupiter’s amount only scales it, by one part in ten thousand for each basis point of gap. chunks is the number of equal parts both routes are cut in (--chunks; the router’s own number when not given). A pool wins a whole chunk or none, so a stock-to-stock pool too small to take one chunk (the size ÷ chunks) at a better price wins nothing: run again with another --chunks to see how much of a gain depends on it. captures.first and captures.last are of the captures taken with two hops; one taken without them is under captures.notUsed and no quote is paired with it. A capture cut to some stocks measures two hops for those stocks only: a quote of another stock is under quotes.notCompared. Each figure of the summary is the median and the mean, with the smallest and the largest beside them. A sale routes the quote’s own amount of the stock, exact to a few raw units; xStocks have 8 decimals and the quotes are against USDC. In jupiterRoutes, sharePct is the part of the quote that trades the stock in pools of that label, found from the stored amounts; onwardHops are the other hops of a path.',
  };
  await new Promise<void>((done) =>
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`, () => done()),
  );
}
