import {
  type EvmRpc,
  fromScaled,
  gapBps,
  marketAt,
  type PoolFeedPlan,
  readPoolAveragePlan,
} from '@colosseum/chain-evm/vault';
import { z } from 'zod';

// The keeper's dry run on a chain where no vault of ours is deployed yet (Robinhood Chain mainnet):
// for every asset of the chain's pool-feed file (contracts/script/config/pool-feeds/<chain id>.json) it
// reads the Chainlink feed and the Uniswap v3 pool at one block and says what the keeper's price check
// would decide there: the Chainlink spot, the pool's average over the window, how far apart they are,
// and why a pool-average feed deployed from that file would give no answer. It holds no key, signs
// nothing and sends nothing: there is no path from here to a transaction.
//
// What it cannot say, with no factory to read: the asset's price range, the closed days, the guardian's
// halts and an issuer's pause. The session is the file's `watch` section, a setting, as the distance and
// the price's greatest age are; on a deployed chain all four are the factory's.

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const count = z.number().int().nonnegative();

/** The pool-feed file of a chain, as the deploy script reads it, with the watch's own section. */
export const PoolFeedsFile = z.object({
  chainId: z.number().int().positive(),
  quoteToken: address,
  quoteDecimals: count.max(18),
  window: count.min(600),
  maxRounds: count.min(1).max(64),
  /** What the keeper's check would be held to: the vault's own settings once it is deployed. */
  watch: z.object({
    /** Seconds after midnight UTC. */
    sessionOpen: count.max(86_400),
    sessionClose: count.max(86_400),
    priceDevBps: count.max(10_000),
    /** The greatest age of a Chainlink answer, in seconds. */
    maxAge: count.min(60),
  }),
  assets: z.array(
    z.object({
      symbol: z.string().min(1),
      token: address,
      tokenDecimals: count.max(18),
      feed: address,
      pool: address,
      minLiquidity: z.string().regex(/^[0-9]+$/),
      jumpBps: count.min(1).max(2000),
      holds: z.array(z.string()),
      accepted: z.boolean(),
    }),
  ),
});
export type PoolFeedsFile = z.infer<typeof PoolFeedsFile>;

/** One asset at one block: what the keeper's price check would decide, and on what. */
export type WatchLine = {
  asset: string;
  /** `would-pass`: a keeper leg's price check would pass now. It says nothing of the trade itself. */
  outcome: 'would-pass' | 'would-refuse';
  /** Why it would be refused, by the vault's error, with the feed's reason after it; empty when it passes. */
  reason: string;
  /** Chainlink's latest answer, dollars for one token, and its age by the block's clock. */
  spot: string | null;
  spotAgeS: number | null;
  /** The pool's average over the window, and Chainlink's own. */
  poolAverage: string | null;
  ownAverage: string | null;
  /** How far the spot is from the pool's average, in bps of the average. */
  gapBps: number | null;
  /** Why a pool-average feed would give no answer; null when it would answer. */
  feedRefusal: string | null;
  liquidity: string;
  meanLiquidity: string;
  inSession: boolean;
  /** The holds the file puts on the asset: it is watched all the same, so a person can decide. */
  holds: string[];
  block: number;
};

/** One read of every asset of the file, at the node's latest block. */
export async function watchRound(o: {
  rpc: EvmRpc;
  file: PoolFeedsFile;
  log?: (line: WatchLine) => void;
}): Promise<WatchLine[]> {
  const { rpc, file } = o;
  const head = await rpc.getBlock({ blockTag: 'latest' });
  const at = { block: head.number, time: head.timestamp };
  const market = marketAt(
    'us_equity',
    {
      sessionOpen: file.watch.sessionOpen,
      sessionClose: file.watch.sessionClose,
      closedUntil: 0n,
      closedToday: false,
    },
    at.time,
  );
  const lines: WatchLine[] = [];
  for (const a of file.assets) {
    const plan: PoolFeedPlan = {
      pool: a.pool as PoolFeedPlan['pool'],
      base: a.token as PoolFeedPlan['base'],
      quote: file.quoteToken as PoolFeedPlan['quote'],
      feed: a.feed as PoolFeedPlan['feed'],
      baseDecimals: a.tokenDecimals,
      quoteDecimals: file.quoteDecimals,
      window: file.window,
      minLiquidity: BigInt(a.minLiquidity),
      jumpBps: a.jumpBps,
      maxRounds: file.maxRounds,
    };
    const r = await readPoolAveragePlan(rpc, plan, at);
    const gap = r.spot > 0n ? gapBps(r.spot, r.average) : null;
    const age = r.spotAt === null ? null : Number(at.time - r.spotAt);
    // The vault's own comparison, with nothing rounded: the distance against the average.
    const apart = r.spot > r.average ? r.spot - r.average : r.average - r.spot;
    const far = apart * 10_000n > r.average * BigInt(file.watch.priceDevBps);
    // The vault's order: the market, then the price and its age, then the average, then the distance.
    const reason =
      market === 'closed'
        ? 'MarketClosed'
        : r.spot === 0n
          ? 'AssetNotPriced: FeedDown'
          : age !== null && age > file.watch.maxAge
            ? 'PriceStale'
            : r.reason
              ? `AssetNotPriced: ${r.reason}`
              : far
                ? 'PriceDeviation'
                : '';
    const shown = (v: bigint) => (v > 0n ? fromScaled(v, r.feedDecimals) : null);
    const line: WatchLine = {
      asset: a.symbol,
      outcome: reason ? 'would-refuse' : 'would-pass',
      reason,
      spot: shown(r.spot),
      spotAgeS: age,
      poolAverage: shown(r.average),
      ownAverage: shown(r.ownAverage),
      gapBps: gap,
      feedRefusal: r.reason,
      liquidity: r.liquidity.toString(),
      meanLiquidity: r.meanLiquidity.toString(),
      inSession: market === 'open',
      holds: a.holds,
      block: Number(at.block),
    };
    lines.push(line);
    o.log?.(line);
  }
  return lines;
}
