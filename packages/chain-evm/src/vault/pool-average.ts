import { type Address, parseAbi, type StateOverride } from 'viem';
import { ask, type EvmRpc, isRevert } from './rpc';

// `PoolAverageFeed` (contracts/src/price/PoolAverageFeed.sol, TickPrice.sol) as the keeper and the app
// read it: the contract's own `check()` where one is deployed, and the same checks written again in the
// contract's arithmetic for a chain where none is yet, so a dry run can say what a feed would answer.
// The contract has the last word.

/** Why a pool-average feed gives no answer, by the contract's `Reason`. */
export type AverageRefusal =
  /** The pool names other tokens, or a token or the feed states other decimals, than at deployment. */
  | 'PoolChanged'
  /** The Chainlink feed gives no price. */
  | 'FeedDown'
  /** The pool is too thin: its liquidity in range is under the floor, now or over the window. */
  | 'ThinPool'
  /** Not enough history: the pool has less than the window of it. */
  | 'ShortHistory'
  /** The pool's average is not a price the feed can state. */
  | 'PriceOutOfRange'
  /** Chainlink's own rounds of the window could not all be read. */
  | 'FeedRounds'
  /** The price just jumped: Chainlink's latest answer is far from its own average over the window. */
  | 'FeedJumped';

/** The contract's `Reason`, in its order: index 0 is no reason. */
const REASONS: readonly (AverageRefusal | null)[] = [
  null,
  'PoolChanged',
  'FeedDown',
  'ThinPool',
  'ShortHistory',
  'PriceOutOfRange',
  'FeedRounds',
  'FeedJumped',
];

/** The refusal a `Reason` number stands for; a number the contract does not have is `PoolChanged`. */
export const averageRefusalOf = (reason: number): AverageRefusal | null =>
  reason in REASONS ? (REASONS[reason] as AverageRefusal | null) : 'PoolChanged';

export const POOL_AVERAGE_FEED_ABI = parseAbi([
  'function check() view returns (uint256 average, uint256 spot, uint256 ownAverage, uint128 liquidity, uint128 meanLiquidity, uint8 reason)',
]);

/** What a pool-average feed read: prices in the Chainlink feed's units, zero where one could not be worked out. */
export type PoolAverageReading = {
  average: bigint;
  spot: bigint;
  ownAverage: bigint;
  liquidity: bigint;
  meanLiquidity: bigint;
  reason: AverageRefusal | null;
};

/** How far `spot` is from `average`, in bps of the average, rounded down; null with no average. */
export const gapBps = (spot: bigint, average: bigint): number | null =>
  average > 0n
    ? Number(((spot > average ? spot - average : average - spot) * 10_000n) / average)
    : null;

// ---- the contract's arithmetic

const Q128 = 1n << 128n;
const MAX_U128 = Q128 - 1n;
/** `TickPrice.MAX_TICK`. */
export const MAX_TICK = 443_636n;
const MOST_LOST = 38n;
/** 2^128 * 1.0001^(-2^i), rounded down: the table of `TickPrice`, printed by contracts/script/tick-table.mjs. */
const FACTORS = [
  0xfff97272373d413259a46990580e2139n,
  0xfff2e50f5f656932ef12357cf3c7fdcbn,
  0xffe5caca7e10e4e61c3624eaa0941ccfn,
  0xffcb9843d60f6159c9db58835c926643n,
  0xff973b41fa98c081472e6896dfb254bfn,
  0xff2ea16466c96a3843ec78b326b52860n,
  0xfe5dee046a99a2a811c461f1969c3052n,
  0xfcbe86c7900a88aedcffc83b479aa3a3n,
  0xf987a7253ac413176f2b074cf7815e53n,
  0xf3392b0822b70005940c7a398e4b70f2n,
  0xe7159475a2c29b7443b29c7fa6e889d8n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e4n,
  0x70d869a156d2a1b890bb3df62baf32f6n,
  0x31be135f97d08fd981231505542fcfa5n,
  0x9aa508b5b7a84e1c677de54f3e99bc8n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe97n,
  0x48a170391f7dc42444e8fa2n,
];

/** `TickPrice.priceAt`: 1.0001^tick * mulBy / divBy, rounded down; null outside the ticks it takes. */
export function tickPrice(tick: bigint, mulBy: bigint, divBy: bigint): bigint | null {
  if (tick < -MAX_TICK || tick > MAX_TICK) return null;
  const magnitude = tick < 0n ? -tick : tick;
  let shrunk = Q128;
  for (let i = 0; i < FACTORS.length; i++)
    if ((magnitude >> BigInt(i)) & 1n) shrunk = (shrunk * (FACTORS[i] as bigint)) >> 128n;
  return tick <= 0n
    ? (shrunk * mulBy) / (Q128 * divBy)
    : (Q128 * mulBy) / ((shrunk + MOST_LOST) * divBy);
}

/** One Chainlink round as `_round` takes it: null for one that does not answer, or answers zero, below, over 128 bits, or with no time. */
export type FeedRound = { roundId: bigint; answer: bigint; updatedAt: bigint } | null;

const usable = (r: FeedRound): r is NonNullable<FeedRound> =>
  r !== null && r.answer > 0n && r.answer <= MAX_U128 && r.updatedAt !== 0n;

export type PoolFeedSettings = {
  baseIsToken0: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  feedDecimals: number;
  window: number;
  minLiquidity: bigint;
  jumpBps: number;
  maxRounds: number;
};

/** What the contract reads, all at one block. */
export type PoolFeedInputs = {
  /** The block's time. */
  now: bigint;
  /** The pool still names the two tokens in order, and the tokens and the feed their decimals. */
  unchanged: boolean;
  latest: FeedRound;
  /** The rounds before the latest, newest first: as many as the walk needs, at most `maxRounds`. */
  earlier: FeedRound[];
  /** `liquidity()`, null where the pool does not answer. */
  liquidity: bigint | null;
  /** `observe([window, 0])`, null where it reverts. */
  observed: { tickCumulatives: [bigint, bigint]; perLiquidity: [bigint, bigint] } | null;
};

/** `PoolAverageFeed.check`, in the contract's order and arithmetic. */
export function poolAverageOf(s: PoolFeedSettings, i: PoolFeedInputs): PoolAverageReading {
  const out: PoolAverageReading = {
    average: 0n,
    spot: 0n,
    ownAverage: 0n,
    liquidity: 0n,
    meanLiquidity: 0n,
    reason: null,
  };
  if (!i.unchanged) return { ...out, reason: 'PoolChanged' };
  const first = (reason: AverageRefusal) => {
    out.reason ??= reason;
  };
  const window = BigInt(s.window);

  const latest = usable(i.latest) && i.latest.updatedAt <= i.now ? i.latest : null;
  if (latest) out.spot = latest.answer;
  else first('FeedDown');

  out.liquidity = i.liquidity !== null && i.liquidity <= MAX_U128 ? i.liquidity : 0n;
  if (out.liquidity < s.minLiquidity) first('ThinPool');

  if (!i.observed) first('ShortHistory');
  else {
    const moved = BigInt.asIntN(56, i.observed.tickCumulatives[1] - i.observed.tickCumulatives[0]);
    const perLiquidity = BigInt.asUintN(
      160,
      i.observed.perLiquidity[1] - i.observed.perLiquidity[0],
    );
    const facing = s.baseIsToken0 ? moved : -moved;
    let tick = facing / window;
    if (facing < 0n && facing % window !== 0n) tick -= 1n;
    const mean = perLiquidity === 0n ? MAX_U128 : (window << 128n) / perLiquidity;
    out.meanLiquidity = mean < MAX_U128 ? mean : MAX_U128;
    if (out.meanLiquidity < s.minLiquidity) first('ThinPool');
    const up = s.baseDecimals + s.feedDecimals;
    const mulBy = up >= s.quoteDecimals ? 10n ** BigInt(up - s.quoteDecimals) : 1n;
    const divBy = up >= s.quoteDecimals ? 1n : 10n ** BigInt(s.quoteDecimals - up);
    const average = tickPrice(tick, mulBy, divBy) ?? 0n;
    out.average = average > MAX_U128 ? 0n : average;
    if (out.average === 0n) first('PriceOutOfRange');
  }

  if (latest) {
    const start = i.now > window ? i.now - window : 0n;
    let upper = latest.updatedAt > start ? latest.updatedAt : start;
    let weighted = latest.answer * (i.now - upper);
    let covered = latest.updatedAt <= start;
    let roundId = latest.roundId;
    let broken = false;
    for (let n = 0; !covered && n < s.maxRounds; n++) {
      if (roundId === 0n) {
        broken = true;
        break;
      }
      roundId -= 1n;
      const round = i.earlier[n] ?? null;
      if (!usable(round) || round.updatedAt > upper) {
        broken = true;
        break;
      }
      const lower = round.updatedAt > start ? round.updatedAt : start;
      weighted += round.answer * (upper - lower);
      upper = lower;
      covered = round.updatedAt <= start;
    }
    if (broken || !covered) first('FeedRounds');
    else {
      out.ownAverage = weighted / window;
      const apart =
        latest.answer > out.ownAverage
          ? latest.answer - out.ownAverage
          : out.ownAverage - latest.answer;
      if (apart * 10_000n > out.ownAverage * BigInt(s.jumpBps)) first('FeedJumped');
    }
  }
  return out;
}

// ---- reading

const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
]);
const ROUND_FEED_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)',
]);
const DECIMALS_ABI = parseAbi(['function decimals() view returns (uint8)']);

/** A view that may revert: null where it does. A node that does not answer is `Unavailable`. */
async function read<T>(what: string, work: () => Promise<unknown>): Promise<T | null> {
  try {
    return (await ask(what, work)) as T;
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

/**
 * `check()` of a deployed pool-average feed at `block`, or null where the address is not one (a test
 * network's written average has no `check`).
 */
export async function readPoolAverageFeed(
  rpc: EvmRpc,
  feed: Address,
  at: { block?: bigint; stateOverride?: StateOverride } = {},
): Promise<PoolAverageReading | null> {
  const r = await read<readonly [bigint, bigint, bigint, bigint, bigint, number]>(
    `check of ${feed}`,
    () =>
      rpc.readContract({
        address: feed,
        abi: POOL_AVERAGE_FEED_ABI,
        functionName: 'check',
        blockNumber: at.block,
        ...(at.stateOverride ? { stateOverride: at.stateOverride } : {}),
      }),
  );
  return r
    ? {
        average: r[0],
        spot: r[1],
        ownAverage: r[2],
        liquidity: r[3],
        meanLiquidity: r[4],
        reason: averageRefusalOf(r[5]),
      }
    : null;
}

/** One asset as a pool-average feed would be deployed for it (contracts/script/config/pool-feeds). */
export type PoolFeedPlan = {
  pool: Address;
  base: Address;
  quote: Address;
  feed: Address;
  baseDecimals: number;
  quoteDecimals: number;
  window: number;
  minLiquidity: bigint;
  jumpBps: number;
  maxRounds: number;
};

/**
 * What a pool-average feed deployed from `plan` would answer at `block`, read from the pool and the
 * Chainlink feed themselves: for a chain where the feed is not deployed yet. Sends nothing.
 */
export async function readPoolAveragePlan(
  rpc: EvmRpc,
  plan: PoolFeedPlan,
  at: { block: bigint; time: bigint },
): Promise<PoolAverageReading & { spotAt: bigint | null; feedDecimals: number }> {
  const blockNumber = at.block;
  const lower = (a: string | null) => a?.toLowerCase() ?? null;
  const call = <T>(address: Address, abi: unknown, functionName: string, args?: unknown[]) =>
    read<T>(`${functionName} of ${address}`, () =>
      rpc.readContract({
        address,
        abi: abi as typeof POOL_ABI,
        functionName: functionName as never,
        args: args as never,
        blockNumber,
      }),
    );
  type RoundWords = readonly [bigint, bigint, bigint, bigint, bigint];
  const roundOf = (r: RoundWords | null): FeedRound =>
    r ? { roundId: r[0], answer: r[1], updatedAt: r[3] } : null;

  const [
    token0,
    token1,
    baseDecimals,
    quoteDecimals,
    feedDecimals,
    liquidity,
    observed,
    latestWords,
  ] = await Promise.all([
    call<string>(plan.pool, POOL_ABI, 'token0'),
    call<string>(plan.pool, POOL_ABI, 'token1'),
    call<number>(plan.base, DECIMALS_ABI, 'decimals'),
    call<number>(plan.quote, DECIMALS_ABI, 'decimals'),
    call<number>(plan.feed, ROUND_FEED_ABI, 'decimals'),
    call<bigint>(plan.pool, POOL_ABI, 'liquidity'),
    call<readonly [readonly bigint[], readonly bigint[]]>(plan.pool, POOL_ABI, 'observe', [
      [plan.window, 0],
    ]),
    call<RoundWords>(plan.feed, ROUND_FEED_ABI, 'latestRoundData'),
  ]);
  const base = lower(plan.base);
  const quote = lower(plan.quote);
  const baseIsToken0 = lower(token0) === base && lower(token1) === quote;
  const unchanged =
    (baseIsToken0 || (lower(token0) === quote && lower(token1) === base)) &&
    baseDecimals === plan.baseDecimals &&
    quoteDecimals === plan.quoteDecimals &&
    feedDecimals !== null;

  // The rounds before the latest, one at a time, until one is a window old: as the contract walks.
  const latest = roundOf(latestWords);
  const earlier: FeedRound[] = [];
  if (usable(latest)) {
    const start = at.time - BigInt(plan.window);
    let stamp = latest.updatedAt;
    for (let n = 1; stamp > start && n <= plan.maxRounds && latest.roundId >= BigInt(n); n++) {
      const round = roundOf(
        await call<RoundWords>(plan.feed, ROUND_FEED_ABI, 'getRoundData', [
          latest.roundId - BigInt(n),
        ]),
      );
      earlier.push(round);
      if (!usable(round)) break;
      stamp = round.updatedAt;
    }
  }

  const reading = poolAverageOf(
    {
      baseIsToken0,
      baseDecimals: plan.baseDecimals,
      quoteDecimals: plan.quoteDecimals,
      feedDecimals: feedDecimals ?? 0,
      window: plan.window,
      minLiquidity: plan.minLiquidity,
      jumpBps: plan.jumpBps,
      maxRounds: plan.maxRounds,
    },
    {
      now: at.time,
      unchanged,
      latest,
      earlier,
      liquidity,
      observed:
        observed && observed[0].length === 2 && observed[1].length === 2
          ? {
              tickCumulatives: [observed[0][0] as bigint, observed[0][1] as bigint],
              perLiquidity: [observed[1][0] as bigint, observed[1][1] as bigint],
            }
          : null,
    },
  );
  return {
    ...reading,
    spotAt: usable(latest) ? latest.updatedAt : null,
    feedDecimals: feedDecimals ?? 0,
  };
}
