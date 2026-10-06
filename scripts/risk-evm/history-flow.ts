// The swaps of a walk (history.ts) as risk_pool_flow rows: the hourly file of every pool, the swaps
// bucketed by hour with `@colosseum/risk`'s own `addSwap` and `poolFlow`, and the row per pool, regime
// and window under `flow-0.1`, the same aggregation Solana's Step 5b rows use. No I/O: the caller hands
// in a reader of each pool's swaps, read twice (the hourly prices need every pool's hours before any
// pool's swaps can be valued), so fifteen million swaps never sit in memory at once.
import {
  addSwap,
  FLOW_METHOD_VERSION,
  type FlowBucket,
  type FlowHour,
  poolFlow,
  type Regime,
} from '@colosseum/risk';
import type { ChainConfig } from './config';
import {
  accumulateHour,
  dollarPoolOf,
  flowSwap,
  HISTORY_METHOD,
  type HistoryPool,
  type HourRow,
  hourlyRows,
  hoursOf,
  newHourAccumulator,
  type PoolDecimals,
  type SwapRow,
} from './history';

export type FlowRow = {
  pool: string;
  assetMint: string;
  assetSymbol: string;
  regime: Regime | 'all';
  window: '24h' | '7d' | '28d';
  swaps: number;
  sellSwaps: number;
  buySwaps: number;
  unpricedSwaps: number;
  sellUsd: number;
  buyUsd: number;
  hours: number;
  medianDepthSellUsd: number | null;
  dataFrom: Date;
  dataTo: Date;
  methodVersion: string;
  source: string;
  method: string;
  fetchedAt: Date;
  provenance: 'live';
};

export const flowSource = (chain: ChainConfig) =>
  `${chain.name} Swap events (${HISTORY_METHOD}: eth_getLogs of the Uniswap v3 pools and the v4 pool manager, every pool of the cut) priced by their hourly file`;
export const FLOW_METHOD =
  "swap events of the pool; USD = quote-leg amount × the hour's quoteUsd (the dollar token at par, another stock at its own dollar pool's price that hour, the native token implied from this pool's price and the stock's dollar price); no depth: median_depth_sell_usd is null";

export type FlowBuild = {
  rows: FlowRow[];
  hourly: HourRow[];
  perPool: Array<{
    pool: string;
    symbol: string;
    quote: string;
    kind: 'cl' | 'v4';
    swaps: number;
    duplicates: number;
    unpriced: number;
    /** Swaps the event logged with nothing on either side (a v4 hook took them); counted, unvalued. */
    withoutSide: number;
    unpricedReason: string | null;
    volume28dUsd: number;
  }>;
  dataTo: string;
};

/** A swap's place in the chain, as a number: dedupes a resumed walk without a string per swap. */
const place = (s: Pick<SwapRow, 'block' | 'logIndex'>) => s.block * 1_000_000 + s.logIndex;

/**
 * Every pool's rows. `swapsOf` yields one pool's swaps (any order) and is called twice per pool.
 * `span` is the walk's: hourly rows are written for each of its hours, so `hours` counts the hours of
 * the regime in the window, swaps or not. A swap seen twice (a walk resumed after a crash) counts once.
 * `to` is the newest swap of the walk, as in Solana's import.
 */
export function buildFlowRows(inp: {
  chain: ChainConfig;
  pools: HistoryPool[];
  decimals: Map<string, PoolDecimals>;
  swapsOf: (pool: string) => Iterable<SwapRow>;
  span: { fromT: number; headT: number };
  regimeAt: (t: number) => Regime;
  fetchedAt: Date;
}): FlowBuild {
  const hours = hoursOf(inp.span.fromT, inp.span.headT);
  const dollarPools = dollarPoolOf(inp.pools, inp.chain.dollar.address);
  // first pass: the last swap of each hour of each pool, and the newest swap of the walk
  const acc = newHourAccumulator();
  const duplicates = new Map<string, number>();
  const counted = new Map<string, number>();
  let newest = 0;
  for (const p of inp.pools) {
    const seen = new Set<number>();
    let n = 0;
    let d = 0;
    for (const s of inp.swapsOf(p.address)) {
      if (s.pool !== p.address) continue;
      const k = place(s);
      if (seen.has(k)) {
        d++;
        continue;
      }
      seen.add(k);
      n++;
      accumulateHour(acc, s);
      if (s.t > newest) newest = s.t;
    }
    counted.set(p.address, n);
    duplicates.set(p.address, d);
  }
  const hourly = hourlyRows({
    pools: inp.pools,
    decimals: inp.decimals,
    swaps: acc,
    hours,
    dollar: inp.chain.dollar.address,
  });
  const to = new Date((newest || inp.span.headT) * 1000).toISOString();
  const hourlyByPool = new Map<string, HourRow[]>();
  for (const h of hourly) {
    let l = hourlyByPool.get(h.pool);
    if (!l) {
      l = [];
      hourlyByPool.set(h.pool, l);
    }
    l.push(h);
  }
  // second pass: each swap valued at its hour's quote, into the buckets, then the rows
  const rows: FlowRow[] = [];
  const perPool: FlowBuild['perPool'] = [];
  for (const p of inp.pools) {
    const d = inp.decimals.get(p.address);
    const hs = new Map<string, FlowHour>(
      (hourlyByPool.get(p.address) ?? []).map((h) => [
        h.hour,
        {
          hour: h.hour,
          regime: inp.regimeAt(Date.parse(h.hour) / 1000),
          quoteUsd: h.quoteUsd,
          depth2pctSellUsd: null,
        },
      ]),
    );
    const buckets = new Map<string, FlowBucket>();
    const seen = new Set<number>();
    let withoutSide = 0;
    for (const s of inp.swapsOf(p.address)) {
      if (s.pool !== p.address) continue;
      const k = place(s);
      if (seen.has(k)) continue;
      seen.add(k);
      let f: { t: number; side: 'sell' | 'buy'; quote: number } | null = null;
      if (d)
        try {
          f = flowSwap(s, { assetIsToken0: p.assetIsToken0, ...d });
        } catch {
          // a v4 hook can take the whole swap itself and the manager logs Swap(…, 0, 0, …): counted, unvalued
          withoutSide++;
        }
      // a pool with unknown decimals has no priced hour: every swap counts, none is valued
      addSwap(buckets, f ?? { t: s.t, side: 'buy', quote: 0 }, f ? hs : new Map(), inp.regimeAt);
    }
    const aggs = poolFlow(buckets.values(), hs.values(), to);
    for (const g of aggs)
      rows.push({
        pool: p.address,
        assetMint: p.asset,
        assetSymbol: p.symbol,
        regime: g.regime,
        window: g.window,
        swaps: g.swaps,
        sellSwaps: g.sellSwaps,
        buySwaps: g.buySwaps,
        unpricedSwaps: g.unpricedSwaps,
        sellUsd: g.sellUsd,
        buyUsd: g.buyUsd,
        hours: g.hours,
        medianDepthSellUsd: g.medianDepthSellUsd,
        dataFrom: new Date(g.from),
        dataTo: new Date(g.to),
        methodVersion: FLOW_METHOD_VERSION,
        source: flowSource(inp.chain),
        method: FLOW_METHOD,
        fetchedAt: inp.fetchedAt,
        provenance: 'live',
      });
    const all = aggs.find((g) => g.regime === 'all' && g.window === '28d');
    let unpriced = 0;
    for (const b of buckets.values()) unpriced += b.unpriced;
    const quoteStockHasDollarPool = !p.otherIsStock || dollarPools.has(p.other);
    const reason = !d
      ? 'quote_decimals_unknown'
      : unpriced === 0
        ? null
        : withoutSide === unpriced
          ? 'swap_without_a_side'
          : p.other === inp.chain.dollar.address.toLowerCase()
            ? withoutSide > 0
              ? 'swap_without_a_side_and_other'
              : 'unexpected'
            : !quoteStockHasDollarPool
              ? 'quote_stock_has_no_dollar_pool_in_the_cut'
              : 'no_dollar_price_for_the_quote_that_hour';
    perPool.push({
      pool: p.address,
      symbol: p.symbol,
      quote: p.otherSymbol ?? p.other,
      kind: p.kind,
      swaps: counted.get(p.address) ?? 0,
      duplicates: duplicates.get(p.address) ?? 0,
      unpriced,
      withoutSide,
      unpricedReason: reason,
      volume28dUsd: Math.round((all?.sellUsd ?? 0) + (all?.buyUsd ?? 0)),
    });
  }
  return { rows, hourly, perPool, dataTo: to };
}

/** A reader over an array, for tests and small walks. */
export const swapsFromArray = (swaps: SwapRow[]) => {
  const byPool = new Map<string, SwapRow[]>();
  for (const s of swaps) {
    let l = byPool.get(s.pool);
    if (!l) {
      l = [];
      byPool.set(s.pool, l);
    }
    l.push(s);
  }
  return (pool: string): Iterable<SwapRow> => byPool.get(pool) ?? [];
};
