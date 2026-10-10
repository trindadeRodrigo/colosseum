import { ContractFunctionRevertedError } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  averageRefusalOf,
  type FeedRound,
  gapBps,
  type PoolFeedInputs,
  type PoolFeedSettings,
  poolAverageOf,
  readPoolAverageFeed,
  tickPrice,
} from '../src/vault/pool-average';
import type { EvmRpc } from '../src/vault/rpc';

// `PoolAverageFeed.check` written again (pool-average.ts), held to the contract: the same exact values
// contracts/test/TickPrice.t.sol checks the library with (`node contracts/script/tick-table.mjs
// --vectors`), and what the contract itself answered on a fork of Robinhood Chain
// (contracts/test/fork/RobinhoodForkPoolFeed.t.sol).

const E20 = 10n ** 20n;

describe('the tick maths, as TickPrice has it', () => {
  it('gives the exact whole part for prices a feed states', () => {
    expect(tickPrice(0n, E20, 1n)).toBe(E20);
    expect(tickPrice(-221_937n, E20, 1n)).toBe(23008084035n);
    expect(tickPrice(-209_730n, E20, 1n)).toBe(77982512515n);
    expect(tickPrice(-230_270n, E20, 1n)).toBe(10000022031n);
    expect(tickPrice(221_937n, 1n, 10_000n)).toBe(434629n);
    expect(tickPrice(10n, 10n ** 8n, 1n)).toBe(100100045n);
    expect(tickPrice(-10n, 10n ** 8n, 1n)).toBe(99900054n);
  });
  it('never rounds up, and is under by at most a unit and a part in 2^58', () => {
    const exact: [bigint, bigint, bigint, bigint][] = [
      [100n, E20, 1n, 101004966209287656885n],
      [-101n, E20, 1n, 98995133360784869684n],
      [443_636n, 1n, 1n, 18446050711097703529n],
      [-443_636n, 10n ** 36n, 1n, 54212146310449513n],
      [443_636n, 10n ** 36n, 1n, 18446050711097703529776342895396472065568967222426633323n],
    ];
    for (const [tick, mulBy, divBy, want] of exact) {
      const got = tickPrice(tick, mulBy, divBy) as bigint;
      expect(got <= want).toBe(true);
      expect(want - got <= 1n + (want >> 58n)).toBe(true);
    }
  });
  it('takes no tick past its range', () => {
    expect(tickPrice(443_637n, 1n, 1n)).toBeNull();
    expect(tickPrice(-443_637n, 1n, 1n)).toBeNull();
  });
});

// The NVDA pool on Friday 2026-10-09 at 16:30:00 UTC, block 84,298,619: USDG is token0.
const NOW = 1_791_563_400n;
const nvda: PoolFeedSettings = {
  baseIsToken0: false,
  baseDecimals: 18,
  quoteDecimals: 6,
  feedDecimals: 8,
  window: 3600,
  minLiquidity: 1_800_000_000_000_000_000n,
  jumpBps: 150,
  maxRounds: 12,
};
const round = (answer: bigint, updatedAt: bigint, roundId = 18446744073709552819n): FeedRound => ({
  roundId,
  answer,
  updatedAt,
});
const atTheBlock: PoolFeedInputs = {
  now: NOW,
  unchanged: true,
  latest: round(23036242923n, 1_791_558_556n),
  earlier: [],
  liquidity: 3_809_668_295_502_054_196n,
  observed: {
    tickCumulatives: [1_540_768_050_217n, 1_541_567_040_486n],
    perLiquidity: [17436856855914321885839723400n, 17437181852926002201389968947n],
  },
};

describe('the check, as PoolAverageFeed makes it', () => {
  it('answers what the contract answered on the fork, for both token orders', () => {
    expect(poolAverageOf(nvda, atTheBlock)).toEqual({
      average: 22996583443n,
      spot: 23036242923n,
      ownAverage: 23036242923n,
      liquidity: 3_809_668_295_502_054_196n,
      meanLiquidity: 3_769_316_261_038_025_369n,
      reason: null,
    });
    // SPY at the same block: SPY is token0.
    const spy = poolAverageOf(
      { ...nvda, baseIsToken0: true, minLiquidity: 110_000_000_000_000_000n },
      {
        ...atTheBlock,
        latest: round(77615113392n, 1_791_498_761n),
        liquidity: 228_026_426_169_417_661n,
        observed: {
          tickCumulatives: [-1_047_449_850_006n, -1_048_204_938_330n],
          perLiquidity: [
            183885868825139943518213384267007982233344182n,
            183885868825139943523585641077300765076754723n,
          ],
        },
      },
    );
    expect([spy.average, spy.meanLiquidity, spy.reason]).toEqual([
      77850061481n,
      228_026_426_169_417_661n,
      null,
    ]);
  });

  it('weighs a round inside the hour with the one before it, as on the fork ten minutes after one', () => {
    const r = poolAverageOf(nvda, {
      ...atTheBlock,
      now: 1_791_559_156n,
      latest: round(23036242923n, 1_791_558_556n),
      earlier: [round(23157436794n, 1_791_552_974n, 18446744073709552818n)],
      liquidity: 2_036_912_397_584_043_917n,
      observed: {
        tickCumulatives: [1_539_826_304_180n, 1_540_625_131_871n],
        perLiquidity: [17436472240278059636403760235n, 17436797507169622996963434455n],
      },
    });
    expect([r.average, r.ownAverage, r.meanLiquidity, r.reason]).toEqual([
      23100296061n,
      23137237815n,
      3_766_188_790_465_169_858n,
      null,
    ]);
  });

  it('tells the first reason, in the contract’s order', () => {
    const reason = (more: Partial<PoolFeedInputs>, settings: Partial<PoolFeedSettings> = {}) =>
      poolAverageOf({ ...nvda, ...settings }, { ...atTheBlock, ...more }).reason;
    expect(reason({ unchanged: false })).toBe('PoolChanged');
    expect(reason({ latest: null })).toBe('FeedDown');
    expect(reason({ latest: round(0n, NOW - 60n) })).toBe('FeedDown');
    expect(reason({ latest: round(23036242923n, NOW + 1n) })).toBe('FeedDown');
    expect(reason({ liquidity: 1_799_999_999_999_999_999n })).toBe('ThinPool');
    expect(reason({ liquidity: null })).toBe('ThinPool');
    // Enough in range now, too little as the hour's average.
    expect(reason({}, { minLiquidity: 3_800_000_000_000_000_000n })).toBe('ThinPool');
    expect(reason({ observed: null })).toBe('ShortHistory');
    // An average tick past the range: 443,637 ticks an hour.
    expect(
      reason({
        observed: {
          tickCumulatives: [0n, -443_637n * 3600n],
          perLiquidity: atTheBlock.observed?.perLiquidity ?? [0n, 0n],
        },
      }),
    ).toBe('PriceOutOfRange');
    // A round ten minutes old and the one before it not read, missing, or stamped after it.
    const fresh = round(23036242923n, NOW - 600n);
    expect(reason({ latest: fresh })).toBe('FeedRounds');
    expect(reason({ latest: fresh, earlier: [null] })).toBe('FeedRounds');
    expect(reason({ latest: fresh, earlier: [round(23036242923n, NOW - 599n)] })).toBe(
      'FeedRounds',
    );
    // More rounds inside the hour than it reads.
    expect(
      reason(
        { latest: fresh, earlier: [round(23036242923n, NOW - 700n), round(1n, NOW - 4000n)] },
        { maxRounds: 1 },
      ),
    ).toBe('FeedRounds');
    // A step of 5% a minute ago; the same step 43 minutes ago is inside the band.
    const before = round(21939278974n, NOW - 7200n);
    expect(reason({ latest: round(23036242923n, NOW - 60n), earlier: [before] })).toBe(
      'FeedJumped',
    );
    expect(reason({ latest: round(23036242923n, NOW - 2580n), earlier: [before] })).toBeNull();
    // The pool is thin and Chainlink jumped: the pool is told.
    expect(
      reason({ liquidity: 1n, latest: round(23036242923n, NOW - 60n), earlier: [before] }),
    ).toBe('ThinPool');
  });

  it('reads the counters across their wrap, in 56 and in 160 bits', () => {
    const top56 = (1n << 55n) - 1n;
    const top160 = (1n << 160n) - 1n;
    const moved = 1_541_567_040_486n - 1_540_768_050_217n;
    const per = 17437181852926002201389968947n - 17436856855914321885839723400n;
    const r = poolAverageOf(nvda, {
      ...atTheBlock,
      observed: {
        // The pool reports each counter in its own width: past the top it starts again from the bottom.
        tickCumulatives: [top56 - 10n, BigInt.asIntN(56, top56 - 10n + moved)],
        perLiquidity: [top160 - 10n, BigInt.asUintN(160, top160 - 10n + per)],
      },
    });
    expect([r.average, r.meanLiquidity]).toEqual([22996583443n, 3_769_316_261_038_025_369n]);
  });
});

describe('what the app is told', () => {
  it('names each of the contract’s reasons, and none for zero', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(averageRefusalOf)).toEqual([
      null,
      'PoolChanged',
      'FeedDown',
      'ThinPool',
      'ShortHistory',
      'PriceOutOfRange',
      'FeedRounds',
      'FeedJumped',
    ]);
    // A reason a later contract adds is still a refusal.
    expect(averageRefusalOf(8)).toBe('PoolChanged');
  });
  it('measures the gap on the average, rounded down', () => {
    expect(gapBps(23036242923n, 22996583443n)).toBe(17);
    expect(gapBps(98n, 100n)).toBe(200);
    expect(gapBps(100n, 0n)).toBeNull();
  });

  const node = (answer: () => unknown) =>
    ({ readContract: async () => answer() }) as unknown as EvmRpc;
  const FEED = '0x00000000000000000000000000000000000000f1';

  it('reads a deployed feed’s own check: its prices and its reason', async () => {
    const thin = await readPoolAverageFeed(
      node(() => [22996583443n, 23036242923n, 23036242923n, 5n, 6n, 3]),
      FEED,
    );
    expect(thin).toEqual({
      average: 22996583443n,
      spot: 23036242923n,
      ownAverage: 23036242923n,
      liquidity: 5n,
      meanLiquidity: 6n,
      reason: 'ThinPool',
    });
  });
  it('answers null for an average that is not a pool-average feed', async () => {
    const reverted = node(() => {
      throw new ContractFunctionRevertedError({ abi: [], functionName: 'check' });
    });
    expect(await readPoolAverageFeed(reverted, FEED)).toBeNull();
  });
});
