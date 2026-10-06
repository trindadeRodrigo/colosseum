// PLAN-UNIVERSE RU.14 (gate EVM-HISTORY): thirty days of trades on Robinhood Chain, every pool of the
// cut. Quotes cannot be read at a past block on the public RPC; `Swap` events can, for the chain's
// whole life, in windows of 100,000 blocks. This file is the part with no I/O: the two decoders, the
// filters, the walk over block windows (a window the endpoint refuses for its log cap is halved), block
// times interpolated between headers, the hourly price of each pool with its quote in dollars, and the
// swap as the flow aggregation of `@colosseum/risk` counts it. The command is history-run.ts; the
// insert into risk_pool_flow is flow-import.ts.
import { TOPIC, words, wordToAddress, wordToInt } from './abi';
import type { ChainConfig } from './config';
import type { CutRow } from './cut';
import { blockWindows, type RawLog, tooManyLogs, ZERO_ADDRESS } from './discovery';
import { isTransient, type Rpc } from './rpc';

export const HISTORY_METHOD = 'history-evm-0.1';
/** Blocks per `eth_getLogs` query: the most the public endpoint allows (RU.2's probe). */
export const DEFAULT_WINDOW = 100_000;
/** Blocks between the headers a swap's time is interpolated from: 1 s off at most (the probe of Oct 6). */
export const DEFAULT_HEADER_STEP = 10_000;
/** The endpoint gave up on a window ("log query timed out", 2026-10-06): a smaller one answers. */
export const QUERY_TIMED_OUT = /timed out|timeout/i;
/** Log queries in one HTTP request: a halved busy window is heavy, and twelve in one request drew a 429. */
export const DEFAULT_BATCH = 2;
/** The waits before asking again when the endpoint cannot be reached; then the walk stops (it resumes). */
export const DEFAULT_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 300_000, 600_000, 600_000];
/** How long an hour with no swap keeps the last price of a pool for pricing another pool's quote. */
export const MAX_CARRY_HOURS = 24;

// ---------------------------------------------------------------------------------------------
// The pools of a walk
// ---------------------------------------------------------------------------------------------

/** One pool of the cut as the walk needs it. `address` is the v3 pool or the v4 pool id, lower case. */
export type HistoryPool = {
  address: string;
  kind: 'cl' | 'v4';
  /** The stock the cut files the pool under, in the registry's mixed case (the collector's spelling). */
  asset: string;
  symbol: string;
  /** The other side, lower case, and its symbol where the cut knows it. */
  other: string;
  otherSymbol: string | null;
  otherIsStock: boolean;
  tvlUsd: number | null;
  reachable: boolean;
  /** Token order is by address on both venues; the native token (address zero) sorts first. */
  assetIsToken0: boolean;
};

/**
 * Every pool of the cut's `pools` (the ranked pools of the tracked stocks, reachable or not: a log does
 * not care who can trade). A pool listed twice keeps its first listing: risk_pool_flow holds one stock
 * per pool.
 */
export function historyPools(
  cut: { chain: string; pools: CutRow[] },
  chain: ChainConfig,
): HistoryPool[] {
  if (cut.chain !== chain.id) throw new Error(`the cut is for ${cut.chain}, not ${chain.id}`);
  const seen = new Set<string>();
  const out: HistoryPool[] = [];
  for (const p of cut.pools) {
    const address = p.address.toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    if (p.kind !== 'cl' && p.kind !== 'v4')
      throw new Error(`${p.address}: unknown pool kind ${p.kind}`);
    out.push({
      address,
      kind: p.kind,
      asset: p.asset,
      symbol: p.symbol,
      other: p.other.toLowerCase(),
      otherSymbol: p.otherSymbol,
      otherIsStock: p.otherIsStock,
      tvlUsd: p.tvlUsd,
      reachable: p.reachable,
      assetIsToken0: p.asset.toLowerCase() < p.other.toLowerCase(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The decoders
// ---------------------------------------------------------------------------------------------

export type SwapLog = RawLog & { transactionHash: string; logIndex: string };

/** One swap as the chain logged it. Amounts keep the event's own sign convention (see `swapSides`). */
export type SwapRow = {
  pool: string;
  kind: 'cl' | 'v4';
  block: number;
  logIndex: number;
  tx: string;
  /** Unix seconds, interpolated between headers (`blockTime`); the day file's `.done` says how far off. */
  t: number;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  /** The fee the v4 pool reported for this swap (hundredths of a bip); null on v3. Recorded, never applied. */
  fee: number | null;
  sender: string;
};

const signed = (w: bigint, bits: number) => BigInt.asIntN(bits, w).toString();

/** A v3 pool's Swap: five words of data, the sender and the recipient in the topics. */
export function decodeV3Swap(log: SwapLog, t: number): SwapRow {
  if (log.topics[0] !== TOPIC.v3Swap || log.topics.length !== 3)
    throw new Error(`not a v3 Swap log: ${log.topics[0]}`);
  const w = words(log.data);
  if (w.length !== 5) throw new Error(`v3 Swap data has ${w.length} words, not 5`);
  return {
    pool: log.address.toLowerCase(),
    kind: 'cl',
    block: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    tx: log.transactionHash,
    t,
    amount0: signed(w[0] as bigint, 256),
    amount1: signed(w[1] as bigint, 256),
    sqrtPriceX96: (w[2] as bigint).toString(),
    liquidity: (w[3] as bigint).toString(),
    tick: wordToInt(w[4] as bigint, 24),
    fee: null,
    sender: wordToAddress(BigInt(log.topics[1] as string)),
  };
}

/** The pool manager's Swap: the pool id and the sender in the topics, six words of data. */
export function decodeV4Swap(log: SwapLog, t: number): SwapRow {
  if (log.topics[0] !== TOPIC.v4Swap || log.topics.length !== 3)
    throw new Error(`not a v4 Swap log: ${log.topics[0]}`);
  const w = words(log.data);
  if (w.length !== 6) throw new Error(`v4 Swap data has ${w.length} words, not 6`);
  return {
    pool: (log.topics[1] as string).toLowerCase(),
    kind: 'v4',
    block: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    tx: log.transactionHash,
    t,
    amount0: signed(w[0] as bigint, 128),
    amount1: signed(w[1] as bigint, 128),
    sqrtPriceX96: (w[2] as bigint).toString(),
    liquidity: (w[3] as bigint).toString(),
    tick: wordToInt(w[4] as bigint, 24),
    fee: Number(w[5] as bigint),
    sender: wordToAddress(BigInt(log.topics[2] as string)),
  };
}

/**
 * Which token went into the pool. v3 logs the pool's deltas (positive came in); v4 logs the swapper's
 * (negative went in). A swap with nothing on either side is refused.
 */
export function swapSides(s: Pick<SwapRow, 'kind' | 'amount0' | 'amount1'>): {
  zeroForOne: boolean;
  in0: bigint;
  in1: bigint;
} {
  const a0 = BigInt(s.amount0);
  const a1 = BigInt(s.amount1);
  const in0 = s.kind === 'cl' ? a0 : -a0;
  const in1 = s.kind === 'cl' ? a1 : -a1;
  if (in0 > 0n === in1 > 0n) throw new Error(`a swap with ${in0} of token 0 and ${in1} of token 1`);
  return { zeroForOne: in0 > 0n, in0, in1 };
}

// ---------------------------------------------------------------------------------------------
// The filters and the walk
// ---------------------------------------------------------------------------------------------

/** One `eth_getLogs` filter: every v3 pool in one address list, or the pool manager and the v4 ids. */
export type SwapFilter = {
  kind: 'cl' | 'v4';
  address: string | string[];
  topics: Array<string | string[]>;
};

export function swapFilters(chain: ChainConfig, pools: HistoryPool[]): SwapFilter[] {
  const out: SwapFilter[] = [];
  const cl = pools.filter((p) => p.kind === 'cl').map((p) => p.address);
  if (cl.length) out.push({ kind: 'cl', address: cl, topics: [TOPIC.v3Swap] });
  const v4 = pools.filter((p) => p.kind === 'v4').map((p) => p.address);
  if (v4.length) {
    const pm = chain.v4?.poolManager;
    if (!pm) throw new Error(`${chain.id}: v4 pools in the cut and no pool manager in config.ts`);
    out.push({ kind: 'v4', address: pm, topics: [TOPIC.v4Swap, v4] });
  }
  return out;
}

const hex = (n: number) => `0x${n.toString(16)}`;
export const logQuery = (f: SwapFilter, from: number, to: number) => ({
  method: 'eth_getLogs',
  params: [{ address: f.address, topics: f.topics, fromBlock: hex(from), toBlock: hex(to) }],
});

export type WalkDeps = {
  rpc: Rpc;
  sleep: (ms: number) => Promise<unknown>;
  log: (event: Record<string, unknown>) => void;
};

/** What one block window returned, every filter in. Rows carry no time yet (`t` is 0). */
export type WindowResult = {
  from: number;
  to: number;
  rows: SwapRow[];
  /** Queries made for this window, the halvings included. */
  queries: number;
  halvings: number;
};

/**
 * Every Swap of the filters between two blocks, one window at a time, newest first, so a stopped walk
 * has its newest days whole and resumes from the oldest window it finished. A window refused for the
 * number of logs is halved until it answers; any other refusal stops the walk with the message. Rows
 * of a window are sorted by block and log index. `onWindow` runs after each window, with the rows of
 * both filters.
 */
export async function walkSwaps(
  deps: WalkDeps,
  filters: SwapFilter[],
  from: number,
  to: number,
  opts: { window: number; pauseMs: number; batch?: number; backoffMs?: number[] },
  onWindow: (w: WindowResult) => Promise<void> | void,
): Promise<{ windows: number; queries: number; halvings: number; rows: number; backoffs: number }> {
  const windows = blockWindows(from, to, opts.window).reverse();
  const batch = opts.batch ?? DEFAULT_BATCH;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  let queries = 0;
  let halvings = 0;
  let rows = 0;
  let backoffs = 0;
  let transient = 0;
  /** One HTTP request; when the endpoint cannot be reached (rate, outage) the walk waits and asks again. */
  const ask = async (requests: ReturnType<typeof logQuery>[]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await deps.rpc.batch(requests);
      } catch (e) {
        const wait = backoff[attempt];
        if (wait === undefined) throw e;
        backoffs++;
        deps.log({
          event: 'backoff',
          attempt: attempt + 1,
          waitS: wait / 1000,
          error: e instanceof Error ? e.message : String(e),
        });
        await deps.sleep(wait);
      }
    }
  };
  for (const [a, b] of windows) {
    const jobs = filters.map((f) => ({ f, a, b }));
    const got: SwapRow[] = [];
    let wq = 0;
    let wh = 0;
    while (jobs.length) {
      const part = jobs.splice(0, batch);
      wq += part.length;
      const replies = await ask(part.map((j) => logQuery(j.f, j.a, j.b)));
      for (const [i, j] of part.entries()) {
        const r = replies[i];
        if (r?.error || !Array.isArray(r?.result)) {
          const message = r?.error?.message ?? 'no result';
          // refused for rate inside the reply (the client's own retries spent): asked again after a wait
          if (r && isTransient(r)) {
            const wait = backoff[Math.min(transient++, backoff.length - 1)] as number;
            backoffs++;
            deps.log({ event: 'backoff', attempt: transient, waitS: wait / 1000, error: message });
            await deps.sleep(wait);
            jobs.push(j);
            continue;
          }
          // too many logs, too large a reply, or too slow to answer: the same window, halved
          if ((tooManyLogs(message) || QUERY_TIMED_OUT.test(message)) && j.b > j.a) {
            const mid = j.a + Math.floor((j.b - j.a) / 2);
            jobs.push({ f: j.f, a: j.a, b: mid }, { f: j.f, a: mid + 1, b: j.b });
            wh++;
            continue;
          }
          throw new Error(`eth_getLogs ${j.a}..${j.b} refused: ${message}`);
        }
        for (const l of r.result as SwapLog[])
          got.push(j.f.kind === 'v4' ? decodeV4Swap(l, 0) : decodeV3Swap(l, 0));
      }
      if (jobs.length) await deps.sleep(opts.pauseMs);
    }
    got.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
    queries += wq;
    halvings += wh;
    rows += got.length;
    await onWindow({ from: a, to: b, rows: got, queries: wq, halvings: wh });
    deps.log({ event: 'window', from: a, to: b, rows: got.length, queries: wq, halvings: wh });
    await deps.sleep(opts.pauseMs);
  }
  return { windows: windows.length, queries, halvings, rows, backoffs };
}

// ---------------------------------------------------------------------------------------------
// Block times
// ---------------------------------------------------------------------------------------------

export type Header = { block: number; t: number };

/** Unix seconds of a block, linear between the two headers around it. Outside the headers is refused. */
export function blockTime(headers: Header[], block: number): number {
  let lo = 0;
  let hi = headers.length - 1;
  const first = headers[0];
  const last = headers[hi];
  if (!first || !last || block < first.block || block > last.block)
    throw new Error(`block ${block} is outside the headers read (${first?.block}..${last?.block})`);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((headers[mid] as Header).block <= block) lo = mid;
    else hi = mid;
  }
  const a = headers[lo] as Header;
  const b = headers[hi] as Header;
  if (a.block === block) return a.t;
  if (b.block === block) return b.t;
  return Math.round(a.t + ((b.t - a.t) * (block - a.block)) / (b.block - a.block));
}

/** The blocks whose exact time measures the interpolation: the middle of every `every`-th gap. */
export function errorProbePlan(headers: Header[], every: number): number[] {
  const out: number[] = [];
  for (let i = every; i < headers.length; i += every) {
    const a = headers[i - 1] as Header;
    const b = headers[i] as Header;
    if (b.block - a.block >= 2) out.push(a.block + Math.floor((b.block - a.block) / 2));
  }
  return out;
}

export const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * The UTC days a walk has whole: every block of the day is at or after the oldest block done (`firstT`
 * is its time) and the day ended at or before the head. The day the head is in is never complete.
 */
export function completeDays(firstT: number, headT: number): string[] {
  const out: string[] = [];
  for (let d = Math.ceil(firstT / 86_400) * 86_400; d + 86_400 <= headT; d += 86_400)
    out.push(dayOf(d));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Prices by the hour, and the quote in dollars
// ---------------------------------------------------------------------------------------------

const HOUR = 3600;
export const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR;
export const hourIso = (t: number) => new Date(hourStart(t) * 1000).toISOString();

/** Units of token 1 per unit of token 0, from sqrtPriceX96 and the two decimals. */
export function priceToken1PerToken0(
  sqrtPriceX96: string,
  decimals0: number,
  decimals1: number,
): number {
  const s = Number(BigInt(sqrtPriceX96)) / 2 ** 96;
  return s * s * 10 ** (decimals0 - decimals1);
}

/** The pool's price as "quote per asset", whichever side the asset is. */
export function quotePerAsset(
  sqrtPriceX96: string,
  m: { assetIsToken0: boolean; decimals0: number; decimals1: number },
): number {
  const p1per0 = priceToken1PerToken0(sqrtPriceX96, m.decimals0, m.decimals1);
  return m.assetIsToken0 ? p1per0 : 1 / p1per0;
}

export type PoolDecimals = { decimals0: number; decimals1: number };

/**
 * Decimals of the two sides. Stocks come from the issuer registry (`decimalsOf`), the dollar token from
 * config.ts; the native token and the wrapper the cut names `wrapped native` (the position manager's
 * WETH9(), read by discovery) are 18 by the EVM's definition. Anything else is unknown and the pool's
 * swaps stay unpriced.
 */
export function poolDecimals(
  p: HistoryPool,
  chain: ChainConfig,
  decimalsOf: (address: string) => number | undefined,
): PoolDecimals | null {
  const of = (address: string, symbol: string | null): number | undefined => {
    const a = address.toLowerCase();
    if (a === chain.dollar.address.toLowerCase()) return chain.dollar.decimals;
    if (a === ZERO_ADDRESS || symbol === 'wrapped native') return 18;
    return decimalsOf(a);
  };
  const da = of(p.asset, p.symbol);
  const dq = of(p.other, p.otherSymbol);
  if (da === undefined || dq === undefined) return null;
  return p.assetIsToken0 ? { decimals0: da, decimals1: dq } : { decimals0: dq, decimals1: da };
}

/** One pool's hour: the last price, the swaps, and what the quote token was worth. */
export type HourRow = {
  pool: string;
  asset: string;
  hour: string;
  /** Quote units per asset unit, the hour's last swap; carried from an earlier hour when `carriedHours` > 0. */
  quotePerAsset: number | null;
  carriedHours: number | null;
  swapsInHour: number;
  quoteUsd: number | null;
  quoteUsdMethod: string | null;
  depth2pctSellUsd: null;
};

/** What the hourly prices need of a pool's swaps: the last swap of each hour and how many there were. */
export type HourAccumulator = {
  last: Map<string, Map<number, { block: number; logIndex: number; sqrt: string }>>;
  counts: Map<string, Map<number, number>>;
};
export const newHourAccumulator = (): HourAccumulator => ({ last: new Map(), counts: new Map() });

/** Adds one swap to the accumulator, so a walk of millions of swaps is read once, pool by pool. */
export function accumulateHour(
  acc: HourAccumulator,
  s: Pick<SwapRow, 'pool' | 't' | 'block' | 'logIndex' | 'sqrtPriceX96'>,
): void {
  const h = hourStart(s.t);
  let m = acc.last.get(s.pool);
  if (!m) {
    m = new Map();
    acc.last.set(s.pool, m);
  }
  const have = m.get(h);
  if (!have || s.block > have.block || (s.block === have.block && s.logIndex > have.logIndex))
    m.set(h, { block: s.block, logIndex: s.logIndex, sqrt: s.sqrtPriceX96 });
  let c = acc.counts.get(s.pool);
  if (!c) {
    c = new Map();
    acc.counts.set(s.pool, c);
  }
  c.set(h, (c.get(h) ?? 0) + 1);
}

export type PricingInput = {
  pools: HistoryPool[];
  decimals: Map<string, PoolDecimals>;
  /** Swaps of every pool, any order; or the accumulator a streaming reader already filled. */
  swaps:
    | Iterable<Pick<SwapRow, 'pool' | 't' | 'block' | 'logIndex' | 'sqrtPriceX96'>>
    | HourAccumulator;
  /** The hours to write a row for, unix seconds of each hour's start, ascending. */
  hours: number[];
  dollar: string;
};

/** The stock's deepest pool against the dollar token: its price is the stock's price in dollars. */
export function dollarPoolOf(pools: HistoryPool[], dollar: string): Map<string, HistoryPool> {
  const d = dollar.toLowerCase();
  const out = new Map<string, HistoryPool>();
  for (const p of pools) {
    if (p.other !== d) continue;
    const have = out.get(p.asset.toLowerCase());
    if (!have || (p.tvlUsd ?? -1) > (have.tvlUsd ?? -1)) out.set(p.asset.toLowerCase(), p);
  }
  return out;
}

/**
 * The hourly rows of every pool. The hour's price is its last swap's; an hour without a swap carries
 * the last price for up to MAX_CARRY_HOURS, then has none. The quote in dollars: the dollar token at
 * par (`usdg_at_par` on Robinhood Chain); another stock at its own dollar pool's price that hour
 * (`implied_from_<pool>`); anything else (the native token, its wrapper) implied from this pool's own
 * price and the asset's dollar price that hour (`implied_from_<asset's dollar pool>`). An hour where
 * the reference has no price leaves the quote without a dollar value, and its swaps unpriced.
 */
export function hourlyRows(inp: PricingInput): HourRow[] {
  const dollar = inp.dollar.toLowerCase();
  const dollarPool = dollarPoolOf(inp.pools, dollar);
  // the last swap of each pool in each hour
  let acc: HourAccumulator;
  if ('last' in inp.swaps && 'counts' in inp.swaps) acc = inp.swaps;
  else {
    acc = newHourAccumulator();
    for (const s of inp.swaps) accumulateHour(acc, s);
  }
  const { last, counts } = acc;
  // each pool's price per hour, carried
  const price = new Map<string, Map<number, { v: number; carried: number }>>();
  for (const p of inp.pools) {
    const d = inp.decimals.get(p.address);
    const m = new Map<number, { v: number; carried: number }>();
    price.set(p.address, m);
    if (!d) continue;
    let lastV: number | null = null;
    let lastH = 0;
    for (const h of inp.hours) {
      const sw = last.get(p.address)?.get(h);
      if (sw) {
        lastV = quotePerAsset(sw.sqrt, { assetIsToken0: p.assetIsToken0, ...d });
        lastH = h;
      }
      if (lastV !== null) {
        const carried = (h - lastH) / HOUR;
        if (carried <= MAX_CARRY_HOURS) m.set(h, { v: lastV, carried });
      }
    }
  }
  const usdOfStock = (asset: string, h: number): { v: number; pool: string } | null => {
    const dp = dollarPool.get(asset.toLowerCase());
    if (!dp) return null;
    const v = price.get(dp.address)?.get(h)?.v;
    return v === undefined ? null : { v, pool: dp.address };
  };
  const out: HourRow[] = [];
  for (const p of inp.pools) {
    for (const h of inp.hours) {
      const own = price.get(p.address)?.get(h) ?? null;
      let quoteUsd: number | null = null;
      let method: string | null = null;
      if (p.other === dollar) {
        quoteUsd = 1;
        method = 'usdg_at_par';
      } else if (p.otherIsStock) {
        const r = usdOfStock(p.other, h);
        if (r) {
          quoteUsd = r.v;
          method = `implied_from_${r.pool}`;
        }
      } else if (own) {
        const r = usdOfStock(p.asset, h);
        if (r && own.v > 0) {
          quoteUsd = r.v / own.v;
          method = `implied_from_${r.pool}`;
        }
      }
      out.push({
        pool: p.address,
        asset: p.asset,
        hour: new Date(h * 1000).toISOString(),
        quotePerAsset: own?.v ?? null,
        carriedHours: own ? own.carried : null,
        swapsInHour: counts.get(p.address)?.get(h) ?? 0,
        quoteUsd,
        quoteUsdMethod: method,
        depth2pctSellUsd: null,
      });
    }
  }
  return out;
}

/** The hours of a span, each hour's start in unix seconds, the hour of `to` included. */
export function hoursOf(from: number, to: number): number[] {
  const out: number[] = [];
  for (let h = hourStart(from); h <= hourStart(to); h += HOUR) out.push(h);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The swap as the flow counts it
// ---------------------------------------------------------------------------------------------

/**
 * A sell sends the stock into the pool. `quote` is the quote-leg amount in token units, whichever way
 * it moved (`@colosseum/risk`'s `FlowSwap`; its USD is the hour's `quoteUsd` × this).
 */
export function flowSwap(
  s: Pick<SwapRow, 'kind' | 'amount0' | 'amount1' | 't'>,
  m: { assetIsToken0: boolean } & PoolDecimals,
): { t: number; side: 'sell' | 'buy'; quote: number } {
  const { zeroForOne, in0, in1 } = swapSides(s);
  const sell = m.assetIsToken0 === zeroForOne;
  const raw = m.assetIsToken0 ? in1 : in0;
  const dec = m.assetIsToken0 ? m.decimals1 : m.decimals0;
  const quote = Math.abs(Number(raw)) / 10 ** dec;
  return { t: s.t, side: sell ? 'sell' : 'buy', quote };
}
