import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CHAINS } from '../scripts/risk-evm/config';
import {
  CUT_METHOD,
  type CutInput,
  type CutRow,
  cutReport,
  cutRow,
  DEXSCREENER_FAILED,
  failedTokens,
} from '../scripts/risk-evm/cut';
import { gapsFor, type PoolRow } from '../scripts/risk-evm/discovery';

// PLAN-UNIVERSE RU.3 (gate UNIVERSE): the 80% rule on Robinhood Chain. The fixture is the discovery of
// 2026-10-05 (blocks 81,044,145 to 81,057,597) frozen to what the cut reads
// (pnpm risk:freeze-universe-fixture <discovery.json> --chain robinhood). No test calls the network.
const fx = JSON.parse(
  gunzipSync(
    readFileSync('fixtures/risk/universe/robinhood-discovery-20261005T1947.json.gz'),
  ).toString(),
) as CutInput & { fetched_at: string };
const robinhood = CHAINS.find((c) => c.id === 'robinhood');
if (!robinhood) throw new Error('no robinhood chain in config.ts');
const RULE = { share: 0.8, minPoolUsd: 1000, collected: robinhood.tokens };
const TRACKED = [
  'AAPL',
  'AMC',
  'AMD',
  'AMZN',
  'COIN',
  'COST',
  'CRCL',
  'DELL',
  'DJT',
  'GLD',
  'GME',
  'GOOGL',
  'HIMS',
  'INTC',
  'LLY',
  'META',
  'MSFT',
  'MSTR',
  'MU',
  'NVDA',
  'PLTR',
  'QQQ',
  'RDDT',
  'SGOV',
  'SLV',
  'SNDK',
  'SPCX',
  'SPY',
  'TSLA',
  'USO',
];

describe('the cut on the frozen Robinhood discovery of Oct 5', () => {
  const r = cutReport(fx, RULE);

  it('the fixture says where it came from and what it leaves out', () => {
    expect(fx.provenance).toBe('fixture');
    expect(fx.chain).toBe('robinhood');
    expect(fx.fetched_at).toBe('2026-10-05T20:11:13.000Z');
    expect(fx.method).toBe('evm-discovery-0.1');
    expect(fx.source).toContain('discovery-robinhood-20261005T1947.json');
    expect(fx.tokens).toHaveLength(194);
    // 64,845 rows in the file; the 61,710 left out have no TVL and under $1,000 on the stock side
    expect(fx.pools).toHaveLength(3135);
    expect(fx.rowsLeftOut?.rows).toBe(61710);
    expect(r.discovery.rowsLeftOut?.rows).toBe(61710);
  });

  it('carries its source, time, method and provenance', () => {
    expect(r.method).toBe(CUT_METHOD);
    expect(r.fetchedAt).toBe(fx.fetchedAt);
    expect(r.source).toBe(fx.source);
    expect(r.provenance).toBe('fixture');
    expect(r.rule.mapping).toContain('never zero');
  });

  it('counts the cut at 80, 90, 95 and 99%', () => {
    expect(r.counts.ranked).toBe(728);
    expect(Math.round(r.counts.rankedUsd)).toBe(90_899_430);
    expect(r.shares.map((s) => [s.share, s.pools, s.stocks, s.poolsOfTheStocks])).toEqual([
      [0.8, 93, 30, 427],
      [0.9, 154, 48, 535],
      [0.95, 225, 67, 630],
      [0.99, 440, 89, 706],
    ]);
  });

  it('names 30 tracked stocks and every ranked pool of each', () => {
    expect(r.tracked.map((t) => t.symbol).sort()).toEqual(TRACKED);
    expect(r.shares[0]?.symbols).toEqual(TRACKED);
    expect(r.cut).toHaveLength(93);
    expect(r.pools).toHaveLength(427);
    expect(r.tracked.reduce((s, t) => s + t.pools, 0)).toBe(427);
    expect(r.tracked.reduce((s, t) => s + t.poolsInCut, 0)).toBe(93);
    expect(r.cut.at(-1)?.cumulativeShare).toBeGreaterThanOrEqual(0.8);
    expect(r.cut.at(-2)?.cumulativeShare).toBeLessThan(0.8);
    // a pool is keyed on the stock's address, never its symbol
    expect(r.pools.every((p) => /^0x[0-9a-fA-F]{40}$/.test(p.asset))).toBe(true);
    expect(r.tracked[0]).toMatchObject({ symbol: 'SPY', poolsInCut: 27, pools: 57 });
  });

  it('lists the 96 tokens with no price', () => {
    expect(r.unpricedTokens.count).toBe(96);
    expect(r.unpricedTokens.tokens.map((t) => t.symbol)).toContain('JOBY');
    const unpriced = new Set(r.unpricedTokens.tokens.map((t) => t.address));
    expect(r.pools.some((p) => unpriced.has(p.asset))).toBe(false);
  });

  it('counts the rows with no TVL that hold $1,000 on the stock side, and ranks none', () => {
    const h = r.unrankedHoldingStock;
    expect(h.rows).toBe(994);
    expect(Math.round(h.tokenUsd)).toBe(5_005_627);
    expect(Object.keys(h.byReason)).toEqual(['other_token_not_priced']);
    expect(h.ofTrackedStocks.rows).toBe(796);
    expect(h.byStock.reduce((s, x) => s + x.rows, 0)).toBe(994);
    expect(r.pools.every((p) => p.tvlUsd !== null)).toBe(true);
  });

  it('without the v4 pools the cut names different stocks, and says which', () => {
    const w = r.withoutV4;
    expect(w.rankedPools).toBe(298);
    expect(w.sameStocksAtShare).toBe(false);
    expect(w.onlyWithV4).toEqual(['AMD', 'PLTR', 'SNDK']);
    expect(w.onlyWithoutV4).toEqual(['IBM', 'NFLX']);
    expect(w.shares.map((s) => [s.pools, s.stocks])).toEqual([
      [47, 29],
      [79, 41],
      [112, 54],
      [194, 66],
    ]);
  });

  it('says which tracked stocks the pools of two stocks touch', () => {
    const t = r.twoStockPools;
    expect(t.rows).toBe(106);
    expect(t.ranked).toBe(50);
    expect(t.inCut).toBe(19);
    expect(t.touchingTracked).toBe(101);
    expect(t.pools.filter((p) => p.inCut).every((p) => p.filedUnder === 'SPY')).toBe(true);
    expect(t.trackedAsOther[0]?.symbol).toBe('QQQ');
    expect(t.wouldAlsoBeNamed).toEqual(['TSM']);
  });

  it('compares the tracked stocks with the 21 the collector reads', () => {
    const v = r.vsCollector;
    expect(v.collected).toBe(21);
    expect(v.both).toHaveLength(20);
    expect(v.trackedNotCollected).toEqual([
      'AMC',
      'COST',
      'DJT',
      'GME',
      'HIMS',
      'LLY',
      'PLTR',
      'QQQ',
      'RDDT',
      'SPCX',
    ]);
    expect(v.collectedNotTracked).toHaveLength(1);
    expect(v.collectedNotTracked[0]).toMatchObject({
      symbol: 'TSM',
      why: 'below_the_cut',
      rank: 102,
    });
    expect(v.collectedNotTracked[0]?.entersAtShare).toBeGreaterThan(0.8);
  });
});

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;
const D = `0x${'d'.repeat(40)}`;
const row = (address: string, asset: string, tvlUsd: number | null, o: Partial<CutRow> = {}) => ({
  address,
  asset,
  tvlUsd,
  symbol: asset.slice(2, 3).toUpperCase(),
  other: `0x${'9'.repeat(40)}`,
  otherSymbol: null,
  otherIsStock: false,
  kind: 'cl' as const,
  venue: 'uniswap-v3',
  reachable: true,
  tokenUsd: tvlUsd === null ? null : tvlUsd / 2,
  tvlMethod: tvlUsd === null ? null : ('balances_held_by_the_pool' as const),
  tvlReason: tvlUsd === null ? ('other_token_not_priced' as const) : null,
  ...o,
});
const token = (address: string, o: Partial<CutInput['tokens'][number]> = {}) => ({
  address,
  symbol: address.slice(2, 3).toUpperCase(),
  priced: true,
  rows: 1,
  reachableRows: 1,
  gaps: [],
  ...o,
});
const input = (pools: CutRow[], tokens: CutInput['tokens']): CutInput => ({
  chain: 'test',
  chainId: 1,
  provenance: 'fixture',
  source: 'made by hand',
  method: 'evm-discovery-0.1',
  fetchedAt: '2026-10-05T00:00:00.000Z',
  blocks: { logsFrom: 0, logsTo: 1, stateFirst: 1, stateLast: 1 },
  params: { band: 0.5, minRefUsd: 1000, minSideUsd: 100 },
  tokens,
  pools,
});

describe('the cut on rows made by hand', () => {
  it('maps a discovery row to the rule: pool id, token address, TVL as measured', () => {
    const p = {
      id: '0xpool',
      token: A,
      symbol: 'AAA',
      other: B.toUpperCase().replace('0X', '0x'),
      otherSymbol: 'BBB',
      otherIsStock: true,
      kind: 'v4',
      venue: 'uniswap-v4',
      reachable: false,
      tokenUsd: 2500,
      tvlUsd: null,
      tvlMethod: null,
      tvlReason: 'other_token_not_priced',
    } as unknown as PoolRow;
    expect(cutRow(p)).toEqual({
      address: '0xpool',
      asset: A,
      tvlUsd: null,
      symbol: 'AAA',
      other: B,
      otherSymbol: 'BBB',
      otherIsStock: true,
      kind: 'v4',
      venue: 'uniswap-v4',
      reachable: false,
      tokenUsd: 2500,
      tvlMethod: null,
      tvlReason: 'other_token_not_priced',
    });
  });

  it('a row with no TVL is counted and listed, never ranked and never zero', () => {
    const r = cutReport(
      input(
        [
          row('p1', A, 8000),
          row('p2', B, 2000),
          row('p3', A, null, { tokenUsd: 50_000 }),
          row('p4', B, null, { tokenUsd: 999 }),
          row('p5', B, 500),
        ],
        [token(A), token(B)],
      ),
      { share: 0.8, minPoolUsd: 1000, collected: [] },
    );
    expect(r.counts).toMatchObject({
      rows: 5,
      measured: 3,
      ranked: 2,
      rankedUsd: 10_000,
      measuredBelowFloor: 1,
      unmeasured: 2,
      unmeasuredByReason: { other_token_not_priced: 2 },
    });
    // the $50,000 row would have led the ranking; it names nothing
    expect(r.cut.map((p) => p.address)).toEqual(['p1']);
    expect(r.tracked).toHaveLength(1);
    expect(r.tracked[0]).toMatchObject({ address: A, pools: 1, unmeasuredPools: 1, dustPools: 0 });
    expect(r.unrankedHoldingStock).toMatchObject({ rows: 1, tokenUsd: 50_000 });
    expect(r.unrankedHoldingStock.byStock).toEqual([
      { address: A, symbol: 'A', tracked: true, rows: 1, tokenUsd: 50_000 },
    ]);
  });

  it('with and without v4: the same stocks when v4 changes nothing, the difference when it does', () => {
    const same = cutReport(
      input(
        [row('p1', A, 9000), row('p2', A, 5000, { kind: 'v4' }), row('p3', B, 1000)],
        [token(A), token(B)],
      ),
      { share: 0.8, minPoolUsd: 1000, collected: [] },
    );
    expect(same.withoutV4.sameStocksAtShare).toBe(true);
    const differs = cutReport(
      input(
        [row('p1', A, 9000, { kind: 'v4' }), row('p2', B, 1000), row('p3', C, 1000)],
        [token(A), token(B), token(C)],
      ),
      { share: 0.8, minPoolUsd: 1000, collected: [] },
    );
    expect(differs.withoutV4).toMatchObject({
      sameStocksAtShare: false,
      onlyWithV4: ['A'],
      onlyWithoutV4: ['B', 'C'],
    });
  });

  it('a pool of two stocks counts for the stock it is filed under, and the other is named beside it', () => {
    const r = cutReport(
      input(
        [
          row('p1', A, 9000, { otherIsStock: true, other: B, otherSymbol: 'B' }),
          row('p2', C, 1000, { otherIsStock: true, other: A, otherSymbol: 'A' }),
          row('p3', C, null, { otherIsStock: true, other: D, otherSymbol: 'D' }),
        ],
        [token(A), token(B), token(C), token(D)],
      ),
      { share: 0.8, minPoolUsd: 1000, collected: [] },
    );
    expect(r.tracked.map((t) => t.symbol)).toEqual(['A']);
    expect(r.twoStockPools).toMatchObject({
      rows: 3,
      ranked: 2,
      inCut: 1,
      touchingTracked: 2,
      wouldAlsoBeNamed: ['B'],
    });
    expect(r.twoStockPools.trackedAsOther).toEqual([
      { address: A, symbol: 'A', pools: 1, tvlUsd: 1000 },
    ]);
  });

  it('says why a collected token is not tracked', () => {
    const r = cutReport(
      input(
        [row('p1', A, 9000), row('p2', B, 1000), row('p3', C, 400), row('p4', D, null)],
        [token(A), token(B), token(C), token(D, { priced: false })],
      ),
      {
        share: 0.8,
        minPoolUsd: 1000,
        collected: [
          { address: A.toUpperCase().replace('0X', '0x'), symbol: 'A' },
          { address: B, symbol: 'B' },
          { address: C, symbol: 'C' },
          { address: D, symbol: 'D' },
          { address: `0x${'e'.repeat(40)}`, symbol: 'E' },
        ],
      },
    );
    expect(r.vsCollector.both).toEqual(['A']);
    expect(r.vsCollector.trackedNotCollected).toEqual([]);
    expect(r.vsCollector.collectedNotTracked.map((x) => [x.symbol, x.why, x.rank])).toEqual([
      ['B', 'below_the_cut', 2],
      ['C', 'no_pool_at_the_floor', null],
      ['D', 'not_priced', null],
      ['E', 'not_in_the_registry', null],
    ]);
    // the money ranked above its pool: a cut of 90% stops before it, any wider cut names it
    expect(r.vsCollector.collectedNotTracked[0]?.entersAtShare).toBe(0.9);
    expect(r.unpricedTokens.tokens.map((t) => t.symbol)).toEqual(['D']);
  });

  it('finds the tokens DexScreener failed for', () => {
    const tokens = [token(A), token(B, { gaps: [DEXSCREENER_FAILED] })];
    // the string discovery writes is the one the cut looks for
    expect(gapsFor({ eventsUsed: true, dexFailed: true, dexAtCap: false })).toEqual([
      DEXSCREENER_FAILED,
    ]);
    expect(failedTokens({ tokens })).toEqual(['B']);
    expect(failedTokens({ tokens: [token(A)] })).toEqual([]);
    const r = cutReport(input([row('p1', A, 9000)], tokens), {
      share: 0.8,
      minPoolUsd: 1000,
      collected: [],
    });
    expect(r.inputGaps.dexscreenerFailed).toEqual(['B']);
  });
});
