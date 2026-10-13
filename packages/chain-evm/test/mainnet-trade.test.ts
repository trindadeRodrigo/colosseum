import { ChainError } from '@colosseum/schemas';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readPoolAveragePlan } from '../src/vault/pool-average';
import { createEvmRpc } from '../src/vault/rpc';
import { worthAtFeed } from '../src/vault/trade-limits';
import {
  ACCOUNTS,
  AVERAGE,
  AVERAGE_FEE,
  BOUND_BPS,
  buildMainnetTradeWorld,
  MAINNET,
  MAX_TRADE_USD,
  MAX_TRADE_USD_NOT_LIVE,
  type MainnetTradeWorld,
} from './mainnet-trade-world';

// An owner's trade on a local copy of Robinhood Chain mainnet, held to the token's Chainlink price and
// to its largest trade. The pool is the real one, and it is really pushed: a stranger trades through
// the real router until the pool's price is off, and the builder refuses the person's order. Nothing
// is sent to any network.
//
//   RH_FORK_URL=<a node that keeps old state> pnpm exec vitest run packages/chain-evm/test/mainnet-trade.test.ts
//
// It needs anvil (Foundry) and `forge build` in contracts/. Skipped without RH_FORK_URL.
// RH_FORK_BLOCK moves the block (default: the one the pools were measured at); RH_TRADE_PORT moves
// anvil off 28845.

const FORK_URL = process.env.RH_FORK_URL;
const PORT = Number(process.env.RH_TRADE_PORT ?? 28_845);
const USD = 1_000_000n;
const GLD = 'robinhood:gld';
const NVDA = 'robinhood:nvda';
const CASH = 'robinhood:usdg';

describe.skipIf(!FORK_URL)("an owner's trade, held to the feed, on a copy of mainnet", () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 300_000 });
  let started: Promise<MainnetTradeWorld> | undefined;
  const start = () => {
    started ??= buildMainnetTradeWorld(FORK_URL ?? '', PORT);
    return started;
  };
  afterAll(async () => (await started)?.stop());

  const refusal = async (work: () => Promise<unknown>): Promise<ChainError> => {
    try {
      await work();
    } catch (e) {
      if (e instanceof ChainError) return e;
      throw e;
    }
    throw new Error('it was not refused');
  };
  const buy = (asset: string, usd: bigint) => ({
    sell: CASH,
    buy: asset,
    amountInRaw: (usd * USD).toString(),
  });
  const priceOf = async (w: MainnetTradeWorld, asset: string) => {
    const [price] = await w.adapter.getPrices([asset]);
    if (!price) throw new Error(`${asset} has no price`);
    return price;
  };

  it('an honest trade is quoted, built with a minimum no lower than the feed allows, and lands', async () => {
    const w = await start();
    for (const [asset, basketId] of [
      [GLD, '501'],
      [NVDA, '502'],
    ] as const) {
      const quote = await w.adapter.quote(buy(asset, 500n), ACCOUNTS.owner);
      // Within the bound of the feed, fee included.
      expect(Math.abs(quote.costBps), asset).toBeLessThan(BOUND_BPS);
      expect(quote.against).toBe('reference');

      const price = await priceOf(w, asset);
      const fair = worthAtFeed(
        { side: 'buy', cashDecimals: 6, assetDecimals: 18 },
        500n * USD,
        price.usdPerToken,
      );
      const feedFloor = (fair * BigInt(10_000 - BOUND_BPS)) / 10_000n;

      await w.land(
        await w.adapter.buildApprove({
          owner: ACCOUNTS.owner,
          basketId,
          amountRaw: (1000n * USD).toString(),
        }),
      );
      const create = await w.adapter.buildCreateVault({
        owner: ACCOUNTS.owner,
        basketId,
        targets: [{ asset, weightBps: 5000 }],
        autoFollow: false,
        depositRaw: (1000n * USD).toString(),
        trades: [buy(asset, 500n)],
        slippageBps: 100,
      });
      const [minimum] = create.preview.minimums;
      expect(BigInt(minimum?.minOutRaw ?? 0), asset).toBeGreaterThanOrEqual(feedFloor);
      await w.land(create);
      const vault = await w.vaultOf(basketId);
      const token = asset === GLD ? MAINNET.gld : MAINNET.nvda;
      expect(await w.balanceOf(token, vault), asset).toBeGreaterThanOrEqual(
        BigInt(minimum?.minOutRaw ?? 0),
      );
      expect(await w.balanceOf(MAINNET.usdg, vault)).toBe(500n * USD);
    }
  });

  it("an order's stated minimum under the feed's floor of now is refused: ask for a new quote", async () => {
    const w = await start();
    const vault = await w.vaultOf('501');
    const price = await priceOf(w, GLD);
    const feedFloor =
      (worthAtFeed(
        { side: 'buy', cashDecimals: 6, assetDecimals: 18 },
        100n * USD,
        price.usdPerToken,
      ) *
        BigInt(10_000 - BOUND_BPS)) /
      10_000n;
    const swap = (minimum: bigint) =>
      w.adapter.buildOwnerSwap({
        vault,
        trades: [buy(GLD, 100n)],
        slippageBps: 100,
        minimums: [minimum.toString()],
      });
    // As if the feed had moved in the person's favour since the order: its minimum is under the floor.
    const under = await refusal(() => swap(feedFloor - 1n));
    expect(under.code).toBe('PriceMoved');
    expect(under.message).toMatch(/the reference price has moved since the order was made/);
    expect(under.message).toMatch(/Ask for a new quote$/);
    // At the floor, the order's own minimum is the one built.
    const built = await swap(feedFloor);
    expect(built.preview.minimums[0]?.minOutRaw).toBe(feedFloor.toString());
  });

  it("a trade above the asset's largest is refused with its limit, whichever way it goes", async () => {
    const w = await start();
    const over = await refusal(() =>
      w.adapter.quote(buy(GLD, BigInt(MAX_TRADE_USD.gld) + 1n), ACCOUNTS.owner),
    );
    expect(over.code).toBe('BadTrade');
    expect(over.message).toMatch(/GLD in one go is more than its pool is trusted to fill/);
    expect(over.message).toMatch(/at most \$1,000 at a time/);
    // At the limit it is quoted.
    await expect(
      w.adapter.quote(buy(GLD, BigInt(MAX_TRADE_USD.gld)), ACCOUNTS.owner),
    ).resolves.toBeDefined();
    // NVDA's is its own, fifty times GLD's.
    await expect(w.adapter.quote(buy(NVDA, 5_000n), ACCOUNTS.owner)).resolves.toBeDefined();
    expect(
      (await refusal(() => w.adapter.quote(buy(NVDA, 50_001n), ACCOUNTS.owner))).message,
    ).toMatch(/at most \$50,000 at a time/);

    // Two trades of one step in the same pool count together.
    const vault = await w.vaultOf('501');
    await w.land(
      await w.adapter.buildApprove({
        owner: ACCOUNTS.owner,
        basketId: '501',
        amountRaw: (1_200n * USD).toString(),
      }),
    );
    const twice = await refusal(() =>
      w.adapter.buildDeposit({
        vault,
        amountRaw: (1_200n * USD).toString(),
        trades: [buy(GLD, 600n), buy(GLD, 600n)],
        slippageBps: 100,
      }),
    );
    expect(twice.code).toBe('BadTrade');
    expect(twice.message).toMatch(/\$1,200 of GLD/);

    // A sale is measured by the feed: 4 GLD is about $1,500 whatever the pool would pay for it.
    const sale = await refusal(() =>
      w.adapter.quote(
        { sell: GLD, buy: CASH, amountInRaw: (4n * 10n ** 18n).toString() },
        ACCOUNTS.owner,
      ),
    );
    expect(sale.code).toBe('BadTrade');
    expect(sale.message).toMatch(/at most \$1,000 at a time/);
  });

  it('a pushed pool: the order is refused while the pool is off the feed, and built again once it is back', async () => {
    const w = await start();
    const vault = await w.vaultOf('501');
    const order = () =>
      w.adapter.buildDeposit({
        vault,
        amountRaw: (500n * USD).toString(),
        trades: [buy(GLD, 500n)],
        slippageBps: 100,
      });
    // Before: the order builds.
    await w.land(
      await w.adapter.buildApprove({
        owner: ACCOUNTS.owner,
        basketId: '501',
        amountRaw: (500n * USD).toString(),
      }),
    );
    const honest = await order();
    const honestMin = BigInt(honest.preview.minimums[0]?.minOutRaw ?? 0);

    // A stranger pushes GLD's pool up with a few thousand dollars.
    const spent = 4_000n * USD;
    const got = await w.push(MAINNET.usdg, MAINNET.gld, spent);
    expect(got).toBeGreaterThan(0n);

    // The step built before the push does not fill at the pushed price: the vault's minimum holds it.
    expect(await w.send(honest)).toBe('reverted');
    expect(await w.balanceOf(MAINNET.usdg, vault)).toBe(500n * USD);

    // A new order is refused before anything is built, in words the person reads.
    const refused = await refusal(order);
    expect(refused.code).toBe('PriceDeviation');
    expect(refused.retryable).toBe(true);
    expect(refused.message).toMatch(
      /the pool's price for GLD is \d+\.\d\d% worse than the reference price, more than the 2\.00% allowed: not trading/,
    );
    expect((await refusal(() => w.adapter.quote(buy(GLD, 500n), ACCOUNTS.owner))).code).toBe(
      'PriceDeviation',
    );
    // So is a sale into the pushed pool, which would pay too well: the price is not one to trade at.
    const held = await w.balanceOf(MAINNET.gld, vault);
    const sale = await refusal(() =>
      w.adapter.buildOwnerSwap({
        vault,
        trades: [{ sell: GLD, buy: CASH, amountInRaw: (held / 2n).toString() }],
        slippageBps: 100,
      }),
    );
    expect(sale.code).toBe('PriceDeviation');
    expect(sale.message).toMatch(/better than the reference price/);
    // NVDA's pool was not touched: its trades go on.
    await expect(w.adapter.quote(buy(NVDA, 500n), ACCOUNTS.owner)).resolves.toBeDefined();

    // The stranger sells back. The pool returns, and the same order builds and lands.
    await w.push(MAINNET.gld, MAINNET.usdg, got);
    const again = await order();
    expect(BigInt(again.preview.minimums[0]?.minOutRaw ?? 0)).toBeGreaterThan(
      (honestMin * 97n) / 100n,
    );
    const before = await w.balanceOf(MAINNET.gld, vault);
    await w.land(again);
    // The deposit's 500 went into GLD: the cash is what it was, and the token is up by the minimum at least.
    expect(await w.balanceOf(MAINNET.usdg, vault)).toBe(500n * USD);
    expect((await w.balanceOf(MAINNET.gld, vault)) - before).toBeGreaterThanOrEqual(
      BigInt(again.preview.minimums[0]?.minOutRaw ?? 0),
    );
  });

  it('while a feed is live it is the witness: a pool 3% above a minutes-old answer is refused', async () => {
    const w = await start();
    // TSLA is listed here with a feed of ours 3% under the real one, at the real one's time: under an
    // hour old at this block, so live. The pool is 3% above it, and that is past the 2%.
    const [price] = await w.adapter.getPrices(['robinhood:tsla']);
    expect(price?.ageSeconds).toBeLessThan(3_600);
    const refused = await refusal(() =>
      w.adapter.quote(buy('robinhood:tsla', 500n), ACCOUNTS.owner),
    );
    expect(refused.code).toBe('PriceDeviation');
    expect(refused.message).toMatch(/3\.\d\d% worse than the reference price/);
  });

  it('a feed gone stale refuses: no witness is not a pass', async () => {
    const w = await start();
    const price = await priceOf(w, GLD);
    await expect(w.adapter.quote(buy(GLD, 100n), ACCOUNTS.owner)).resolves.toBeDefined();
    await w.later((price.maxAgeSeconds ?? 0) + 60);
    const stale = await refusal(() => w.adapter.quote(buy(GLD, 100n), ACCOUNTS.owner));
    expect(stale.code).toBe('PriceStale');
    // GLD's average pool keeps too little history to stand in for its feed: said, and not traded.
    expect(stale.message).toBe(
      "GLD trades only while its market is open, for now: its pool keeps too little history for an hour's average price",
    );
    const vault = await w.vaultOf('501');
    expect(
      (
        await refusal(() =>
          w.adapter.buildOwnerSwap({ vault, trades: [buy(GLD, 100n)], slippageBps: 100 }),
        )
      ).code,
    ).toBe('PriceStale');
  });
});

// Overnight and the weekend: a stock's feed older than an hour, then past its `maxAge`. The witness is
// the last hour's average of the asset's Uniswap v3 pool, inside a rail around the feed's last answer.
// A copy of its own: the clock is moved on for good, six hours and then a day more.
describe.skipIf(!FORK_URL)(
  "an owner's trade while the feed is not live, on a copy of mainnet",
  () => {
    vi.setConfig({ hookTimeout: 600_000, testTimeout: 600_000 });
    let started: Promise<MainnetTradeWorld> | undefined;
    const start = () => {
      started ??= (async () => {
        const w = await buildMainnetTradeWorld(FORK_URL ?? '', PORT + 1);
        // Six hours on: no feed is live, none is past its 26 hours, and every pool's last hour is quiet.
        await w.later(6 * 3600);
        return w;
      })();
      return started;
    };
    afterAll(async () => (await started)?.stop());
    const MSFT = 'robinhood:msft';
    const AAPL = 'robinhood:aapl';
    const refusal = async (work: () => Promise<unknown>): Promise<ChainError> => {
      try {
        await work();
      } catch (e) {
        if (e instanceof ChainError) return e;
        throw e;
      }
      throw new Error('it was not refused');
    };
    const buy = (asset: string, usd: bigint) => ({
      sell: CASH,
      buy: asset,
      amountInRaw: (usd * USD).toString(),
    });
    const average = async (w: MainnetTradeWorld, slug: 'nvda' | 'msft' | 'aapl' | 'tsla') => {
      const block = await w.client.getBlock();
      const reading = await readPoolAveragePlan(
        createEvmRpc(w.rpcUrl),
        {
          pool: AVERAGE[slug].pool,
          base: MAINNET[slug],
          quote: MAINNET.usdg,
          feed: w.record.assets.find((a) => a.id === `robinhood:${slug}`)?.feed as `0x${string}`,
          baseDecimals: 18,
          quoteDecimals: 6,
          window: 3600,
          minLiquidity: BigInt(AVERAGE[slug].minLiquidity),
          jumpBps: 10_000,
          maxRounds: 1,
        },
        { block: block.number, time: block.timestamp },
      );
      return reading;
    };

    it('overnight: a feed six hours old, both pools 3% above its last answer and steady for an hour, and the trade lands', async () => {
      const w = await start();
      const TSLA = 'robinhood:tsla';
      const [price] = await w.adapter.getPrices([TSLA]);
      // Not live, and not past its 26 hours either.
      expect(price?.ageSeconds).toBeGreaterThan(6 * 3600);
      expect(price?.ageSeconds).toBeLessThan(price?.maxAgeSeconds ?? 0);
      const reading = await average(w, 'tsla');
      const above = Number(reading.average) / 1e8 / Number(price?.usdPerToken);
      expect(above).toBeGreaterThan(1.02);
      expect(above).toBeLessThan(1.04);
      // Held to Friday's answer it would be refused at 2%. Held to its pool's last hour it is an honest
      // trade, inside the 10% rail.
      const quote = await w.adapter.quote(buy(TSLA, 500n), ACCOUNTS.owner);
      expect(quote.costBps).toBeGreaterThan(200);
      await w.land(
        await w.adapter.buildApprove({
          owner: ACCOUNTS.owner,
          basketId: '600',
          amountRaw: (1000n * USD).toString(),
        }),
      );
      const create = await w.adapter.buildCreateVault({
        owner: ACCOUNTS.owner,
        basketId: '600',
        targets: [{ asset: TSLA, weightBps: 5000 }],
        autoFollow: false,
        depositRaw: (1000n * USD).toString(),
        trades: [buy(TSLA, 500n)],
        slippageBps: 100,
      });
      const fair = worthAtFeed(
        { side: 'buy', cashDecimals: 6, assetDecimals: 18 },
        500n * USD,
        (Number(reading.average) / 1e8).toFixed(8),
      );
      const minimum = BigInt(create.preview.minimums[0]?.minOutRaw ?? 0);
      expect(minimum).toBeGreaterThanOrEqual((fair * BigInt(10_000 - BOUND_BPS)) / 10_000n - 1n);
      await w.land(create);
      expect(await w.balanceOf(MAINNET.tsla, await w.vaultOf('600'))).toBeGreaterThanOrEqual(
        minimum,
      );
      // GLD's average cannot be used, so its feed, under 26 hours old, is still its witness: it trades.
      await expect(w.adapter.quote(buy(GLD, 100n), ACCOUNTS.owner)).resolves.toBeDefined();
      // And a push of the trade pool is refused against the average, not the feed.
      const got = await w.push(MAINNET.usdg, MAINNET.tsla, 110_000n * USD);
      expect(
        (await refusal(() => w.adapter.quote(buy(TSLA, 500n), ACCOUNTS.owner))).message,
      ).toMatch(/worse than the last hour's average price/);
      await w.push(MAINNET.tsla, MAINNET.usdg, got);
    });

    it('while the feed is not live, one trade is at most the smaller limit, and the person is told why', async () => {
      const w = await start();
      // NVDA's own largest trade is $50,000. Six hours after its feed last spoke it is $20,000.
      await expect(
        w.adapter.quote(buy(NVDA, BigInt(MAX_TRADE_USD_NOT_LIVE)), ACCOUNTS.owner),
      ).resolves.toBeDefined();
      const over = await refusal(() =>
        w.adapter.quote(buy(NVDA, BigInt(MAX_TRADE_USD_NOT_LIVE) + 1n), ACCOUNTS.owner),
      );
      expect(over.code).toBe('BadTrade');
      expect(over.message).toMatch(
        /^\$20,001 of NVDA in one go is more than is traded while NVDA('s market is closed| has no live reference price): at most \$20,000 at a time/,
      );
    });

    it('the witness is not chosen by thinning the average pool: with the feed twenty hours old, the trade is refused, not passed against it', async () => {
      const w = await start();
      await w.later(14 * 3600);
      const [price] = await w.adapter.getPrices([MSFT]);
      // Twenty hours old: not live, and still inside its 26 hours. The pool sits on that answer, so held
      // to the feed alone this trade would pass.
      expect(price?.ageSeconds).toBeGreaterThan(20 * 3600);
      expect(price?.ageSeconds).toBeLessThan(price?.maxAgeSeconds ?? 0);
      const before = await w.adapter.quote(buy(MSFT, 100n), ACCOUNTS.owner);
      expect(Math.abs(before.costBps)).toBeLessThan(BOUND_BPS);
      // A stranger buys MSFT in its average pool: $60,000 moves it about 4% and uses up what is in range.
      for (let i = 0; i < 12; i += 1)
        await w.pushAverage(MAINNET.usdg, MAINNET.msft, AVERAGE_FEE.msft, 5_000n * USD);
      expect((await average(w, 'msft')).reason).toBe('ThinPool');
      // The trade pool has not moved and the feed's answer is where it was. It is refused all the same.
      const refused = await refusal(() => w.adapter.quote(buy(MSFT, 100n), ACCOUNTS.owner));
      expect(refused.code).toBe('PriceStale');
      expect(refused.message).toBe(
        "MSFT trades only while its market is open, for now: the pool its hour's average price comes from is too thin to trust",
      );
    });

    it('the feeds are stale, and an honest trade is built against the last hour of the pool and lands', async () => {
      const w = await start();
      // A day and a half from the fork's block: every feed is now past its 26 hours.
      await w.later(16 * 3600);
      const [price] = await w.adapter.getPrices([NVDA]);
      expect(price?.ageSeconds).toBeGreaterThan(price?.maxAgeSeconds ?? 0);
      const reading = await average(w, 'nvda');
      expect(reading.reason === null || reading.reason === 'FeedRounds').toBe(true);
      expect(reading.average).toBeGreaterThan(0n);
      // The average is a real price: within a few percent of the feed's last answer.
      const last = BigInt(Math.round(Number(price?.usdPerToken) * 1e8));
      expect(Number(((reading.average - last) * 10_000n) / last)).toBeGreaterThan(-300);
      expect(Number(((reading.average - last) * 10_000n) / last)).toBeLessThan(300);

      await expect(w.adapter.quote(buy(NVDA, 500n), ACCOUNTS.owner)).resolves.toBeDefined();
      const fair = worthAtFeed(
        { side: 'buy', cashDecimals: 6, assetDecimals: 18 },
        500n * USD,
        (Number(reading.average) / 1e8).toFixed(8),
      );
      await w.land(
        await w.adapter.buildApprove({
          owner: ACCOUNTS.owner,
          basketId: '601',
          amountRaw: (1000n * USD).toString(),
        }),
      );
      const create = await w.adapter.buildCreateVault({
        owner: ACCOUNTS.owner,
        basketId: '601',
        targets: [{ asset: NVDA, weightBps: 5000 }],
        autoFollow: false,
        depositRaw: (1000n * USD).toString(),
        trades: [buy(NVDA, 500n)],
        slippageBps: 100,
      });
      // The minimum is held to the average's floor, as it is to the feed's while the feed is fresh.
      const minimum = BigInt(create.preview.minimums[0]?.minOutRaw ?? 0);
      expect(minimum).toBeGreaterThanOrEqual((fair * BigInt(10_000 - BOUND_BPS)) / 10_000n - 1n);
      await w.land(create);
      expect(await w.balanceOf(MAINNET.nvda, await w.vaultOf('601'))).toBeGreaterThanOrEqual(
        minimum,
      );
    });
    it('the size limit holds while the feed is stale: the smaller one', async () => {
      const w = await start();
      const over = await refusal(() => w.adapter.quote(buy(NVDA, 20_001n), ACCOUNTS.owner));
      expect(over.code).toBe('BadTrade');
      expect(over.message).toMatch(/at most \$20,000 at a time/);
    });

    it("a one-block push of the trade pool is refused against the last hour's average", async () => {
      const w = await start();
      const got = await w.push(MAINNET.usdg, MAINNET.nvda, 180_000n * USD);
      const refused = await refusal(() => w.adapter.quote(buy(NVDA, 500n), ACCOUNTS.owner));
      expect(refused.code).toBe('PriceDeviation');
      expect(refused.message).toMatch(
        /the pool's price for NVDA is \d+\.\d\d% worse than the last hour's average price/,
      );
      const vault = await w.vaultOf('601');
      expect(
        (
          await refusal(() =>
            w.adapter.buildOwnerSwap({ vault, trades: [buy(NVDA, 100n)], slippageBps: 100 }),
          )
        ).code,
      ).toBe('PriceDeviation');
      // The stranger trades back, and the next order is quoted again.
      await w.push(MAINNET.nvda, MAINNET.usdg, got);
      await expect(w.adapter.quote(buy(NVDA, 500n), ACCOUNTS.owner)).resolves.toBeDefined();
    });

    it('a token whose average pool keeps too little history is not traded on a stale feed, and says so', async () => {
      const w = await start();
      const refused = await refusal(() => w.adapter.quote(buy(GLD, 100n), ACCOUNTS.owner));
      expect(refused.code).toBe('PriceStale');
      expect(refused.message).toBe(
        "GLD trades only while its market is open, for now: its pool keeps too little history for an hour's average price",
      );
    });

    it('the rail: both pools standing far from the last feed answer do not carry a trade', async () => {
      const w = await start();
      // AAPL is listed here with a feed of our own whose last answer is 12% under the real one: as if
      // the market had moved that far since the feed last spoke. Its two pools agree with each other.
      const [price] = await w.adapter.getPrices([AAPL]);
      const reading = await average(w, 'aapl');
      expect(reading.reason === null || reading.reason === 'FeedRounds').toBe(true);
      expect(Number(reading.average) / 1e8 / Number(price?.usdPerToken)).toBeGreaterThan(1.1);
      const refused = await refusal(() => w.adapter.quote(buy(AAPL, 100n), ACCOUNTS.owner));
      expect(refused.code).toBe('PriceDeviation');
      expect(refused.message).toMatch(
        /^the pool's price for AAPL is 1\d\.\d\d% worse than its last reference price, from \d+ hours ago, more than the 10\.00% allowed while there is no fresh one: not trading$/,
      );
    });

    it('the rail has an age: a feed silent past four days anchors nothing, and the token stops', async () => {
      const w = await start();
      await expect(w.adapter.quote(buy(NVDA, 500n), ACCOUNTS.owner)).resolves.toBeDefined();
      await w.later(4 * 86_400);
      const refused = await refusal(() => w.adapter.quote(buy(NVDA, 500n), ACCOUNTS.owner));
      expect(refused.code).toBe('PriceStale');
      expect(refused.message).toMatch(
        /^the reference price of NVDA has been silent for \d+ days, longer than the 4 days a trade may lean on its last answer: not trading NVDA until it speaks again$/,
      );
    });
  },
);
