import { ChainError } from '@colosseum/schemas';
import { toScaled } from './amounts';

// What an owner's trade is held to before it is built, beside the vault's own minimum.
//
// The vault checks an owner's swap against nothing but `minOut`, and `minOut` used to come from the
// pool's own quote: whatever the pool said was the price. A thin pool can be pushed for a few hundred
// dollars, a person's order quoted and filled there, and the pool sold back. So a trade is also held
// to the asset's Chainlink price, the one witness that is not the pool:
//
// - the pool's quote is within `priceBoundBps` of what the feed says the trade is worth, either way,
//   pool fee included, or the step is refused (`PriceDeviation`);
// - a feed that gives no price refuses (`AssetNotPriced`): no witness is not a pass;
// - a feed is the witness only while it is live: its answer younger than the network's
//   `liveFeedSeconds` (the chain's `sessionPriceAge`, an hour). A stock's feed is not live overnight
//   or over a weekend, and holding a Saturday trade to 2% of Friday's close would refuse an honest
//   move. Past that age the witness is the one-hour average of the asset's average pool (the Uniswap
//   v3 pool the keeper's `PoolAverageFeed` is designed around, read here off chain with the same
//   arithmetic), held to the same bound, inside an outer rail: the quote is within `staleRailBps` of
//   the feed's last answer, however old;
// - an asset whose record says its average cannot be used yet (too little history) keeps the feed
//   as its witness up to the asset's own `maxAge`, the only one it has, and past that is not traded.
//   An average the record calls usable that reads thin, short or unreadable refuses at once: the
//   witness is never chosen by thinning a pool;
// - while the witness is not the live feed, one trade is at most `maxTradeUsdNotLive`, and the
//   feed's last answer anchors the rail for `staleRailMaxAgeSeconds` and no longer;
// - `minOut` is never under the feed's worth less the bound, so the fill itself is held to it on the
//   chain, whatever the pool does between the quote and the block;
// - one trade is at most the asset's `maxTradeUsd`, the size its pool was measured to fill.
//
// What it does not do: it is the app's check, not the contract's. Someone who builds their own call
// data for their own vault is held to their own `minOut` only. And where the feed is itself made from
// pools (GLD), the witness can be moved with enough money in enough pools: there the size limit is the
// protection that counts.

/** What a network holds its owners' trades to. */
export type TradeLimits = {
  /**
   * How far a pool's quote may be from the Chainlink price, in basis points, pool fee included. Null:
   * not checked on this network, and the record says why.
   */
  priceBoundBps: number | null;
  /** The largest single trade of each asset, in dollars, by token address in lower case. Null or absent: none. */
  maxTradeUsd: Readonly<Record<string, number | null>>;
  /**
   * While an asset's feed is stale: how far a pool's quote may be from the feed's last answer, however
   * old, in basis points. With it, a stale feed is replaced as the witness by the one-hour average of
   * the asset's average pool (`average`), held to the same `priceBoundBps`. Null or absent: a stale
   * feed refuses, as it did before there was a second witness.
   */
  staleRailBps?: number | null;
  /** Each asset's average pool, by token address in lower case. Null or absent: it has none. */
  average?: Readonly<Record<string, AveragePool | null>>;
  /**
   * How young a feed's answer is while the feed is the witness: the network's `sessionPriceAge`, an
   * hour on Robinhood Chain. Older than that, an asset whose hour average can be used is held to the
   * average instead; one whose average cannot be used keeps the feed up to its `maxAge`. Null or
   * absent: a feed is the witness until its `maxAge`.
   */
  liveFeedSeconds?: number | null;
  /**
   * The largest single trade of any asset while its witness is not the live feed, in dollars: the
   * smaller of this and the asset's own. What a trade can lose to someone who moves both pools is the
   * rail times its size, so the size is held down while the pools are all there is. Null or absent: none.
   */
  maxTradeUsdNotLive?: number | null;
  /**
   * How old the feed's last answer may be and still anchor the rail, in seconds. Past it an asset is
   * not traded against its average: a feed that has died does not leave the pool as the only witness.
   * Null or absent: no limit.
   */
  staleRailMaxAgeSeconds?: number | null;
};

/**
 * The pool an asset's one-hour average is read from while its feed is stale: the Uniswap v3 pool the
 * keeper's `PoolAverageFeed` is designed around, read off chain with the same arithmetic. `usable` is
 * stated, never guessed: false while the pool keeps too little history for an hour's window, and then
 * the asset is not traded on a stale feed at all.
 */
export type AveragePool = { pool: string; minLiquidity: bigint; usable: boolean };

/** What the average pool said, for a trade whose feed is stale. */
export type AverageWitness =
  | { state: 'ok'; usdPerToken: string }
  /** The record says the pool's history is too short to use. */
  | { state: 'unusable' }
  /** Read, and refused by the average's own rules: too thin now or over the hour, or under an hour of history. */
  | { state: 'thin' | 'short' | 'unreadable' };

/** No limit at all: for a chain in memory and for tests of something else. */
export const NO_TRADE_LIMITS: TradeLimits = { priceBoundBps: null, maxTradeUsd: {} };

/** The feed's answer for the asset, as the reader gives it. */
export type FeedPrice = {
  usdPerToken: string;
  ageSeconds: number;
  maxAgeSeconds: number;
  /** Whether the asset's market is open by the vault's own calendar, where it has one. */
  market?: 'open' | 'closed' | 'unknown';
};

export type HeldTrade = {
  symbol: string;
  /** `buy`: cash in, the asset out. `sell`: the asset in, cash out. */
  side: 'buy' | 'sell';
  /** This trade's own input, raw. */
  amountIn: bigint;
  /** What the pool quotes for it, raw. */
  out: bigint;
  /** Everything this transaction puts through the same pool up to and including this trade, raw, in the trade's input token. */
  amountInSoFar: bigint;
  cashDecimals: number;
  assetDecimals: number;
  /** Null where the asset has no feed, or the network does not check. */
  price: FeedPrice | null;
  /** The asset's one-hour pool average, read only while its feed is stale and the network has a rail. */
  average?: AverageWitness | null;
};

const SCALE = 10n ** 18n;
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
const days = (seconds: number) => {
  const d = Math.round(seconds / 86_400);
  return d <= 1 ? 'a day' : `${d} days`;
};
const hours = (seconds: number) => {
  const h = Math.round(seconds / 3600);
  return h < 1 ? 'under an hour' : h === 1 ? '1 hour' : `${h} hours`;
};

/**
 * A network whose money is real states both limits: null means unchecked, and on a mainnet nothing
 * may be unchecked. Said of the chain's number and of the record's own name, so it holds whichever
 * way a record comes to be admitted. Returns what is missing, or null.
 */
export function unlimitedOnMainnet(record: {
  network: string;
  evmChainId: number;
  priceBoundBps: number | null;
  staleRailBps?: number | null;
  maxTradeUsdNotLive?: number | null;
  staleRailMaxAge?: number | null;
  assets: readonly { symbol: string; maxTradeUsd: number | null }[];
}): string | null {
  const mainnet = [1, 4663, 8453].includes(record.evmChainId) || /-mainnet$/.test(record.network);
  if (!mainnet) return null;
  if (record.priceBoundBps === null)
    return 'a mainnet record states no priceBoundBps: an owner trade would be checked against no price';
  // Where the average may stand in for the feed, its two limits are stated with it.
  if ((record.staleRailBps ?? null) !== null) {
    if ((record.maxTradeUsdNotLive ?? null) === null)
      return 'a mainnet record with a rail states no maxTradeUsdNotLive: a trade of any size would lean on the pools alone';
    if ((record.staleRailMaxAge ?? null) === null)
      return 'a mainnet record with a rail states no staleRailMaxAge: a feed that died would anchor trades for ever';
  }
  const open = record.assets.filter((a) => a.maxTradeUsd === null).map((a) => a.symbol);
  return open.length
    ? `a mainnet record states no maxTradeUsd for ${open.join(', ')}: a trade of any size would be built`
    : null;
}
const dollars = (usd: number) =>
  `$${usd.toLocaleString('en-US', { maximumFractionDigits: usd < 100 ? 2 : 0 })}`;

/** What `amountIn` is worth on the other side at the feed's price, raw. */
export function worthAtFeed(
  t: Pick<HeldTrade, 'side' | 'cashDecimals' | 'assetDecimals'>,
  amountIn: bigint,
  usdPerToken: string,
): bigint {
  const price = toScaled(usdPerToken);
  if (price <= 0n) throw new ChainError('AssetNotPriced', 'the reference price is not above zero');
  const cash = 10n ** BigInt(t.cashDecimals);
  const asset = 10n ** BigInt(t.assetDecimals);
  return t.side === 'buy'
    ? (amountIn * asset * SCALE) / (cash * price)
    : (amountIn * price * cash) / (asset * SCALE);
}

/**
 * Holds one trade to the limits, or throws the refusal a person reads. Returns the least the trade
 * may fill at by the feed (`feedFloor`, raw output), or null where the network does not check.
 */
export function holdTrade(limits: TradeLimits, token: string, t: HeldTrade): bigint | null {
  const assetMax = limits.maxTradeUsd[token.toLowerCase()] ?? null;
  const checked = limits.priceBoundBps !== null;
  if (checked && !t.price)
    throw new ChainError(
      'AssetNotPriced',
      `${t.symbol} has no reference price to check the pool against: not trading`,
    );
  // Three ages of a feed. Live: younger than the network's `liveFeedSeconds`, and the feed is the
  // witness. Past that, the asset's hour average is the witness wherever it can be used, inside the
  // rail. Stale: past the asset's own `maxAge`, and with no average to use the trade is refused;
  // between the two the feed is still the only witness there is, and it is kept.
  const stale = checked && t.price !== null && t.price.ageSeconds > t.price.maxAgeSeconds;
  const live =
    t.price !== null &&
    !stale &&
    t.price.ageSeconds <= (limits.liveFeedSeconds ?? t.price.maxAgeSeconds);
  const rail = limits.staleRailBps ?? null;
  // A stale feed with no second witness for the network or the asset: nothing to check against.
  if (stale && t.price && (rail === null || !t.average))
    throw new ChainError(
      'PriceStale',
      t.price.market === 'closed'
        ? `no fresh reference price for ${t.symbol}: the market is closed; trades of ${t.symbol} resume when it opens`
        : `no fresh reference price for ${t.symbol}: the last one is ${hours(t.price.ageSeconds)} old, and it may be ${hours(t.price.maxAgeSeconds)} at most; trades of ${t.symbol} resume when a new one arrives`,
    );
  // An average the record says can be used, and that cannot be read as one now: refused, whatever
  // the feed's age. Falling back to the feed here would let whoever thins the average pool choose
  // the witness: an answer many hours old in place of the pool's last hour.
  const broken =
    !live &&
    rail !== null &&
    t.average != null &&
    t.average.state !== 'ok' &&
    t.average.state !== 'unusable';
  // A second witness that cannot be used: said plainly, and not traded.
  if ((stale || broken) && t.average && t.average.state !== 'ok')
    throw new ChainError(
      'PriceStale',
      `${t.symbol} trades only while its market is open, for now: ${
        t.average.state === 'unusable'
          ? "its pool keeps too little history for an hour's average price"
          : t.average.state === 'thin'
            ? "the pool its hour's average price comes from is too thin to trust"
            : t.average.state === 'short'
              ? 'its pool has less than an hour of history for an average price'
              : "its hour's average price could not be read"
      }`,
    );

  // The rail has an age: a feed silent for longer than the network allows no longer anchors
  // anything, and the pool is not left as the only witness for ever.
  const railMaxAge = limits.staleRailMaxAgeSeconds ?? null;
  if (
    !live &&
    rail !== null &&
    t.price &&
    t.average?.state === 'ok' &&
    railMaxAge !== null &&
    t.price.ageSeconds > railMaxAge
  )
    throw new ChainError(
      'PriceStale',
      `the reference price of ${t.symbol} has been silent for ${days(t.price.ageSeconds)}, longer than the ${days(railMaxAge)} a trade may lean on its last answer: not trading ${t.symbol} until it speaks again`,
    );

  // While the witness is not the live feed, one trade is at most the network's smaller limit.
  const quiet = checked && t.price !== null && !live ? (limits.maxTradeUsdNotLive ?? null) : null;
  const lower = quiet !== null && (assetMax === null || quiet < assetMax);
  const max = lower ? quiet : assetMax;
  if (max !== null) {
    // In dollars by the feed where there is one, so a pushed pool cannot make a sale look small;
    // by the cash side otherwise.
    const cash = 10 ** t.cashDecimals;
    const soFar =
      t.side === 'buy'
        ? Number(t.amountInSoFar) / cash
        : t.price
          ? Number(worthAtFeed(t, t.amountInSoFar, t.price.usdPerToken)) / cash
          : (Number(t.out) / cash) * (Number(t.amountInSoFar) / Number(t.amountIn));
    if (soFar > max)
      throw new ChainError(
        'BadTrade',
        lower
          ? `${dollars(soFar)} of ${t.symbol} in one go is more than is traded ${t.price?.market === 'closed' ? `while ${t.symbol}'s market is closed` : `while ${t.symbol} has no live reference price`}: at most ${dollars(max)} at a time. Trade less, or in parts`
          : `${dollars(soFar)} of ${t.symbol} in one go is more than its pool is trusted to fill: at most ${dollars(max)} at a time. Trade less, or in parts`,
      );
  }

  if (!checked || !t.price) return null;
  const bound = BigInt(limits.priceBoundBps as number);
  // The witness: the feed while it is fresh; the last hour's average of the asset's pool while it is
  // stale, inside an outer rail around the feed's last answer.
  const average = !live && rail !== null && t.average?.state === 'ok' ? t.average : null;
  if (average && rail !== null) {
    const last = worthAtFeed(t, t.amountIn, t.price.usdPerToken);
    const off = t.out > last ? t.out - last : last - t.out;
    if (last <= 0n || off * 10_000n > BigInt(rail) * last)
      throw new ChainError(
        'PriceDeviation',
        `the pool's price for ${t.symbol} is ${last > 0n ? pct((off * 10_000n + last - 1n) / last) : 'far'} ${t.out < last ? 'worse' : 'better'} than its last reference price, from ${hours(t.price.ageSeconds)} ago, more than the ${pct(BigInt(rail))} allowed while there is no fresh one: not trading`,
      );
  }
  const against = average ? "the last hour's average price" : 'the reference price';
  const fair = worthAtFeed(t, t.amountIn, average ? average.usdPerToken : t.price.usdPerToken);
  if (fair <= 0n)
    throw new ChainError('BadTrade', `a trade of ${t.symbol} too small to price: not trading`);
  const gap = t.out > fair ? t.out - fair : fair - t.out;
  // Compared without rounding to whole basis points: 2.0099% is past a bound of 2%.
  if (gap * 10_000n > bound * fair) {
    // Shown rounded up, so a gap just past the bound never reads as the bound itself.
    const shown = (gap * 10_000n + fair - 1n) / fair;
    const way = t.out < fair ? 'worse' : 'better';
    // Just past the bound is most often an ordinary move, and passes in a moment; far past it is a
    // pool that is thin for this size, or pushed.
    throw new ChainError(
      'PriceDeviation',
      gap * 10_000n <= bound * fair + (bound * fair) / 2n
        ? `the pool's price for ${t.symbol} is ${pct(shown)} ${way} than ${against} right now, just past the ${pct(bound)} allowed: try again shortly`
        : `the pool's price for ${t.symbol} is ${pct(shown)} ${way} than ${against}, more than the ${pct(bound)} allowed: not trading. The pool may be thin or pushed; try a smaller amount, or later`,
    );
  }
  return (fair * (10_000n - bound)) / 10_000n;
}
