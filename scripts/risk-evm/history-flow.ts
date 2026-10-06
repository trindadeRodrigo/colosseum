// The swaps of a walk (history.ts) as risk_pool_flow rows: the hourly file of every pool, the swaps
// bucketed by hour with `@colosseum/risk`'s own `addSwap` and `poolFlow`, and the row per pool, regime
// and window under `flow-0.1`, the same aggregation Solana's Step 5b rows use. No I/O.
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
  flowSwap,
  HISTORY_METHOD,
  type HistoryPool,
  type HourRow,
  hourlyRows,
  hoursOf,
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
    unpricedReason: string | null;
    volume28dUsd: number;
  }>;
  dataTo: string;
};

/**
 * Every pool's rows. `span` is the walk's: hourly rows are written for each of its hours, so `hours`
 * counts the hours of the regime in the window, swaps or not. A swap seen twice (a walk resumed after a
 * crash) counts once. `to` is the newest swap of the walk, as in Solana's import.
 */
export function buildFlowRows(inp: {
  chain: ChainConfig;
  pools: HistoryPool[];
  decimals: Map<string, PoolDecimals>;
  swaps: SwapRow[];
  span: { fromT: number; headT: number };
  regimeAt: (t: number) => Regime;
  fetchedAt: Date;
}): FlowBuild {
  const seen = new Set<string>();
  const swaps: SwapRow[] = [];
  const duplicates = new Map<string, number>();
  for (const s of inp.swaps) {
    const key = `${s.tx}/${s.logIndex}`;
    if (seen.has(key)) {
      duplicates.set(s.pool, (duplicates.get(s.pool) ?? 0) + 1);
      continue;
    }
    seen.add(key);
    swaps.push(s);
  }
  const hours = hoursOf(inp.span.fromT, inp.span.headT);
  const hourly = hourlyRows({
    pools: inp.pools,
    decimals: inp.decimals,
    swaps,
    hours,
    dollar: inp.chain.dollar.address,
  });
  const newest = swaps.reduce((a, s) => Math.max(a, s.t), 0);
  const to = new Date((newest || inp.span.headT) * 1000).toISOString();
  const rows: FlowRow[] = [];
  const perPool: FlowBuild['perPool'] = [];
  const byPool = new Map<string, SwapRow[]>();
  for (const s of swaps) {
    let l = byPool.get(s.pool);
    if (!l) {
      l = [];
      byPool.set(s.pool, l);
    }
    l.push(s);
  }
  for (const p of inp.pools) {
    const d = inp.decimals.get(p.address);
    const hs = new Map<string, FlowHour>(
      hourly
        .filter((h) => h.pool === p.address)
        .map((h) => [
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
    const mine = byPool.get(p.address) ?? [];
    let unpriced = 0;
    for (const s of mine) {
      const f = d
        ? flowSwap(s, { assetIsToken0: p.assetIsToken0, ...d })
        : { t: s.t, side: 'buy' as const, quote: 0 };
      // a pool with unknown decimals has no priced hour: every swap counts, none is valued
      addSwap(buckets, f, d ? hs : new Map(), inp.regimeAt);
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
    for (const b of buckets.values()) unpriced += b.unpriced;
    const reason = !d
      ? 'quote_decimals_unknown'
      : unpriced > 0
        ? p.other === inp.chain.dollar.address.toLowerCase()
          ? 'unexpected'
          : 'no_dollar_price_for_the_quote_that_hour'
        : null;
    perPool.push({
      pool: p.address,
      symbol: p.symbol,
      quote: p.otherSymbol ?? p.other,
      kind: p.kind,
      swaps: mine.length,
      duplicates: duplicates.get(p.address) ?? 0,
      unpriced,
      unpricedReason: reason,
      volume28dUsd: Math.round((all?.sellUsd ?? 0) + (all?.buyUsd ?? 0)),
    });
  }
  return { rows, hourly, perPool, dataTo: to };
}
