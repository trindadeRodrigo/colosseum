import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainError } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { deploymentLimits, EvmDeploymentRecord } from '../src/vault/deployment';
import {
  type HeldTrade,
  holdTrade,
  NO_TRADE_LIMITS,
  type TradeLimits,
  unlimitedOnMainnet,
  worthAtFeed,
} from '../src/vault/trade-limits';

// What an owner's trade is held to before it is built: the feed's price, and the asset's largest
// trade. No node: the numbers are worked by hand.

const GLD_AT = '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e';
const LIMITS: TradeLimits = { priceBoundBps: 200, maxTradeUsd: { [GLD_AT]: 1_000 } };
const USD = 1_000_000n;
const ONE = 10n ** 18n;
const FRESH = { usdPerToken: '400', ageSeconds: 60, maxAgeSeconds: 93_600 };
/** $400 of cash for GLD at $400: one token at the feed's price. */
const buyOf = (out: bigint, over: Partial<HeldTrade> = {}): HeldTrade => ({
  symbol: 'GLD',
  side: 'buy',
  amountIn: 400n * USD,
  amountInSoFar: 400n * USD,
  out,
  cashDecimals: 6,
  assetDecimals: 18,
  price: FRESH,
  ...over,
});
/** One GLD for cash: $400 at the feed's price. */
const sellOf = (out: bigint, over: Partial<HeldTrade> = {}): HeldTrade => ({
  ...buyOf(out),
  side: 'sell',
  amountIn: ONE,
  amountInSoFar: ONE,
  ...over,
});
const refusalOf = (work: () => unknown): ChainError => {
  try {
    work();
  } catch (e) {
    if (e instanceof ChainError) return e;
    throw e;
  }
  throw new Error('it was not refused');
};

describe("what a trade is worth at the feed's price", () => {
  it('is exact, in raw units, both ways and at other decimals', () => {
    const d = { cashDecimals: 6, assetDecimals: 18 };
    expect(worthAtFeed({ side: 'buy', ...d }, 400n * USD, '400')).toBe(ONE);
    expect(worthAtFeed({ side: 'sell', ...d }, ONE, '400')).toBe(400n * USD);
    expect(worthAtFeed({ side: 'buy', ...d }, 100n * USD, '225.28949995')).toBe(
      (100n * USD * ONE * ONE) / (USD * 225_289_499_950_000_000_000n),
    );
    // An 8-decimal token against 6-decimal cash.
    const btc = { cashDecimals: 6, assetDecimals: 8 };
    expect(worthAtFeed({ side: 'buy', ...btc }, 50_000n * USD, '100000')).toBe(50_000_000n);
    expect(worthAtFeed({ side: 'sell', ...btc }, 100_000_000n, '100000')).toBe(100_000n * USD);
    expect(() => worthAtFeed({ side: 'buy', ...d }, 1n, '0')).toThrow(ChainError);
  });
});

describe('the bound to the feed', () => {
  it("passes a quote inside the bound and gives the feed's floor: the worth less the bound", () => {
    // 0.5% under the feed: a pool's fee and a little impact.
    expect(holdTrade(LIMITS, GLD_AT, buyOf((ONE * 995n) / 1000n))).toBe((ONE * 98n) / 100n);
    expect(holdTrade(LIMITS, GLD_AT, sellOf(398n * USD))).toBe(392n * USD);
    // Exactly at the bound, either side, still passes.
    expect(holdTrade(LIMITS, GLD_AT, buyOf((ONE * 98n) / 100n))).toBe((ONE * 98n) / 100n);
    expect(holdTrade(LIMITS, GLD_AT, buyOf((ONE * 102n) / 100n))).toBe((ONE * 98n) / 100n);
  });

  it('refuses a quote further from the feed than the bound, worse or better, in words a person reads', () => {
    const worse = refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 95n) / 100n)));
    expect(worse.code).toBe('PriceDeviation');
    expect(worse.retryable).toBe(true);
    expect(worse.message).toBe(
      "the pool's price for GLD is 5.00% worse than the reference price, more than the 2.00% allowed: not trading. The pool may be thin or pushed; try a smaller amount, or later",
    );
    // A sale into a pool pushed down pays too little.
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, sellOf(380n * USD))).message).toMatch(
      /5\.00% worse/,
    );
    // And a price too good is not a price to trade at either: the pool is off its feed.
    const better = refusalOf(() => holdTrade(LIMITS, GLD_AT, sellOf(420n * USD)));
    expect(better.code).toBe('PriceDeviation');
    expect(better.message).toMatch(/5\.00% better than the reference price/);
    // One basis point past the bound.
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 9_799n) / 10_000n))).code).toBe(
      'PriceDeviation',
    );
  });

  it('compares the gap exactly: a fraction of a basis point past the bound is past it', () => {
    // 2.0099% under the feed. Floored to whole basis points it would read 2.00% and pass.
    const justPast = buyOf((ONE * 979_901n) / 1_000_000n);
    const refused = refusalOf(() => holdTrade(LIMITS, GLD_AT, justPast));
    expect(refused.code).toBe('PriceDeviation');
    // Shown rounded up, so it never reads as the bound itself; and as a moment's thing, not an error.
    expect(refused.message).toBe(
      "the pool's price for GLD is 2.01% worse than the reference price right now, just past the 2.00% allowed: try again shortly",
    );
    // The same on the other side, and one raw unit past the bound is enough.
    expect(
      refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 102n) / 100n + 1n))).message,
    ).toMatch(/2\.01% better than the reference price right now, just past the 2\.00% allowed/);
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 98n) / 100n - 1n))).code).toBe(
      'PriceDeviation',
    );
    // Exactly at the bound still passes, to the unit.
    expect(holdTrade(LIMITS, GLD_AT, buyOf((ONE * 98n) / 100n))).not.toBeNull();
    // Up to half the bound again past it reads as "try again"; further reads as a pool that is off.
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 97n) / 100n))).message).toMatch(
      /3\.00% worse .* just past the 2\.00% allowed: try again shortly/,
    );
    expect(
      refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf((ONE * 9_699n) / 10_000n))).message,
    ).toMatch(/3\.01% worse .* more than the 2\.00% allowed: not trading/);
  });

  it('refuses where there is no witness: a stale feed, or no feed at all', () => {
    const stale = refusalOf(() =>
      holdTrade(LIMITS, GLD_AT, buyOf(ONE, { price: { ...FRESH, ageSeconds: 93_601 } })),
    );
    expect(stale.code).toBe('PriceStale');
    expect(stale.retryable).toBe(true);
    // In hours, never in seconds: a person reads this.
    expect(stale.message).toBe(
      'no fresh reference price for GLD: the last one is 26 hours old, and it may be 26 hours at most; trades of GLD resume when a new one arrives',
    );
    expect(stale.message).not.toMatch(/93600|93601/);
    // A stock over a weekend: its market is closed, and that is what the person is told.
    const weekend = refusalOf(() =>
      holdTrade(
        LIMITS,
        GLD_AT,
        buyOf(ONE, { symbol: 'NVDA', price: { ...FRESH, ageSeconds: 150_000, market: 'closed' } }),
      ),
    );
    expect(weekend.code).toBe('PriceStale');
    expect(weekend.message).toBe(
      'no fresh reference price for NVDA: the market is closed; trades of NVDA resume when it opens',
    );
    // A closed market with a price still inside its age is a price: nothing is refused for the hour.
    expect(
      holdTrade(LIMITS, GLD_AT, buyOf(ONE, { price: { ...FRESH, market: 'closed' } })),
    ).not.toBeNull();
    // At its limit to the second it is still a price.
    expect(
      holdTrade(LIMITS, GLD_AT, buyOf(ONE, { price: { ...FRESH, ageSeconds: 93_600 } })),
    ).not.toBeNull();
    const none = refusalOf(() => holdTrade(LIMITS, GLD_AT, buyOf(ONE, { price: null })));
    expect(none.code).toBe('AssetNotPriced');
    expect(none.message).toMatch(/GLD has no reference price to check the pool against/);
  });

  it('a network that does not check holds nothing to the feed, and says so with null', () => {
    expect(holdTrade(NO_TRADE_LIMITS, GLD_AT, buyOf(ONE / 2n))).toBeNull();
    expect(holdTrade(NO_TRADE_LIMITS, GLD_AT, buyOf(ONE, { price: null }))).toBeNull();
    expect(
      holdTrade({ priceBoundBps: null, maxTradeUsd: { [GLD_AT]: null } }, GLD_AT, sellOf(1n)),
    ).toBeNull();
  });
});

describe('a stale feed: the last hour of the pool stands in, inside a rail', () => {
  const WEEKEND: TradeLimits = { ...LIMITS, staleRailBps: 1_000 };
  const STALE = { ...FRESH, ageSeconds: 130_000, market: 'closed' as const };
  // The feed last said $400; the pool's last hour averages $410.
  const witnessed = (out: bigint, over: Partial<HeldTrade> = {}) =>
    buyOf(out, { price: STALE, average: { state: 'ok', usdPerToken: '410' }, ...over });
  const fairAtAverage = (400n * USD * ONE * ONE) / (USD * 410n * ONE);

  it('holds the quote to the average by the same bound, and the minimum to its floor', () => {
    expect(holdTrade(WEEKEND, GLD_AT, witnessed(fairAtAverage))).toBe((fairAtAverage * 98n) / 100n);
    // 2% under the average passes; a unit more does not.
    expect(holdTrade(WEEKEND, GLD_AT, witnessed((fairAtAverage * 98n) / 100n + 1n))).not.toBeNull();
    const refused = refusalOf(() =>
      holdTrade(WEEKEND, GLD_AT, witnessed((fairAtAverage * 95n) / 100n)),
    );
    expect(refused.code).toBe('PriceDeviation');
    // The refusal names the witness it used.
    expect(refused.message).toBe(
      "the pool's price for GLD is 5.01% worse than the last hour's average price, more than the 2.00% allowed: not trading. The pool may be thin or pushed; try a smaller amount, or later",
    );
    expect(
      refusalOf(() => holdTrade(WEEKEND, GLD_AT, witnessed((fairAtAverage * 9_790n) / 10_000n)))
        .message,
    ).toMatch(
      /worse than the last hour's average price right now, just past the 2\.00% allowed: try again shortly/,
    );
  });

  it('a fresh feed is still the witness: the average is not read for it', () => {
    // Inside the feed's bound, far from an average that would refuse: the feed decides.
    const fresh = buyOf(ONE, { price: FRESH, average: { state: 'ok', usdPerToken: '300' } });
    expect(holdTrade(WEEKEND, GLD_AT, fresh)).toBe((ONE * 98n) / 100n);
  });

  it('the rail: a quote over 10% from the last feed answer is refused, whatever the average says', () => {
    // Both pools agree at $460, 15% above the $400 the feed last said.
    const drifted = (400n * USD * ONE * ONE) / (USD * 460n * ONE);
    const refused = refusalOf(() =>
      holdTrade(
        WEEKEND,
        GLD_AT,
        witnessed(drifted, { average: { state: 'ok', usdPerToken: '460' } }),
      ),
    );
    expect(refused.code).toBe('PriceDeviation');
    expect(refused.message).toBe(
      "the pool's price for GLD is 13.05% worse than its last reference price, from 36 hours ago, more than the 10.00% allowed while there is no fresh one: not trading",
    );
    // Exactly at the rail, with the average agreeing, it is traded; a unit past, it is not.
    const at = (ONE * 90n) / 100n;
    const agreeing = { state: 'ok' as const, usdPerToken: '444.444444444444444444' };
    expect(holdTrade(WEEKEND, GLD_AT, witnessed(at, { average: agreeing }))).not.toBeNull();
    expect(
      refusalOf(() => holdTrade(WEEKEND, GLD_AT, witnessed(at - 1n, { average: agreeing })))
        .message,
    ).toMatch(/than its last reference price/);
    // The other way too: a pool paying 12% more than the feed last said.
    expect(
      refusalOf(() =>
        holdTrade(
          WEEKEND,
          GLD_AT,
          witnessed((ONE * 112n) / 100n, { average: { state: 'ok', usdPerToken: '357' } }),
        ),
      ).message,
    ).toMatch(/12\.00% better than its last reference price/);
  });

  it('a token whose average cannot be used is not traded on a stale feed, and the person is told why', () => {
    const cases: [HeldTrade['average'], RegExp][] = [
      [{ state: 'unusable' }, /its pool keeps too little history for an hour's average price$/],
      [{ state: 'short' }, /its pool has less than an hour of history for an average price$/],
      [{ state: 'thin' }, /the pool its hour's average price comes from is too thin to trust$/],
      [{ state: 'unreadable' }, /its hour's average price could not be read$/],
    ];
    for (const [average, why] of cases) {
      const refused = refusalOf(() => holdTrade(WEEKEND, GLD_AT, witnessed(ONE, { average })));
      expect(refused.code).toBe('PriceStale');
      expect(refused.retryable).toBe(true);
      expect(refused.message).toMatch(/^GLD trades only while its market is open, for now: /);
      expect(refused.message).toMatch(why);
    }
  });

  it('with no average pool for the asset, or no rail for the network, a stale feed refuses as before', () => {
    const none = refusalOf(() => holdTrade(WEEKEND, GLD_AT, buyOf(ONE, { price: STALE })));
    expect(none.code).toBe('PriceStale');
    expect(none.message).toBe(
      'no fresh reference price for GLD: the market is closed; trades of GLD resume when it opens',
    );
    // No rail: the average is not a witness here, however good.
    for (const limits of [LIMITS, { ...LIMITS, staleRailBps: null }])
      expect(refusalOf(() => holdTrade(limits, GLD_AT, witnessed(fairAtAverage))).message).toMatch(
        /^no fresh reference price for GLD/,
      );
  });

  it('the size limit holds on a stale feed, measured at its last answer', () => {
    const big = witnessed((ONE * 1_001n) / 410n, {
      amountIn: 1_001n * USD,
      amountInSoFar: 1_001n * USD,
    });
    expect(refusalOf(() => holdTrade(WEEKEND, GLD_AT, big)).code).toBe('BadTrade');
  });
});

describe('a feed is the witness only while it is live', () => {
  // An hour, as the chain's sessionPriceAge; the rail and the average as on a mainnet.
  const NIGHT: TradeLimits = { ...LIMITS, staleRailBps: 1_000, liveFeedSeconds: 3_600 };
  const sixHours = { ...FRESH, ageSeconds: 6 * 3600, market: 'closed' as const };
  // The feed last said $400. Both pools have stood at $412 for the last hour: 3% up.
  const at412 = (400n * USD * ONE * ONE) / (USD * 412n * ONE);
  const steady = { state: 'ok' as const, usdPerToken: '412' };

  it('an honest move overnight lands: 3% above a six-hour-old answer, steady for an hour', () => {
    const trade = buyOf(at412, { price: sixHours, average: steady });
    // Held to the average: at it, so the floor is 2% under the average, not under the old answer.
    expect(holdTrade(NIGHT, GLD_AT, trade)).toBe((at412 * 98n) / 100n);
    // The same trade with the feed as the witness to its maxAge is refused at 2%: the weekend stop.
    const before = refusalOf(() => holdTrade({ ...NIGHT, liveFeedSeconds: null }, GLD_AT, trade));
    expect(before.code).toBe('PriceDeviation');
    expect(before.message).toMatch(/2\.92% worse than the reference price/);
  });

  it('to the second: at the live age the feed decides, a second past it the average does', () => {
    const edge = (ageSeconds: number) =>
      buyOf(at412, { price: { ...FRESH, ageSeconds }, average: steady });
    expect(refusalOf(() => holdTrade(NIGHT, GLD_AT, edge(3_600))).message).toMatch(
      /than the reference price/,
    );
    expect(holdTrade(NIGHT, GLD_AT, edge(3_601))).not.toBeNull();
  });

  it('past the live age a push of the trade pool is refused against the average, inside the rail', () => {
    const pushed = buyOf((at412 * 95n) / 100n, { price: sixHours, average: steady });
    expect(refusalOf(() => holdTrade(NIGHT, GLD_AT, pushed)).message).toMatch(
      /5\.01% worse than the last hour's average price/,
    );
    // And the rail still stands: both pools 12% from the last answer.
    const far = buyOf((ONE * 100n) / 112n, {
      price: sixHours,
      average: { state: 'ok', usdPerToken: '448' },
    });
    expect(refusalOf(() => holdTrade(NIGHT, GLD_AT, far)).message).toMatch(
      /worse than its last reference price, from 6 hours ago, more than the 10\.00% allowed/,
    );
  });

  it('an asset whose record says its average cannot be used keeps the feed, the only witness it has, up to maxAge', () => {
    for (const average of [{ state: 'unusable' as const }, null]) {
      // Inside 2% of the six-hour-old answer: traded, against the feed.
      expect(
        holdTrade(NIGHT, GLD_AT, buyOf((ONE * 99n) / 100n, { price: sixHours, average })),
      ).toBe((ONE * 98n) / 100n);
      // 3% from it: refused against the feed, since nothing better can speak.
      expect(
        refusalOf(() => holdTrade(NIGHT, GLD_AT, buyOf(at412, { price: sixHours, average })))
          .message,
      ).toMatch(/worse than the reference price/);
    }
    // Past maxAge it is refused, as before.
    const past = { ...sixHours, ageSeconds: 93_601 };
    expect(
      refusalOf(() =>
        holdTrade(NIGHT, GLD_AT, buyOf(ONE, { price: past, average: { state: 'unusable' } })),
      ).message,
    ).toMatch(/^GLD trades only while its market is open, for now/);
  });

  it('the witness is not chosen by thinning a pool: a usable average that reads thin, short or unreadable refuses, with no fall-back to the feed', () => {
    for (const state of ['thin', 'short', 'unreadable'] as const) {
      // Dead on the six-hour-old answer, which would pass against the feed: refused all the same.
      const refused = refusalOf(() =>
        holdTrade(NIGHT, GLD_AT, buyOf(ONE, { price: sixHours, average: { state } })),
      );
      expect(refused.code, state).toBe('PriceStale');
      expect(refused.message, state).toMatch(
        /^GLD trades only while its market is open, for now: /,
      );
      // A twenty-hour-old answer is no better a way out.
      const twenty = { ...sixHours, ageSeconds: 20 * 3600 };
      expect(
        refusalOf(() => holdTrade(NIGHT, GLD_AT, buyOf(ONE, { price: twenty, average: { state } })))
          .code,
        state,
      ).toBe('PriceStale');
    }
    // While the feed is live the average is not asked, and nothing is refused for it.
    expect(
      holdTrade(NIGHT, GLD_AT, buyOf(ONE, { price: FRESH, average: { state: 'thin' } })),
    ).not.toBeNull();
    // On a network with no rail the average is no witness, so its state decides nothing.
    expect(
      holdTrade(
        { ...NIGHT, staleRailBps: null },
        GLD_AT,
        buyOf(ONE, { price: sixHours, average: { state: 'thin' } }),
      ),
    ).not.toBeNull();
  });

  it('while the witness is not the live feed, one trade is at most the smaller limit', () => {
    const NVDA_AT = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
    const limits: TradeLimits = {
      ...NIGHT,
      maxTradeUsd: { [NVDA_AT]: 50_000, [GLD_AT]: 1_000 },
      maxTradeUsdNotLive: 20_000,
    };
    const of = (usd: bigint, price: HeldTrade['price'], symbol = 'NVDA') =>
      buyOf((ONE * usd) / 400n, {
        symbol,
        amountIn: usd * USD,
        amountInSoFar: usd * USD,
        price,
        average: { state: 'ok', usdPerToken: '400' },
      });
    // Live: the asset's own $50,000.
    expect(holdTrade(limits, NVDA_AT, of(50_000n, FRESH))).not.toBeNull();
    // Not live: $20,000 passes, a dollar more does not, and the person is told which limit it is.
    expect(holdTrade(limits, NVDA_AT, of(20_000n, sixHours))).not.toBeNull();
    const refused = refusalOf(() => holdTrade(limits, NVDA_AT, of(20_001n, sixHours)));
    expect(refused.code).toBe('BadTrade');
    expect(refused.message).toBe(
      "$20,001 of NVDA in one go is more than is traded while NVDA's market is closed: at most $20,000 at a time. Trade less, or in parts",
    );
    expect(
      refusalOf(() => holdTrade(limits, NVDA_AT, of(20_001n, { ...sixHours, market: 'open' })))
        .message,
    ).toMatch(/while NVDA has no live reference price: at most \$20,000 at a time/);
    // The smaller of the two: GLD's own $1,000 still binds, with its own words.
    expect(refusalOf(() => holdTrade(limits, GLD_AT, of(1_001n, sixHours, 'GLD'))).message).toMatch(
      /more than its pool is trusted to fill: at most \$1,000 at a time/,
    );
    // It holds where the feed is kept past its live age too: the witness there is not a live feed either.
    expect(
      refusalOf(() =>
        holdTrade(limits, NVDA_AT, { ...of(20_001n, sixHours), average: { state: 'unusable' } }),
      ).message,
    ).toMatch(/at most \$20,000 at a time/);
  });

  it('the rail has an age: past it the feed anchors nothing, and the asset is not traded against its pool alone', () => {
    const limits: TradeLimits = { ...NIGHT, staleRailMaxAgeSeconds: 4 * 86_400 };
    const aged = (ageSeconds: number) =>
      buyOf(at412, { price: { ...sixHours, ageSeconds }, average: steady });
    // Three days, a long weekend: traded against the average.
    expect(holdTrade(limits, GLD_AT, aged(3 * 86_400))).not.toBeNull();
    expect(holdTrade(limits, GLD_AT, aged(4 * 86_400))).not.toBeNull();
    const dead = refusalOf(() => holdTrade(limits, GLD_AT, aged(4 * 86_400 + 1)));
    expect(dead.code).toBe('PriceStale');
    expect(dead.message).toBe(
      'the reference price of GLD has been silent for 4 days, longer than the 4 days a trade may lean on its last answer: not trading GLD until it speaks again',
    );
    expect(refusalOf(() => holdTrade(limits, GLD_AT, aged(9 * 86_400))).message).toMatch(
      /silent for 9 days/,
    );
    // With no age stated the rail has none.
    expect(holdTrade(NIGHT, GLD_AT, aged(9 * 86_400))).not.toBeNull();
  });

  it('a feed that keeps speaking stays the witness: a 24/7 feed, minutes old', () => {
    const live = buyOf(ONE, {
      price: { ...FRESH, ageSeconds: 600, market: 'open' },
      average: steady,
    });
    expect(holdTrade(NIGHT, GLD_AT, live)).toBe((ONE * 98n) / 100n);
  });
});

describe("the asset's largest trade", () => {
  const big = (usd: bigint) =>
    buyOf((ONE * usd) / 400n, { amountIn: usd * USD, amountInSoFar: usd * USD });

  it('passes a trade at the limit and refuses a dollar more, with the limit named', () => {
    expect(holdTrade(LIMITS, GLD_AT, big(1_000n))).not.toBeNull();
    const over = refusalOf(() => holdTrade(LIMITS, GLD_AT, big(1_001n)));
    expect(over.code).toBe('BadTrade');
    expect(over.message).toBe(
      '$1,001 of GLD in one go is more than its pool is trusted to fill: at most $1,000 at a time. Trade less, or in parts',
    );
  });

  it('counts what the same step already put through the pool', () => {
    const second = buyOf(ONE, { amountInSoFar: 1_200n * USD });
    expect(refusalOf(() => holdTrade(LIMITS, GLD_AT, second)).message).toMatch(/\$1,200 of GLD/);
  });

  it('measures a sale by the feed, so a pool pushed down cannot make it look small', () => {
    // Three tokens are $1,200 at the feed, though this pool would pay $600 for them.
    const cheap = sellOf(600n * USD, { amountIn: 3n * ONE, amountInSoFar: 3n * ONE });
    const refused = refusalOf(() => holdTrade(LIMITS, GLD_AT, cheap));
    expect(refused.code).toBe('BadTrade');
    expect(refused.message).toMatch(/\$1,200 of GLD/);
  });

  it('holds a network that checks no feed by the cash side', () => {
    const sized: TradeLimits = { priceBoundBps: null, maxTradeUsd: { [GLD_AT]: 1_000 } };
    expect(holdTrade(sized, GLD_AT, big(1_000n))).toBeNull();
    expect(refusalOf(() => holdTrade(sized, GLD_AT, big(1_001n))).code).toBe('BadTrade');
    const sale = sellOf(1_100n * USD, { amountIn: 3n * ONE, amountInSoFar: 3n * ONE, price: null });
    expect(refusalOf(() => holdTrade(sized, GLD_AT, sale)).message).toMatch(/\$1,100 of GLD/);
  });

  it("is the asset's own: another token has another, or none", () => {
    const other = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
    expect(holdTrade(LIMITS, other, big(40_000n))).not.toBeNull();
    // Looked up whatever the case the address is written in.
    expect(
      refusalOf(() => holdTrade(LIMITS, GLD_AT.toUpperCase().replace('0X', '0x'), big(2_000n)))
        .code,
    ).toBe('BadTrade');
  });
});

describe("a network's limits, from its record", () => {
  const raw = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'deployments', 'robinhood-testnet.json'),
      'utf8',
    ),
  );

  it('the test network checks nothing against its feeds and limits no trade, and says both', () => {
    const record = EvmDeploymentRecord.parse(raw);
    expect(record.priceBoundBps).toBeNull();
    const limits = deploymentLimits(record);
    expect(limits.priceBoundBps).toBeNull();
    expect(Object.keys(limits.maxTradeUsd).sort()).toEqual(
      record.assets.map((a) => a.address).sort(),
    );
    expect(Object.values(limits.maxTradeUsd).every((v) => v === null)).toBe(true);
  });

  it('a record has to say: no bound and no limit are stated, never left out', () => {
    const parses = (change: (r: typeof raw) => void) => {
      const copy = structuredClone(raw);
      change(copy);
      return EvmDeploymentRecord.safeParse(copy).success;
    };
    expect(parses(() => {})).toBe(true);
    expect(parses((r) => delete r.priceBoundBps)).toBe(false);
    expect(parses((r) => delete r.assets[0].maxTradeUsd)).toBe(false);
    expect(parses((r) => (r.priceBoundBps = 200))).toBe(true);
    expect(parses((r) => (r.priceBoundBps = 0))).toBe(false);
    expect(parses((r) => (r.priceBoundBps = 1_001))).toBe(false);
    expect(parses((r) => (r.assets[0].maxTradeUsd = 1_000))).toBe(true);
    expect(parses((r) => (r.assets[0].maxTradeUsd = 0))).toBe(false);
    expect(parses((r) => (r.assets[0].maxTradeUsd = 1.5))).toBe(false);
    const record = EvmDeploymentRecord.parse(
      (() => {
        const copy = structuredClone(raw);
        copy.priceBoundBps = 200;
        copy.assets[0].maxTradeUsd = 1_000;
        return copy;
      })(),
    );
    expect(deploymentLimits(record)).toMatchObject({
      priceBoundBps: 200,
      maxTradeUsd: { [record.assets[0]?.address ?? '']: 1_000 },
    });
  });

  it('a mainnet may not run unchecked: a null bound or a null largest trade is refused, by number and by name', () => {
    const nvda = { symbol: 'NVDA', maxTradeUsd: 50_000 as number | null };
    const of = (over: Partial<Parameters<typeof unlimitedOnMainnet>[0]>) =>
      unlimitedOnMainnet({
        network: 'robinhood-mainnet',
        evmChainId: 4663,
        priceBoundBps: 200,
        assets: [nvda, { symbol: 'GLD', maxTradeUsd: 1_000 }],
        ...over,
      });
    expect(of({})).toBeNull();
    expect(of({ priceBoundBps: null })).toMatch(/states no priceBoundBps/);
    expect(of({ assets: [nvda, { symbol: 'GLD', maxTradeUsd: null }] })).toMatch(
      /states no maxTradeUsd for GLD/,
    );
    // The chain's number alone says mainnet, whatever the record calls itself: Robinhood Chain, Ethereum, Base.
    for (const evmChainId of [4663, 1, 8453])
      expect(
        of({ network: 'robinhood-local', evmChainId, priceBoundBps: null }),
        String(evmChainId),
      ).toMatch(/priceBoundBps/);
    // With a rail, the two limits that go with it are stated too.
    expect(of({ staleRailBps: 1_000 })).toMatch(/states no maxTradeUsdNotLive/);
    expect(of({ staleRailBps: 1_000, maxTradeUsdNotLive: 20_000 })).toMatch(
      /states no staleRailMaxAge/,
    );
    expect(
      of({ staleRailBps: 1_000, maxTradeUsdNotLive: 20_000, staleRailMaxAge: 345_600 }),
    ).toBeNull();
    // And so does the name alone.
    expect(of({ evmChainId: 31_337, priceBoundBps: null })).toMatch(/priceBoundBps/);
    // A test network and a local copy say null and are taken at their word.
    expect(
      of({ network: 'robinhood-testnet', evmChainId: 46_630, priceBoundBps: null }),
    ).toBeNull();
    expect(
      of({
        network: 'robinhood-local',
        evmChainId: 31_337,
        assets: [{ symbol: 'GLD', maxTradeUsd: null }],
      }),
    ).toBeNull();

    // Through the record itself: the test network's own, given a mainnet's number, is refused for
    // its nulls as well as for the number, so lifting the one refusal leaves the other standing.
    const copied = structuredClone(raw);
    copied.evmChainId = 4663;
    const parsed = EvmDeploymentRecord.safeParse(copied);
    expect(parsed.success).toBe(false);
    const said = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    expect(said.some((m) => /states no priceBoundBps/.test(m))).toBe(true);
    // And where the limits are handed to the adapter, whatever way the record came.
    const record = EvmDeploymentRecord.parse(raw);
    expect(() => deploymentLimits({ ...record, evmChainId: 4663 })).toThrow(
      /states no priceBoundBps/,
    );
    expect(() =>
      deploymentLimits({ ...record, network: 'robinhood-mainnet', priceBoundBps: 200 }),
    ).toThrow(/states no maxTradeUsd for tSPY/);
    expect(deploymentLimits(record).priceBoundBps).toBeNull();
  });
});
