import { describe, expect, it } from 'vitest';
import { MULTIPLIER_WINDOW_S, referenceOf, tradeRefusal } from '../src/vault/keeper';

// The keeper checks of `keeperSwap` written again (keeper.ts), at the contract's own boundaries.

const NOW = 1_791_246_000n; // a Monday, 22:40 UTC
const asset = {
  source: 1,
  feed: '0x00000000000000000000000000000000000000f1',
  flags: 1,
  minPrice: 100_00000000n,
  maxPrice: 200_00000000n,
  maxAge: 3_600,
};
const round = (answer: bigint, age = 60n) => ({ answer, updatedAt: NOW - age });

describe('the reference, in the contract’s order', () => {
  it('values an asset with a feed, the switch, a price in range, fresh, near its average', () => {
    expect(referenceOf(asset, round(150_00000000n), round(150_00000000n), 200, NOW)).toBeNull();
  });
  it('refuses at each check, the first that fails', () => {
    const ok = round(150_00000000n);
    expect(referenceOf({ ...asset, source: 0 }, ok, ok, 200, NOW)).toBe('AssetNotPriced');
    expect(referenceOf({ ...asset, flags: 0 }, ok, ok, 200, NOW)).toBe('KeeperAssetOff');
    expect(referenceOf(asset, null, ok, 200, NOW)).toBe('AssetNotPriced');
    expect(referenceOf(asset, round(0n), ok, 200, NOW)).toBe('AssetNotPriced');
    expect(referenceOf(asset, round(99_99999999n), ok, 200, NOW)).toBe('PriceOutOfRange');
    expect(referenceOf(asset, round(200_00000001n), ok, 200, NOW)).toBe('PriceOutOfRange');
    expect(referenceOf(asset, round(150_00000000n, 3_601n), ok, 200, NOW)).toBe('PriceStale');
    expect(referenceOf(asset, round(150_00000000n, 3_600n), ok, 200, NOW)).toBeNull();
    expect(referenceOf(asset, round(150_00000000n, -3_601n), ok, 200, NOW)).toBe('PriceStale');
    expect(referenceOf(asset, ok, null, 200, NOW)).toBe('AssetNotPriced');
    expect(referenceOf(asset, ok, round(150_00000000n, 3_601n), 200, NOW)).toBe('PriceStale');
    // 2% of the average apart is allowed, a unit more is not
    expect(referenceOf(asset, round(153_00000000n), ok, 200, NOW)).toBeNull();
    expect(referenceOf(asset, round(153_00000001n), ok, 200, NOW)).toBe('PriceDeviation');
  });
});

describe('what stops a trade in an asset', () => {
  const base = {
    lastKeeperAt: 0n,
    cooldown: 3_600,
    effectiveAt: null,
    paused: null,
    haltUntil: 0n,
    session: 'always' as const,
    market: { sessionOpen: 52_200, sessionClose: 72_000, closedUntil: 0n, closedToday: false },
  };
  it('lets a tradable asset go', () => {
    expect(tradeRefusal(base, NOW)).toBeNull();
  });
  it('holds to the cooldown, the multiplier window, the pause, the halt and the session, in that order', () => {
    expect(tradeRefusal({ ...base, lastKeeperAt: NOW - 3_599n }, NOW)).toBe('Cooldown');
    expect(tradeRefusal({ ...base, lastKeeperAt: NOW - 3_600n }, NOW)).toBeNull();
    expect(tradeRefusal({ ...base, effectiveAt: NOW + MULTIPLIER_WINDOW_S - 1n }, NOW)).toBe(
      'MultiplierWindow',
    );
    expect(tradeRefusal({ ...base, effectiveAt: NOW - MULTIPLIER_WINDOW_S }, NOW)).toBeNull();
    expect(tradeRefusal({ ...base, effectiveAt: 0n }, NOW)).toBeNull();
    expect(tradeRefusal({ ...base, effectiveAt: 'unanswered' }, NOW)).toBe('MultiplierWindow');
    expect(tradeRefusal({ ...base, paused: 1n }, NOW)).toBe('MarketClosed');
    expect(tradeRefusal({ ...base, paused: 'unanswered' }, NOW)).toBe('MarketClosed');
    expect(tradeRefusal({ ...base, paused: 0n }, NOW)).toBeNull();
    expect(tradeRefusal({ ...base, haltUntil: NOW + 1n }, NOW)).toBe('MarketClosed');
    // 22:40 UTC is after the session's close
    expect(tradeRefusal({ ...base, session: 'us_equity' }, NOW)).toBe('MarketClosed');
    expect(
      tradeRefusal(
        {
          ...base,
          session: 'us_equity',
          market: { ...base.market, sessionOpen: 0, sessionClose: 86_400 },
        },
        NOW,
      ),
    ).toBeNull();
  });
});
