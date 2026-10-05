import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, riskAssetSnapshots } from '@colosseum/db';
import { costAt, fitCurve } from '@colosseum/risk';
import { getTableColumns } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decodeAggregate3,
  decodeSqrtPrice,
  encodeAggregate3,
  encodeGetSlot0,
  word,
} from '../scripts/risk-evm/abi';
import { CHAINS, rpcFor } from '../scripts/risk-evm/config';
import {
  bestPerSize,
  buildRow,
  buyAmounts,
  costPct,
  GRID_USD,
  METHOD_VERSION,
  midUsd,
  nearMedian,
  outUsdOf,
  type PoolQuotes,
  parseRow,
  sellAmounts,
  toDbRow,
  toRaw,
} from '../scripts/risk-evm/curve';
import { acquireLock, runLoop } from '../scripts/risk-evm/loop';
import {
  attested,
  type Candidate,
  candidates,
  eligible,
  factoryCalls,
  type PoolRef,
} from '../scripts/risk-evm/pools';
import {
  createRpc,
  type Rpc,
  type RpcReply,
  type RpcRequest,
  RpcUnreachable,
} from '../scripts/risk-evm/rpc';
import {
  collectOnce,
  decodeQuotes,
  isBlockGone,
  MAX_PIN_AGE_MS,
  MAX_REPINS_PER_TOKEN,
  quoteRequest,
} from '../scripts/risk-evm/run';
import {
  type Attempt,
  attemptOf,
  missedLine,
  RETRY_AFTER_MIN,
  RETRY_MARGIN_MS,
  runSlot,
  slotLine,
} from '../scripts/risk-evm/slot';

// REVM-1. Nothing here may reach the network: the chain's answers come from a recorded fixture.
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('a risk-evm test tried to call the network');
  });
});

const robinhood = CHAINS.find((c) => c.id === 'robinhood') as (typeof CHAINS)[number];
const repeat = <T>(items: T[], times: number): T[] =>
  Array.from({ length: times }, () => items).flat();
const NVDA = robinhood.tokens.find((t) => t.symbol === 'NVDA') as { address: string };
const D = { token: 18, dollar: 6 };
const quote = (out: bigint, filledIn: bigint) => ({ out, filledIn });
const SMALL_BUY = 100_000_000n; // $100 and $10,000 in a 6-decimal dollar token
const LARGE_BUY = 10_000_000_000n;
const pool = (id: string, mid: number, over: Partial<PoolQuotes> = {}): PoolQuotes => ({
  pool: id,
  midUsd: mid,
  sellIn: sellAmounts(mid, D.token, [100, 10_000]),
  buyIn: buyAmounts(D.dollar, [100, 10_000]),
  sell: [null, null],
  buy: [null, null],
  ...over,
});

describe('mid price and trade sizes', () => {
  it('turns sqrtPriceX96 into dollars per token, for either token order', () => {
    const two = 2n * 2n ** 96n; // price of token0 in token1, raw units: 4
    expect(midUsd(two, true, 6, 6)).toBe(4);
    expect(midUsd(two, false, 6, 6)).toBe(0.25);
    // 18-decimal token as token1 against a 6-decimal dollar token: 4e12 raw tokens per raw dollar
    expect(midUsd(2_000_000n * 2n ** 96n, false, 18, 6)).toBeCloseTo(0.25, 12);
    expect(midUsd(2_000_000n * 2n ** 96n, true, 6, 18)).toBeCloseTo(4, 12);
  });
  it('sizes a sale in tokens at the pool mid and a purchase in dollar tokens', () => {
    expect(sellAmounts(250, 18, [10_000])).toEqual([40n * 10n ** 18n]);
    expect(sellAmounts(250, 8, [10_000])).toEqual([40n * 10n ** 8n]);
    expect(buyAmounts(6, [100, 5_000_000])).toEqual([100_000_000n, 5_000_000_000_000n]);
    expect(toRaw(1.5, 6)).toBe(1_500_000n);
    expect(() => toRaw(-1, 6)).toThrow();
  });
  it("uses Rodrigo's size grid", () => {
    const src = readFileSync('scripts/risk/collector/pools.ts', 'utf8');
    const list = /const NOTIONALS = \[([^\]]+)\]/.exec(src)?.[1] ?? '';
    expect(GRID_USD).toEqual(list.split(',').map((n) => Number(n.replaceAll('_', '').trim())));
  });
});

describe('cost against the pool mid', () => {
  it('sell: dollars received against the size', () => {
    const outUsd = outUsdOf(
      'sell',
      quote(9_990_000_000n, 40n * 10n ** 18n),
      250,
      D.token,
      D.dollar,
    );
    expect(outUsd).toBe(9_990);
    expect(costPct(10_000, outUsd)).toBeCloseTo(0.1, 10);
  });
  it('buy: tokens received, valued at the same pool mid', () => {
    const outUsd = outUsdOf('buy', quote(399n * 10n ** 17n, LARGE_BUY), 250, D.token, D.dollar);
    expect(outUsd).toBeCloseTo(9_975, 9);
    expect(costPct(10_000, outUsd)).toBeCloseTo(0.25, 9);
  });
});

describe('best single pool per size', () => {
  const deep = pool('deep', 250, {
    sell: [quote(99_700_000n, 400_000_000_000_000_000n), quote(9_960_000_000n, 40n * 10n ** 18n)],
    buy: [
      quote(398_800_000_000_000_000n, SMALL_BUY),
      quote(39_840_000_000_000_000_000n, LARGE_BUY),
    ],
  });
  const tight = pool('tight', 250.5, {
    // cheaper for small sizes, runs out at $10k: only three quarters of the tokens are taken
    sell: [
      quote(99_950_000n, sellAmounts(250.5, 18, [100])[0] as bigint),
      quote(7_400_000_000n, ((sellAmounts(250.5, 18, [10_000])[0] as bigint) * 3n) / 4n),
    ],
    buy: [quote(399_000_000_000_000_000n, SMALL_BUY), null],
  });
  const silent = pool('silent', 250);
  const sell = bestPerSize('sell', [deep, tight, silent], D, [100, 10_000]);
  const buy = bestPerSize('buy', [deep, tight, silent], D, [100, 10_000]);

  it('picks the lowest cost at each size, which can be a different pool', () => {
    expect(sell.map((p) => p.pool)).toEqual(['tight', 'deep']);
    expect(sell[0]?.costPct).toBeCloseTo(0.05, 9);
    expect(sell[1]?.costPct).toBeCloseTo(0.4, 9);
    expect(sell.map((p) => p.midUsd)).toEqual([250.5, 250]);
    expect(buy.map((p) => p.pool)).toEqual(['tight', 'deep']);
    // 0.399 tokens at the tight pool's own mid of 250.5
    expect(buy[0]?.outUsd).toBeCloseTo(99.9495, 9);
  });
  it('counts the pools that answered and ignores the ones that did not', () => {
    expect(sell.map((p) => p.quoted)).toEqual([2, 2]);
    expect(buy.map((p) => p.quoted)).toEqual([2, 1]);
  });
  it('reports the share of the amount a pool could not take, and counts it as lost', () => {
    expect(sell.map((p) => p.unfilledShare)).toEqual([0, 0]);
    const partial = bestPerSize('sell', [tight], D, [100, 10_000]);
    expect(partial[1]?.unfilledShare).toBeCloseTo(0.25, 12);
    expect(partial[1]?.costPct).toBeCloseTo(26, 9);
    expect(buy.map((p) => p.unfilledShare)).toEqual([0, 0]);
  });
  it('keeps the first pool on a tie and leaves a size empty when no pool quoted it', () => {
    const whole = 400_000_000_000_000_000n;
    const a = pool('a', 250, { sell: [quote(99_000_000n, whole), null] });
    const b = pool('b', 250, { sell: [quote(99_000_000n, whole), null] });
    const tie = bestPerSize('sell', [a, b], D, [100, 10_000]);
    expect(tie[0]?.pool).toBe('a');
    expect(tie[1]).toEqual({
      notionalUsd: 10_000,
      outUsd: null,
      costPct: null,
      unfilledShare: null,
      pool: null,
      midUsd: null,
      quoted: 0,
    });
  });
  it('leaves out a pool whose price is far from the others', () => {
    const pools = [{ midUsd: 100 }, { midUsd: 100.3 }, { midUsd: 91 }];
    expect(nearMedian(pools, 0.02)).toEqual([{ midUsd: 100 }, { midUsd: 100.3 }]);
    expect(nearMedian([{ midUsd: 100 }, { midUsd: 120 }], 0.02)).toEqual([]);
    expect(nearMedian([{ midUsd: 100 }], 0.02)).toEqual([{ midUsd: 100 }]);
  });
});

describe('row shape', () => {
  const row = buildRow({
    token: { symbol: 'NVDA', address: NVDA.address, decimals: 18 },
    dollarDecimals: 6,
    blockTime: new Date('2026-10-02T17:49:23.000Z'),
    blockNumber: 78_422_492,
    pools: [
      pool('0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3', 250, {
        sell: [quote(99_950_000n, 400_000_000_000_000_000n), null],
        buy: [quote(399_800_000_000_000_000n, SMALL_BUY), null],
      }),
    ],
    source: 'eth_call at block 78422492 (test)',
    grid: [100, 10_000],
  });
  const columns = getTableColumns(riskAssetSnapshots);

  it('has exactly the columns of risk_asset_snapshots', () => {
    expect(Object.keys(row).sort()).toEqual(Object.keys(columns).sort());
    expect(Object.keys(toDbRow(row)).sort()).toEqual(Object.keys(columns).sort());
  });
  it('gives every column a value of its type', () => {
    const db = toDbRow(row) as Record<string, unknown>;
    for (const [name, col] of Object.entries(columns)) {
      const v = db[name];
      if (col.notNull) expect(v, name).not.toBeNull();
      if (col.dataType === 'date') expect(v, name).toBeInstanceOf(Date);
      else if (col.dataType === 'json') expect(Array.isArray(v), name).toBe(true);
      else expect(typeof v, name).toBe(col.dataType);
    }
  });
  it('carries its source, time, method and version', () => {
    expect(row.methodVersion).toBe('evmq-0.1');
    expect(METHOD_VERSION).toBe('evmq-0.1');
    expect(row.method).toBe('best_single_pool_exact_in_vs_own_pool_mid');
    expect(row.provenance).toBe('live');
    expect(row.fetchedAt).toBe('2026-10-02T17:49:23.000Z');
    expect(row.slot).toBe(78_422_492);
    expect(row.source).toContain('block 78422492');
    expect(row.refPool).toBe('0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3');
    expect(row.refMidUsd).toBe(250);
    expect(row.pools).toBe(1);
  });
  it("keeps Rodrigo's four keys on every point, which is all compute.ts reads", () => {
    for (const p of [...row.sell, ...row.buy])
      expect(Object.keys(p)).toEqual(
        expect.arrayContaining(['notionalUsd', 'outUsd', 'costPct', 'unfilledShare']),
      );
    // compute.ts drops a point whose outUsd is not a finite number
    expect(Number.isFinite(row.sell[1]?.outUsd)).toBe(false);
  });
  it('survives the JSONL round trip and rejects a line that is not a row', () => {
    const back = parseRow(JSON.parse(JSON.stringify(row)));
    expect(back).toEqual(row);
    expect(parseRow(null)).toBeNull();
    expect(parseRow({ ...row, fetchedAt: 'yesterday' })).toBeNull();
    expect(parseRow({ ...row, provenance: 'mock' })).toBeNull();
    expect(parseRow({ ...row, sell: [{ outUsd: 1 }] })).toBeNull();
    const { source: _source, ...noSource } = row;
    expect(parseRow(noSource)).toBeNull();
  });
  it('builds an insert that leaves an existing row alone', async () => {
    // never connects: the query is only built
    const { db, client } = createDb('postgres://nobody:nothing@127.0.0.1:1/none');
    const q = db
      .insert(riskAssetSnapshots)
      .values([toDbRow(row)])
      .onConflictDoNothing()
      .toSQL();
    expect(q.sql).toMatch(
      /^insert into "risk_asset_snapshots" \("asset_mint", .*"provenance"\) values \(.*\) on conflict do nothing$/,
    );
    expect(q.params).toHaveLength(Object.keys(columns).length);
    await client.end();
  });
  it('never stores an RPC URL that came from the environment', () => {
    const custom = rpcFor(robinhood, { RISK_EVM_RH_RPC_URL: 'https://example.invalid/v2/a-key' });
    expect(custom.url).toBe('https://example.invalid/v2/a-key');
    expect(custom.label).not.toContain('example.invalid');
    expect(rpcFor(robinhood, {}).label).toBe(robinhood.rpcDefault);
  });
});

type Side = {
  side: 'sell' | 'buy';
  zeroForOne: boolean;
  amountsIn: string[];
  castCalldata: string;
  result: string;
};
type Fixture = {
  provenance: string;
  block: number;
  fetchedAt: string;
  v3: {
    pool: PoolRef;
    slot0: string;
    sqrtPriceX96: string;
    sides: Array<Side & { castDecoded: { ins: string[]; outs: string[] } }>;
  };
  v4: {
    pool: PoolRef;
    slot0: string;
    sqrtPriceX96: string;
    sides: Array<Side & { castDecoded: Array<{ success: boolean; amountOut: string | null }> }>;
  };
};

describe('recorded quoter responses (Robinhood Chain, NVDA)', () => {
  const fx = JSON.parse(
    readFileSync('fixtures/risk-evm/robinhood-nvda-quotes.json', 'utf8'),
  ) as Fixture;
  const tag = `0x${fx.block.toString(16)}`;
  const amounts = (s: Side) => s.amountsIn.map(BigInt);

  it('is labelled as a fixture', () => {
    expect(fx.provenance).toBe('fixture');
  });
  it('builds the same calldata as cast, for both pool kinds and both directions', () => {
    for (const s of fx.v3.sides) {
      const [call, block, override] = quoteRequest(robinhood, fx.v3.pool, s.side, amounts(s), tag)
        .params as [{ to: string; data: string }, string, Record<string, { code: string }>];
      expect(call.data).toBe(s.castCalldata);
      expect(block).toBe(tag);
      // the quoter exists only as a state override on this one call
      const artefact = JSON.parse(readFileSync('scripts/risk-evm/cl-quoter.json', 'utf8'));
      expect(override[call.to]?.code).toBe(artefact.deployedBytecode);
    }
    for (const s of fx.v4.sides) {
      const req = quoteRequest(robinhood, fx.v4.pool, s.side, amounts(s), tag);
      const [call] = req.params as [{ to: string; data: string }];
      expect(call.data).toBe(s.castCalldata);
      expect(call.to).toBe(robinhood.multicall3);
      expect(req.params).toHaveLength(2);
    }
    expect(fx.v3.sides.map((s) => s.zeroForOne)).toEqual([false, true]); // NVDA is token1
  });
  it('decodes the pool prices as cast does', () => {
    expect(decodeSqrtPrice(fx.v3.slot0)).toBe(BigInt(fx.v3.sqrtPriceX96));
    expect(decodeSqrtPrice(fx.v4.slot0)).toBe(BigInt(fx.v4.sqrtPriceX96));
    const mid = midUsd(BigInt(fx.v3.sqrtPriceX96), false, 18, 6);
    // the same price in integer arithmetic: 2^192 × 10^12 / sqrtPrice², in millionths of a dollar
    const exact = (2n ** 192n * 10n ** 18n) / BigInt(fx.v3.sqrtPriceX96) ** 2n;
    expect(mid).toBeCloseTo(Number(exact) / 1e6, 5);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(1_000);
  });
  it('decodes the injected quoter as cast does', () => {
    for (const s of fx.v3.sides) {
      const got = decodeQuotes(fx.v3.pool, s.result, amounts(s));
      expect(got.map((q) => q?.out)).toEqual(s.castDecoded.outs.map(BigInt));
      expect(got.map((q) => q?.filledIn)).toEqual(s.castDecoded.ins.map(BigInt));
    }
  });
  it('decodes the v4 Quoter through Multicall3 as cast does, failed sizes included', () => {
    for (const s of fx.v4.sides) {
      const got = decodeQuotes(fx.v4.pool, s.result, amounts(s));
      expect(got.map((q) => q?.out ?? null)).toEqual(
        s.castDecoded.map((d) => (d.success && d.amountOut ? BigInt(d.amountOut) : null)),
      );
      // a v4 quote that comes back was filled in full
      got.forEach((q, i) => {
        if (q) expect(q.filledIn).toBe(amounts(s)[i]);
      });
      // the failures are the Quoter's own refusal, not a lack of gas:
      // UnexpectedRevertBytes(NotEnoughLiquidity(poolId))
      const refused = decodeAggregate3(s.result).filter((r) => !r.success);
      expect(refused).toHaveLength(3);
      for (const r of refused) {
        expect(r.data.slice(0, 10)).toBe('0x6190b2b0');
        expect(r.data).toContain(`7a5ed734${fx.v4.pool.id.slice(2)}`);
      }
    }
    // this thin pool cannot take the three largest sizes
    expect(fx.v4.sides[0]?.castDecoded.map((d) => d.success)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
  it('turns the recording into a row whose costs match the raw amounts', () => {
    const toQuotes = (f: Fixture['v3'] | Fixture['v4']): PoolQuotes => {
      const side = (name: 'sell' | 'buy') => f.sides.find((s) => s.side === name) as Side;
      return {
        pool: f.pool.id,
        midUsd: midUsd(BigInt(f.sqrtPriceX96), f.pool.tokenIs0, 18, 6),
        sellIn: amounts(side('sell')),
        buyIn: amounts(side('buy')),
        sell: decodeQuotes(f.pool, side('sell').result, amounts(side('sell'))),
        buy: decodeQuotes(f.pool, side('buy').result, amounts(side('buy'))),
      };
    };
    const row = buildRow({
      token: { symbol: 'NVDA', address: NVDA.address, decimals: 18 },
      dollarDecimals: 6,
      blockTime: new Date(fx.fetchedAt),
      blockNumber: fx.block,
      pools: [toQuotes(fx.v3), toQuotes(fx.v4)],
      source: 'fixture',
    });
    const sellOuts = fx.v3.sides[0]?.castDecoded.outs.map(Number) as number[];
    // the deep v3 pool wins every size; cost is 1 − dollars out / size
    expect(row.sell.map((p) => p.pool)).toEqual(GRID_USD.map(() => fx.v3.pool.id));
    row.sell.forEach((p, i) => {
      expect(p.costPct).toBeCloseTo((1 - (sellOuts[i] as number) / 1e6 / p.notionalUsd) * 100, 9);
    });
    expect(row.sell.map((p) => p.quoted)).toEqual([2, 2, 2, 2, 2, 1, 1, 1]);
    const at = (usd: number) => row.sell.find((p) => p.notionalUsd === usd)?.costPct as number;
    // a 0.05% pool: a small sale costs the fee, larger ones cost more, in order
    expect(at(100)).toBeGreaterThan(0.049);
    expect(at(100)).toBeLessThan(0.06);
    expect(at(10_000)).toBeGreaterThan(at(100));
    expect(at(50_000)).toBeGreaterThan(at(10_000));
    expect(at(50_000)).toBeLessThan(1);
    // buying: tokens received, valued at the pool's mid taken in integer arithmetic
    const exactMid = Number((2n ** 192n * 10n ** 18n) / BigInt(fx.v3.sqrtPriceX96) ** 2n) / 1e6;
    const buyOuts = fx.v3.sides[1]?.castDecoded.outs.map(Number) as number[];
    expect(row.buy.map((p) => p.pool)).toEqual(GRID_USD.map(() => fx.v3.pool.id));
    row.buy.forEach((p, i) => {
      const outUsd = ((buyOuts[i] as number) / 1e18) * exactMid;
      expect(p.costPct).toBeCloseTo((1 - outUsd / p.notionalUsd) * 100, 6);
    });
    expect(row.buy[3]?.costPct).toBeGreaterThan(0.05);
    expect(row.buy[3]?.costPct).toBeLessThan(0.2);
    expect(row.sell.map((p) => p.unfilledShare)).toEqual(GRID_USD.map(() => 0));
    // what scripts/risk/compute.ts does with a row: finite outUsd only, cost = 1 − outUsd / notionalUsd
    const samples = row.sell
      .filter((p) => Number.isFinite(p.outUsd))
      .map((p) => ({ notionalUsd: p.notionalUsd, cost: 1 - (p.outUsd as number) / p.notionalUsd }));
    const curve = fitCurve(samples, { quantile: 0.5, minSamples: 1 });
    expect(curve.points.map((p) => p.notionalUsd)).toEqual(GRID_USD);
    expect(curve.insufficientFrom).toBeNull();
    expect(costAt(curve, 10_000)).toBeCloseTo(at(10_000) / 100, 12);
  });
});

describe('pool list', () => {
  const token = { symbol: 'NVDA', address: NVDA.address, decimals: 18 };
  const usdg = robinhood.dollar.address;
  const v3 = '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3';
  const v4 = `0x${'ab'.repeat(32)}`;
  const pair = (pairAddress: string, usd: number, over: Record<string, unknown> = {}) => ({
    chainId: 'robinhood',
    dexId: 'uniswap',
    pairAddress,
    baseToken: { address: token.address },
    quoteToken: { address: usdg },
    liquidity: { usd },
    ...over,
  });
  const opts = { minLiquidityUsd: 10_000, limit: 3 };

  it('keeps pairs against the dollar token on this chain, deepest first', () => {
    const got = candidates(
      [
        pair(v4, 50_000),
        pair(v3, 900_000),
        pair('0x1111111111111111111111111111111111111111', 5_000), // too thin
        pair('0x2222222222222222222222222222222222222222', 800_000, {
          quoteToken: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' }, // against WETH
        }),
        pair('0x3333333333333333333333333333333333333333', 700_000, { chainId: 'base' }),
        // listed the other way round
        pair('0x4444444444444444444444444444444444444444', 20_000, {
          baseToken: { address: usdg.toLowerCase() },
          quoteToken: { address: token.address.toLowerCase() },
        }),
      ],
      robinhood,
      token,
      opts,
    );
    expect(got.map((c) => [c.kind, c.liquidityUsd])).toEqual([
      ['cl', 900_000],
      ['v4', 50_000],
      ['cl', 20_000],
    ]);
    expect(candidates([pair(v4, 50_000)], { ...robinhood, v4: null }, token, opts)).toEqual([]);
  });

  const ok = (...ws: Array<string | bigint | number>) => ({
    success: true,
    data: `0x${ws.map((w) => (typeof w === 'string' ? w.slice(2).toLowerCase().padStart(64, '0') : word(w))).join('')}`,
  });
  const cl = (id: string): Candidate => ({ kind: 'cl', id, dex: 'uniswap', liquidityUsd: 1 });
  const clReplies = (t0: string, t1: string) => [ok(t0), ok(t1), ok(500), ok(10)];
  const factory = robinhood.clFactories[0]?.address as string;
  const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

  it('keeps a v3-style pool only when an allowlisted factory names it for the pair', () => {
    // the second candidate copies everything the real pool says about itself
    const copycat = '0x18A5aF4E442F8be68968Cc1f00D537F8af2D12Cd';
    const found = eligible(
      robinhood,
      token,
      [cl(v3), cl(copycat), cl(usdg), cl(factory)],
      [
        ...clReplies(usdg, token.address),
        ...clReplies(usdg, token.address),
        ...clReplies(usdg, weth),
        ...Array.from({ length: 4 }, () => ({ success: false, data: '0x' })),
      ],
    );
    expect(found.pools.map((p) => p.id)).toEqual([v3, copycat]);
    expect(found.skipped).toEqual({
      'not the token against the dollar token': 1,
      'not a v3-style pool': 1,
    });
    const calls = factoryCalls(robinhood, token, found.pools);
    // getPool(USDG, NVDA, 500) on the Uniswap v3 factory, once per candidate
    const getPool = `0x1698ee82${usdg.slice(2).toLowerCase().padStart(64, '0')}${token.address
      .slice(2)
      .toLowerCase()
      .padStart(64, '0')}${word(500)}`;
    expect(calls).toEqual([
      { target: factory, callData: getPool },
      { target: factory, callData: getPool },
    ]);
    const kept = attested(robinhood, found, [ok(v3), ok(v3)], 3);
    expect(kept.pools).toEqual([
      {
        kind: 'cl',
        id: v3,
        dex: 'uniswap',
        tokenIs0: false,
        fee: 500,
        tickSpacing: 10,
        liquidityUsd: 1,
      },
    ]);
    expect(kept.skipped).toEqual({
      'not the token against the dollar token': 1,
      'not a v3-style pool': 1,
      'not a pool of an allowlisted factory': 1,
    });
    // a factory that knows no such pool answers the zero address
    expect(attested(robinhood, found, [ok(0), { success: false, data: '0x' }], 3).pools).toEqual(
      [],
    );
  });
  it('asks a Slipstream factory by tick spacing', () => {
    const base = CHAINS.find((c) => c.id === 'base') as (typeof CHAINS)[number];
    const nvdac = base.tokens[0] as (typeof base.tokens)[number];
    const [call] = factoryCalls(base, nvdac, [
      {
        kind: 'cl',
        id: v3,
        dex: 'aerodrome',
        tokenIs0: false,
        fee: 500,
        tickSpacing: 10,
        liquidityUsd: 1,
      },
    ]);
    expect(call?.target).toBe(base.clFactories[0]?.address);
    expect(call?.callData.slice(0, 10)).toBe('0x28af8d0b');
    expect(call?.callData.slice(-64)).toBe(word(10));
  });
  it('keeps a v4 pool only when it has no hook, and stops at the pool limit', () => {
    const c: Candidate = { kind: 'v4', id: v4, dex: 'uniswap', liquidityUsd: 1 };
    const key = (hooks: string | number) => ok(usdg, token.address, 3000, 60, hooks);
    const found = eligible(
      robinhood,
      token,
      [c, c, c, c],
      [key('0x00000000000000000000000000000000000000c0'), ok(0, 0, 0, 0, 0), key(0), key(0)],
    );
    expect(found.pools).toHaveLength(2);
    expect(factoryCalls(robinhood, token, found.pools)).toEqual([]);
    const kept = attested(robinhood, found, [], 1);
    expect(kept.pools).toHaveLength(1);
    expect(kept.pools[0]).toMatchObject({
      kind: 'v4',
      tokenIs0: false,
      fee: 3000,
      tickSpacing: 60,
    });
    expect(kept.skipped).toEqual({
      'has a hook': 1,
      'no pool key on the position manager': 1,
      'beyond the pool limit': 1,
    });
  });
});

/** A Multicall3.aggregate3 response, built the long way round. */
function aggregate3Result(items: Array<{ success: boolean; data: string }>): string {
  const bodies = items.map((it) => {
    const bytes = it.data.slice(2);
    return (
      word(it.success) +
      word(0x40) +
      word(bytes.length / 2) +
      bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
    );
  });
  let offset = items.length * 32;
  const heads = bodies.map((b) => {
    const head = word(offset);
    offset += b.length / 2;
    return head;
  });
  return `0x${word(0x20)}${word(items.length)}${heads.join('')}${bodies.join('')}`;
}

type RpcErrors = {
  provenance: string;
  blockGone: Array<{ from: string; message: string }>;
  notBlockGone: Array<{ from: string; message: string }>;
};
const rpcErrors = JSON.parse(
  readFileSync('fixtures/risk-evm/rpc-errors.json', 'utf8'),
) as RpcErrors;
/** The two answers the overnight run of Oct 2 to 3 met when the machine slept during a run. */
const HISTORICAL_STATE = rpcErrors.blockGone[0]?.message as string;
const LAYER_STALE = rpcErrors.blockGone[1]?.message as string;

describe('one run, replayed from the recording', () => {
  const fx = JSON.parse(
    readFileSync('fixtures/risk-evm/robinhood-nvda-quotes.json', 'utf8'),
  ) as Fixture;
  const BLOCK_A = fx.block;
  const STEP = 1_000; // each new pin is this many blocks, and 100 seconds, after the last
  const tagOf = (n: number) => `0x${n.toString(16)}`;
  const tag = tagOf(BLOCK_A);
  const timeOf = (n: number) =>
    new Date(Date.parse(fx.fetchedAt) + ((n - BLOCK_A) / STEP) * 100_000).toISOString();
  const nvda = robinhood.tokens.find((t) => t.symbol === 'NVDA') as (typeof robinhood.tokens)[0];
  const recorded = new Map<string, string>();
  for (const f of [fx.v3, fx.v4]) for (const s of f.sides) recorded.set(s.castCalldata, s.result);
  const midCalls = [
    { target: fx.v3.pool.id, callData: '0x3850c7bd' },
    { target: robinhood.v4?.stateView as string, callData: encodeGetSlot0(fx.v4.pool.id) },
  ];
  const slot0s = [
    { success: true, data: fx.v3.slot0 },
    { success: true, data: fx.v4.slot0 },
  ];
  // the price call for the pools of one, two or three tokens: calldata, and how many tokens it covers
  const mids = new Map([1, 2, 3].map((k) => [encodeAggregate3(repeat(midCalls, k)), k]));
  const v3Sell = fx.v3.sides[0]?.castCalldata as string;
  const v4Buy = fx.v4.sides[1] as Fixture['v4']['sides'][number];

  type Seen = { method: string; data: string; tag: string };
  type World = { clock: number; head: number; seen: Seen[] };
  type Scenario = {
    /** Symbols to list, all with NVDA's address and pools. */
    tokens?: string[];
    /** Symbols listed with no pool at all. */
    noPools?: string[];
    only?: Set<string>;
    /** Minutes after the start at which the next scheduled run is due. */
    untilMin?: number;
    /** Answers before the recording does; 'unreachable' makes the request fail as a dead network does. */
    override?: (call: Seen, world: World) => RpcReply | 'unreachable' | undefined;
    /** Called when the run asks for a block after its first: 'unreachable' as above, or the endpoint's refusal. */
    onRepin?: (world: World) => RpcReply | 'unreachable' | undefined;
  };
  const unreachable = () =>
    new RpcUnreachable('RPC unreachable after 3 tries (TypeError ENOTFOUND)');

  /** Runs collectOnce against a client that answers from the fixture, with a clock the scenario moves. */
  async function run(scenario: Scenario = {}) {
    const symbols = scenario.tokens ?? ['NVDA'];
    const empty = new Set(scenario.noPools ?? []);
    const chain = { ...robinhood, tokens: symbols.map((symbol) => ({ ...nvda, symbol })) };
    const dir = mkdtempSync(join(tmpdir(), 'risk-evm-run-'));
    const listed = { address: NVDA.address, pools: [fx.v3.pool, fx.v4.pool], skipped: {} };
    const world: World = { clock: Date.parse(fx.fetchedAt), head: BLOCK_A, seen: [] };
    writeFileSync(
      join(dir, 'pools-robinhood.json'),
      JSON.stringify({
        chain: 'robinhood',
        chainId: 4663,
        discoveredAt: new Date(world.clock).toISOString(),
        source: 'test',
        method: 'test',
        maxPools: 3,
        tokens: Object.fromEntries(
          symbols.map((symbol) => [symbol, empty.has(symbol) ? { ...listed, pools: [] } : listed]),
        ),
      }),
    );
    const answer = (r: RpcRequest): RpcReply => {
      if (r.method === 'eth_chainId') {
        world.seen.push({ method: r.method, data: '', tag: '' });
        return { result: '0x1237' };
      }
      if (r.method === 'eth_getBlockByNumber') {
        world.seen.push({ method: r.method, data: '', tag: '' });
        const refused = world.head > BLOCK_A ? scenario.onRepin?.(world) : undefined;
        if (refused === 'unreachable') throw unreachable();
        if (refused) return refused;
        const n = world.head;
        world.head += STEP;
        return {
          result: { number: tagOf(n), timestamp: tagOf(Date.parse(timeOf(n)) / 1000) },
        };
      }
      const [call, at] = r.params as [{ data: string }, string];
      const seen = { method: r.method, data: call.data, tag: at };
      world.seen.push(seen);
      const forced = scenario.override?.(seen, world);
      if (forced === 'unreachable') throw unreachable();
      if (forced) return forced;
      const tokens = mids.get(call.data);
      if (tokens) return { result: aggregate3Result(repeat(slot0s, tokens)) };
      const result = recorded.get(call.data);
      return result ? { result } : { error: { message: 'not in the recording' } };
    };
    const rpc: Rpc = {
      batch: async (requests) => requests.map(answer),
      call: async <T>(method: string, params: unknown[]) => {
        const reply = answer({ method, params });
        if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
        return reply.result as T;
      },
      stats: () => ({ httpRequests: 0, rpcCalls: world.seen.length }),
    };
    const events: Record<string, unknown>[] = [];
    const summary = await collectOnce(chain, {
      dir,
      maxPools: 3,
      minLiquidityUsd: 10_000,
      poolsMaxAgeHours: 24,
      rediscover: false,
      only: scenario.only,
      until: scenario.untilMin === undefined ? undefined : world.clock + scenario.untilMin * 60_000,
      env: { RISK_EVM_RH_RPC_URL: 'https://example.invalid/v2/a-key' },
      rpc,
      now: () => world.clock,
      sleep: async () => {},
      log: (e) => events.push(e),
    });
    const file = join(dir, 'assets', `${fx.fetchedAt.slice(0, 10)}.jsonl`);
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    const rows = lines.map(
      (l) => parseRow(JSON.parse(l)) as NonNullable<ReturnType<typeof parseRow>>,
    );
    return { summary, events, seen: world.seen, rows };
  }
  const calls = (seen: Seen[]) => seen.filter((q) => q.method === 'eth_call');
  const isQuote = (q: Seen) => recorded.has(q.data);

  it('writes one row at the pinned block, in seven calls, without the RPC URL', async () => {
    const r = await run();
    expect(r.summary).toMatchObject({
      rows: 1,
      block: fx.block,
      repins: 0,
      poolsRediscovered: false,
    });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as (typeof r.rows)[number];
    expect(row).toMatchObject({
      asset: 'NVDA',
      assetMint: NVDA.address,
      slot: fx.block,
      fetchedAt: fx.fetchedAt,
      pools: 2,
      refPool: fx.v3.pool.id,
      methodVersion: 'evmq-0.1',
      provenance: 'live',
    });
    const out10k = Number(fx.v3.sides[0]?.castDecoded.outs[3]) / 1e6;
    expect(row.sell[3]?.costPct).toBeCloseTo((1 - out10k / 10_000) * 100, 9);
    expect(r.summary.tokens[0]).toMatchObject({ sell10k: row.sell[3]?.costPct, block: fx.block });
    expect(row.sell.map((p) => p.quoted)).toEqual([2, 2, 2, 2, 2, 1, 1, 1]);
    // chain id and block, the mids, then one call per pool and side
    expect(r.seen).toHaveLength(7);
    expect(calls(r.seen).every((q) => q.tag === tag)).toBe(true);
    // the URL from the environment may carry a key: it is named, never written
    expect(row.source).toContain('the RPC in RISK_EVM_RH_RPC_URL');
    expect(JSON.stringify([row, r.summary, r.events])).not.toMatch(/example\.invalid|a-key/);
  });
  it('writes no row when the deepest pool did not answer, rather than pass off the thin one', async () => {
    const r = await run({
      override: (q) =>
        q.data === v3Sell ? { error: { code: -32016, message: 'over rate limit' } } : undefined,
    });
    expect(r.rows).toEqual([]);
    expect(r.summary.rows).toBe(0);
    expect(r.summary.tokens[0]?.error).toMatch(
      /sell quote from pool 0xd4EB.* failed: over rate limit/,
    );
    // worth another try within the hour, and no cost is reported for it
    expect(r.summary.tokens[0]).toMatchObject({ retry: true, sell10k: null, sell50k: null });
  });
  it('asks a v4 pool again with fewer sizes when the call runs out of gas', async () => {
    const all = decodeAggregate3(v4Buy.result);
    const r = await run({
      override: (q) => {
        if (q.data === v4Buy.castCalldata) return { error: { message: 'out of gas' } };
        // the second try carries seven sizes, so it is not in the recording
        const known = mids.has(q.data) || recorded.has(q.data);
        return known ? undefined : { result: aggregate3Result(all.slice(0, 7)) };
      },
    });
    expect(r.seen).toHaveLength(8);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.buy.map((p) => p.quoted)).toEqual([2, 2, 2, 2, 2, 1, 1, 1]);
  });
  it('leaves out a pool that is still out of gas after three smaller tries, and says so', async () => {
    const r = await run({
      override: (q) =>
        mids.has(q.data) || (recorded.has(q.data) && q.data !== v4Buy.castCalldata)
          ? undefined
          : { error: { message: 'out of gas' } },
    });
    expect(r.seen).toHaveLength(10);
    expect(r.events).toEqual([
      { event: 'quote_out_of_gas', asset: 'NVDA', pool: fx.v4.pool.id, side: 'buy' },
    ]);
    expect(r.rows[0]?.buy.map((p) => p.quoted)).toEqual(GRID_USD.map(() => 1));
    expect(r.rows[0]?.sell.map((p) => p.quoted)).toEqual([2, 2, 2, 2, 2, 1, 1, 1]);
  });
  it('refuses an endpoint that answers for another chain', async () => {
    await expect(
      collectOnce(
        { ...robinhood, chainId: 46630 },
        {
          dir: mkdtempSync(join(tmpdir(), 'risk-evm-run-')),
          maxPools: 3,
          minLiquidityUsd: 10_000,
          poolsMaxAgeHours: 24,
          rediscover: false,
          rpc: {
            batch: async () => [
              { result: '0x1237' },
              { result: { number: tag, timestamp: '0x1' } },
            ],
            call: async () => {
              throw new Error('unexpected call');
            },
            stats: () => ({ httpRequests: 0, rpcCalls: 0 }),
          },
          log: () => {},
        },
      ),
    ).rejects.toThrow('answers for chain 4663, not 46630');
  });

  describe('when the pinned block can no longer be read', () => {
    const BLOCK_B = BLOCK_A + STEP;

    it('knows the wordings the two Robinhood Chain endpoints use, and no others', () => {
      expect(rpcErrors.provenance).toBe('fixture');
      expect(rpcErrors.blockGone.length).toBeGreaterThanOrEqual(5);
      for (const e of rpcErrors.blockGone) expect(isBlockGone(e.message), e.message).toBe(true);
      for (const e of rpcErrors.notBlockGone) expect(isBlockGone(e.message), e.message).toBe(false);
      expect(isBlockGone(undefined)).toBe(false);
      expect(HISTORICAL_STATE).toMatch(/^historical state [0-9a-f]{64} is not available$/);
      expect(LAYER_STALE).toMatch(/^missing trie node [0-9a-f]{64} \(path 00\) layer stale$/);
    });

    for (const [name, message] of [
      ['historical state', HISTORICAL_STATE],
      ['layer stale', LAYER_STALE],
    ] as const) {
      it(`measures the token again on a fresh block, prices included (${name})`, async () => {
        const r = await run({
          override: (q) =>
            q.data === v3Sell && q.tag === tag ? { error: { code: -32000, message } } : undefined,
        });
        expect(r.summary).toMatchObject({ rows: 1, repins: 1, block: BLOCK_A });
        expect(r.rows).toHaveLength(1);
        // the row belongs to the second block entirely: number, time and source
        expect(r.rows[0]).toMatchObject({ slot: BLOCK_B, fetchedAt: timeOf(BLOCK_B) });
        expect(r.rows[0]?.source).toContain(`block ${BLOCK_B} `);
        expect(r.summary.tokens[0]).toMatchObject({ block: BLOCK_B });
        // first block: prices and four quotes, one of them refused. Then a new block, and all five again.
        const all = calls(r.seen);
        expect(all.map((q) => q.tag)).toEqual([
          ...repeat([tag], 5),
          ...repeat([tagOf(BLOCK_B)], 5),
        ]);
        const second = all.slice(5);
        expect(mids.has(second[0]?.data as string)).toBe(true);
        expect(second.slice(1).every(isQuote)).toBe(true);
        expect(r.events).toEqual([
          {
            event: 'repinned',
            reason: 'block_gone',
            asset: 'NVDA',
            fromBlock: BLOCK_A,
            error: message,
          },
        ]);
      });
    }

    it('takes a fresh block when the price call itself finds the state gone', async () => {
      const r = await run({
        override: (q) =>
          mids.has(q.data) && q.tag === tag ? { error: { message: HISTORICAL_STATE } } : undefined,
      });
      expect(r.summary).toMatchObject({ rows: 1, repins: 1 });
      expect(r.rows[0]).toMatchObject({ slot: BLOCK_B, fetchedAt: timeOf(BLOCK_B) });
      // no quote was ever asked at the first block
      expect(
        calls(r.seen)
          .filter(isQuote)
          .every((q) => q.tag === tagOf(BLOCK_B)),
      ).toBe(true);
    });

    it('writes no row, and no cost, when every fresh block fails the same way', async () => {
      const r = await run({
        override: (q) => (q.data === v3Sell ? { error: { message: HISTORICAL_STATE } } : undefined),
      });
      expect(r.rows).toEqual([]);
      expect(r.summary).toMatchObject({ rows: 0, repins: MAX_REPINS_PER_TOKEN });
      expect(r.summary.tokens[0]).toMatchObject({
        error: `the block's state was gone: ${HISTORICAL_STATE}`,
        retry: true,
        sell10k: null,
        sell50k: null,
      });
      expect(r.summary.tokens[0]?.block).toBeUndefined();
      // three blocks were tried, each with its own prices
      expect(
        calls(r.seen)
          .filter((q) => mids.has(q.data))
          .map((q) => q.tag),
      ).toEqual([tag, tagOf(BLOCK_B), tagOf(BLOCK_B + STEP)]);
    });

    it('only redoes the token that failed: rows already written keep their block', async () => {
      let refused = false;
      const r = await run({
        tokens: ['NVDA', 'NVDB'],
        override: (q, world) => {
          // the second token's first quote, at the first block
          const quotesSoFar = world.seen.filter(isQuote).length;
          if (!refused && q.data === v3Sell && quotesSoFar === 5) {
            refused = true;
            return { error: { message: LAYER_STALE } };
          }
          return undefined;
        },
      });
      expect(r.rows.map((row) => [row.asset, row.slot])).toEqual([
        ['NVDA', BLOCK_A],
        ['NVDB', BLOCK_B],
      ]);
      expect(r.summary).toMatchObject({ rows: 2, repins: 1 });
    });
  });

  describe('when the run was paused (a sleeping machine)', () => {
    const BLOCK_B = BLOCK_A + STEP;
    const twoTokens = (pauseMs: number) =>
      run({
        tokens: ['NVDA', 'NVDB'],
        override: (q, world) => {
          // the clock jumps while the first token's last quote is on the wire
          if (q.data === v4Buy.castCalldata && world.seen.filter(isQuote).length === 4)
            world.clock += pauseMs;
          return undefined;
        },
      });

    it('keeps one block for the whole run when nothing pauses it', async () => {
      const r = await twoTokens(MAX_PIN_AGE_MS);
      expect(r.summary).toMatchObject({ rows: 2, repins: 0 });
      expect(r.rows.map((row) => row.slot)).toEqual([BLOCK_A, BLOCK_A]);
      // one price call covers both tokens
      expect(calls(r.seen).filter((q) => mids.has(q.data))).toHaveLength(1);
      expect(r.seen).toHaveLength(2 + 1 + 8);
    });
    it('starts what is left on a fresh block once the pin is older than the limit', async () => {
      const r = await twoTokens(30 * 60_000);
      expect(r.summary).toMatchObject({ rows: 2, repins: 1, block: BLOCK_A });
      expect(r.rows.map((row) => [row.asset, row.slot, row.fetchedAt])).toEqual([
        ['NVDA', BLOCK_A, fx.fetchedAt],
        ['NVDB', BLOCK_B, timeOf(BLOCK_B)],
      ]);
      // the second token's prices were read again, at its own block, before its quotes
      const second = calls(r.seen).filter((q) => q.tag === tagOf(BLOCK_B));
      expect(second).toHaveLength(5);
      expect(mids.get(second[0]?.data as string)).toBe(1);
      expect(second.slice(1).every(isQuote)).toBe(true);
      expect(r.events).toEqual([
        {
          event: 'repinned',
          reason: 'pin_too_old',
          asset: 'NVDB',
          fromBlock: BLOCK_A,
          ageMs: 30 * 60_000,
        },
      ]);
    });
    it('leaves what is left to the next run when it wakes after that run was due', async () => {
      const r = await run({
        tokens: ['NVDA', 'NVDB', 'NVDC'],
        untilMin: 60,
        override: (q, world) => {
          if (q.data === v4Buy.castCalldata && world.seen.filter(isQuote).length === 4)
            world.clock += 94 * 60_000;
          return undefined;
        },
      });
      // no second sample of the same tokens a minute before the next run takes its own
      expect(r.rows.map((row) => row.asset)).toEqual(['NVDA']);
      expect(r.summary).toMatchObject({
        rows: 1,
        repins: 0,
        aborted: 'the next scheduled run is due',
      });
      expect(r.summary.tokens.slice(1).map((t) => [t.error, t.retry ?? false])).toEqual([
        ['not tried: the next scheduled run is due', false],
        ['not tried: the next scheduled run is due', false],
      ]);
      expect(r.seen).toHaveLength(2 + 1 + 4);
    });
    describe("with a token's quotes on the wire, which then find their block gone", () => {
      const asleepFor = (minutes: number) => {
        let slept = false;
        return run({
          tokens: ['NVDA', 'NVDB', 'NVDC'],
          untilMin: 60,
          override: (q, world) => {
            // the second token's quotes, at the first block
            if (isQuote(q) && q.tag === tag && world.seen.filter(isQuote).length > 4) {
              if (!slept) {
                slept = true;
                world.clock += minutes * 60_000;
              }
              return { error: { code: -32000, message: HISTORICAL_STATE } };
            }
            return undefined;
          },
        });
      };

      it('does not finish that token on a fresh block once the next run is due', async () => {
        const r = await asleepFor(94);
        // one row, from before the pause; nothing is written 34 minutes into the next hour
        expect(r.rows.map((row) => [row.asset, row.slot, row.fetchedAt])).toEqual([
          ['NVDA', BLOCK_A, fx.fetchedAt],
        ]);
        expect(r.summary).toMatchObject({
          rows: 1,
          repins: 0,
          aborted: 'the next scheduled run is due',
        });
        expect(r.summary.tokens.map((t) => [t.asset, t.error ?? null, t.retry ?? false])).toEqual([
          ['NVDA', null, false],
          ['NVDB', 'not measured: the next scheduled run is due', false],
          ['NVDC', 'not tried: the next scheduled run is due', false],
        ]);
        expect(r.summary.tokens[1]).toMatchObject({ sell10k: null, sell50k: null });
        // no fresh block was asked for, and nothing was read at any other block
        expect(r.seen.filter((q) => q.method === 'eth_getBlockByNumber')).toHaveLength(1);
        expect(calls(r.seen).every((q) => q.tag === tag)).toBe(true);
        expect(r.events).toEqual([]);
      });
      it('finishes it on a fresh block when the machine wakes inside the hour', async () => {
        const r = await asleepFor(30);
        expect(r.rows.map((row) => [row.asset, row.slot])).toEqual([
          ['NVDA', BLOCK_A],
          ['NVDB', BLOCK_B],
          ['NVDC', BLOCK_B],
        ]);
        expect(r.summary).toMatchObject({ rows: 3, repins: 1 });
        expect(r.summary.aborted).toBeUndefined();
        expect(r.events).toEqual([
          {
            event: 'repinned',
            reason: 'block_gone',
            asset: 'NVDB',
            fromBlock: BLOCK_A,
            error: HISTORICAL_STATE,
          },
        ]);
      });
    });
    it('uses a limit of a few minutes', () => {
      expect(MAX_PIN_AGE_MS).toBeGreaterThanOrEqual(60_000);
      expect(MAX_PIN_AGE_MS).toBeLessThanOrEqual(5 * 60_000);
    });
  });

  describe('when the network is down', () => {
    it('stops at the first token it cannot reach and marks the rest for another try', async () => {
      const r = await run({
        tokens: ['NVDA', 'NVDB', 'NVDC'],
        override: (q, world) =>
          isQuote(q) && world.seen.filter(isQuote).length > 4 ? 'unreachable' : undefined,
      });
      expect(r.rows.map((row) => row.asset)).toEqual(['NVDA']);
      expect(r.summary).toMatchObject({
        rows: 1,
        aborted: 'RPC unreachable after 3 tries (TypeError ENOTFOUND)',
      });
      expect(r.summary.tokens.map((t) => [t.asset, t.error ?? null, t.retry ?? false])).toEqual([
        ['NVDA', null, false],
        ['NVDB', 'RPC unreachable after 3 tries (TypeError ENOTFOUND)', true],
        ['NVDC', 'not tried: RPC unreachable after 3 tries (TypeError ENOTFOUND)', true],
      ]);
      // nothing was asked for the third token
      expect(r.seen.filter(isQuote)).toHaveLength(5);
    });
    it('fails as a whole when even the first call cannot get through', async () => {
      await expect(
        collectOnce(robinhood, {
          dir: mkdtempSync(join(tmpdir(), 'risk-evm-run-')),
          maxPools: 3,
          minLiquidityUsd: 10_000,
          poolsMaxAgeHours: 24,
          rediscover: false,
          rpc: {
            batch: async () => {
              throw new RpcUnreachable('RPC unreachable after 3 tries (TypeError ENOTFOUND)');
            },
            call: async () => {
              throw new Error('unexpected call');
            },
            stats: () => ({ httpRequests: 0, rpcCalls: 0 }),
          },
          log: () => {},
        }),
      ).rejects.toBeInstanceOf(RpcUnreachable);
    });
    it('stops the same way when the price call or a fresh block cannot get through', async () => {
      const prices = await run({
        tokens: ['NVDA', 'NVDB'],
        override: (q) => (mids.has(q.data) ? 'unreachable' : undefined),
      });
      expect(prices.rows).toEqual([]);
      expect(prices.summary.tokens.map((t) => t.retry)).toEqual([true, true]);
      expect(prices.seen.filter(isQuote)).toEqual([]);

      const repin = await run({
        override: (q) => (q.data === v3Sell ? { error: { message: LAYER_STALE } } : undefined),
        onRepin: () => 'unreachable',
      });
      expect(repin.rows).toEqual([]);
      expect(repin.summary).toMatchObject({
        rows: 0,
        aborted: 'RPC unreachable after 3 tries (TypeError ENOTFOUND)',
      });
      expect(repin.summary.tokens[0]).toMatchObject({ retry: true, sell10k: null });
    });
    it('stops, and keeps the hour open, when the endpoint refuses the fresh block', async () => {
      // the state is gone for the first token, then the call for a new block is refused for rate
      const r = await run({
        tokens: ['NVDA', 'NVDB', 'NVDC'],
        override: (q) =>
          q.data === v3Sell && q.tag === tag ? { error: { message: HISTORICAL_STATE } } : undefined,
        onRepin: () => ({ error: { code: -32016, message: 'over rate limit' } }),
      });
      const refusal = 'no fresh block: eth_getBlockByNumber: over rate limit';
      expect(r.rows).toEqual([]);
      expect(r.summary).toMatchObject({ rows: 0, aborted: refusal });
      expect(r.summary.tokens.map((t) => [t.asset, t.error, t.retry ?? false])).toEqual([
        ['NVDA', refusal, true],
        ['NVDB', `not tried: ${refusal}`, true],
        ['NVDC', `not tried: ${refusal}`, true],
      ]);
      // one refusal ends the run: the other tokens do not each ask for a block in turn
      expect(r.seen.filter((q) => q.method === 'eth_getBlockByNumber')).toHaveLength(2);

      // so the hour tries all three again, instead of ending after one attempt with nothing to retry
      let clock = 0;
      const tried: Array<string[] | null> = [];
      const outcome = await runSlot({
        attempt: async (only, n) => {
          tried.push(only ? [...only] : null);
          return n === 1 ? attemptOf(r.summary) : { rows: [...(only ?? [])], missing: [] };
        },
        retryAfterMs: [2 * 60_000],
        until: 3_600_000,
        marginMs: 2 * 60_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        stopped: () => false,
      });
      expect(tried).toEqual([null, ['NVDA', 'NVDB', 'NVDC']]);
      expect(outcome).toMatchObject({ attempts: 2, ended: 'complete', missing: [] });
      expect(outcome.rows).toEqual(['NVDA', 'NVDB', 'NVDC']);
    });
    it('does the same when the run was paused and the fresh block it then asks for is refused', async () => {
      const r = await run({
        tokens: ['NVDA', 'NVDB'],
        override: (q, world) => {
          if (q.data === v4Buy.castCalldata && world.seen.filter(isQuote).length === 4)
            world.clock += 30 * 60_000;
          return undefined;
        },
        onRepin: () => ({ error: { message: 'Request timeout on the free plan' } }),
      });
      expect(r.rows.map((row) => row.asset)).toEqual(['NVDA']);
      expect(r.summary.tokens[1]).toMatchObject({
        error: 'no fresh block: eth_getBlockByNumber: Request timeout on the free plan',
        retry: true,
      });
    });
    it('says which gaps are not worth another try: no pool, or a call that reverted', async () => {
      const r = await run({
        tokens: ['NOPOOL', 'NVDA', 'NVDB', 'LATER'],
        noPools: ['NOPOOL', 'LATER'],
        override: (q, world) => {
          const quotes = world.seen.filter(isQuote).length;
          if (q.data === v3Sell && quotes === 1)
            return { error: { message: 'execution reverted' } };
          return isQuote(q) && quotes > 4 ? 'unreachable' : undefined;
        },
      });
      expect(r.rows).toEqual([]);
      expect(r.summary.tokens.map((t) => [t.asset, t.error, t.retry ?? false])).toEqual([
        ['NOPOOL', 'no eligible pool', false],
        ['NVDA', `sell quote from pool ${fx.v3.pool.id} failed: execution reverted`, false],
        ['NVDB', 'RPC unreachable after 3 tries (TypeError ENOTFOUND)', true],
        // not reached, and it has no pool anyway: nothing to retry
        ['LATER', 'no eligible pool', false],
      ]);
    });
    it('measures only the tokens it is asked for on a second attempt', async () => {
      const r = await run({ tokens: ['NVDA', 'NVDB', 'NVDC'], only: new Set(['NVDB', 'NVDC']) });
      expect(r.rows.map((row) => row.asset)).toEqual(['NVDB', 'NVDC']);
      expect(r.summary.tokens.map((t) => t.asset)).toEqual(['NVDB', 'NVDC']);
      expect(mids.get(calls(r.seen)[0]?.data as string)).toBe(2);
    });
  });
});

describe('second chances within the hour', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const down = { error: 'RPC unreachable after 3 tries (TypeError ENOTFOUND)', retry: true };
  /** `script[n]` is what attempt n+1 does; the clock moves only when runSlot waits. */
  async function slot(
    script: Array<Attempt | Error>,
    opts: {
      until?: number;
      retryAfterMin?: number[];
      stopAfterSleeps?: number;
      /** The machine sleeps this long during the first wait. */
      asleepMs?: number;
    } = {},
  ) {
    let now = 0;
    let sleeps = 0;
    const tried: Array<{ at: number; only: string[] | null }> = [];
    const outcome = await runSlot({
      attempt: async (only, n) => {
        tried.push({ at: now, only: only ? [...only] : null });
        const step = script[n - 1];
        if (!step) throw new Error('more attempts than the test expects');
        if (step instanceof Error) throw step;
        return step;
      },
      retryAfterMs: (opts.retryAfterMin ?? [2, 4, 8, 16]).map((m) => m * MIN),
      until: opts.until ?? HOUR,
      marginMs: 2 * MIN,
      now: () => now,
      sleep: async (ms) => {
        now += sleeps++ === 0 && opts.asleepMs ? opts.asleepMs : ms;
      },
      stopped: () => opts.stopAfterSleeps !== undefined && sleeps >= opts.stopAfterSleeps,
    });
    return { outcome, tried, endedAt: now };
  }
  const all = (...assets: string[]): Attempt => ({ rows: assets, missing: [] });

  it('does not retry a run that wrote every row', async () => {
    const r = await slot([all('NVDA', 'SPY')]);
    expect(r.outcome).toEqual({
      attempts: 1,
      rows: ['NVDA', 'SPY'],
      missing: [],
      error: null,
      ended: 'complete',
    });
  });
  it('tries again after two minutes, then four, when the network was down, so a ten-minute outage keeps the hour', async () => {
    const r = await slot([
      new Error(down.error),
      new Error(down.error),
      new Error(down.error),
      all('NVDA', 'SPY'),
    ]);
    // attempts at 0, 2, 6 and 14 minutes: the outage ended somewhere between minute 6 and 14
    expect(r.tried.map((t) => t.at / MIN)).toEqual([0, 2, 6, 14]);
    expect(r.tried.every((t) => t.only === null)).toBe(true);
    expect(r.outcome).toMatchObject({ attempts: 4, rows: ['NVDA', 'SPY'], ended: 'complete' });
    expect(r.outcome.error).toBeNull();
  });
  it('retries only the tokens that are missing for a reason that may pass', async () => {
    const r = await slot([
      {
        rows: ['SPY'],
        missing: [
          { asset: 'NVDA', ...down },
          { asset: 'GLD', ...down },
          { asset: 'SLV', error: 'no eligible pool', retry: false },
        ],
      },
      { rows: ['NVDA'], missing: [{ asset: 'GLD', ...down }] },
      all('GLD'),
    ]);
    expect(r.tried.map((t) => t.only)).toEqual([null, ['NVDA', 'GLD'], ['GLD']]);
    expect(r.outcome).toEqual({
      attempts: 3,
      rows: ['SPY', 'NVDA', 'GLD'],
      missing: [{ asset: 'SLV', error: 'no eligible pool' }],
      error: null,
      ended: 'nothing to retry',
    });
  });
  it('does not retry a token whose pools are the reason', async () => {
    const r = await slot([
      { rows: [], missing: [{ asset: 'SLV', error: 'no pool gave a sell quote', retry: false }] },
    ]);
    expect(r.outcome).toMatchObject({ attempts: 1, ended: 'nothing to retry' });
  });
  it('gives up after the last wait and says what is still missing and why', async () => {
    const r = await slot([1, 2, 3, 4, 5].map(() => new Error(down.error)));
    expect(r.tried.map((t) => t.at / MIN)).toEqual([0, 2, 6, 14, 30]);
    expect(r.outcome).toEqual({
      attempts: 5,
      rows: [],
      missing: [],
      error: down.error,
      ended: 'out of attempts',
    });
  });
  it('keeps the rows it has, and the reasons, when the retries run out or a later attempt fails', async () => {
    const stillDown = { rows: [], missing: [{ asset: 'GLD', ...down }] };
    const out = await slot([
      { rows: ['SPY'], missing: [{ asset: 'GLD', ...down }] },
      stillDown,
      stillDown,
      stillDown,
      stillDown,
    ]);
    expect(out.outcome).toEqual({
      attempts: 5,
      rows: ['SPY'],
      missing: [{ asset: 'GLD', error: down.error }],
      error: null,
      ended: 'out of attempts',
    });
    const thrown = await slot(
      [
        { rows: ['SPY'], missing: [{ asset: 'GLD', ...down }] },
        new Error('another run holds the lock'),
      ],
      { retryAfterMin: [2] },
    );
    expect(thrown.tried.map((t) => t.only)).toEqual([null, ['GLD']]);
    expect(thrown.outcome).toEqual({
      attempts: 2,
      rows: ['SPY'],
      missing: [{ asset: 'GLD', error: down.error }],
      error: 'another run holds the lock',
      ended: 'out of attempts',
    });
  });
  it('never starts a retry within two minutes of the next scheduled run', async () => {
    // the next run is due at minute 15: a retry at minute 14 would run into it
    const r = await slot(
      [1, 2, 3].map(() => new Error(down.error)),
      { until: 15 * MIN },
    );
    expect(r.tried.map((t) => t.at / MIN)).toEqual([0, 2, 6]);
    expect(r.outcome).toMatchObject({ attempts: 3, ended: 'next run is due', error: down.error });
    // and it does not sit out the wait first: the hour's summary is written at once
    expect(r.endedAt).toBe(6 * MIN);
  });
  it('gives the hour up when the machine slept through the wait into the next run', async () => {
    const r = await slot([new Error(down.error)], { asleepMs: 2 * HOUR });
    expect(r.tried).toHaveLength(1);
    expect(r.outcome).toMatchObject({ attempts: 1, ended: 'next run is due' });
  });
  describe('with the waits the loop uses', () => {
    /** The network is down for `minutes`; every attempt that starts before it is back fails. */
    const outage = (minutes: number, attemptMs = 0) => {
      let now = 0;
      const tried: number[] = [];
      return runSlot({
        attempt: async () => {
          tried.push(now);
          const failed = now < minutes * MIN;
          now += attemptMs;
          if (failed) throw new Error(down.error);
          return all('NVDA', 'SPY');
        },
        retryAfterMs: RETRY_AFTER_MIN.map((m) => m * MIN),
        until: HOUR,
        marginMs: RETRY_MARGIN_MS,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        stopped: () => false,
      }).then((outcome) => ({ outcome, tried: tried.map((t) => t / MIN), endedAt: now / MIN }));
    };

    it('tries at about 2, 6, 14, 30 and 50 minutes, and the last wait ends before the margin', () => {
      const starts = RETRY_AFTER_MIN.map((_, i) =>
        RETRY_AFTER_MIN.slice(0, i + 1).reduce((a, b) => a + b, 0),
      );
      expect(starts).toEqual([2, 6, 14, 30, 50]);
      expect((starts.at(-1) as number) * MIN).toBeLessThan(HOUR - RETRY_MARGIN_MS);
      expect(RETRY_MARGIN_MS).toBe(2 * MIN);
    });
    it('keeps the hour through a 35-minute outage, which a last try at minute 30 would lose', async () => {
      const r = await outage(35);
      expect(r.tried).toEqual([0, 2, 6, 14, 30, 50]);
      expect(r.outcome).toMatchObject({ attempts: 6, rows: ['NVDA', 'SPY'], ended: 'complete' });
      const shorter = await outage(10);
      expect(shorter.tried).toEqual([0, 2, 6, 14]);
      expect(shorter.outcome).toMatchObject({ attempts: 4, ended: 'complete' });
    });
    it('gives the hour up after the sixth attempt and does not wait any longer', async () => {
      const r = await outage(60);
      expect(r.tried).toEqual([0, 2, 6, 14, 30, 50]);
      expect(r.outcome).toMatchObject({
        attempts: 6,
        rows: [],
        error: down.error,
        ended: 'out of attempts',
      });
      expect(r.endedAt).toBe(50);
    });
    it('starts no retry inside the margin even when every failed attempt waits out its timeouts', async () => {
      // three 30 s timeouts and the client's own waits: about 95 s per failed attempt
      const slow = await outage(60, 95_000);
      expect(slow.tried).toHaveLength(6);
      for (const t of slow.tried) expect(t * MIN).toBeLessThanOrEqual(HOUR - RETRY_MARGIN_MS);
      expect(slow.endedAt).toBeLessThan(60);
      // slower still, three minutes each: the last retry is dropped, not run into the next hour
      const slower = await outage(60, 3 * MIN);
      expect(slower.tried).toHaveLength(5);
      expect(slower.outcome).toMatchObject({ attempts: 5, ended: 'next run is due' });
    });
  });
  it('makes one attempt only when no waits are given (a one-off run)', async () => {
    const r = await slot([new Error(down.error)], { retryAfterMin: [], until: Infinity });
    expect(r.outcome).toMatchObject({ attempts: 1, ended: 'out of attempts' });
  });
  it('stops waiting when the collector is told to stop', async () => {
    const r = await slot([new Error(down.error)], { stopAfterSleeps: 1 });
    expect(r.outcome).toMatchObject({ attempts: 1, ended: 'stopped' });
  });
});

describe('run log', () => {
  const HOUR = 3_600_000;
  const t0 = Date.parse('2026-10-03T02:23:42.000Z');
  const chain = { id: 'robinhood', tokens: ['SPY', 'NVDA', 'GLD'] };

  it('counts a token as a row exactly when it has no error', () => {
    expect(
      attemptOf({
        tokens: [
          { asset: 'SPY' },
          {
            asset: 'NVDA',
            error: 'RPC unreachable after 3 tries (TypeError ENOTFOUND)',
            retry: true,
          },
          { asset: 'GLD', error: 'no eligible pool' },
        ],
      }),
    ).toEqual({
      rows: ['SPY'],
      missing: [
        {
          asset: 'NVDA',
          error: 'RPC unreachable after 3 tries (TypeError ENOTFOUND)',
          retry: true,
        },
        { asset: 'GLD', error: 'no eligible pool', retry: false },
      ],
    });
  });
  it('closes each scheduled hour with what it got, what it lacks and why', () => {
    const line = slotLine(
      'slot',
      chain,
      { scheduledAt: t0, startedAt: t0 + 5, finishedAt: t0 + 14 * 60_000 },
      {
        attempts: 3,
        rows: ['SPY', 'NVDA'],
        missing: [{ asset: 'GLD', error: 'no pool gave a sell quote' }],
        error: null,
        ended: 'nothing to retry',
      },
    );
    expect(line).toEqual({
      event: 'slot',
      chain: 'robinhood',
      scheduledAt: '2026-10-03T02:23:42.000Z',
      startedAt: '2026-10-03T02:23:42.005Z',
      finishedAt: '2026-10-03T02:37:42.000Z',
      attempts: 3,
      rows: 2,
      tokens: 3,
      missing: [{ asset: 'GLD', error: 'no pool gave a sell quote' }],
      error: null,
      ended: 'nothing to retry',
    });
    // what the README's gap query selects
    expect(line.event === 'slot' && line.rows < line.tokens).toBe(true);
  });
  it('records an hour with no run at all, and when the collector came back', () => {
    const line = missedLine(chain, t0 + HOUR, t0 + 3 * HOUR + 17 * 60_000);
    expect(line).toEqual({
      event: 'slot',
      chain: 'robinhood',
      scheduledAt: '2026-10-03T03:23:42.000Z',
      attempts: 0,
      rows: 0,
      tokens: 3,
      missing: [],
      error:
        'not run: the collector was asleep or still on an earlier run at this hour; it came back at 2026-10-03T05:40:42.000Z',
      ended: 'missed',
    });
    expect(line.rows < line.tokens).toBe(true);
    // and an hour the collector came back too late for
    expect(missedLine(chain, t0 + 2 * HOUR, t0 + 2 * HOUR + 58 * 60_000, 'late')).toMatchObject({
      scheduledAt: '2026-10-03T04:23:42.000Z',
      rows: 0,
      ended: 'missed',
      error:
        'not run: the collector came back at 2026-10-03T05:21:42.000Z, with less than half the interval left before the next run',
    });
  });
  it('keeps a run started by hand out of the hourly sample', () => {
    const line = slotLine(
      'one_off',
      chain,
      { scheduledAt: t0, startedAt: t0, finishedAt: t0 },
      {
        attempts: 1,
        rows: [],
        missing: [],
        error: 'another run holds the lock',
        ended: 'out of attempts',
      },
    );
    expect(line.event).toBe('one_off');
  });
});

describe('RPC client', () => {
  const reply = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body }) as Response;
  const client = (answers: Array<(body: Array<{ id: number }>) => Response | Error>) => {
    const sent: unknown[] = [];
    const rpc = createRpc('https://rpc.invalid/v2/a-key', {
      sleep: async () => {},
      fetch: (async (_url: unknown, init: { body: string }) => {
        const body = JSON.parse(init.body);
        sent.push(body);
        const next = answers.shift();
        if (!next) throw new Error('unexpected request');
        const out = next(body);
        if (out instanceof Error) throw out;
        return out;
      }) as unknown as typeof fetch,
    });
    return { rpc, sent };
  };

  it('sends a batch as one request and returns replies in request order', async () => {
    const { rpc, sent } = client([
      () =>
        reply([
          { id: 1, result: '0xb' },
          { id: 0, result: '0xa' },
        ]),
    ]);
    const got = await rpc.batch([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_blockNumber', params: [] },
    ]);
    expect(got.map((r) => r.result)).toEqual(['0xa', '0xb']);
    expect(sent).toHaveLength(1);
    expect(rpc.stats()).toEqual({ httpRequests: 1, rpcCalls: 2 });
  });
  it('asks again only for the calls an endpoint refused for rate', async () => {
    const { rpc, sent } = client([
      () =>
        reply([
          { id: 0, result: '0xa' },
          { id: 1, error: { code: -32016, message: 'over rate limit' } },
        ]),
      (body) => reply(body.map((r) => ({ id: r.id, result: '0xb' }))),
    ]);
    const got = await rpc.batch([
      { method: 'eth_call', params: ['first'] },
      { method: 'eth_call', params: ['second'] },
    ]);
    expect(got.map((r) => r.result)).toEqual(['0xa', '0xb']);
    expect((sent[1] as Array<{ params: string[] }>).map((r) => r.params[0])).toEqual(['second']);
  });
  it('asks again when the endpoint refuses a whole batch with one error', async () => {
    const { rpc, sent } = client([
      () => reply({ error: { code: 429, message: 'Too Many Requests' } }),
      (body) => reply(body.map((r) => ({ id: r.id, result: '0xc' }))),
    ]);
    const got = await rpc.batch([
      { method: 'eth_call', params: [] },
      { method: 'eth_call', params: [] },
    ]);
    expect(got.map((r) => r.result)).toEqual(['0xc', '0xc']);
    expect(sent).toHaveLength(2);
  });
  it('leaves an error that will not go away, such as out of gas, to the caller', async () => {
    const { rpc, sent } = client([
      () => reply([{ id: 0, error: { code: -32000, message: 'out of gas' } }]),
    ]);
    const [got] = await rpc.batch([{ method: 'eth_call', params: [] }]);
    expect(got?.error?.message).toBe('out of gas');
    expect(sent).toHaveLength(1);
    const { rpc: second } = client([
      () => reply([{ id: 0, error: { message: 'execution reverted' } }]),
    ]);
    await expect(second.call('eth_call', [])).rejects.toThrow('eth_call: execution reverted');
  });
  it('retries a busy or unreachable endpoint and never puts the URL in an error', async () => {
    const { rpc } = client([
      () => reply(null, 503),
      () => new TypeError('fetch failed: https://rpc.invalid/v2/a-key'),
      () => reply([{ id: 0, result: '0x1' }]),
    ]);
    expect(await rpc.call('eth_chainId', [])).toBe('0x1');
    const down = client([1, 2, 3].map(() => () => new TypeError('https://rpc.invalid/v2/a-key')));
    const failure = await down.rpc.call('eth_chainId', []).catch((e: Error) => e);
    // its own error type, so a run can tell "the network is down" from "the endpoint said no"
    expect(failure).toBeInstanceOf(RpcUnreachable);
    expect((failure as Error).message).toBe('RPC unreachable after 3 tries (TypeError)');
    expect((failure as Error).message).not.toContain('a-key');
  });
  it('waits and asks again when a node has not caught up to the block yet', async () => {
    for (const e of rpcErrors.blockGone.slice(3)) {
      const { rpc, sent } = client([
        () => reply([{ id: 0, error: { code: -32000, message: e.message } }]),
        () => reply([{ id: 0, result: '0xd' }]),
      ]);
      expect(await rpc.call('eth_call', []), e.message).toBe('0xd');
      expect(sent).toHaveLength(2);
    }
    // state that is gone does not come back: that one is for the run to handle, with a fresh block
    const { rpc, sent } = client([
      () => reply([{ id: 0, error: { code: -32000, message: HISTORICAL_STATE } }]),
    ]);
    await expect(rpc.call('eth_call', [])).rejects.toThrow(HISTORICAL_STATE);
    expect(sent).toHaveLength(1);
  });
});

describe('injected quoter artefact', () => {
  it('was built from the committed source, which is Apache-2.0', () => {
    const src = readFileSync('scripts/risk-evm/ClQuoter.sol');
    const artefact = JSON.parse(readFileSync('scripts/risk-evm/cl-quoter.json', 'utf8'));
    expect(createHash('sha256').update(src).digest('hex')).toBe(artefact.sourceSha256);
    expect(src.toString()).toMatch(/^\/\/ SPDX-License-Identifier: Apache-2\.0/);
    expect(artefact.deployedBytecode).toMatch(/^0x[0-9a-f]{200,}$/);
    // quote(address,bool,uint256[],uint256), uniswapV3SwapCallback(int256,int256,bytes), error Q(int256,int256)
    for (const selector of ['186ccfa5', 'fa461e33', '4ca9c7f9'])
      expect(artefact.deployedBytecode).toContain(selector);
  });
});

describe('hourly loop', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  // a clock that only moves when the loop sleeps, a run takes time, or the machine sleeps
  function harness(
    durations: number[],
    failAt: number[] = [],
    /** After run n the machine sleeps and wakes at this time. */
    wakeAt: Record<number, number> = {},
    opts: { intervalMs?: number; runs?: number } = {},
  ) {
    let now = 0;
    let active = 0;
    let overlapped = false;
    const starts: number[] = [];
    const slots: Array<{ at: number; until: number }> = [];
    const missed: number[] = [];
    const tooLate: number[] = [];
    const errors: unknown[] = [];
    const done = runLoop({
      runOnce: async (slot) => {
        if (active > 0) overlapped = true;
        active++;
        const n = starts.push(now) - 1;
        slots.push(slot);
        await Promise.resolve();
        now += durations[n] ?? 1_000;
        active--;
        if (failAt.includes(n)) throw new Error(`run ${n} failed`);
      },
      intervalMs: opts.intervalMs ?? HOUR,
      now: () => now,
      sleep: async (ms) => {
        const wake = wakeAt[starts.length - 1];
        if (wake !== undefined) {
          delete wakeAt[starts.length - 1];
          now = wake;
        } else now += ms;
      },
      stopped: () => starts.length >= (opts.runs ?? 4) && active === 0,
      onError: (e) => errors.push(e),
      onMissed: (at, why) => {
        missed.push(at);
        if (why === 'late') tooLate.push(at);
      },
    });
    return done.then(() => ({
      starts,
      slots,
      missed,
      tooLate,
      errors,
      overlapped: () => overlapped,
    }));
  }

  it('runs at once, then once an hour, and tells each run when the next is due', async () => {
    const r = await harness([]);
    expect(r.starts).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
    expect(r.slots).toEqual([0, 1, 2, 3].map((k) => ({ at: k * HOUR, until: (k + 1) * HOUR })));
    expect(r.missed).toEqual([]);
  });
  it('logs a failed run and carries on', async () => {
    const r = await harness([], [1]);
    expect(r.starts).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
    expect(r.errors.map(String)).toEqual(['Error: run 1 failed']);
  });
  it('never overlaps: after a run longer than an hour, the hour it ran through is recorded as missed', async () => {
    const r = await harness([1_000, 2.5 * HOUR]);
    // the second run ends at 3.5 h: the 2 h slot is gone, the 3 h slot is run late, then 4 h on time
    expect(r.starts).toEqual([0, HOUR, 3.5 * HOUR, 4 * HOUR]);
    expect(r.slots.map((s) => s.at)).toEqual([0, HOUR, 3 * HOUR, 4 * HOUR]);
    expect(r.missed).toEqual([2 * HOUR]);
    expect(r.tooLate).toEqual([]);
    expect(r.overlapped()).toBe(false);
  });
  it('after a sleeping machine wakes in the first half of an hour, runs that hour once, late', async () => {
    // asleep from just after the first run until 4 h 20 min: 40 minutes are left before 5 h
    const r = await harness([], [], { 0: 4 * HOUR + 20 * MIN });
    expect(r.missed).toEqual([HOUR, 2 * HOUR, 3 * HOUR]);
    expect(r.tooLate).toEqual([]);
    expect(r.slots[1]).toEqual({ at: 4 * HOUR, until: 5 * HOUR });
    expect(r.starts).toEqual([0, 4 * HOUR + 20 * MIN, 5 * HOUR, 6 * HOUR]);
    expect(r.overlapped()).toBe(false);
  });
  it('after it wakes in the second half, records that hour as missed too and waits for the grid', async () => {
    // 4 h 40 min: a run now and the 5 h run would be 20 minutes apart
    const r = await harness([], [], { 0: 4 * HOUR + 40 * MIN });
    expect(r.missed).toEqual([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
    expect(r.tooLate).toEqual([4 * HOUR]);
    expect(r.starts).toEqual([0, 5 * HOUR, 6 * HOUR, 7 * HOUR]);
    expect(r.slots[1]).toEqual({ at: 5 * HOUR, until: 6 * HOUR });

    // two minutes before the hour: no sample at minute 298 and another at minute 300
    const close = await harness([], [], { 0: 4 * HOUR + 58 * MIN });
    expect(close.starts).toEqual([0, 5 * HOUR, 6 * HOUR, 7 * HOUR]);
    expect(close.tooLate).toEqual([4 * HOUR]);
  });
  it('draws the line at half the interval, whatever the interval is', async () => {
    // exactly half left: still run
    const at = await harness([], [], { 0: 4.5 * HOUR }, { runs: 2 });
    expect(at.starts).toEqual([0, 4.5 * HOUR]);
    expect(at.tooLate).toEqual([]);
    // a millisecond less than half: missed
    const past = await harness([], [], { 0: 4.5 * HOUR + 1 }, { runs: 2 });
    expect(past.starts).toEqual([0, 5 * HOUR]);
    expect(past.tooLate).toEqual([4 * HOUR]);
    // a ten-minute grid: the line is at five minutes
    const ten = { intervalMs: 10 * MIN, runs: 2 };
    const early = await harness([], [], { 0: 44 * MIN }, ten);
    expect(early.starts).toEqual([0, 44 * MIN]);
    expect(early.slots[1]).toEqual({ at: 40 * MIN, until: 50 * MIN });
    const late = await harness([], [], { 0: 46 * MIN }, ten);
    expect(late.starts).toEqual([0, 50 * MIN]);
    expect(late.missed).toEqual([10 * MIN, 20 * MIN, 30 * MIN, 40 * MIN]);
    expect(late.tooLate).toEqual([40 * MIN]);
  });
  it('runs are never closer than half the interval, however the machine sleeps', async () => {
    for (const wake of [61, 89, 90, 91, 119, 120, 121, 179, 181, 299]) {
      const r = await harness([], [], { 0: wake * MIN, 1: (wake + 95) * MIN }, { runs: 4 });
      const gaps = r.starts.slice(1).map((t, i) => t - (r.starts[i] as number));
      expect(Math.min(...gaps), `wake at minute ${wake}`).toBeGreaterThanOrEqual(HOUR / 2);
      expect(r.overlapped()).toBe(false);
    }
  });
});

describe('run lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-evm-lock-'));
  const held = (pid: number, startedAt = new Date().toISOString()) => {
    const path = join(dir, `${pid}-${Math.random()}.lock`);
    writeFileSync(path, JSON.stringify({ pid, startedAt }));
    return path;
  };

  it('is refused while a live process holds it, and free again once released', () => {
    const path = join(dir, 'a.lock');
    const release = acquireLock(path);
    expect(release).toBeTypeOf('function');
    release?.();
    expect(acquireLock(path)).toBeTypeOf('function');
    expect(acquireLock(held(process.ppid))).toBeNull();
  });
  it('is not removed by a process that no longer holds it', () => {
    const path = join(dir, 'b.lock');
    const release = acquireLock(path);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    release?.();
    expect(existsSync(path)).toBe(true);
  });
  it('is taken over from a process that is gone, or when it is older than a run can be', () => {
    expect(acquireLock(held(2 ** 30))).toBeTypeOf('function');
    const old = new Date(Date.now() - 3_600_000).toISOString();
    expect(acquireLock(held(process.ppid, old), 15 * 60_000)).toBeTypeOf('function');
    expect(acquireLock(held(process.ppid, old))).toBeNull();
  });
});
