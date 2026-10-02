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
import { createRpc, type Rpc, type RpcReply, type RpcRequest } from '../scripts/risk-evm/rpc';
import { collectOnce, decodeQuotes, quoteRequest } from '../scripts/risk-evm/run';

// REVM-1. Nothing here may reach the network: the chain's answers come from a recorded fixture.
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('a risk-evm test tried to call the network');
  });
});

const robinhood = CHAINS.find((c) => c.id === 'robinhood') as (typeof CHAINS)[number];
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

describe('one run, replayed from the recording', () => {
  const fx = JSON.parse(
    readFileSync('fixtures/risk-evm/robinhood-nvda-quotes.json', 'utf8'),
  ) as Fixture;
  const tag = `0x${fx.block.toString(16)}`;
  const chain = { ...robinhood, tokens: robinhood.tokens.filter((t) => t.symbol === 'NVDA') };
  const recorded = new Map<string, string>();
  for (const f of [fx.v3, fx.v4]) for (const s of f.sides) recorded.set(s.castCalldata, s.result);
  const midsCall = encodeAggregate3([
    { target: fx.v3.pool.id, callData: '0x3850c7bd' },
    { target: robinhood.v4?.stateView as string, callData: encodeGetSlot0(fx.v4.pool.id) },
  ]);
  const v3Sell = fx.v3.sides[0]?.castCalldata as string;
  const v4Buy = fx.v4.sides[1] as Fixture['v4']['sides'][number];

  /** Runs collectOnce against a client that answers from the fixture, unless `override` answers first. */
  async function run(override: (data: string) => RpcReply | undefined = () => undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'risk-evm-run-'));
    writeFileSync(
      join(dir, 'pools-robinhood.json'),
      JSON.stringify({
        chain: 'robinhood',
        chainId: 4663,
        discoveredAt: new Date().toISOString(),
        source: 'test',
        method: 'test',
        maxPools: 3,
        tokens: { NVDA: { address: NVDA.address, pools: [fx.v3.pool, fx.v4.pool], skipped: {} } },
      }),
    );
    const seen: RpcRequest[] = [];
    const answer = (r: RpcRequest): RpcReply => {
      seen.push(r);
      if (r.method === 'eth_chainId') return { result: '0x1237' };
      if (r.method === 'eth_getBlockByNumber')
        return {
          result: { number: tag, timestamp: `0x${(Date.parse(fx.fetchedAt) / 1000).toString(16)}` },
        };
      const [call] = r.params as [{ data: string }];
      const forced = override(call.data);
      if (forced) return forced;
      if (call.data === midsCall)
        return {
          result: aggregate3Result([
            { success: true, data: fx.v3.slot0 },
            { success: true, data: fx.v4.slot0 },
          ]),
        };
      const result = recorded.get(call.data);
      return result ? { result } : { error: { message: 'not in the recording' } };
    };
    const rpc: Rpc = {
      batch: async (requests) => requests.map(answer),
      call: async <T>(method: string, params: unknown[]) => answer({ method, params }).result as T,
      stats: () => ({ httpRequests: 0, rpcCalls: seen.length }),
    };
    const events: Record<string, unknown>[] = [];
    const summary = await collectOnce(chain, {
      dir,
      maxPools: 3,
      minLiquidityUsd: 10_000,
      poolsMaxAgeHours: 24,
      rediscover: false,
      env: { RISK_EVM_RH_RPC_URL: 'https://example.invalid/v2/a-key' },
      rpc,
      log: (e) => events.push(e),
    });
    const file = join(dir, 'assets', `${fx.fetchedAt.slice(0, 10)}.jsonl`);
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    return { summary, events, seen, rows: lines.map((l) => parseRow(JSON.parse(l))) };
  }

  it('writes one row at the pinned block, in seven calls, without the RPC URL', async () => {
    const r = await run();
    expect(r.summary).toMatchObject({ rows: 1, block: fx.block, poolsRediscovered: false });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as NonNullable<(typeof r.rows)[number]>;
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
    expect(r.summary.tokens[0]?.sell10k).toBe(row.sell[3]?.costPct);
    expect(row.sell.map((p) => p.quoted)).toEqual([2, 2, 2, 2, 2, 1, 1, 1]);
    // chain id and block, the mids, then one call per pool and side
    expect(r.seen).toHaveLength(7);
    const calls = r.seen.filter((q) => q.method === 'eth_call');
    expect(calls.every((q) => q.params[1] === tag)).toBe(true);
    // the URL from the environment may carry a key: it is named, never written
    expect(row.source).toContain('the RPC in RISK_EVM_RH_RPC_URL');
    expect(JSON.stringify([row, r.summary, r.events])).not.toMatch(/example\.invalid|a-key/);
  });
  it('writes no row when the deepest pool did not answer, rather than pass off the thin one', async () => {
    const r = await run((data) =>
      data === v3Sell ? { error: { code: -32016, message: 'over rate limit' } } : undefined,
    );
    expect(r.rows).toEqual([]);
    expect(r.summary.rows).toBe(0);
    expect(r.summary.tokens[0]?.error).toMatch(
      /sell quote from pool 0xd4EB.* failed: over rate limit/,
    );
  });
  it('asks a v4 pool again with fewer sizes when the call runs out of gas', async () => {
    const all = decodeAggregate3(v4Buy.result);
    const r = await run((data) => {
      if (data === v4Buy.castCalldata) return { error: { message: 'out of gas' } };
      // the second try carries seven sizes, so it is not in the recording
      const known = data === midsCall || recorded.has(data);
      return known ? undefined : { result: aggregate3Result(all.slice(0, 7)) };
    });
    expect(r.seen).toHaveLength(8);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.buy.map((p) => p.quoted)).toEqual([2, 2, 2, 2, 2, 1, 1, 1]);
  });
  it('leaves out a pool that is still out of gas after three smaller tries, and says so', async () => {
    const r = await run((data) =>
      data === midsCall || (recorded.has(data) && data !== v4Buy.castCalldata)
        ? undefined
        : { error: { message: 'out of gas' } },
    );
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
        { ...chain, chainId: 46630 },
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
    const failure = await down.rpc.call('eth_chainId', []).catch((e: Error) => e.message);
    expect(failure).toBe('RPC unreachable after 3 tries (TypeError)');
    expect(failure).not.toContain('a-key');
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
  const HOUR = 3_600_000;
  // a clock that only moves when the loop sleeps or a run takes time
  function harness(durations: number[], failAt: number[] = []) {
    let now = 0;
    let active = 0;
    let overlapped = false;
    const starts: number[] = [];
    const errors: unknown[] = [];
    const done = runLoop({
      runOnce: async () => {
        if (active > 0) overlapped = true;
        active++;
        const n = starts.push(now) - 1;
        await Promise.resolve();
        now += durations[n] ?? 1_000;
        active--;
        if (failAt.includes(n)) throw new Error(`run ${n} failed`);
      },
      intervalMs: HOUR,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      stopped: () => starts.length >= 4 && active === 0,
      onError: (e) => errors.push(e),
    });
    return done.then(() => ({ starts, errors, overlapped: () => overlapped }));
  }

  it('runs at once, then once an hour', async () => {
    const r = await harness([]);
    expect(r.starts).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
  });
  it('logs a failed run and carries on', async () => {
    const r = await harness([], [1]);
    expect(r.starts).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
    expect(r.errors.map(String)).toEqual(['Error: run 1 failed']);
  });
  it('never overlaps: a run longer than an hour pushes the next one to the following slot', async () => {
    const r = await harness([1_000, 2.5 * HOUR]);
    expect(r.starts).toEqual([0, HOUR, 4 * HOUR, 5 * HOUR]);
    expect(r.overlapped()).toBe(false);
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
