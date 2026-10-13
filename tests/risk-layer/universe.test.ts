import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { trackedSet, type UniversePool } from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-UNIVERSE RU.1 (gate UNIVERSE): the 80% rule as one pure function, on the Solana registry of
// 2026-10-01 01:39Z frozen to pool address, asset and TVL (pnpm risk:freeze-universe-fixture).
const fx = JSON.parse(
  gunzipSync(
    readFileSync('fixtures/risk/universe/solana-registry-20261001T0139.json.gz'),
  ).toString(),
) as {
  source: string;
  fetched_at: string;
  method: string;
  provenance: string;
  pools: UniversePool[];
};
const RULE = { share: 0.8, minPoolUsd: 1000 };
const STOCKS = [
  'AAPLx',
  'AMZNx',
  'COINx',
  'CRCLx',
  'GLDx',
  'GMEx',
  'GOOGLx',
  'HOODx',
  'MCDx',
  'METAx',
  'MSFTx',
  'MSTRx',
  'NVDAx',
  'QQQx',
  'SPCXx',
  'SPYx',
  'STRCx',
  'TSLAx',
];
const pool = (address: string, asset: string, tvlUsd: number | null): UniversePool => ({
  address,
  asset,
  tvlUsd,
});

describe('trackedSet on the frozen Solana registry of Oct 1', () => {
  it('the fixture says where it came from', () => {
    expect(fx.provenance).toBe('fixture');
    expect(fx.fetched_at).toBe('2026-10-01T01:38:24.027Z');
    expect(fx.method).toBe('registry-0.1');
    expect(fx.source).toContain('registry-20261001T0139.json');
    expect(fx.pools).toHaveLength(5951);
  });

  it('names the 18 stocks and their 869 pools', () => {
    const t = trackedSet(fx.pools, RULE);
    expect(t.assets).toEqual(STOCKS);
    expect(t.pools).toHaveLength(869);
    expect(t.pools.every((p) => STOCKS.includes(p.asset) && (p.tvlUsd as number) >= 1000)).toBe(
      true,
    );
    // every pool of the cut is among the tracked pools
    const tracked = new Set(t.pools.map((p) => p.address));
    expect(t.cut.every((p) => tracked.has(p.address))).toBe(true);
    // the pools of the 18 the rule leaves out are dust: with money below the floor, or empty
    expect(t.dustPools).toBe(5422 - 869);
    expect(t.unmeasuredPools).toBe(0);
  });

  it('pins the size of the cut on each base', () => {
    // Base of the rule (DU1): pools of $1,000 or more. 992 pools, the cut is 34 (the 34 of PLAN-RISK).
    const live = trackedSet(fx.pools, RULE);
    expect(live.rankedPools).toBe(992);
    expect(live.cut).toHaveLength(34);
    expect(live.cutUsd).toBeGreaterThanOrEqual(0.8 * live.rankedUsd);
    expect(live.cutUsd - (live.cut.at(-1)?.tvlUsd as number)).toBeLessThan(0.8 * live.rankedUsd);
    // Base of every pool with money: 5,694 pools, the cut is 35. The same 18 stocks either way.
    const all = trackedSet(fx.pools, { share: 0.8, minPoolUsd: 0 });
    expect(all.rankedPools).toBe(5694);
    expect(all.cut).toHaveLength(35);
    expect(all.assets).toEqual(STOCKS);
    expect(all.pools).toHaveLength(5179);
    // The 18 hold 96.3% of all pool TVL (PLAN-UNIVERSE section 2).
    expect(all.poolsUsd / all.rankedUsd).toBeCloseTo(0.963, 3);
  });

  it('the wider cuts on the same base', () => {
    const at = (share: number) => {
      const t = trackedSet(fx.pools, { share, minPoolUsd: 1000 });
      return [t.cut.length, t.assets.length];
    };
    expect(at(0.9)).toEqual([82, 25]);
    expect(at(0.95)).toEqual([206, 34]);
    expect(at(0.99)).toEqual([757, 45]);
  });

  it('does not depend on the order of the input', () => {
    const a = trackedSet(fx.pools, RULE);
    const b = trackedSet([...fx.pools].reverse(), RULE);
    expect(b.cut.map((p) => p.address)).toEqual(a.cut.map((p) => p.address));
    expect(b.pools.map((p) => p.address)).toEqual(a.pools.map((p) => p.address));
  });
});

describe('trackedSet, by hand', () => {
  const pools = [
    pool('p1', 'A', 50),
    pool('p2', 'B', 30),
    pool('p3', 'C', 15),
    pool('p4', 'A', 5),
    pool('p5', 'C', 0.5),
    pool('p6', 'B', null),
    pool('p7', 'D', null),
  ];

  it('takes the shortest prefix that reaches the share, then every pool of the assets it names', () => {
    // ranked at a floor of 1: 50, 30, 15, 5 = 100. 80% is reached exactly by p1 + p2.
    const t = trackedSet(pools, { share: 0.8, minPoolUsd: 1 });
    expect(t.rankedUsd).toBe(100);
    expect(t.cut.map((p) => p.address)).toEqual(['p1', 'p2']);
    expect(t.cutUsd).toBe(80);
    expect(t.assets).toEqual(['A', 'B']);
    // p4 is outside the cut and tracked because A is; p3 is not, C was not named
    expect(t.pools.map((p) => p.address)).toEqual(['p1', 'p2', 'p4']);
    expect(t.poolsUsd).toBe(85);
    // B's unmeasured pool is counted apart, never ranked as a zero
    expect(t.dustPools).toBe(0);
    expect(t.unmeasuredPools).toBe(1);
  });

  it('one more pool when the share is just above the prefix', () => {
    const t = trackedSet(pools, { share: 0.81, minPoolUsd: 1 });
    expect(t.cut.map((p) => p.address)).toEqual(['p1', 'p2', 'p3']);
    expect(t.assets).toEqual(['A', 'B', 'C']);
    expect(t.pools.map((p) => p.address)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(t.dustPools).toBe(1);
  });

  it('the floor changes the base, and an unmeasured pool never names an asset', () => {
    const t = trackedSet(pools, { share: 1, minPoolUsd: 0 });
    expect(t.rankedPools).toBe(5);
    expect(t.rankedUsd).toBe(100.5);
    expect(t.assets).toEqual(['A', 'B', 'C']);
    expect(t.cut).toHaveLength(5);
  });

  it('a pool with no money names nothing, at any floor', () => {
    const t = trackedSet([pool('a', 'A', 10), pool('z', 'Z', 0)], { share: 1, minPoolUsd: 0 });
    expect(t.assets).toEqual(['A']);
    expect(t.rankedPools).toBe(1);
  });

  it('equal pools are ordered by address', () => {
    const tie = [pool('b', 'B', 10), pool('a', 'A', 10), pool('c', 'C', 10)];
    const t = trackedSet(tie, { share: 0.5, minPoolUsd: 0 });
    expect(t.cut.map((p) => p.address)).toEqual(['a', 'b']);
    expect(trackedSet([...tie].reverse(), { share: 0.5, minPoolUsd: 0 }).assets).toEqual(t.assets);
  });

  it('keeps the caller’s own fields on the pools it returns, and leaves the input alone', () => {
    const input = [
      { ...pool('x', 'A', 1), venue: 'v3' },
      { ...pool('y', 'A', 9), venue: 'v4' },
    ];
    const t = trackedSet(input, { share: 0.8, minPoolUsd: 0 });
    expect(t.pools.map((p) => p.venue)).toEqual(['v4', 'v3']);
    expect(input.map((p) => p.address)).toEqual(['x', 'y']);
  });

  it('nothing measured gives an empty set, not an error', () => {
    const t = trackedSet([pool('n', 'A', null)], RULE);
    expect(t).toMatchObject({ rankedUsd: 0, cut: [], assets: [], pools: [], unmeasuredPools: 0 });
    expect(trackedSet([], RULE).assets).toEqual([]);
  });

  it('refuses a share outside (0, 1], a negative floor, a TVL that is not a finite amount, a pool with no asset and a repeated pool', () => {
    expect(() => trackedSet(pools, { share: 0, minPoolUsd: 0 })).toThrow(/share/);
    expect(() => trackedSet(pools, { share: 1.2, minPoolUsd: 0 })).toThrow(/share/);
    expect(() => trackedSet(pools, { share: Number.NaN, minPoolUsd: 0 })).toThrow(/share/);
    expect(() => trackedSet(pools, { share: 0.8, minPoolUsd: -1 })).toThrow(/minPoolUsd/);
    expect(() => trackedSet([pool('a', 'A', -1)], RULE)).toThrow(/tvlUsd/);
    expect(() => trackedSet([pool('a', 'A', Number.NaN)], RULE)).toThrow(/tvlUsd/);
    expect(() => trackedSet([pool('a', 'A', Number.POSITIVE_INFINITY)], RULE)).toThrow(/tvlUsd/);
    // a figure that arrived as text from an untyped JSON row
    expect(() => trackedSet([pool('a', 'A', '10' as unknown as number)], RULE)).toThrow(/tvlUsd/);
    expect(() => trackedSet([pool('a', '', 1)], RULE)).toThrow(/names no asset/);
    expect(() => trackedSet([pool('a', undefined as unknown as string, 1)], RULE)).toThrow(
      /names no asset/,
    );
    expect(() => trackedSet([pool('a', 'A', 1), pool('a', 'B', 2)], RULE)).toThrow(/twice/);
  });
});
