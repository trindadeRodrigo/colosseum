import { marketAt } from './market';

// The vault's keeper checks written again, as `keeperSwap` makes them before it trades
// (contracts/src/BasketVault.sol: `_beforeLeg`, `_checkToken`, `_checkMarket`, `_reference`). They say
// what a leg would be refused for before one is sent; the contract still has the last word, and it also
// checks the direction, the band, "no further", the value received and the loss cap, which depend on
// the trade.

/** Why the keeper may not value an asset now, by the contract's error, as every adapter names it. */
export type ReferenceRefusal =
  | 'AssetNotPriced'
  | 'KeeperAssetOff'
  | 'PriceOutOfRange'
  | 'PriceStale'
  | 'PriceDeviation';

/** Why the asset itself cannot be traded now, though it can be valued. */
export type TradeRefusal = 'Cooldown' | 'MultiplierWindow' | 'MarketClosed';

/** A day either side of a token's multiplier change, in seconds (`MULTIPLIER_WINDOW`). */
export const MULTIPLIER_WINDOW_S = 86_400n;
/** The bit of `AssetConfig.flags` that switches the keeper on for an asset (`KEEPER_ON`). */
export const KEEPER_ON = 1;

/** A feed's answer and its time, or null for one that does not answer as a feed or answers zero or below. */
export type Round = { answer: bigint; updatedAt: bigint } | null;

/** A price stamped at most `maxAge` ago, and not further ahead of the clock than that (`_fresh`). */
export const fresh = (stamp: bigint, maxAge: number, now: bigint) =>
  stamp <= now ? now - stamp <= BigInt(maxAge) : stamp - now <= BigInt(maxAge);

/** `_reference`: in the contract's order, a feed, the switch, a price, the range, its age, the average's age, the distance. */
export function referenceOf(
  a: {
    source: number;
    feed: string | null;
    flags: number;
    minPrice: bigint;
    maxPrice: bigint;
    maxAge: number;
  },
  price: Round,
  average: Round,
  devBps: number,
  now: bigint,
): ReferenceRefusal | null {
  if (a.source !== 1 || !a.feed) return 'AssetNotPriced';
  if ((a.flags & KEEPER_ON) === 0) return 'KeeperAssetOff';
  if (!price || price.answer <= 0n) return 'AssetNotPriced';
  if (price.answer < a.minPrice || price.answer > a.maxPrice) return 'PriceOutOfRange';
  if (!fresh(price.updatedAt, a.maxAge, now)) return 'PriceStale';
  if (!average || average.answer <= 0n) return 'AssetNotPriced';
  if (!fresh(average.updatedAt, a.maxAge, now)) return 'PriceStale';
  const apart =
    price.answer > average.answer ? price.answer - average.answer : average.answer - price.answer;
  if (average.answer > (1n << 128n) - 1n || apart * 10_000n > average.answer * BigInt(devBps))
    return 'PriceDeviation';
  return null;
}

/**
 * Checks 6, 10, 9 on the asset traded, in the contract's order: its cooldown, then the token (the
 * multiplier window, the issuer's pause, the guardian's halt), then the market. A schedule or a pause
 * probe that does not answer refuses the trade, as the contract does. The issuer's pause and the halt
 * are `MarketClosed` here, as every adapter names `AssetPaused` and `AssetHalted`.
 */
export function tradeRefusal(
  t: {
    lastKeeperAt: bigint;
    cooldown: number;
    /** `effectiveAt()` where the asset has a schedule; null where it has none; 'unanswered' where it does not answer. */
    effectiveAt: bigint | null | 'unanswered';
    /** The pause probe's word where the asset has one; null where it has none; 'unanswered' where it does not answer. */
    paused: bigint | null | 'unanswered';
    haltUntil: bigint;
    session: 'always' | 'us_equity';
    market: {
      sessionOpen: number;
      sessionClose: number;
      closedUntil: bigint;
      closedToday: boolean;
    };
  },
  now: bigint,
): TradeRefusal | null {
  if (now < t.lastKeeperAt + BigInt(t.cooldown)) return 'Cooldown';
  if (t.effectiveAt === 'unanswered') return 'MultiplierWindow';
  if (t.effectiveAt !== null) {
    const apart = t.effectiveAt > now ? t.effectiveAt - now : now - t.effectiveAt;
    if (apart < MULTIPLIER_WINDOW_S) return 'MultiplierWindow';
  }
  if (t.paused === 'unanswered' || (t.paused !== null && t.paused !== 0n)) return 'MarketClosed';
  if (now < t.haltUntil) return 'MarketClosed';
  return marketAt(t.session, t.market, now) === 'closed' ? 'MarketClosed' : null;
}
