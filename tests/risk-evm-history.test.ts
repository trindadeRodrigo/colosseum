import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createDb, riskPoolFlow } from '@colosseum/db';
import { defaultRegimeParams, type Regime, regimeAt } from '@colosseum/risk';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { TOPIC } from '../scripts/risk-evm/abi';
import { CHAINS, type ChainConfig } from '../scripts/risk-evm/config';
import { insertFlowRows } from '../scripts/risk-evm/flow-insert';
import {
  blockTime,
  completeDays,
  decodeV3Swap,
  decodeV4Swap,
  dollarPoolOf,
  flowSwap,
  type Header,
  type HistoryPool,
  hourlyRows,
  hoursOf,
  logQuery,
  type PoolDecimals,
  poolDecimals,
  quotePerAsset,
  type SwapLog,
  type SwapRow,
  swapFilters,
  swapSides,
  weightedMedian,
} from '../scripts/risk-evm/history';
import { buildFlowRows, swapsFromArray } from '../scripts/risk-evm/history-flow';
import { type Cursor, runHistory } from '../scripts/risk-evm/history-run';
import { replayRpc, requestKey } from '../scripts/risk-evm/replay';
import type { RpcReply, RpcRequest } from '../scripts/risk-evm/rpc';

// PLAN-UNIVERSE RU.14: thirty days of trades on Robinhood Chain. The fixture is a recorded quarter-day
// walk of seven pools (scripts/risk-evm/record-history-fixture.ts): every answer the endpoint gave,
// keyed by request, and the two halves of the newest window. No test calls the network.
type Fixture = {
  recordedAt: string;
  chain: string;
  pools: HistoryPool[];
  opts: { days: number; window: number; headerStep: number; probeEvery: number };
  summary: Record<string, unknown>;
  newestWindow: { from: number; to: number; mid: number };
  answers: Record<string, RpcReply>;
};
const fx = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk-evm/robinhood-history.json.gz')).toString(),
) as Fixture;
const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const dollar = robinhood.dollar.address.toLowerCase();
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const regimeOfT = (t: number): Regime => regimeAt(new Date(t * 1000), P);
const jsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** The logs of the recording with one topic, as the endpoint gave them. */
const recordedLogs = (topic0: string): SwapLog[] =>
  Object.values(fx.answers).flatMap((r) =>
    Array.isArray(r.result) ? (r.result as SwapLog[]).filter((l) => l.topics[0] === topic0) : [],
  );
const word = (data: string, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);

async function walk(
  override?: (r: RpcRequest) => RpcReply | undefined,
  root = mkdtempSync(join(tmpdir(), 'risk-evm-history-')),
) {
  const rpc = replayRpc(fx.answers, override);
  const events: Record<string, unknown>[] = [];
  const summary = await runHistory(
    { rpc, sleep: async () => {}, log: (e) => events.push(e), now: () => new Date(fx.recordedAt) },
    robinhood,
    fx.pools,
    root,
    fx.opts,
  );
  const cursor = JSON.parse(readFileSync(join(root, 'cursor.json'), 'utf8')) as Cursor;
  const swaps = fx.pools.flatMap((p) => {
    const d = join(root, 'swaps', p.address);
    return existsSync(d)
      ? readdirSync(d)
          .filter((f) => f.endsWith('.jsonl'))
          .flatMap((f) => jsonl<SwapRow>(join(d, f)))
      : [];
  });
  return { root, rpc, events, summary, cursor, swaps };
}

describe('the decoders (RU.14)', () => {
  it('a v3 Swap: five words read by hand, the sender from the first topic', () => {
    const log = recordedLogs(TOPIC.v3Swap)[0] as SwapLog;
    const s = decodeV3Swap(log, 1234);
    expect(s).toMatchObject({
      pool: log.address.toLowerCase(),
      kind: 'cl',
      block: Number(BigInt(log.blockNumber)),
      logIndex: Number(BigInt(log.logIndex)),
      tx: log.transactionHash,
      t: 1234,
      amount0: BigInt.asIntN(256, word(log.data, 0)).toString(),
      amount1: BigInt.asIntN(256, word(log.data, 1)).toString(),
      sqrtPriceX96: word(log.data, 2).toString(),
      liquidity: word(log.data, 3).toString(),
      tick: Number(BigInt.asIntN(24, word(log.data, 4))),
      fee: null,
      sender: `0x${(log.topics[1] as string).slice(26)}`,
    });
    expect(s.sender).toMatch(/^0x[0-9a-f]{40}$/);
    expect(() => decodeV4Swap(log, 0)).toThrow(/not a v4 Swap/);
  });

  it('a v4 Swap: the pool id from the first topic, six words, the fee last', () => {
    const log = recordedLogs(TOPIC.v4Swap)[0] as SwapLog;
    const s = decodeV4Swap(log, 99);
    expect(s).toMatchObject({
      pool: (log.topics[1] as string).toLowerCase(),
      kind: 'v4',
      amount0: BigInt.asIntN(128, word(log.data, 0)).toString(),
      amount1: BigInt.asIntN(128, word(log.data, 1)).toString(),
      sqrtPriceX96: word(log.data, 2).toString(),
      liquidity: word(log.data, 3).toString(),
      tick: Number(BigInt.asIntN(24, word(log.data, 4))),
      fee: Number(word(log.data, 5)),
      sender: `0x${(log.topics[2] as string).slice(26)}`,
    });
    expect(fx.pools.some((p) => p.address === s.pool)).toBe(true);
    expect(() => decodeV3Swap(log, 0)).toThrow(/not a v3 Swap/);
  });

  it('the sign conventions hold on the chain: a swap that sends token 0 in never raises the price', () => {
    // v3 logs the pool's deltas, v4 the swapper's; consecutive swaps of one pool prove which is which
    const byPool = new Map<string, SwapRow[]>();
    for (const l of recordedLogs(TOPIC.v3Swap)) {
      const s = decodeV3Swap(l, 0);
      byPool.set(s.pool, [...(byPool.get(s.pool) ?? []), s]);
    }
    for (const l of recordedLogs(TOPIC.v4Swap)) {
      const s = decodeV4Swap(l, 0);
      byPool.set(s.pool, [...(byPool.get(s.pool) ?? []), s]);
    }
    let pairs = 0;
    for (const rows of byPool.values()) {
      const seen = new Set<string>();
      const sorted = rows
        .filter((r) => !seen.has(`${r.tx}/${r.logIndex}`) && seen.add(`${r.tx}/${r.logIndex}`))
        .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      for (let i = 1; i < sorted.length; i++) {
        const before = BigInt((sorted[i - 1] as SwapRow).sqrtPriceX96);
        const after = BigInt((sorted[i] as SwapRow).sqrtPriceX96);
        const { zeroForOne } = swapSides(sorted[i] as SwapRow);
        if (zeroForOne) expect(after <= before).toBe(true);
        else expect(after >= before).toBe(true);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(1000);
    expect(byPool.size).toBeGreaterThanOrEqual(5);
  });

  it('a swap with both sides in, or neither, is refused', () => {
    expect(() => swapSides({ kind: 'cl', amount0: '1', amount1: '1' })).toThrow(/a swap with/);
    expect(() => swapSides({ kind: 'v4', amount0: '0', amount1: '0' })).toThrow(/a swap with/);
    expect(swapSides({ kind: 'cl', amount0: '5', amount1: '-3' })).toEqual({
      zeroForOne: true,
      in0: 5n,
      in1: -3n,
    });
    expect(swapSides({ kind: 'v4', amount0: '5', amount1: '-3' })).toEqual({
      zeroForOne: false,
      in0: -5n,
      in1: 3n,
    });
  });
});

describe('the filters and block times', () => {
  it('one address list for the v3 pools, the pool manager with the ids for v4', () => {
    const f = swapFilters(robinhood, fx.pools);
    const cl = fx.pools.filter((p) => p.kind === 'cl').map((p) => p.address);
    const v4 = fx.pools.filter((p) => p.kind === 'v4').map((p) => p.address);
    expect(f).toEqual([
      { kind: 'cl', address: cl, topics: [TOPIC.v3Swap] },
      { kind: 'v4', address: robinhood.v4?.poolManager, topics: [TOPIC.v4Swap, v4] },
    ]);
    expect(logQuery(f[0] as (typeof f)[0], 16, 31).params[0]).toMatchObject({
      fromBlock: '0x10',
      toBlock: '0x1f',
    });
  });

  it('interpolates between the headers and refuses a block outside them', () => {
    const headers: Header[] = [
      { block: 100, t: 1000 },
      { block: 200, t: 1010 },
      { block: 300, t: 1030 },
    ];
    expect(blockTime(headers, 100)).toBe(1000);
    expect(blockTime(headers, 150)).toBe(1005);
    expect(blockTime(headers, 275)).toBe(1025);
    expect(blockTime(headers, 300)).toBe(1030);
    expect(() => blockTime(headers, 99)).toThrow(/outside the headers/);
    expect(() => blockTime(headers, 301)).toThrow(/outside the headers/);
  });

  it('on the recording the interpolation is within a second of the blocks read exactly', async () => {
    const { root, cursor } = await walk();
    const rows = jsonl<Header & { exact?: boolean }>(join(root, 'headers.jsonl'));
    const headers = rows.filter((r) => !r.exact);
    const exact = rows.filter((r) => r.exact);
    expect(exact.length).toBeGreaterThanOrEqual(3);
    const errors = exact.map((e) => Math.abs(blockTime(headers, e.block) - e.t));
    expect(Math.max(...errors)).toBeLessThanOrEqual(1);
    expect(cursor.maxTimeErrorS).toBe(Math.max(...errors));
    // the headers are every headerStep blocks from the head, and the span's first block
    expect(headers.at(-1)?.block).toBe(cursor.head);
    expect(headers[0]?.block).toBe(cursor.from);
    expect((headers[2] as Header).block - (headers[1] as Header).block).toBe(fx.opts.headerStep);
  });

  it('a day is complete when the walk holds every block of it and the head is past its end', () => {
    const day = 86_400;
    // the oldest block done is 10 s into Oct 2; the head is 1 s into Oct 5
    const oct2 = Date.parse('2026-10-02T00:00:00Z') / 1000;
    expect(completeDays(oct2 + 10, oct2 + 3 * day + 1)).toEqual(['2026-10-03', '2026-10-04']);
    expect(completeDays(oct2, oct2 + 3 * day + 1)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(completeDays(oct2 + 10, oct2 + day)).toEqual([]);
    expect(completeDays(oct2 + 10, oct2 + 2 * day)).toEqual(['2026-10-03']);
  });
});

describe('the walk', () => {
  it('writes every swap of the recording to its pool and day, newest window first, and completes', async () => {
    const { events, summary, cursor, swaps, root } = await walk();
    expect(summary).toMatchObject({
      event: 'run',
      windows: 3,
      queries: 6,
      halvings: 0,
      rows: fx.summary.rows,
      unknownPools: [],
      complete: true,
    });
    expect(cursor).toMatchObject({
      chain: 'robinhood',
      method: 'history-evm-0.1',
      complete: true,
      oldestDone: cursor.from,
      oldestDoneT: cursor.fromT,
      pools: 7,
    });
    const windows = events.filter((e) => e.event === 'window').map((e) => e.to as number);
    expect(windows).toEqual([...windows].sort((a, b) => b - a));
    expect(swaps.length).toBe(fx.summary.rows);
    const keys = new Set(swaps.map((s) => `${s.tx}/${s.logIndex}`));
    expect(keys.size).toBe(swaps.length);
    for (const s of swaps) {
      expect(s.t).toBeGreaterThanOrEqual(cursor.fromT);
      expect(s.t).toBeLessThanOrEqual(cursor.headT);
      expect(fx.pools.some((p) => p.address === s.pool)).toBe(true);
    }
    // the span is a quarter of a day: no UTC day is whole, so no day is marked done
    const marks = fx.pools.flatMap((p) => {
      const d = join(root, 'swaps', p.address);
      return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.done')) : [];
    });
    expect(marks).toEqual([]);
    expect(completeDays(cursor.fromT, cursor.headT)).toEqual([]);
  });

  it('a window refused for its log cap is halved; the rows are the same', async () => {
    let refused = 0;
    const { from, to } = fx.newestWindow;
    const whole = requestKey(logQuery(swapFilters(robinhood, fx.pools)[0] as never, from, to));
    const { summary, swaps } = await walk((r) => {
      if (requestKey(r) === whole && refused === 0) {
        refused++;
        return { error: { message: 'logs matched by query exceeds limit of 10000' } };
      }
      return undefined;
    });
    expect(refused).toBe(1);
    expect(summary).toMatchObject({
      halvings: 1,
      queries: 8,
      rows: fx.summary.rows,
      complete: true,
    });
    expect(swaps.length).toBe(fx.summary.rows);
  });

  it('a window the endpoint timed out on is halved too, and an unreachable endpoint is waited out', async () => {
    const { from, to } = fx.newestWindow;
    const whole = requestKey(logQuery(swapFilters(robinhood, fx.pools)[1] as never, from, to));
    let timedOut = 0;
    let thrown = 0;
    const rpc = replayRpc(fx.answers, (r) => {
      if (requestKey(r) === whole && timedOut === 0) {
        timedOut++;
        return { error: { message: 'log query timed out' } };
      }
      return undefined;
    });
    const batch = rpc.batch;
    rpc.batch = async (requests) => {
      if (thrown === 0 && requests[0]?.method === 'eth_getLogs') {
        thrown++;
        throw new Error('RPC unreachable after 3 tries (HTTP 429)');
      }
      return batch(requests);
    };
    const waits: number[] = [];
    const root = mkdtempSync(join(tmpdir(), 'risk-evm-history-'));
    const events: Record<string, unknown>[] = [];
    const summary = await runHistory(
      {
        rpc,
        sleep: async (ms) => {
          waits.push(ms);
        },
        log: (e) => events.push(e),
        now: () => new Date(fx.recordedAt),
      },
      robinhood,
      fx.pools,
      root,
      fx.opts,
    );
    expect(timedOut).toBe(1);
    expect(summary).toMatchObject({
      halvings: 1,
      backoffs: 1,
      rows: fx.summary.rows,
      complete: true,
    });
    expect(events.find((e) => e.event === 'backoff')).toMatchObject({ attempt: 1, waitS: 30 });
    expect(waits).toContain(30_000);
    // a refusal for rate inside the reply is asked again after a wait, not halved and not fatal
    let limited = 0;
    const again = await walk((r) => {
      if (r.method === 'eth_getLogs' && limited === 0) {
        limited++;
        return { error: { code: 429, message: 'rate limit exceeded' } };
      }
      return undefined;
    });
    expect(limited).toBe(1);
    expect(again.summary).toMatchObject({
      halvings: 0,
      backoffs: 1,
      rows: fx.summary.rows,
      complete: true,
    });
  });

  it('any other refusal stops the walk; the next run resumes from the oldest window done', async () => {
    let windowsSeen = 0;
    const root = mkdtempSync(join(tmpdir(), 'risk-evm-history-'));
    await expect(
      walk((r) => {
        if (r.method !== 'eth_getLogs') return undefined;
        windowsSeen++;
        return windowsSeen > 2 ? { error: { message: 'plan limit reached' } } : undefined;
      }, root),
    ).rejects.toThrow(/refused: plan limit reached/);
    const stopped = JSON.parse(readFileSync(join(root, 'cursor.json'), 'utf8')) as Cursor;
    expect(stopped.complete).toBe(false);
    expect(stopped.oldestDone).toBe(fx.newestWindow.from);
    const resumed = await walk(undefined, root);
    expect(resumed.events[0]).toMatchObject({ event: 'resume', oldestDone: fx.newestWindow.from });
    expect(resumed.summary).toMatchObject({ windows: 2, complete: true });
    expect(resumed.swaps.length).toBe(fx.summary.rows);
    expect(new Set(resumed.swaps.map((s) => `${s.tx}/${s.logIndex}`)).size).toBe(fx.summary.rows);
    // a finished walk is not walked again
    const again = await walk(undefined, root);
    expect(again.summary).toMatchObject({ event: 'already_complete' });
    expect(again.rpc.asked).toEqual([]);
  });
});

describe('prices by the hour and the quote in dollars', () => {
  const A = '0x00000000000000000000000000000000000000aa';
  const B = '0x00000000000000000000000000000000000000bb';
  const ETH = '0x0000000000000000000000000000000000000000';
  const X = '0x00000000000000000000000000000000000000ee';
  const pool = (
    address: string,
    asset: string,
    other: string,
    extra: Partial<HistoryPool>,
  ): HistoryPool => ({
    address,
    kind: 'cl',
    asset,
    symbol: asset === A ? 'AAA' : 'BBB',
    other,
    otherSymbol: other === dollar ? 'USDG' : other === ETH ? 'native' : other === B ? 'BBB' : null,
    otherIsStock: other === B,
    tvlUsd: 1,
    reachable: true,
    assetIsToken0: asset < other,
    ...extra,
  });
  const pools = [
    pool('pa', A, dollar, { tvlUsd: 100 }),
    pool('pa2', A, dollar, { tvlUsd: 5 }), // shallower: not the dollar pool
    pool('pe', A, ETH, {}),
    pool('pb', B, dollar, {}),
    pool('px', A, X, { otherIsStock: false }), // a token nobody knows
    pool('pab', A, B, { otherIsStock: true }),
  ];
  const decimals = new Map<string, PoolDecimals>();
  for (const p of pools) {
    const d = poolDecimals(p, robinhood, (a) => (a === A || a === B ? 18 : undefined));
    if (d) decimals.set(p.address, d);
  }
  /** sqrtPriceX96 for `quote` units of the quote token per unit of the asset. */
  const sqrtFor = (quote: number, p: HistoryPool): string => {
    const d = decimals.get(p.address) ?? { decimals0: 18, decimals1: 18 };
    const p1per0 = p.assetIsToken0 ? quote : 1 / quote;
    const raw = p1per0 * 10 ** (d.decimals1 - d.decimals0);
    return BigInt(Math.round(Math.sqrt(raw) * 2 ** 48) * 2 ** 48).toString();
  };
  const h0 = Date.parse('2026-10-05T14:00:00Z') / 1000;
  const swap = (p: HistoryPool, t: number, quote: number, i: number): SwapRow => ({
    pool: p.address,
    kind: 'cl',
    block: Math.floor(t),
    logIndex: i,
    tx: `0x${i}`,
    t,
    amount0: '0',
    amount1: '0',
    sqrtPriceX96: sqrtFor(quote, p),
    liquidity: '0',
    tick: 0,
    fee: null,
    sender: A,
  });
  const [pa, , pe, pb, px, pab] = pools as [
    HistoryPool,
    HistoryPool,
    HistoryPool,
    HistoryPool,
    HistoryPool,
    HistoryPool,
  ];
  const swaps = [
    swap(pa, h0 + 60, 100, 1), // AAA at 100 dollars
    swap(pa, h0 + 120, 102, 2), // the hour's last swap wins
    swap(pe, h0 + 200, 0.05, 3), // AAA at 0.05 ETH: ETH is 102 / 0.05 dollars
    swap(pb, h0 + 300, 20, 4), // BBB at 20 dollars
    swap(pab, h0 + 400, 5, 5), // AAA at 5 BBB: the quote is BBB, 20 dollars
    swap(px, h0 + 500, 1, 6),
    swap(pa, h0 + 3600 * 2 + 10, 110, 7), // two hours later
  ];
  const hours = hoursOf(h0, h0 + 3600 * 27);

  it('decimals: the registry for stocks, config for the dollar, 18 for the native token, unknown otherwise', () => {
    expect(poolDecimals(pa, robinhood, () => 18)).toEqual({ decimals0: 18, decimals1: 6 });
    expect(pe.assetIsToken0).toBe(false);
    expect(poolDecimals(pe, robinhood, () => 18)).toEqual({ decimals0: 18, decimals1: 18 });
    expect(poolDecimals(px, robinhood, (a) => (a === A ? 18 : undefined))).toBeNull();
    expect(dollarPoolOf(pools, dollar).get(A)?.address).toBe('pa');
    expect(
      quotePerAsset(sqrtFor(100, pa), { assetIsToken0: true, decimals0: 18, decimals1: 6 }),
    ).toBeCloseTo(100, 6);
  });

  it('prices each hour from its last swap, carries it for a day, and prices the quote as the plan says', () => {
    const rows = hourlyRows({ pools, decimals, swaps, hours, dollar });
    const at = (p: string, k: number) =>
      rows.find((r) => r.pool === p && r.hour === new Date((h0 + k * 3600) * 1000).toISOString());
    expect(rows.length).toBe(pools.length * hours.length);
    expect(at('pa', 0)).toMatchObject({
      quotePerAsset: expect.closeTo(102, 6),
      carriedHours: 0,
      swapsInHour: 2,
      quoteUsd: 1,
      quoteUsdMethod: 'usdg_at_par',
      depth2pctSellUsd: null,
    });
    expect(at('pa', 1)).toMatchObject({ carriedHours: 1, swapsInHour: 0, quoteUsd: 1 });
    expect(at('pa', 2)).toMatchObject({ quotePerAsset: expect.closeTo(110, 6), carriedHours: 0 });
    expect(at('pa', 26)).toMatchObject({ quotePerAsset: expect.closeTo(110, 6), carriedHours: 24 });
    expect(at('pa', 27)).toMatchObject({ quotePerAsset: null, carriedHours: null, quoteUsd: 1 });
    // the native token: the chain's one price for the hour, implied by the pools that swapped in it
    expect(at('pe', 0)?.quoteUsd).toBeCloseTo(102 / 0.05, 4);
    expect(at('pe', 0)?.quoteUsdMethod).toBe('native_median_of_1_pools');
    // two hours on, no native pool swapped: the hour's price is carried, not re-implied from a carried price
    expect(at('pe', 2)?.quoteUsd).toBeCloseTo(102 / 0.05, 4);
    expect(at('pe', 2)?.quoteUsdMethod).toBe('native_median_of_1_pools_carried_2h');
    expect(at('pe', 27)).toMatchObject({ quoteUsd: null, quoteUsdMethod: null });
    // another stock: its own dollar pool
    expect(at('pab', 0)).toMatchObject({
      quoteUsd: expect.closeTo(20, 6),
      quoteUsdMethod: 'implied_from_pb',
    });
    // a token nobody knows: no decimals, no price, no dollar value
    expect(at('px', 0)).toMatchObject({ quotePerAsset: null, quoteUsd: null, swapsInHour: 1 });
  });

  it('a near-empty native pool pushed to an absurd price is valued at the market, not at itself', () => {
    const broken = pool('pbroken', A, ETH, { tvlUsd: 1 });
    const dec = new Map(decimals);
    dec.set('pbroken', poolDecimals(broken, robinhood, () => 18) as PoolDecimals);
    const rows = hourlyRows({
      pools: [...pools, broken],
      decimals: dec,
      swaps: [
        swap(pa, h0 + 60, 100, 1),
        swap(pe, h0 + 200, 0.05, 3), // AAA at 0.05 ETH: ETH is 2,000 dollars
        swap(broken, h0 + 300, 1e-30, 9), // AAA at 1e-30 ETH: ETH would be 10^32 dollars
      ],
      hours: hoursOf(h0, h0 + 3600),
      dollar,
    });
    const atH0 = (p: string) =>
      rows.find((r) => r.pool === p && r.hour === new Date(h0 * 1000).toISOString());
    // two pools with one swap each: the weighted median is the lower, the market's
    expect(atH0('pe')?.quoteUsd).toBeCloseTo(2000, 2);
    expect(atH0('pbroken')?.quoteUsd).toBeCloseTo(2000, 2);
    expect(atH0('pbroken')?.quoteUsdMethod).toBe('native_median_of_2_pools');
    expect(
      weightedMedian([
        { v: 1, w: 1 },
        { v: 1e32, w: 1 },
      ]),
    ).toBe(1);
    expect(
      weightedMedian([
        { v: 1, w: 1 },
        { v: 2, w: 5 },
        { v: 1e32, w: 1 },
      ]),
    ).toBe(2);
  });

  it('a swap as the flow counts it: the side by which token went in, the quote leg in units', () => {
    const m = { assetIsToken0: true, decimals0: 18, decimals1: 6 };
    // v3: the pool received 1 AAA (token 0 in) and gave 100 USDG: a sell of 1 for 100
    expect(
      flowSwap({ kind: 'cl', amount0: `${10n ** 18n}`, amount1: '-100000000', t: 1 }, m),
    ).toEqual({
      t: 1,
      side: 'sell',
      quote: 100,
    });
    // v4: the swapper paid 100 USDG (negative) and got 1 AAA: a buy for 100
    expect(
      flowSwap({ kind: 'v4', amount0: `${10n ** 18n}`, amount1: '-100000000', t: 2 }, m),
    ).toEqual({
      t: 2,
      side: 'buy',
      quote: 100,
    });
    // the asset as token 1 (the native pool): ETH in is a buy of the asset
    const me = { assetIsToken0: false, decimals0: 18, decimals1: 18 };
    expect(
      flowSwap({ kind: 'cl', amount0: `${5n * 10n ** 16n}`, amount1: `-${10n ** 18n}`, t: 3 }, me),
    ).toEqual({
      t: 3,
      side: 'buy',
      quote: 0.05,
    });
  });

  it('the flow rows, recomputed by hand', () => {
    const sells = [
      { ...swap(pa, h0 + 60, 100, 11), amount0: `${10n ** 18n}`, amount1: '-100000000' },
      { ...swap(pa, h0 + 120, 102, 12), amount0: `-${2n * 10n ** 18n}`, amount1: '204000000' },
      { ...swap(pa, h0 + 3600 * 30, 90, 13), amount0: `${10n ** 18n}`, amount1: '-90000000' },
      { ...swap(px, h0 + 500, 1, 14), amount0: '1', amount1: '-1' },
    ];
    const span = { fromT: h0 - 3600 * 700, headT: h0 + 3600 * 30 + 100 };
    const built = buildFlowRows({
      chain: robinhood,
      pools,
      decimals,
      swapsOf: swapsFromArray([...sells, sells[0] as SwapRow]), // one swap twice: a resumed walk
      span,
      regimeAt: regimeOfT,
      fetchedAt: new Date('2026-10-06T00:00:00Z'),
    });
    expect(built.rows.length).toBe(pools.length * 15);
    expect(built.dataTo).toBe(new Date((h0 + 3600 * 30) * 1000).toISOString());
    const row = (p: string, regime: string, window: string) =>
      built.rows.find((r) => r.pool === p && r.regime === regime && r.window === window);
    // 28 days: the three swaps of pa; 24 h: only the last (the window ends at the newest swap)
    expect(row('pa', 'all', '28d')).toMatchObject({
      assetMint: A,
      assetSymbol: 'AAA',
      swaps: 3,
      sellSwaps: 2,
      buySwaps: 1,
      unpricedSwaps: 0,
      sellUsd: 190,
      buyUsd: 204,
      hours: 672,
      medianDepthSellUsd: null,
      methodVersion: 'flow-0.1',
      provenance: 'live',
    });
    expect(row('pa', 'all', '24h')).toMatchObject({ swaps: 1, sellUsd: 90, buyUsd: 0, hours: 24 });
    // the hour of h0 is a Monday 14:00Z: US market hours; its regime row holds the first two swaps
    expect(regimeOfT(h0)).toBe('us_market_hours');
    expect(row('pa', 'us_market_hours', '28d')?.swaps).toBe(2);
    // a pool with unknown decimals: counted, never valued
    expect(row('px', 'all', '28d')).toMatchObject({
      swaps: 1,
      unpricedSwaps: 1,
      sellUsd: 0,
      buyUsd: 0,
    });
    expect(built.perPool.find((r) => r.pool === 'pa')).toMatchObject({
      duplicates: 1,
      unpriced: 0,
    });
    expect(built.perPool.find((r) => r.pool === 'px')).toMatchObject({
      unpriced: 1,
      unpricedReason: 'quote_decimals_unknown',
    });
    expect(row('pa', 'all', '28d')?.source).toMatch(
      /Robinhood Chain Swap events \(history-evm-0.1/,
    );
  });

  it('a swap the event logged with nothing on either side (a v4 hook took it) is counted, not fatal', () => {
    const hooked: SwapRow = {
      ...swap(pa, h0 + 60, 100, 21),
      kind: 'v4',
      amount0: '0',
      amount1: '0',
    };
    const sold: SwapRow = {
      ...swap(pa, h0 + 90, 100, 22),
      amount0: `${10n ** 18n}`,
      amount1: '-100000000',
    };
    const built = buildFlowRows({
      chain: robinhood,
      pools: [pa],
      decimals,
      swapsOf: swapsFromArray([hooked, sold]),
      span: { fromT: h0 - 3600, headT: h0 + 3600 },
      regimeAt: regimeOfT,
      fetchedAt: new Date('2026-10-06T00:00:00Z'),
    });
    const all = built.rows.find((r) => r.regime === 'all' && r.window === '28d');
    expect(all).toMatchObject({ swaps: 2, unpricedSwaps: 1, sellSwaps: 1, sellUsd: 100 });
    expect(built.perPool[0]).toMatchObject({
      swaps: 2,
      unpriced: 1,
      withoutSide: 1,
      unpricedReason: 'swap_without_a_side',
    });
  });
});

describe('the recording end to end', () => {
  it('prices the dollar pools at par, the native and stock quotes by implication, and the unknown token not at all', async () => {
    const { swaps, cursor } = await walk();
    const decimalsOf = (a: string) =>
      fx.pools.some((p) => p.asset.toLowerCase() === a) ? 18 : undefined;
    const decimals = new Map<string, PoolDecimals>();
    for (const p of fx.pools) {
      const d = poolDecimals(p, robinhood, decimalsOf);
      if (d) decimals.set(p.address, d);
    }
    const built = buildFlowRows({
      chain: robinhood,
      pools: fx.pools,
      decimals,
      swapsOf: swapsFromArray(swaps),
      span: { fromT: cursor.fromT, headT: cursor.headT },
      regimeAt: regimeOfT,
      fetchedAt: new Date(fx.recordedAt),
    });
    const by = (pick: (p: HistoryPool) => boolean) =>
      built.perPool.find((r) => pick(fx.pools.find((p) => p.address === r.pool) as HistoryPool));
    const nvdaUsd = by(
      (p) => p.symbol === 'NVDA' && p.other === dollar,
    ) as (typeof built.perPool)[0];
    expect(nvdaUsd.swaps).toBeGreaterThan(100);
    expect(nvdaUsd.unpriced).toBe(0);
    expect(nvdaUsd.volume28dUsd).toBeGreaterThan(10_000);
    expect(by((p) => p.symbol === 'NVDA' && p.otherSymbol === 'native')).toMatchObject({
      unpriced: 0,
    });
    expect(by((p) => p.symbol === 'NVDA' && p.otherSymbol === 'wrapped native')).toMatchObject({
      unpriced: 0,
    });
    const unknown = by(
      (p) => p.symbol === 'NVDA' && p.otherSymbol === null,
    ) as (typeof built.perPool)[0];
    expect(unknown.unpriced).toBe(unknown.swaps);
    expect(unknown.unpricedReason).toBe(unknown.swaps ? 'quote_decimals_unknown' : null);
    const twoStocks = by((p) => p.otherIsStock) as (typeof built.perPool)[0];
    expect(twoStocks.unpriced).toBe(0);
    // every hour of the span has a row per pool; the dollar pools say at par
    expect(built.hourly.length).toBe(fx.pools.length * hoursOf(cursor.fromT, cursor.headT).length);
    expect(
      built.hourly
        .filter((h) => h.pool === nvdaUsd.pool)
        .every((h) => h.quoteUsdMethod === 'usdg_at_par'),
    ).toBe(true);
    // the dollar value of a swap is the quote leg at par: the sum over the hour equals the rows' sum
    const all = built.rows.find(
      (r) => r.pool === nvdaUsd.pool && r.regime === 'all' && r.window === '28d',
    );
    const d = decimals.get(nvdaUsd.pool) as PoolDecimals;
    const p = fx.pools.find((x) => x.address === nvdaUsd.pool) as HistoryPool;
    const byHand = swaps
      .filter((s) => s.pool === nvdaUsd.pool)
      .map((s) => flowSwap(s, { assetIsToken0: p.assetIsToken0, ...d }));
    expect(all?.sellUsd).toBeCloseTo(
      byHand.filter((s) => s.side === 'sell').reduce((a, s) => a + s.quote, 0),
      6,
    );
    expect(all?.buyUsd).toBeCloseTo(
      byHand.filter((s) => s.side === 'buy').reduce((a, s) => a + s.quote, 0),
      6,
    );
    expect(all?.swaps).toBe(byHand.length);
  });

  it('a second insert of the same rows inserts nothing (in a transaction that is rolled back)', async () => {
    const pool = `0x${'f1'.repeat(32)}`;
    const rows = buildFlowRows({
      chain: robinhood,
      pools: [
        {
          address: pool,
          kind: 'v4',
          asset: `0x${'f2'.repeat(20)}`,
          symbol: 'FIXEVM',
          other: dollar,
          otherSymbol: 'USDG',
          otherIsStock: false,
          tvlUsd: 1,
          reachable: true,
          assetIsToken0: false,
        },
      ],
      decimals: new Map([[pool, { decimals0: 6, decimals1: 18 }]]),
      swapsOf: swapsFromArray([]),
      span: { fromT: 1_791_000_000, headT: 1_791_003_600 },
      regimeAt: regimeOfT,
      fetchedAt: new Date('2026-10-06T00:00:00Z'),
    }).rows;
    expect(rows.length).toBe(15);
    const { db, client } = createDb();
    const outcome = { first: -1, second: -1, stored: 0 };
    class Undo extends Error {}
    try {
      await db.transaction(async (tx) => {
        outcome.first = (await insertFlowRows(tx, rows)).inserted;
        outcome.second = (await insertFlowRows(tx, rows)).inserted;
        const stored = await tx
          .select()
          .from(riskPoolFlow)
          .where(and(eq(riskPoolFlow.pool, pool), eq(riskPoolFlow.regime, 'all')));
        outcome.stored = stored.length;
        expect(stored[0]).toMatchObject({
          assetSymbol: 'FIXEVM',
          methodVersion: 'flow-0.1',
          hours: 2,
        });
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    } finally {
      await client.end();
    }
    expect(outcome).toEqual({ first: 15, second: 0, stored: 3 });
  });
});
