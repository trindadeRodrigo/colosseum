import {
  type AssetFacts,
  type FactNullReason,
  type FactUnit,
  fact,
  type MeasuredFact,
  missing,
} from '@colosseum/schemas';
import { quantileOf } from '../curves';
import type { PoolEvent } from '../events/logs';
import { REGIMES, type Regime } from '../time';

/**
 * Flow (PLAN-ANALYTICS item 16, part 1): volume, net sell pressure and turnover against depth, from the decoded swap
 * history of the value pools (Step 5b: successful transactions only) and the hourly state of each pool. Pure
 * functions over rows the caller read: no clock, no I/O.
 *
 *   A swap        one decoded swap event of the pool. A sell sends the stock into the pool; a buy takes it out.
 *   Its USD       the quote-leg amount × the hour's `quoteUsd` (USDC at par, other quotes implied from the asset's
 *                 USDC pool). An hour without a row, or a row without `quoteUsd`, leaves the swap unpriced: counted
 *                 in `swaps`, left out of every USD figure, and counted in `unpricedSwaps`.
 *   Windows       the last 24, 168 and 672 hours of the history, ending at the hour of its newest event.
 *   Turnover      (priced volume ÷ hourly rows of the regime in the window) ÷ the median ±2% sell depth of those rows.
 */
export const FLOW_METHOD_VERSION = 'flow-0.1';
export const FLOW_WINDOWS = { '24h': 24, '7d': 168, '28d': 672 } as const;
export type FlowWindow = keyof typeof FLOW_WINDOWS;
export const FLOW_WINDOW_NAMES = Object.keys(FLOW_WINDOWS) as FlowWindow[];
const HOUR_MS = 3_600_000;

export type FlowPoolMeta = {
  pool: string;
  assetIsToken0: boolean;
  decimals0: number;
  decimals1: number;
};
/** `quote`: the quote-leg amount in token units. `t`: unix seconds. */
export type FlowSwap = { t: number; side: 'sell' | 'buy'; quote: number };
/** One hourly row of a pool (Step 5b reconstruction); `hour` is the hour's start, ISO. */
export type FlowHour = {
  hour: string;
  regime: Regime;
  quoteUsd: number | null;
  depth2pctSellUsd: number | null;
};

/** The pool's swaps in one decoded transaction row; other events and other pools are ignored. */
export function swapsOfRow(
  row: { t: number; ev: PoolEvent[] | null },
  m: FlowPoolMeta,
): FlowSwap[] {
  const out: FlowSwap[] = [];
  for (const e of row.ev ?? []) {
    if (e.kind !== 'swap' || e.pool !== m.pool) continue;
    // zeroForOne: token 0 goes in. The stock goes in (a sell) when it is token 0 and zeroForOne, or token 1 and not.
    const sell = m.assetIsToken0 === e.zeroForOne;
    const quote = m.assetIsToken0
      ? Number(e.amount1) / 10 ** m.decimals1
      : Number(e.amount0) / 10 ** m.decimals0;
    out.push({ t: row.t, side: sell ? 'sell' : 'buy', quote });
  }
  return out;
}

/** Swaps of one pool summed by hour. */
export type FlowBucket = {
  hour: string;
  regime: Regime;
  swaps: number;
  sellSwaps: number;
  buySwaps: number;
  unpriced: number;
  sellUsd: number;
  buyUsd: number;
};

export const hourOf = (t: number) =>
  new Date(Math.floor((t * 1000) / HOUR_MS) * HOUR_MS).toISOString();

/** Adds one swap to its hour's bucket. The regime is the hourly row's; without a row, `regimeAt` of the swap. */
export function addSwap(
  buckets: Map<string, FlowBucket>,
  s: FlowSwap,
  hours: Map<string, FlowHour>,
  regimeAt: (t: number) => Regime,
): void {
  const hour = hourOf(s.t);
  const row = hours.get(hour);
  let b = buckets.get(hour);
  if (!b) {
    b = {
      hour,
      regime: row?.regime ?? regimeAt(s.t),
      swaps: 0,
      sellSwaps: 0,
      buySwaps: 0,
      unpriced: 0,
      sellUsd: 0,
      buyUsd: 0,
    };
    buckets.set(hour, b);
  }
  b.swaps++;
  if (s.side === 'sell') b.sellSwaps++;
  else b.buySwaps++;
  const q = row?.quoteUsd;
  if (q === null || q === undefined || !Number.isFinite(q)) {
    b.unpriced++;
    return;
  }
  if (s.side === 'sell') b.sellUsd += s.quote * q;
  else b.buyUsd += s.quote * q;
}

/** One pool's flow in one regime ('all': every regime) and one window. Sums, not yet facts. */
export type FlowAggregate = {
  regime: Regime | 'all';
  window: FlowWindow;
  /** Start of the window's first hour, and the newest event of the history. */
  from: string;
  to: string;
  swaps: number;
  sellSwaps: number;
  buySwaps: number;
  unpricedSwaps: number;
  sellUsd: number;
  buyUsd: number;
  /** Hourly rows of the pool in the regime and the window. */
  hours: number;
  /** Median ±2% sell depth over those rows; null without any. */
  medianDepthSellUsd: number | null;
};

/** The window ending at `to` (the newest event of the history): its last `n` hours, the newest hour included. */
export function flowWindow(to: string, window: FlowWindow): { from: string; to: string } {
  const last = Math.floor(Date.parse(to) / HOUR_MS) * HOUR_MS;
  return { from: new Date(last - (FLOW_WINDOWS[window] - 1) * HOUR_MS).toISOString(), to };
}

/** A pool's flow per window and per regime (and 'all'), from its hourly buckets and hourly rows. */
export function poolFlow(
  buckets: Iterable<FlowBucket>,
  hours: Iterable<FlowHour>,
  to: string,
): FlowAggregate[] {
  const bs = [...buckets];
  const hs = [...hours];
  const out: FlowAggregate[] = [];
  for (const window of FLOW_WINDOW_NAMES) {
    const w = flowWindow(to, window);
    const inWin = (hour: string) => hour >= w.from && hour <= w.to;
    for (const regime of [...REGIMES, 'all'] as const) {
      const pick = (r: Regime) => regime === 'all' || r === regime;
      const b = bs.filter((x) => inWin(x.hour) && pick(x.regime));
      const h = hs.filter((x) => inWin(x.hour) && pick(x.regime));
      const depths = h
        .map((x) => x.depth2pctSellUsd)
        .filter((x): x is number => x !== null && Number.isFinite(x));
      const sum = (k: keyof FlowBucket) => b.reduce((a, x) => a + (x[k] as number), 0);
      out.push({
        regime,
        window,
        ...w,
        swaps: sum('swaps'),
        sellSwaps: sum('sellSwaps'),
        buySwaps: sum('buySwaps'),
        unpricedSwaps: sum('unpriced'),
        sellUsd: sum('sellUsd'),
        buyUsd: sum('buyUsd'),
        hours: h.length,
        medianDepthSellUsd: depths.length ? quantileOf(depths, 0.5) : null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The sheet's block

type RowMeta = {
  source: string;
  method: string;
  methodVersion: string;
  provenance: MeasuredFact['provenance'];
};
export type FlowPoolRows = {
  pool: string;
  venue: string;
  /** Quote symbol, or its mint when the registry has no symbol. */
  quote: string;
  rows: FlowAggregate[];
};
export type FlowInput = RowMeta & { pools: FlowPoolRows[] };
type FlowBlock = NonNullable<AssetFacts['flow']>;
type FlowRow = Omit<FlowBlock['byRegime'][number], 'regime'>;

export const FLOW_NOT_COLLECTED =
  'swaps are counted for the 34 value pools of the Step 5b history (80% of xStock pool TVL); the collectors count swaps for every pool from Oct 12';
const HOLDERS_DETAIL =
  "the mint's token accounts and their owners: part 2 of item 16, a larger read from Mon Oct 5 (DA3)";

/** Sums of the asset's pools in one regime and window: hours are the most any pool has (they share one clock),
 *  depth is the sum of the pools' medians. */
function combine(rows: FlowAggregate[]) {
  const s = (k: 'swaps' | 'unpricedSwaps' | 'sellUsd' | 'buyUsd') =>
    rows.reduce((a, r) => a + r[k], 0);
  const withDepth = rows.filter((r) => r.medianDepthSellUsd !== null && r.hours > 0);
  return {
    swaps: s('swaps'),
    unpriced: s('unpricedSwaps'),
    sellUsd: s('sellUsd'),
    buyUsd: s('buyUsd'),
    hours: Math.max(0, ...rows.map((r) => r.hours)),
    depth: withDepth.length
      ? withDepth.reduce((a, r) => a + (r.medianDepthSellUsd as number), 0)
      : null,
    from: rows[0]?.from,
    to: rows[0]?.to,
  };
}

/**
 * The flow block of an asset sheet. `minSwaps`: priced swaps needed in a bucket before its USD figures are given.
 * Absent input: every fact is `not_collected` (the asset is not among the value pools).
 */
export function flowFacts(inp: FlowInput | null | undefined, minSwaps: number): FlowBlock {
  const holders = {
    top10Share: missing('not_collected', 'fraction', { detail: HOLDERS_DETAIL }),
    inWalletsShare: missing('not_collected', 'fraction', { detail: HOLDERS_DETAIL }),
    inLendingShare: missing('not_collected', 'fraction', { detail: HOLDERS_DETAIL }),
    inPoolsShare: missing('not_collected', 'fraction', { detail: HOLDERS_DETAIL }),
  };
  const none = (reason: FactNullReason, regime?: Regime, detail?: string): FlowRow => {
    const m = (unit: FactUnit) =>
      missing(reason, unit, { ...(regime ? { regime } : {}), ...(detail ? { detail } : {}) });
    return {
      volumeUsd: m('usd'),
      sellUsd: m('usd'),
      buyUsd: m('usd'),
      swaps: m('count'),
      netSellPressure: m('ratio'),
      turnoverPerHour: m('ratio'),
      unpricedSwaps: m('count'),
    };
  };
  if (!inp || inp.pools.length === 0) {
    const w = none('not_collected', undefined, FLOW_NOT_COLLECTED);
    return {
      window: null,
      byRegime: REGIMES.map((regime) => ({
        regime,
        ...none('not_collected', regime, FLOW_NOT_COLLECTED),
      })),
      byWindow: FLOW_WINDOW_NAMES.map((window) => ({ window, from: null, to: null, ...w })),
      byPool: [],
      holders,
    };
  }
  const f = (
    value: number,
    unit: FactUnit,
    c: { from: string; to: string },
    samples: number,
    quality: MeasuredFact['quality'],
    regime?: Regime,
    method = inp.method,
  ): MeasuredFact =>
    fact({
      value,
      unit,
      quality,
      ...(regime ? { regime } : {}),
      source: inp.source,
      method,
      methodVersion: inp.methodVersion,
      provenance: inp.provenance,
      fetchedAt: c.to,
      dataFrom: c.from,
      samples,
    });

  /** The facts of one bucket. `scope`: the asset (summed over its value pools, a lower bound for counts and USD)
   *  or one pool (measured). */
  const bucket = (
    rows: FlowAggregate[],
    regime: Regime | undefined,
    scope: 'asset' | 'pool',
  ): FlowRow => {
    const c = combine(rows);
    const ctx = { ...(regime ? { regime } : {}) };
    if (!c.from || !c.to) return none('not_collected', regime, FLOW_NOT_COLLECTED);
    const win = { from: c.from, to: c.to };
    const total: 'lower_bound' | 'measured' = scope === 'asset' ? 'lower_bound' : 'measured';
    const priced = c.swaps - c.unpriced;
    // the regime does not occur in the window (no hourly row, no swap): nothing was observed, not a zero
    if (c.hours === 0 && c.swaps === 0)
      return none(
        'no_samples_in_regime',
        regime,
        `no hourly row and no swap of the pool${scope === 'asset' ? 's' : ''} in this ${regime ? 'regime' : 'window'}`,
      );
    const counts = {
      swaps: f(c.swaps, 'count', win, c.swaps, total, regime),
      unpricedSwaps: f(c.unpriced, 'count', win, c.swaps, 'measured', regime),
    };
    // no hourly row in this regime and window: no price, no depth
    if (c.hours === 0) {
      const d = `${c.swaps} swaps; no hourly row of the pool${scope === 'asset' ? 's' : ''} in this ${regime ? 'regime' : 'window'}`;
      const n = (unit: FactUnit) => missing('no_samples_in_regime', unit, { ...ctx, detail: d });
      return {
        volumeUsd: n('usd'),
        sellUsd: n('usd'),
        buyUsd: n('usd'),
        netSellPressure: n('ratio'),
        turnoverPerHour: n('ratio'),
        ...counts,
      };
    }
    if (priced < minSwaps) {
      const d = `${priced} priced swaps (${c.unpriced} unpriced), ${minSwaps} needed`;
      const n = (unit: FactUnit) => missing('insufficient_samples', unit, { ...ctx, detail: d });
      return {
        volumeUsd: n('usd'),
        sellUsd: n('usd'),
        buyUsd: n('usd'),
        netSellPressure: n('ratio'),
        turnoverPerHour: n('ratio'),
        ...counts,
      };
    }
    const vol = c.sellUsd + c.buyUsd;
    const perHour = vol / c.hours;
    return {
      volumeUsd: f(vol, 'usd', win, priced, total, regime),
      sellUsd: f(c.sellUsd, 'usd', win, priced, total, regime),
      buyUsd: f(c.buyUsd, 'usd', win, priced, total, regime),
      netSellPressure:
        vol > 0
          ? f(
              (c.sellUsd - c.buyUsd) / vol,
              'ratio',
              win,
              priced,
              'measured',
              regime,
              `${inp.method}; (sell USD − buy USD) ÷ (sell USD + buy USD)`,
            )
          : missing('insufficient_samples', 'ratio', { ...ctx, detail: 'no priced volume' }),
      turnoverPerHour:
        c.depth !== null && c.depth > 0
          ? f(
              perHour / c.depth,
              'ratio',
              win,
              priced,
              'measured',
              regime,
              `${inp.method}; (USD volume ÷ ${c.hours} hourly rows) ÷ ${scope === 'asset' ? 'the sum of the pools’ median' : 'the median'} ±2% sell depth`,
            )
          : missing('no_samples_in_regime', 'ratio', {
              ...ctx,
              detail: 'no ±2% depth in the hourly rows',
            }),
      ...counts,
    };
  };
  const rowsOf = (regime: Regime | 'all', window: FlowWindow) =>
    inp.pools.flatMap((p) => p.rows.filter((r) => r.regime === regime && r.window === window));

  const all28 = rowsOf('all', '28d');
  const w28 = all28[0];
  const assetVol = all28.reduce((a, r) => a + r.sellUsd + r.buyUsd, 0);
  const assetPriced = all28.reduce((a, r) => a + r.swaps - r.unpricedSwaps, 0);
  return {
    window: w28 ? { from: w28.from, to: w28.to } : null,
    byRegime: REGIMES.map((regime) => ({
      regime,
      ...bucket(rowsOf(regime, '28d'), regime, 'asset'),
    })),
    byWindow: FLOW_WINDOW_NAMES.map((window) => {
      const rows = rowsOf('all', window);
      return {
        window,
        from: rows[0]?.from ?? null,
        to: rows[0]?.to ?? null,
        ...bucket(rows, undefined, 'asset'),
      };
    }),
    byPool: inp.pools.map((p) => {
      const r = p.rows.filter((x) => x.regime === 'all' && x.window === '28d');
      const b = bucket(r, undefined, 'pool');
      const v = b.volumeUsd.value;
      return {
        pool: p.pool,
        venue: p.venue,
        quote: p.quote,
        volume28dUsd: b.volumeUsd,
        swaps: b.swaps,
        unpricedSwaps: b.unpricedSwaps,
        share:
          v !== null && assetVol > 0 && w28
            ? f(
                v / assetVol,
                'fraction',
                w28,
                assetPriced,
                'measured',
                undefined,
                `${inp.method}; the pool's priced 28-day volume ÷ the asset's over its value pools`,
              )
            : missing(
                b.volumeUsd.value === null ? b.volumeUsd.reason : 'insufficient_samples',
                'fraction',
                {
                  detail: 'the pool or the asset has no priced 28-day volume',
                },
              ),
      };
    }),
    holders,
  };
}
