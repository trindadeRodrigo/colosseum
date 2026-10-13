import { readFileSync } from 'node:fs';
import type { EvmRpc } from '@colosseum/chain-evm/vault';
import { describe, expect, it } from 'vitest';
import { PoolFeedsFile, watchRound } from '../../apps/keeper/src/watch';

// The keeper's dry run on Robinhood Chain mainnet (watch.ts), on a stand-in for the node that answers
// what the chain answered on Friday 2026-10-09 at 16:30:00 UTC (block 84,298,619) for NVDA: the reads
// contracts/test/fork/RobinhoodForkPoolFeed.t.sol makes of the real pool and the real Chainlink feed.
// Nothing here has a key or a way to send.

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const POOL = '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3';
const FEED = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const FRIDAY_1630 = 1_791_563_400n;

const file = (more: Partial<PoolFeedsFile['watch']> = {}, floor = '1900000000000000000') =>
  PoolFeedsFile.parse({
    chainId: 4663,
    quoteToken: USDG,
    quoteDecimals: 6,
    window: 3600,
    maxRounds: 12,
    watch: { sessionOpen: 54_000, sessionClose: 71_100, priceDevBps: 150, maxAge: 93_600, ...more },
    assets: [
      {
        symbol: 'NVDA',
        token: NVDA,
        tokenDecimals: 18,
        feed: FEED,
        pool: POOL,
        minLiquidity: floor,
        jumpBps: 150,
        holds: [],
        accepted: false,
      },
    ],
  });

type Chain = { time: bigint; spot: bigint; spotAt: bigint; liquidity: bigint };
const friday: Chain = {
  time: FRIDAY_1630,
  spot: 23036242923n,
  spotAt: 1_791_558_556n,
  liquidity: 3_809_668_295_502_054_196n,
};

/** A node that answers the reads of one block, and counts anything else as a failure of the test. */
function node(chain: Chain) {
  const asked: string[] = [];
  const rpc = {
    getBlock: async () => ({ number: 84_298_619n, timestamp: chain.time }),
    readContract: async (call: { address: string; functionName: string; blockNumber?: bigint }) => {
      asked.push(call.functionName);
      expect(call.blockNumber).toBe(84_298_619n);
      const of = `${call.address.toLowerCase()} ${call.functionName}`;
      switch (of) {
        case `${POOL.toLowerCase()} token0`:
          return USDG;
        case `${POOL.toLowerCase()} token1`:
          return NVDA;
        case `${NVDA.toLowerCase()} decimals`:
          return 18;
        case `${USDG.toLowerCase()} decimals`:
          return 6;
        case `${FEED.toLowerCase()} decimals`:
          return 8;
        case `${POOL.toLowerCase()} liquidity`:
          return chain.liquidity;
        case `${POOL.toLowerCase()} observe`:
          return [
            [1_540_768_050_217n, 1_541_567_040_486n],
            [17436856855914321885839723400n, 17437181852926002201389968947n],
          ];
        case `${FEED.toLowerCase()} latestRoundData`:
          return [
            18446744073709552819n,
            chain.spot,
            chain.spotAt,
            chain.spotAt,
            18446744073709552819n,
          ];
        default:
          throw new Error(`the watch asked for ${of}`);
      }
    },
  } as unknown as EvmRpc;
  return { rpc, asked };
}

describe("the keeper's dry run on mainnet", () => {
  it('says the spot, the pool average, their gap and that the price check would pass, in session', async () => {
    const { rpc } = node(friday);
    const logged: unknown[] = [];
    const [line] = await watchRound({ rpc, file: file(), log: (l) => logged.push(l) });
    expect(line).toEqual({
      asset: 'NVDA',
      outcome: 'would-pass',
      reason: '',
      spot: '230.36242923',
      spotAgeS: 4844,
      poolAverage: '229.96583443',
      ownAverage: '230.36242923',
      gapBps: 17,
      feedRefusal: null,
      liquidity: '3809668295502054196',
      meanLiquidity: '3769316261038025369',
      inSession: true,
      holds: [],
      block: 84_298_619,
    });
    expect(logged).toEqual([line]);
  });

  it('holds the session to the file’s setting, not to a value of its own', async () => {
    // 16:30 UTC is inside 15:00 to 19:45 and outside a session that opens at 17:00.
    const late = await watchRound({ rpc: node(friday).rpc, file: file({ sessionOpen: 61_200 }) });
    expect([late[0]?.outcome, late[0]?.reason, late[0]?.inSession]).toEqual([
      'would-refuse',
      'MarketClosed',
      false,
    ]);
    // A Saturday is closed whatever the hours; the prices are still read and said.
    const saturday = await watchRound({
      rpc: node({ ...friday, time: FRIDAY_1630 + 86_400n }).rpc,
      file: file(),
    });
    expect([saturday[0]?.reason, saturday[0]?.poolAverage]).toEqual([
      'MarketClosed',
      '229.96583443',
    ]);
  });

  it('says why the feed would refuse, and the distance when that is what refuses', async () => {
    const thin = await watchRound({ rpc: node(friday).rpc, file: file({}, '3800000000000000000') });
    expect([thin[0]?.outcome, thin[0]?.reason, thin[0]?.feedRefusal, thin[0]?.gapBps]).toEqual([
      'would-refuse',
      'AssetNotPriced: ThinPool',
      'ThinPool',
      17,
    ]);
    // Chainlink 2% over where the token traded, and quiet for hours.
    const far = await watchRound({
      rpc: node({ ...friday, spot: 23456515111n }).rpc,
      file: file(),
    });
    expect([far[0]?.reason, far[0]?.feedRefusal, far[0]?.gapBps]).toEqual([
      'PriceDeviation',
      null,
      199,
    ]);
    // At 150 bps of the average and a unit more: the vault's comparison, with nothing rounded.
    const edge = 22996583443n + (22996583443n * 150n) / 10_000n;
    const at = await watchRound({ rpc: node({ ...friday, spot: edge }).rpc, file: file() });
    const past = await watchRound({ rpc: node({ ...friday, spot: edge + 1n }).rpc, file: file() });
    expect([at[0]?.reason, at[0]?.gapBps]).toEqual(['', 149]);
    expect([past[0]?.reason, past[0]?.gapBps]).toEqual(['PriceDeviation', 150]);
    // An answer older than the greatest age.
    const stale = await watchRound({ rpc: node(friday).rpc, file: file({ maxAge: 3600 }) });
    expect(stale[0]?.reason).toBe('PriceStale');
    // A feed that answers zero.
    const down = await watchRound({ rpc: node({ ...friday, spot: 0n }).rpc, file: file() });
    expect([down[0]?.reason, down[0]?.spot]).toEqual(['AssetNotPriced: FeedDown', null]);
  });

  it('reads the committed mainnet file: eleven assets, the design’s session, and no asset accepted', () => {
    const committed = PoolFeedsFile.parse(
      JSON.parse(
        readFileSync(
          new URL('../../contracts/script/config/pool-feeds/4663.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    expect(committed.chainId).toBe(4663);
    expect(committed.assets).toHaveLength(11);
    expect(committed.watch).toEqual({
      sessionOpen: 54_000,
      sessionClose: 71_100,
      priceDevBps: 150,
      maxAge: 93_600,
    });
    expect(committed.assets.some((a) => a.accepted)).toBe(false);
  });
});
