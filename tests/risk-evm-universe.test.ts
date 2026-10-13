import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { trackedSet } from '@colosseum/risk';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeSymbol, intWord, TOPIC } from '../scripts/risk-evm/abi';
import { CHAINS } from '../scripts/risk-evm/config';
import {
  type DiscoverOptions,
  type DiscoveryFile,
  runDiscovery,
  scanCreated,
} from '../scripts/risk-evm/discover-run';
import {
  allowedSpan,
  amountsInBand,
  bandTicks,
  bitmapWords,
  blockWindows,
  type Candidate,
  creationFilters,
  decodeV3Created,
  decodeV4Created,
  dexPools,
  fileUnder,
  gapsFor,
  isIdle,
  mergeCandidates,
  money,
  type PoolState,
  priceFromDollarPools,
  type RawLog,
  reach,
  summarize,
  ticksOfWord,
  tooManyLogs,
  usdPerRawFromPool,
  ZERO_ADDRESS,
} from '../scripts/risk-evm/discovery';
import type { Reply } from '../scripts/risk-evm/multicall';
import {
  confirmTokens,
  parseRegistry,
  stamp,
  tokenChecks,
  type UniverseToken,
} from '../scripts/risk-evm/registry';
import { replayRpc } from '../scripts/risk-evm/replay';
import type { RpcReply, RpcRequest } from '../scripts/risk-evm/rpc';

// PLAN-UNIVERSE RU.2. Nothing here may reach the network: the chain's and the two APIs' answers come
// from fixtures/risk-evm/robinhood-discovery.json.gz, recorded by scripts/risk-evm/record-discovery-fixture.ts.
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('a risk-evm test tried to call the network');
  });
});

type Fixture = {
  provenance: string;
  source: string;
  method: string;
  fetchedAt: string;
  block: number;
  fromBlock: number;
  options: { band: number; minRefUsd: number; minSideUsd: number };
  registry: { assets: Array<Record<string, unknown>> };
  tokenChecks: Reply[];
  gets: Record<string, unknown>;
  answers: Record<string, RpcReply>;
  knownLogs: { v3: RawLog; v4: RawLog };
  counts: DiscoveryFile['counts'];
  fallbackCounts: DiscoveryFile['counts'];
  bandCheck: DiscoveryFile['bandCheck'];
  refusals: Record<string, { from: string; when: string; message: string }>;
};
const fx = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk-evm/robinhood-discovery.json.gz')).toString('utf8'),
) as Fixture;
const quotes = JSON.parse(readFileSync('fixtures/risk-evm/robinhood-nvda-quotes.json', 'utf8')) as {
  v3: { pool: { id: string; fee: number; tickSpacing: number } };
  v4: { pool: { id: string; fee: number; tickSpacing: number; key: { hooks: string } } };
};
const robinhood = CHAINS.find((c) => c.id === 'robinhood') as (typeof CHAINS)[0];
const USDG = robinhood.dollar.address.toLowerCase();
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C';

describe('fixture', () => {
  it('says where it came from', () => {
    expect(fx.provenance).toBe('fixture');
    for (const k of ['source', 'method', 'fetchedAt'] as const) expect(fx[k]).toBeTruthy();
  });
});

describe('token list from the registry', () => {
  it('keeps the tokens deployed on the chain, keyed on the address', () => {
    const { tokens, skipped } = parseRegistry(fx.registry, 4663);
    expect(skipped).toEqual([]);
    expect(tokens.map((t) => [t.symbol, t.address, t.decimals])).toEqual(
      expect.arrayContaining([
        ['NVDA', NVDA, 18],
        ['SPY', SPY, 18],
      ]),
    );
    expect(tokens).toHaveLength(2);
  });

  it('leaves out an entry with no deployment here, a bad address or a second listing, with the reason', () => {
    const asset = (symbol: string, d: unknown) => ({
      tokenSymbol: symbol,
      tokenDecimals: 18,
      deployments: d,
    });
    const { tokens, skipped } = parseRegistry(
      {
        assets: [
          asset('A', [{ chainId: 4663, contractAddress: NVDA }]),
          asset('B', [{ chainId: 1, contractAddress: SPY }]),
          asset('C', [{ chainId: 4663, contractAddress: '0x1234' }]),
          // the same address again, under another symbol and another spelling
          asset('D', [{ chainId: 4663, contractAddress: NVDA.toLowerCase() }]),
          { tokenSymbol: 'E', deployments: [{ chainId: 4663, contractAddress: SPY }] },
        ],
      },
      4663,
    );
    expect(tokens.map((t) => t.symbol)).toEqual(['A']);
    expect(skipped).toEqual([
      { symbol: 'B', reason: 'no_deployment_on_this_chain' },
      { symbol: 'C', reason: 'not_an_address' },
      { symbol: 'D', reason: 'address_listed_twice' },
      { symbol: 'E', reason: 'no_decimals' },
    ]);
    expect(() => parseRegistry({ nothing: true }, 4663)).toThrow(/no list of assets/);
  });

  it('confirms each address by the answers the chain gave', () => {
    const { tokens } = parseRegistry(fx.registry, 4663);
    expect(tokenChecks(tokens)).toHaveLength(4);
    const checked = confirmTokens(tokens, fx.tokenChecks);
    for (const t of checked) {
      expect(t.confirmed).toBe(true);
      expect(t.onchain).toEqual({ symbol: t.symbol, decimals: 18 });
    }
  });

  it('does not confirm a contract that is silent or says something else', () => {
    const { tokens } = parseRegistry(fx.registry, 4663);
    const [dec, sym] = fx.tokenChecks as [Reply, Reply];
    const other = fx.tokenChecks[3] as Reply; // the second token's symbol
    const silent = { success: false, data: '0x' };
    const six = { success: true, data: `0x${'0'.repeat(63)}6` };
    const got = (replies: Reply[]) => confirmTokens(tokens.slice(0, 1), replies)[0];
    expect(got([silent, sym])).toMatchObject({
      confirmed: false,
      reason: 'no_answer_from_the_contract',
    });
    expect(got([six, sym])).toMatchObject({ confirmed: false, reason: 'decimals_differ' });
    expect(got([dec, other])).toMatchObject({ confirmed: false, reason: 'symbol_differs' });
    expect(() => confirmTokens(tokens, [dec])).toThrow(/answers/);
  });

  it('reads a symbol as a string or as bytes32, and refuses what is not text', () => {
    const str = `0x${'0'.repeat(62)}20${'0'.repeat(63)}4${Buffer.from('NVDA').toString('hex').padEnd(64, '0')}`;
    expect(decodeSymbol(str)).toBe('NVDA');
    expect(decodeSymbol(`0x${Buffer.from('MKR').toString('hex').padEnd(64, '0')}`)).toBe('MKR');
    expect(decodeSymbol('0x')).toBeNull();
    expect(decodeSymbol(`0x${'ff'.repeat(32)}`)).toBeNull();
  });

  it('stamps a file name to the minute, in UTC', () => {
    expect(stamp(new Date('2026-10-05T18:05:59.000Z'))).toBe('20261005T1805');
  });
});

describe('creation events', () => {
  it('decodes the v3 factory event of the pool the collector quotes', () => {
    const c = decodeV3Created(fx.knownLogs.v3);
    expect(c).toMatchObject({
      kind: 'cl',
      id: quotes.v3.pool.id.toLowerCase(),
      token0: USDG,
      token1: NVDA.toLowerCase(),
      fee: quotes.v3.pool.fee,
      tickSpacing: quotes.v3.pool.tickSpacing,
      hooks: null,
    });
    expect(c.block).toBe(Number(fx.knownLogs.v3.blockNumber));
    expect(fx.knownLogs.v3.topics[0]).toBe(TOPIC.v3PoolCreated);
  });

  it('decodes the v4 pool manager event of the pool the collector quotes', () => {
    const c = decodeV4Created(fx.knownLogs.v4);
    expect(c).toMatchObject({
      kind: 'v4',
      id: quotes.v4.pool.id,
      fee: quotes.v4.pool.fee,
      tickSpacing: quotes.v4.pool.tickSpacing,
      hooks: quotes.v4.pool.key.hooks.toLowerCase(),
    });
    expect([c.token0, c.token1].sort()).toEqual([USDG, NVDA.toLowerCase()].sort());
    expect(fx.knownLogs.v4.topics[0]).toBe(TOPIC.v4Initialize);
  });

  it('refuses a log of another event', () => {
    expect(() => decodeV3Created(fx.knownLogs.v4)).toThrow(/PoolCreated/);
    expect(() => decodeV4Created(fx.knownLogs.v3)).toThrow(/Initialize/);
  });

  it('asks each contract twice, the tokens on either side of the pair', () => {
    const filters = creationFilters(robinhood, [NVDA, SPY]);
    expect(filters.map((f) => [f.kind, f.topics.length])).toEqual([
      ['cl', 2],
      ['cl', 3],
      ['v4', 3],
      ['v4', 4],
    ]);
    const list = [`0x${'0'.repeat(24)}${NVDA.slice(2).toLowerCase()}`, expect.any(String)];
    expect(filters[0]?.topics).toEqual([TOPIC.v3PoolCreated, list]);
    expect(filters[3]?.topics).toEqual([TOPIC.v4Initialize, null, null, list]);
    expect(filters[2]?.address).toBe(robinhood.v4?.poolManager);
  });

  it('covers a block range in windows with no gap and no overlap', () => {
    expect(blockWindows(0, 250, 100)).toEqual([
      [0, 99],
      [100, 199],
      [200, 250],
    ]);
    expect(blockWindows(5, 5, 100)).toEqual([[5, 5]]);
    expect(blockWindows(6, 5, 100)).toEqual([]);
    expect(() => blockWindows(0, 1, 0)).toThrow();
  });

  it('reads what the endpoints said when they refused a log query', () => {
    const r = fx.refusals;
    expect(allowedSpan(r.wholeLife?.message)).toBe(10_000_000);
    expect(allowedSpan(r.tokenList?.message)).toBe(100_000);
    expect(allowedSpan(r.tooManyLogs?.message)).toBeNull();
    expect(tooManyLogs(r.tooManyLogs?.message)).toBe(true);
    expect(tooManyLogs(r.wholeLife?.message)).toBe(false);
    // the Swap walk of RU.14 (2026-10-06) met a refusal for the reply's size on a busy window
    expect(tooManyLogs('response too large')).toBe(true);
    expect(tooManyLogs('Request timeout on the free plan, please upgrade to paid plan')).toBe(
      false,
    );
    // the second endpoint names no span the scan could use
    expect(allowedSpan(r.drpc?.message)).toBeNull();
    expect(tooManyLogs(r.drpc?.message)).toBe(false);
  });

  it('halves a window the endpoint refuses for the number of logs, and stops on any other refusal', async () => {
    const filter = creationFilters(robinhood, [NVDA])[2];
    if (!filter) throw new Error('no v4 filter');
    const spans: Array<[number, number]> = [];
    const answer = (r: RpcRequest): RpcReply => {
      const q = r.params[0] as { fromBlock: string; toBlock: string };
      const [a, b] = [Number(q.fromBlock), Number(q.toBlock)];
      spans.push([a, b]);
      // more than 100 blocks at once is "too many logs"; a window that fits holds the one real log
      if (b - a >= 100) return { error: { message: fx.refusals.tooManyLogs?.message } };
      return { result: a === 0 ? [fx.knownLogs.v4] : [] };
    };
    const deps = {
      rpc: replayRpc({}, answer),
      fetchJson: async () => [],
      sleep: async () => {},
      now: () => 0,
      log: () => {},
    };
    const got = await scanCreated(deps, [filter], 0, 399, 400, { batch: 10, pauseMs: 0 });
    expect(got.created.map((c) => c.id)).toEqual([quotes.v4.pool.id]);
    // 400 → 200 + 200 → four of 100: every block asked once in the end, none twice
    const kept = spans.filter(([a, b]) => b - a < 100).sort((x, y) => x[0] - y[0]);
    expect(kept).toEqual([
      [0, 99],
      [100, 199],
      [200, 299],
      [300, 399],
    ]);
    expect(got.queries).toBe(spans.length);
    const refusing = {
      ...deps,
      rpc: replayRpc({}, () => ({ error: { message: fx.refusals.drpc?.message } })),
    };
    await expect(
      scanCreated(refusing, [filter], 0, 399, 400, { batch: 10, pauseMs: 0 }),
    ).rejects.toThrow(/eth_getLogs 0\.\.399 refused: ranges over 10000 blocks/);
  });
});

describe('filing and reach', () => {
  const stocks = new Map([
    [NVDA.toLowerCase(), NVDA],
    [SPY.toLowerCase(), SPY],
  ]);

  it('files a pool under its stock, by address, whichever side it is on', () => {
    expect(fileUnder(USDG, NVDA.toLowerCase(), stocks)).toEqual({
      token: NVDA,
      other: USDG,
      tokenIs0: false,
      otherIsStock: false,
      filedUnder: 'its_only_stock',
    });
    expect(fileUnder(SPY, '0xffffffffffffffffffffffffffffffffffffffff', stocks)).toMatchObject({
      token: SPY,
      tokenIs0: true,
      otherIsStock: false,
    });
    expect(fileUnder(USDG, ZERO_ADDRESS, stocks)).toBeNull();
  });

  it('files a pool of two stocks once, under token0, and says the other side is a stock', () => {
    // SPY's address is the lower of the two
    expect(fileUnder(SPY.toLowerCase(), NVDA.toLowerCase(), stocks)).toEqual({
      token: SPY,
      other: NVDA.toLowerCase(),
      tokenIs0: true,
      otherIsStock: true,
      filedUnder: 'token0_of_two_stocks',
    });
  });

  it('marks a pool the vault cannot reach and keeps it', () => {
    const hook = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
    expect(reach({ kind: 'v4', hooks: ZERO_ADDRESS, attested: true })).toEqual({
      reachable: true,
      unreachableReason: null,
    });
    expect(reach({ kind: 'v4', hooks: hook, attested: true })).toEqual({
      reachable: false,
      unreachableReason: 'has_hook',
    });
    expect(reach({ kind: 'cl', hooks: null, attested: true }).reachable).toBe(true);
    expect(reach({ kind: 'cl', hooks: null, attested: false })).toEqual({
      reachable: false,
      unreachableReason: 'other_venue',
    });
  });

  it('merges the sources into one candidate per pool', () => {
    const created = [decodeV3Created(fx.knownLogs.v3), decodeV4Created(fx.knownLogs.v4)];
    const pairs = [
      {
        chainId: 'robinhood',
        dexId: 'uniswap',
        labels: ['v3'],
        pairAddress: quotes.v3.pool.id, // mixed case, as DexScreener writes it
        baseToken: { address: NVDA },
        quoteToken: { address: robinhood.dollar.address },
        liquidity: { usd: 1 },
        volume: { h24: 2 },
      },
      {
        chainId: 'robinhood',
        dexId: 'ramses',
        labels: ['v3'],
        pairAddress: '0xdac1904d82000000000000000000000000000001',
        baseToken: { address: NVDA },
        quoteToken: { address: robinhood.dollar.address },
        liquidity: {},
      },
      { chainId: 'base', pairAddress: '0x2222222222222222222222222222222222222222' },
      { chainId: 'robinhood', pairAddress: 'not-a-pool', baseToken: { address: NVDA } },
    ];
    const fromDex = dexPools(pairs, robinhood, NVDA);
    expect(fromDex.map((p) => p.kind)).toEqual(['cl', 'cl']);
    expect(fromDex[1]?.dex).toEqual({
      dexId: 'ramses',
      labels: ['v3'],
      liquidityUsd: null, // absent is null, not zero
      volumeH24Usd: null,
    });
    // the same event twice, as when a pool of two stocks answers both filters
    const merged = mergeCandidates(robinhood, [...created, ...created], fromDex);
    expect(merged.size).toBe(3);
    const v3 = merged.get(quotes.v3.pool.id.toLowerCase()) as Candidate;
    expect(v3.sources).toEqual(['v3_factory_log', 'dexscreener']);
    expect(v3.attested).toBe(true);
    expect(v3.factory).toBe(robinhood.clFactories[0]?.address.toLowerCase());
    const other = merged.get('0xdac1904d82000000000000000000000000000001') as Candidate;
    expect(other).toMatchObject({ attested: false, token0: null, sources: ['dexscreener'] });
  });
});

describe('money in a pool', () => {
  const Q96 = 2n ** 96n;
  const state = (over: Partial<PoolState>): PoolState => ({
    block: 1,
    fetchedAt: '2026-10-05T00:00:00.000Z',
    balance0: null,
    balance1: null,
    sqrtPriceX96: Q96,
    liquidity: 0n,
    tick: 0,
    inBand: null,
    ...over,
  });

  it('prices a token from a dollar pool without its decimals', () => {
    // price 4 raw dollars per raw token (sqrt 2), a 6-decimal dollar: 4e-6 dollars per raw unit
    expect(usdPerRawFromPool(2n * Q96, true, 6)).toBeCloseTo(4e-6, 18);
    expect(usdPerRawFromPool(2n * Q96, false, 6)).toBeCloseTo(0.25e-6, 18);
    expect(usdPerRawFromPool(0n, true, 6)).toBeNull();
  });

  it('takes the price from the dollar pool holding the most dollars, above the floor only', () => {
    const pool = (id: string, dollarUsd: number, sqrt: bigint, kind: 'cl' | 'v4' = 'cl') => ({
      id,
      kind,
      tokenIs0: true,
      sqrtPriceX96: sqrt,
      dollarUsd,
      block: 7,
    });
    const pools = [pool('0xb', 5_000, 2n * Q96), pool('0xa', 90_000, 3n * Q96)];
    const p = priceFromDollarPools('0xT', pools, 6, 1_000);
    expect(p).toMatchObject({
      address: '0xt',
      refPool: '0xa',
      refDollarUsd: 90_000,
      method: 'mid_of_deepest_dollar_pool',
      reason: null,
      block: 7,
    });
    expect(p.usdPerRaw).toBeCloseTo(9e-6, 18);
    // input order does not matter, nor does a tie
    const tie = [pool('0xb', 5_000, 2n * Q96), pool('0xa', 5_000, 3n * Q96)];
    for (const list of [tie, [...tie].reverse()])
      expect(priceFromDollarPools('0xT', list, 6, 1_000).refPool).toBe('0xa');
    // a deeper v4 pool is the reference, and the price says which kind it came from
    const withV4 = [...pools, pool('0xc', 400_000, 4n * Q96, 'v4')];
    expect(priceFromDollarPools('0xT', withV4, 6, 1_000)).toMatchObject({
      refPool: '0xc',
      method: 'mid_of_deepest_v4_dollar_pool',
    });
    // every pool under the floor: no price, with the reason, never a zero
    expect(priceFromDollarPools('0xT', pools, 6, 100_000)).toMatchObject({
      usdPerRaw: null,
      method: null,
      reason: 'no_dollar_pool_above_floor',
    });
  });

  it('counts the ticks a band reaches and the bitmap words that hold them', () => {
    // 1.0001^4055 is just above 1.5
    expect(bandTicks(0, 0.5)).toEqual({ lo: -4055, hi: 4055 });
    expect(bandTicks(887_000, 0.5).hi).toBe(887_272);
    expect(bitmapWords(-4055, 4055, 10)).toEqual([-2, -1, 0, 1]);
    expect(bitmapWords(0, 2559, 10)).toEqual([0]);
    expect(bitmapWords(-1, 0, 60)).toEqual([-1, 0]);
    expect(ticksOfWord(0, 0b101n, 60)).toEqual([0, 120]);
    expect(ticksOfWord(-1, 1n << 255n, 10)).toEqual([-10]);
    // a negative word position on the wire is two's complement
    expect(intWord(-1)).toBe('f'.repeat(64));
    expect(intWord(2)).toBe(`${'0'.repeat(63)}2`);
  });

  it('adds up what the positions hold within the band, tick by tick', () => {
    const L = 1_000_000n;
    const s = (t: number) => 1.0001 ** (t / 2);
    const range = { lo: -200, hi: 200 };
    // no initialized tick inside: one position spanning the band
    const flat = amountsInBand(L, Q96, 0, [], range);
    expect(flat.raw0).toBeCloseTo(1e6 * (1 - 1 / s(200)), 6);
    expect(flat.raw1).toBeCloseTo(1e6 * (1 - s(-200)), 6);
    // the position ends at +100 and at -100: nothing beyond
    const ends = [
      { tick: -100, liquidityNet: L },
      { tick: 100, liquidityNet: -L },
    ];
    const tight = amountsInBand(L, Q96, 0, ends, range);
    expect(tight.raw0).toBeCloseTo(1e6 * (1 - 1 / s(100)), 6);
    expect(tight.raw1).toBeCloseTo(1e6 * (1 - s(-100)), 6);
    // a second position of 3L starts at +100: its token0 between +100 and +200 counts too
    const more = amountsInBand(
      L,
      Q96,
      0,
      [
        { tick: -100, liquidityNet: L },
        { tick: 100, liquidityNet: 2n * L },
      ],
      range,
    );
    expect(more.raw0).toBeCloseTo(1e6 * (1 - 1 / s(100)) + 3e6 * (1 / s(100) - 1 / s(200)), 6);
    expect(more.raw1).toBeCloseTo(tight.raw1, 6);
    // ticks outside the band are ignored; a price of zero holds nothing
    expect(amountsInBand(L, Q96, 0, [{ tick: 500, liquidityNet: -L }], range)).toEqual(flat);
    expect(amountsInBand(L, 0n, 0, [], range)).toEqual({ raw0: 0, raw1: 0 });
  });

  it('values a v3 pool by the balances it holds', () => {
    const s = state({ balance0: 2_000_000n, balance1: 3_000_000n });
    // the stock is token1 at 2e-6 dollars a raw unit, the dollar token0 at 1e-6
    expect(money('cl', false, s, { token: 2e-6, other: 1e-6 })).toEqual({
      tokenUsd: 6,
      otherUsd: 2,
      tvlUsd: 8,
      tvlMethod: 'balances_held_by_the_pool',
      tvlReason: null,
      bandUsd: null,
    });
  });

  it('values a v4 pool by what its positions hold within the band, and says so', () => {
    const s = state({ liquidity: 5n, inBand: { raw0: 1_000_000, raw1: 4_000_000 } });
    expect(money('v4', true, s, { token: 3e-6, other: 1e-6 })).toEqual({
      tokenUsd: 3,
      otherUsd: 4,
      tvlUsd: 7,
      tvlMethod: 'v4_positions_within_band_of_the_price',
      tvlReason: null,
      bandUsd: 7,
    });
  });

  it('a pool that was read and holds nothing is idle; one that was not read is not', () => {
    expect(isIdle('cl', state({ balance0: 0n, balance1: 0n }))).toBe(true);
    expect(isIdle('cl', state({ balance0: 0n, balance1: 1n }))).toBe(false);
    expect(isIdle('cl', state({ balance0: null, balance1: null }))).toBe(false);
    expect(isIdle('v4', state({ liquidity: 0n }))).toBe(true);
    expect(isIdle('v4', state({ liquidity: null }))).toBe(false);
  });

  it('gives null with a reason, never zero, when a side or the pool is not measured', () => {
    const cl = state({ balance0: 2_000_000n, balance1: 3_000_000n });
    const noOther = money('cl', true, cl, { token: 1e-6, other: null, otherLookedUp: true });
    expect(noOther).toMatchObject({
      tokenUsd: 2,
      otherUsd: null,
      tvlUsd: null,
      tvlMethod: null,
      tvlReason: 'other_token_not_priced',
    });
    expect(
      money('cl', true, cl, { token: 1e-6, other: null, otherLookedUp: false }).tvlReason,
    ).toBe('stock_side_below_floor_other_token_not_looked_up');
    expect(money('cl', true, cl, { token: null, other: 1e-6 })).toMatchObject({
      tvlUsd: null,
      tvlReason: 'token_not_priced',
    });
    // a v4 pool whose ticks were not read
    expect(money('v4', true, state({ liquidity: 5n }), { token: 1e-6, other: 1e-6 })).toEqual({
      tokenUsd: null,
      otherUsd: null,
      tvlUsd: null,
      tvlMethod: null,
      tvlReason: 'pool_state_not_read',
      bandUsd: null,
    });
  });
});

describe('one discovery pass, replayed from the recording', () => {
  const universe = (): UniverseToken[] =>
    confirmTokens(parseRegistry(fx.registry, 4663).tokens, fx.tokenChecks);
  const options = (over: Partial<DiscoverOptions> = {}): DiscoverOptions => ({
    tokens: universe(),
    universe: { file: 'fixture', fetchedAt: fx.fetchedAt },
    rpcLabel: robinhood.rpcDefault,
    ...fx.options,
    fromBlock: fx.fromBlock,
    logs: 'auto',
    logCache: null,
    logBatch: 10,
    logPauseMs: 0,
    dexPauseMs: 0,
    ...over,
  });
  const run = async (
    over: Partial<DiscoverOptions> = {},
    override?: (r: RpcRequest) => RpcReply | undefined,
    gets: Record<string, unknown> = fx.gets,
  ) => {
    const rpc = replayRpc(fx.answers, override);
    const out = await runDiscovery(
      robinhood,
      {
        rpc,
        fetchJson: async (url) => {
          if (!(url in gets)) throw new Error(`HTTP 500 (not in the recording: ${url})`);
          return gets[url];
        },
        sleep: async () => {},
        now: () => Date.parse(fx.fetchedAt),
        log: () => {},
      },
      options(over),
    );
    return { ...out, rpc };
  };
  let file: DiscoveryFile;
  beforeAll(async () => {
    file = (await run()).file;
  });

  it('comes to what the recording came to', () => {
    expect(file.counts).toEqual(fx.counts);
    // ratios of floats: the last digit differs between machines, so nine decimals, not equality
    expect(file.bandCheck.pools).toBe(fx.bandCheck.pools);
    for (const k of ['medianRatio', 'p10', 'p90'] as const)
      expect(file.bandCheck[k]).toBeCloseTo(fx.bandCheck[k] as number, 9);
    expect(file.blocks).toMatchObject({
      logsFrom: fx.fromBlock,
      logsTo: fx.block,
      stateFirst: fx.block,
      stateLast: fx.block,
    });
  });

  it('carries its source, time, method and provenance, on the file and on every row', () => {
    expect(file.provenance).toBe('live');
    expect(file.method).toBe('evm-discovery-0.1');
    expect(file.source).toContain(`blocks ${fx.fromBlock} to ${fx.block}`);
    expect(file.fetchedAt).toBe(fx.fetchedAt);
    expect(file.params).toEqual(fx.options);
    for (const p of file.pools) {
      expect(p.block).toBe(fx.block);
      expect(p.fetchedAt).toBe(fx.fetchedAt);
      expect(p.sources.length).toBeGreaterThan(0);
    }
  });

  it('gives every token of the universe a row', () => {
    expect(file.tokens.map((t) => t.symbol).sort()).toEqual(['NVDA', 'SPY']);
    for (const t of file.tokens) {
      expect(t.status).toBe('pools');
      expect(t.pools).toBe(file.pools.filter((p) => p.token === t.address).length);
      expect(t.pools).toBeGreaterThan(0);
    }
  });

  it('writes one row per pool, keyed on the token address', () => {
    const ids = file.pools.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of file.pools) {
      expect([NVDA, SPY]).toContain(p.token); // the registry's spelling, not a symbol
      expect(p.id).toBe(p.id.toLowerCase());
      expect(p.other).toBe(p.other.toLowerCase());
    }
  });

  it("finds the collector's two pools of the earlier fixture, both reachable", () => {
    const v3 = file.pools.find((p) => p.id === quotes.v3.pool.id.toLowerCase());
    const v4 = file.pools.find((p) => p.id === quotes.v4.pool.id);
    expect(v3).toMatchObject({
      kind: 'cl',
      venue: 'uniswap-v3',
      token: NVDA,
      symbol: 'NVDA',
      otherSymbol: 'USDG',
      againstDollar: true,
      reachable: true,
      unreachableReason: null,
      fee: quotes.v3.pool.fee,
      tvlMethod: 'balances_held_by_the_pool',
    });
    // created long before the recorded blocks: DexScreener named it and the factory vouched for it
    expect(v3?.sources).toEqual(['dexscreener', 'v3_factory_getpool']);
    expect(v4).toMatchObject({
      kind: 'v4',
      venue: 'uniswap-v4',
      token: NVDA,
      reachable: true,
      hooks: ZERO_ADDRESS,
      balanceToken: null, // a v4 pool has no balance of its own
      tvlMethod: 'v4_positions_within_band_of_the_price',
    });
  });

  it('keeps and marks the pools the vault cannot reach', () => {
    const hooked = file.pools.filter((p) => p.unreachableReason === 'has_hook');
    const elsewhere = file.pools.filter((p) => p.unreachableReason === 'other_venue');
    expect(hooked.length).toBeGreaterThan(0);
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const p of hooked) {
      expect(p.kind).toBe('v4');
      expect(p.hooks).not.toBe(ZERO_ADDRESS);
      expect(p.reachable).toBe(false);
    }
    for (const p of elsewhere) {
      expect(p.kind).toBe('cl');
      expect(p.venue).not.toBe('uniswap-v3');
      expect(p.factory).not.toBe(robinhood.clFactories[0]?.address.toLowerCase());
    }
    for (const p of file.pools.filter((x) => x.reachable))
      expect(p.kind === 'v4' ? p.hooks : p.venue).toBe(
        p.kind === 'v4' ? ZERO_ADDRESS : 'uniswap-v3',
      );
    expect(file.counts.reachable).toBe(file.pools.filter((p) => p.reachable).length);
  });

  it('files a pool of the two stocks once, under SPY (token0), and says NVDA is a stock too', () => {
    const both = file.pools.filter((p) => p.otherIsStock);
    expect(both.length).toBeGreaterThan(0);
    expect(both.length).toBe(file.counts.twoStockPools);
    for (const p of both) {
      expect(p).toMatchObject({
        token: SPY,
        other: NVDA.toLowerCase(),
        otherSymbol: 'NVDA',
        tokenIs0: true,
        filedUnder: 'token0_of_two_stocks',
      });
    }
    for (const p of file.pools.filter((x) => !x.otherIsStock))
      expect(p.filedUnder).toBe('its_only_stock');
  });

  it("a v3 pool's TVL is its two balances at the two prices, recomputed here", () => {
    const usdPerRaw = new Map(file.prices.map((p) => [p.address, p.usdPerRaw]));
    const measured = file.pools.filter((p) => p.tvlMethod === 'balances_held_by_the_pool');
    expect(measured.length).toBeGreaterThan(10);
    for (const p of measured) {
      const tokenUsd =
        Number(BigInt(p.balanceToken as string)) * (usdPerRaw.get(p.token.toLowerCase()) as number);
      const otherUsd =
        Number(BigInt(p.balanceOther as string)) * (usdPerRaw.get(p.other) as number);
      expect(p.tokenUsd).toBeCloseTo(tokenUsd, 6);
      expect(p.otherUsd).toBeCloseTo(otherUsd, 6);
      expect(p.tvlUsd).toBeCloseTo(tokenUsd + otherUsd, 6);
    }
  });

  it('prices each stock by the mid of its deepest reachable dollar pool, recomputed here', () => {
    for (const address of [NVDA, SPY]) {
      const price = file.prices.find((p) => p.address === address.toLowerCase());
      // the dollar side of each: a v3 pool's raw balance at six decimals, a v4 pool's side in the band
      const depth = (p: (typeof file.pools)[number]) =>
        p.kind === 'cl' ? Number(BigInt(p.balanceOther as string)) / 1e6 : (p.otherUsd as number);
      const mine = file.pools.filter(
        (p) => p.token === address && p.reachable && p.againstDollar && p.liquidity !== '0',
      );
      expect(new Set(mine.map((p) => p.kind)).size).toBe(2);
      const deepest = [...mine].sort((a, b) => depth(b) - depth(a))[0];
      expect(price).toMatchObject({
        method:
          deepest?.kind === 'cl' ? 'mid_of_deepest_dollar_pool' : 'mid_of_deepest_v4_dollar_pool',
        refPool: deepest?.id,
      });
      expect(price?.refDollarUsd).toBeCloseTo(depth(deepest as (typeof file.pools)[number]), 6);
      const s = Number(BigInt(deepest?.sqrtPriceX96 as string)) / 2 ** 96;
      const raw1Per0 = s * s;
      const dollarsPerRaw = (deepest?.tokenIs0 ? raw1Per0 : 1 / raw1Per0) / 1e6;
      expect(price?.usdPerRaw).toBeCloseTo(dollarsPerRaw, 24);
      // a whole token is 1e18 raw units: a share price, not a rounding artefact
      expect((price?.usdPerRaw as number) * 1e18).toBeGreaterThan(10);
      expect((price?.usdPerRaw as number) * 1e18).toBeLessThan(10_000);
    }
    expect(file.prices.find((p) => p.address === USDG)).toMatchObject({
      usdPerRaw: 1e-6,
      method: 'dollar_token_counts_as_one',
    });
    const native = file.prices.find((p) => p.address === ZERO_ADDRESS);
    const wrapped = file.prices.find((p) => p.symbol === 'wrapped native');
    expect(native).toMatchObject({
      method: 'same_as_wrapped_native',
      usdPerRaw: wrapped?.usdPerRaw,
    });
  });

  it('on the Uniswap v3 dollar pools, what the ticks add up to is what the pool holds', () => {
    // the same walk that values a v4 pool, checked where the balances can be read: within the band it
    // can only be less than the balances (fees owed and liquidity outside the band are not in it)
    expect(file.bandCheck.pools).toBeGreaterThanOrEqual(4);
    expect(file.bandCheck.medianRatio as number).toBeGreaterThan(0.95);
    expect(file.bandCheck.p90 as number).toBeLessThanOrEqual(1.0001);
    for (const p of file.pools.filter((x) => x.kind === 'v4' && x.tvlUsd !== null))
      expect(p.bandUsd).toBe(p.tvlUsd);
  });

  it('a TVL that was not measured is null with a reason, never zero', () => {
    const nulls = file.pools.filter((p) => p.tvlUsd === null);
    expect(nulls.length).toBeGreaterThan(0);
    expect(nulls.length).toBe(file.counts.tvlNull);
    for (const p of nulls) {
      expect(p.tvlReason).toBeTruthy();
      expect(p.tvlMethod).toBeNull();
    }
    for (const p of file.pools.filter((x) => x.tvlUsd !== null)) {
      expect(p.tvlReason).toBeNull();
      expect(p.tvlUsd as number).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.tvlUsd)).toBe(true);
    }
    // a pool that holds nothing has no row: it is counted on its token
    for (const p of file.pools)
      expect(
        p.kind === 'cl' ? p.balanceToken !== '0' || p.balanceOther !== '0' : p.liquidity !== '0',
      ).toBe(true);
    const idle = file.tokens.reduce(
      (n, t) => n + t.idle.clNoBalance + t.idle.v4NoLiquidityInRange,
      0,
    );
    expect(idle).toBe(file.counts.idleNotListed);
    // and a token's total is the sum of the measured rows only
    for (const t of file.tokens) {
      const mine = file.pools.filter((p) => p.token === t.address);
      expect(t.tvlUnmeasured).toBe(mine.filter((p) => p.tvlUsd === null).length);
      expect(t.tvlUsd).toBeCloseTo(
        mine.reduce((s, p) => s + (p.tvlUsd ?? 0), 0),
        4,
      );
    }
  });

  it('says what the run could not have seen for a token', () => {
    // DexScreener returned its cap of 30 pairs for both: other venues may have more
    for (const t of file.tokens)
      expect(t.gaps).toEqual(['dexscreener_at_its_cap_other_venues_may_be_missing']);
    expect(file.sources.creationEvents).toMatchObject({ used: true, complete: true });
    expect(file.sources.dexscreener).toMatchObject({ asked: 2, failed: [], atCap: 2 });
  });

  it('records what the endpoint allowed for the creation events', () => {
    expect(file.logsProbe).toMatchObject({ usable: true, window: 100_000 });
    expect(file.logsProbe?.filtered.ok).toBe(false);
    expect(file.logsProbe?.filtered.answer).toMatch(/only 100000 are allowed/);
    expect(file.logsProbe?.windowQuery?.ok).toBe(true);
  });

  it('gives the same file on a second pass over the same answers', async () => {
    const again = (await run()).file;
    expect(JSON.stringify(again.pools)).toBe(JSON.stringify(file.pools));
    expect(again.tokens).toEqual(file.tokens);
  });

  it('feeds the 80% rule: one pool per address, the asset keyed on the token address', () => {
    const set = trackedSet(
      file.pools.map((p) => ({ address: p.id, asset: p.token, tvlUsd: p.tvlUsd })),
      { share: 0.8, minPoolUsd: 1_000 },
    );
    expect(set.assets.every((a) => a === NVDA || a === SPY)).toBe(true);
    expect(set.cut.length).toBeGreaterThan(0);
    // the unmeasured pools are left out and counted, not ranked as empty
    expect(set.unmeasuredPools).toBe(
      file.pools.filter((p) => set.assets.includes(p.token) && p.tvlUsd === null).length,
    );
  });

  it('keeps the events it read, so the next pass reads only the blocks since', async () => {
    const first = await run();
    expect(first.logCache).toMatchObject({
      chainId: 4663,
      fromBlock: fx.fromBlock,
      scannedTo: fx.block,
    });
    const logQueries = (rpc: { asked: RpcRequest[] }) =>
      rpc.asked.filter((r) => r.method === 'eth_getLogs').length;
    const second = await run({ logCache: first.logCache });
    // only the probe's two queries: no window is left to scan
    expect(logQueries(second.rpc)).toBe(2);
    expect(logQueries(first.rpc)).toBeGreaterThan(2);
    expect(JSON.stringify(second.file.pools)).toBe(JSON.stringify(file.pools));
    // a cache made for other tokens is not trusted
    const stale = { ...(first.logCache as NonNullable<typeof first.logCache>), tokens: [USDG] };
    const third = await run({ logCache: stale });
    expect(logQueries(third.rpc)).toBe(logQueries(first.rpc));
  });

  describe('when the endpoint refuses the creation events', () => {
    const refuseLogs = (r: RpcRequest): RpcReply | undefined =>
      r.method === 'eth_getLogs' ? { error: { message: fx.refusals.drpc?.message } } : undefined;
    let fallback: DiscoveryFile;
    beforeAll(async () => {
      fallback = (await run({}, refuseLogs)).file;
    });

    it('falls back to DexScreener and the factory, and states the gap on every token', () => {
      expect(fallback.counts).toEqual(fx.fallbackCounts);
      expect(fallback.logsProbe).toMatchObject({ usable: false, window: null });
      expect(fallback.sources.creationEvents).toMatchObject({ used: false, complete: false });
      expect(fallback.blocks.logsTo).toBeNull();
      expect(fallback.source).not.toContain('Initialize events');
      for (const t of fallback.tokens) {
        expect(t.gaps).toContain('v4_pools_from_dexscreener_only');
        expect(t.gaps).toContain('v3_pools_from_dexscreener_and_getpool_only');
      }
      const sources = new Set(fallback.pools.flatMap((p) => p.sources));
      expect([...sources].sort()).toEqual(['dexscreener', 'v3_factory_getpool']);
    });

    it("still finds the collector's pools, and nothing the full pass did not", () => {
      const full = new Set(file.pools.map((p) => p.id));
      for (const p of fallback.pools) expect(full.has(p.id)).toBe(true);
      expect(fallback.pools.length).toBeLessThan(file.pools.length);
      const ids = new Set(fallback.pools.map((p) => p.id));
      expect(ids.has(quotes.v3.pool.id.toLowerCase())).toBe(true);
      expect(ids.has(quotes.v4.pool.id)).toBe(true);
    });

    it('--no-logs takes the same path without asking', async () => {
      const off = await run({ logs: 'off' });
      expect(off.rpc.asked.some((r) => r.method === 'eth_getLogs')).toBe(false);
      expect(off.file.logsProbe).toBeNull();
      expect(JSON.stringify(off.file.pools)).toBe(JSON.stringify(fallback.pools));
    });
  });
});

describe('token summaries', () => {
  it('states what a run could not have seen', () => {
    expect(gapsFor({ eventsUsed: true, dexFailed: false, dexAtCap: false })).toEqual([]);
    expect(gapsFor({ eventsUsed: true, dexFailed: false, dexAtCap: true })).toEqual([
      'dexscreener_at_its_cap_other_venues_may_be_missing',
    ]);
    // a failed lookup is the wider gap: the cap is not also reported
    expect(gapsFor({ eventsUsed: true, dexFailed: true, dexAtCap: true })).toEqual([
      'dexscreener_failed_other_venues_not_listed',
    ]);
    expect(gapsFor({ eventsUsed: false, dexFailed: false, dexAtCap: false })).toEqual([
      'v4_pools_from_dexscreener_only',
      'v3_pools_from_dexscreener_and_getpool_only',
    ]);
  });

  it('gives a row to a token with no pool and to one that was not confirmed', () => {
    const tokens = [
      { address: NVDA, symbol: 'NVDA', confirmed: true },
      { address: SPY, symbol: 'SPY', confirmed: false },
    ];
    const got = summarize(tokens, [], {
      idle: new Map([[NVDA, { clNoBalance: 1, v4NoLiquidityInRange: 2 }]]),
      refused: new Map([[NVDA, { does_not_answer_token0_token1: 1 }]]),
      gaps: new Map(),
    });
    expect(got).toEqual([
      {
        address: NVDA,
        symbol: 'NVDA',
        status: 'no_pool',
        pools: 0,
        reachable: 0,
        byVenue: {},
        tvlUsd: null, // no measured pool: null, not zero
        tvlUnmeasured: 0,
        idle: { clNoBalance: 1, v4NoLiquidityInRange: 2 },
        refused: { does_not_answer_token0_token1: 1 },
        gaps: [],
      },
      {
        address: SPY,
        symbol: 'SPY',
        status: 'not_confirmed',
        pools: 0,
        reachable: 0,
        byVenue: {},
        tvlUsd: null,
        tvlUnmeasured: 0,
        idle: { clNoBalance: 0, v4NoLiquidityInRange: 0 },
        refused: {},
        gaps: [],
      },
    ]);
  });
});
