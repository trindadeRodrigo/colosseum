import { type Price, type Target, Trade, type VaultState } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDecimal } from './amounts';
import { batchTrades, planRebalance, RebalanceError, rebalancePlan } from './plan-rebalance';
import { asset, price, vault } from './testing';
import type { AssetUnits } from './view';

const CASH = 'solana:usdc';
const USDC = asset(CASH, { decimals: 6, cls: 'cash' });
const ASSETS = [
  USDC,
  asset('solana:spy', { decimals: 8 }),
  asset('solana:nvda', { decimals: 8 }),
  asset('solana:gold', { decimals: 9 }),
  asset('solana:tsla', { decimals: 8 }),
];
const PRICES = [
  price('solana:spy', '100'),
  price('solana:nvda', '50'),
  price('solana:gold', '200'),
  price('solana:tsla', '20'),
];
const POLICY = { bandBps: 50, minTradeUsd: 1 };
const targets = (weights: Record<string, number>): Target[] =>
  Object.entries(weights).map(([id, weightBps]) => ({ asset: `solana:${id}`, weightBps }));
const code = (work: () => unknown) => {
  try {
    work();
  } catch (e) {
    return e instanceof RebalanceError ? e.code : `not a RebalanceError: ${e}`;
  }
  return 'did not throw';
};
/** A trade stops a hair before the exact amount: a few raw units of margin, never one past. */
const justUnder = (amountInRaw: string | undefined, exact: bigint, margin = 3n) => {
  const amount = BigInt(amountInRaw ?? -1);
  return amount <= exact && amount >= exact - margin;
};

describe('planRebalance', () => {
  it('sells what is over its target, then buys what is under, through cash', () => {
    // $1,000: $100 cash, SPY $600 (target 50%), NVDA $300 (30%), no gold (20%).
    const v = vault('100000000', {
      'solana:spy': ['600000000', 5000],
      'solana:nvda': ['600000000', 3000],
    });
    const plan = planRebalance(
      v,
      targets({ spy: 5000, nvda: 3000, gold: 2000 }),
      PRICES,
      POLICY,
      ASSETS,
    );
    expect(plan).toHaveLength(2);
    // SPY is $100 over: one whole token, 8 decimals, less a hair so it is never sold past its target.
    expect(plan[0]).toMatchObject({ sell: 'solana:spy', buy: CASH });
    expect(justUnder(plan[0]?.amountInRaw, 100_000_000n)).toBe(true);
    // Gold is $200 under, paid from the $100 held and the $100 the sale brings. A hair under $200,
    // so that rounding can never carry it past its target.
    expect(plan[1]).toMatchObject({ sell: CASH, buy: 'solana:gold' });
    const spent = BigInt(plan[1]?.amountInRaw ?? 0);
    expect(spent <= 200_000_000n && spent >= 199_999_990n).toBe(true);
    for (const t of plan) expect(Trade.parse(t)).toEqual(t);
  });

  it('plans nothing while every asset is inside the band', () => {
    // SPY at 50.4% and NVDA at 49.6% of $1,000, against 50 and 50: both 40 bps out, band 50.
    const v = vault('0', { 'solana:spy': ['504000000', 5000], 'solana:nvda': ['992000000', 5000] });
    const t = targets({ spy: 5000, nvda: 5000 });
    expect(planRebalance(v, t, PRICES, POLICY, ASSETS)).toEqual([]);
    // One bp more and it is outside: both are brought to 50%.
    const out = vault('0', {
      'solana:spy': ['505100000', 5000],
      'solana:nvda': ['989800000', 5000],
    });
    const plan = planRebalance(out, t, PRICES, POLICY, ASSETS);
    expect(plan.map((x) => [x.sell, x.buy])).toEqual([
      ['solana:spy', CASH],
      [CASH, 'solana:nvda'],
    ]);
    // $5.10 of SPY at $100.
    expect(justUnder(plan[0]?.amountInRaw, 5_100_000n)).toBe(true);
  });

  it('invests a fresh deposit in the proportions of the targets', () => {
    const v = vault('1000000000', {});
    const plan = planRebalance(
      v,
      targets({ spy: 5000, nvda: 3000, gold: 2000 }),
      PRICES,
      POLICY,
      ASSETS,
    );
    expect(plan.map((x) => x.buy)).toEqual(['solana:spy', 'solana:nvda', 'solana:gold']);
    const spent = plan.map((x) => Number(x.amountInRaw) / 1e6);
    expect(spent[0]).toBeCloseTo(500, 4);
    expect(spent[1]).toBeCloseTo(300, 4);
    expect(spent[2]).toBeCloseTo(200, 4);
    expect(plan.reduce((n, x) => n + BigInt(x.amountInRaw), 0n) <= 1_000_000_000n).toBe(true);
  });

  it('sells a position that is not a target whole, and leaves no dust of it', () => {
    // TSLA is held and is no longer a target.
    const v = vault('0', {
      'solana:spy': ['500000000', 5000],
      'solana:tsla': ['2500000001', 5000],
    });
    const plan = planRebalance(v, targets({ spy: 5000, nvda: 5000 }), PRICES, POLICY, ASSETS);
    expect(plan[0]).toEqual({ sell: 'solana:tsla', buy: CASH, amountInRaw: '2500000001' });
    expect(plan[1]).toMatchObject({ sell: CASH, buy: 'solana:nvda' });
  });

  it('keeps as cash what the targets leave of 100%', () => {
    // Targets add up to 90%: of $1,000 in cash, $100 stays.
    const plan = planRebalance(
      vault('1000000000', {}),
      targets({ spy: 6000, gold: 3000 }),
      PRICES,
      POLICY,
      ASSETS,
    );
    const spent = plan.reduce((n, x) => n + BigInt(x.amountInRaw), 0n);
    expect(spent <= 900_000_000n && spent >= 899_999_990n).toBe(true);
  });

  it('makes no trade under the dust threshold', () => {
    // $10 in all, SPY 5% over and NVDA 5% under: a $0.50 trade each way.
    const v = vault('0', { 'solana:spy': ['5500000', 5000], 'solana:nvda': ['9000000', 5000] });
    const t = targets({ spy: 5000, nvda: 5000 });
    expect(planRebalance(v, t, PRICES, { bandBps: 50, minTradeUsd: 1 }, ASSETS)).toEqual([]);
    expect(planRebalance(v, t, PRICES, { bandBps: 50, minTradeUsd: 0.25 }, ASSETS)).toHaveLength(2);
    // A sale is made and the purchase it would pay for is dust: the cash stays.
    const lopsided = vault('0', {
      'solana:spy': ['12000000', 5000],
      'solana:nvda': ['7000000', 2500],
      'solana:gold': ['22500000', 2500],
    });
    const plan = planRebalance(
      lopsided,
      targets({ spy: 5000, nvda: 2500, gold: 2500 }),
      PRICES,
      { bandBps: 50, minTradeUsd: 1.5 },
      ASSETS,
    );
    // $20 in all: SPY $12 against $10 (sell $2); NVDA $3.50 against $5 (buy $1.50, less a hair:
    // dust); gold $4.50 against $5 (dust).
    expect(plan.map((x) => [x.sell, x.buy])).toEqual([['solana:spy', CASH]]);
    expect(justUnder(plan[0]?.amountInRaw, 2_000_000n)).toBe(true);
  });

  it('sizes the purchases for what the sales are expected to bring when given a cost', () => {
    const v = vault('0', { 'solana:spy': ['1000000000', 5000] });
    const t = targets({ spy: 5000, nvda: 5000 });
    const exact = planRebalance(v, t, PRICES, POLICY, ASSETS);
    const careful = planRebalance(v, t, PRICES, { ...POLICY, costBps: 100 }, ASSETS);
    expect(exact[0]).toEqual(careful[0]);
    // $500 of SPY sold; at 1% the purchase counts on $495.
    expect(justUnder(careful[1]?.amountInRaw, 495_000_000n)).toBe(true);
    expect(BigInt(exact[1]?.amountInRaw ?? 0) > 499_999_990n).toBe(true);
  });

  it('leaves out an asset with no price, says so, and plans the rest', () => {
    // SPY and NVDA are targets; NVDA has no price and none is held: its half stays in cash.
    const v = vault('1000000000', { 'solana:spy': ['100000000', 5000] });
    const t = targets({ spy: 5000, nvda: 5000 });
    const noNvda = PRICES.filter((p) => p.asset !== 'solana:nvda');
    for (const [prices, assets] of [
      [noNvda, ASSETS],
      // A price of zero is no price, and so is an asset that is not on the list.
      [[...noNvda, price('solana:nvda', '0')], ASSETS],
      [PRICES, ASSETS.filter((a) => a.id !== 'solana:nvda')],
    ] as const) {
      const plan = rebalancePlan(v, t, [...prices], POLICY, assets);
      expect(plan.unpriced).toEqual(['solana:nvda']);
      expect(plan.weighed).toBe(true);
      // $1,100 in all: SPY goes from $100 to $550, and $550 stays for NVDA.
      expect(plan.trades.map((x) => [x.sell, x.buy])).toEqual([[CASH, 'solana:spy']]);
      expect(justUnder(plan.trades[0]?.amountInRaw, 450_000_000n)).toBe(true);
    }

    // A position that is held, is not a target and has no price (a delisted token): the rest is
    // planned as if it were not there.
    const old = vault('1000000000', { 'solana:old': ['5', 0] });
    const rest = rebalancePlan(old, t, PRICES, POLICY, [...ASSETS, asset('solana:old')]);
    expect(rest.unpriced).toEqual(['solana:old']);
    expect(rest.trades.map((x) => x.buy)).toEqual(['solana:nvda', 'solana:spy']);

    // Held and a target, with no price: the vault cannot be weighed, so nothing is planned.
    const blind = vault('500000000', {
      'solana:spy': ['500000000', 5000],
      'solana:nvda': ['1000000000', 5000],
    });
    expect(rebalancePlan(blind, t, noNvda, POLICY, ASSETS)).toEqual({
      trades: [],
      unpriced: ['solana:nvda'],
      weighed: false,
    });
    expect(planRebalance(blind, t, noNvda, POLICY, ASSETS)).toEqual([]);
    // With every price there, nothing is left out.
    expect(rebalancePlan(blind, t, PRICES, POLICY, ASSETS)).toMatchObject({
      unpriced: [],
      weighed: true,
    });
  });

  it('counts cash as one dollar, whatever price it is handed for it', () => {
    const v = vault('1000000000', {});
    const t = targets({ spy: 5000, nvda: 5000 });
    const plain = planRebalance(v, t, PRICES, POLICY, ASSETS);
    for (const feed of ['0.9991', '1.0004', '0.5'])
      expect(planRebalance(v, t, [...PRICES, price(CASH, feed)], POLICY, ASSETS)).toEqual(plain);
  });

  it('refuses input it cannot use as a RebalanceError, never as another kind of error', () => {
    const v = vault('1000000000', { 'solana:spy': ['100000000', 5000] });
    const t = targets({ spy: 5000, nvda: 5000 });
    const run = (
      over: {
        vault?: typeof v;
        targets?: Target[];
        prices?: Price[];
        policy?: object;
        assets?: AssetUnits[];
      } = {},
    ) =>
      code(() =>
        planRebalance(
          over.vault ?? v,
          over.targets ?? t,
          over.prices ?? PRICES,
          (over.policy ?? POLICY) as typeof POLICY,
          over.assets ?? ASSETS,
        ),
      );
    expect(run()).toBe('did not throw');

    // The cash token off the asset list.
    expect(run({ assets: [] })).toBe('AssetNotPriced');

    expect(run({ targets: [{ asset: CASH, weightBps: 10_000 }] })).toBe('BadTargets');
    expect(run({ targets: targets({ spy: 6000, nvda: 5000 }) })).toBe('BadTargets');
    expect(run({ targets: [...targets({ spy: 5000 }), ...targets({ spy: 5000 })] })).toBe(
      'BadTargets',
    );
    expect(run({ targets: targets({ spy: 50.5, nvda: 5000 }) })).toBe('BadTargets');

    for (const policy of [
      { bandBps: -1, minTradeUsd: 1 },
      { bandBps: 0.5, minTradeUsd: 1 },
      { bandBps: Number.NaN, minTradeUsd: 1 },
      { bandBps: 50, minTradeUsd: Number.NaN },
      { bandBps: 50, minTradeUsd: -1 },
      { bandBps: 50, minTradeUsd: Number.POSITIVE_INFINITY },
      { bandBps: 50, minTradeUsd: 1, costBps: 1.5 },
      { bandBps: 50, minTradeUsd: 1, costBps: Number.NaN },
      { bandBps: 50, minTradeUsd: 1, costBps: 10_001 },
      { bandBps: '50', minTradeUsd: 1 },
    ])
      expect(run({ policy }), JSON.stringify(policy)).toBe('BadPolicy');

    const spy = (usd: string) => [price('solana:spy', usd), price('solana:nvda', '50')];
    for (const bad of ['1e-7', '0x10', '1.2.3', '', ' 100', '100 ', '-5', '.5', '1e3', '0100'])
      expect(run({ prices: spy(bad) }), `price "${bad}"`).toBe('BadInput');
    // Two prices for one asset, even the same one twice.
    expect(run({ prices: [...PRICES, price('solana:spy', '100')] })).toBe('BadInput');

    for (const raw of ['', '1.5', '-5', '0x10', '1e3', ' 7'])
      expect(run({ vault: vault(raw, {}) }), `cash "${raw}"`).toBe('BadInput');
    expect(run({ vault: vault('1', { 'solana:spy': ['', 5000] }) })).toBe('BadInput');
    expect(run({ vault: vault('1', { [CASH]: ['5', 0] }) })).toBe('BadInput');
    expect(run({ assets: [USDC, asset('solana:spy', { decimals: 2.5 })] })).toBe('BadInput');

    // An empty vault has nothing to trade.
    expect(planRebalance(vault('0', {}), t, PRICES, POLICY, ASSETS)).toEqual([]);
  });

  it('cuts a plan into transactions of at most the trades a chain takes, in order', () => {
    const plan = planRebalance(
      vault('0', { 'solana:tsla': ['5000000000', 0] }),
      targets({ spy: 2500, nvda: 2500, gold: 5000 }),
      PRICES,
      POLICY,
      ASSETS,
    );
    expect(plan.map((x) => x.buy)).toEqual([CASH, 'solana:gold', 'solana:nvda', 'solana:spy']);
    expect(batchTrades(plan, 1)).toEqual(plan.map((x) => [x]));
    expect(batchTrades(plan, 3).map((b) => b.length)).toEqual([3, 1]);
    expect(batchTrades(plan, 8)).toEqual([plan]);
    expect(batchTrades(plan, 3).flat()).toEqual(plan);
    expect(batchTrades([], 8)).toEqual([]);
    expect(() => batchTrades(plan, 0)).toThrow(RangeError);
  });
});

// ---- what the review of BAS-1 found ----

/** A pool, as the mock and the real ones pay: the output in whole units first, then the cost off it. */
function poolOut(amountIn: bigint, sell: [string, number], buy: [string, number], costBps: bigint) {
  const gross =
    (amountIn * parseDecimal(sell[0]) * 10n ** BigInt(buy[1])) /
    (parseDecimal(buy[0]) * 10n ** BigInt(sell[1]));
  return (gross * (10_000n - costBps)) / 10_000n;
}

describe('planRebalance, the review of BAS-1', () => {
  it('a batch planned with a cost never spends more cash than its sales bring in', () => {
    // The smallest input the review found: the plan bought with 239,520,238 against 239,520,236 held.
    const messy = [
      price('solana:spy', '105.35209657'),
      price('solana:nvda', '53.81015838'),
      price('solana:gold', '168.08563233'),
    ];
    const v = vault('4', {
      'solana:spy': ['284474639', 3850],
      'solana:gold': ['118867981', 1350],
      'solana:nvda': ['0', 4800],
    });
    const eight = ['spy', 'nvda', 'gold'].map((x) => asset(`solana:${x}`, { decimals: 8 }));
    for (const costBps of [10, 11, 12, 75, 300]) {
      const plan = planRebalance(
        v,
        targets({ spy: 3850, gold: 1350, nvda: 4800 }),
        messy,
        { bandBps: 50, minTradeUsd: 1, costBps },
        [USDC, ...eight],
      );
      expect(plan.map((t) => t.buy)).toEqual([CASH, CASH, 'solana:nvda']);
      let cash = 4n;
      for (const t of plan) {
        const amount = BigInt(t.amountInRaw);
        if (t.buy === CASH) {
          const usd = messy.find((p) => p.asset === t.sell)?.usdPerToken ?? '0';
          cash += poolOut(amount, [usd, 8], ['1', 6], BigInt(costBps));
        } else {
          expect(amount <= cash, `cost ${costBps}: buys with ${amount}, holds ${cash}`).toBe(true);
          cash -= amount;
        }
      }
    }
  });

  it('does not start a plan by selling again what a sale just brought to its target', () => {
    // After two keeper sales at a cost of 10 bps: SPY and NVDA sit a hair over their targets (their
    // drift shows as 0), the cash they brought is idle, and gold is 4% under.
    const v = vault('43302259839', {
      'solana:spy': ['475895204288', 5000],
      'solana:nvda': ['571059782477', 3000],
      'solana:gold': ['99919915064', 2000],
    });
    const after = [
      price('solana:spy', '112'),
      price('solana:nvda', '56'),
      price('solana:gold', '170'),
    ];
    const eight = ['spy', 'nvda', 'gold'].map((x) => asset(`solana:${x}`, { decimals: 8 }));
    const plan = planRebalance(v, targets({ spy: 5000, nvda: 3000, gold: 2000 }), after, POLICY, [
      USDC,
      ...eight,
    ]);
    // The one thing to do is to buy gold with the idle cash.
    expect(plan.map((t) => [t.sell, t.buy])).toEqual([[CASH, 'solana:gold']]);
    const spent = BigInt(plan[0]?.amountInRaw ?? 0);
    expect(spent <= 43_302_259_839n && spent > 43_290_000_000n).toBe(true);
  });

  it('spends cash that sits idle above its share, even with every asset inside the band', () => {
    // $1,000: SPY on target, NVDA 38 bps under, gold 26 under, and the 64 bps they lack held as cash.
    const v = vault('6400000', {
      'solana:spy': ['500000000', 5000],
      'solana:nvda': ['592400000', 3000],
      'solana:gold': ['987000000', 2000],
    });
    const plan = planRebalance(
      v,
      targets({ spy: 5000, nvda: 3000, gold: 2000 }),
      PRICES,
      POLICY,
      ASSETS,
    );
    expect(plan.map((t) => [t.sell, t.buy])).toEqual([
      [CASH, 'solana:nvda'],
      [CASH, 'solana:gold'],
    ]);
    // Cash 40 bps over its share is inside the band: nothing to do.
    const calm = vault('4000000', {
      'solana:spy': ['500000000', 5000],
      'solana:nvda': ['596000000', 3000],
      'solana:gold': ['990000000', 2000],
    });
    expect(
      planRebalance(calm, targets({ spy: 5000, nvda: 3000, gold: 2000 }), PRICES, POLICY, ASSETS),
    ).toEqual([]);
  });
});

// ---- properties ----
//
// A second, plain model of a vault applies the trades one by one at the given prices, with nothing
// lost but what whole units lose, and checks each trade as the vault would. Values are whole numbers
// of 1e-36 dollars, so every comparison is exact.

type Book = { cash: bigint; held: Map<string, bigint> };
type World = {
  v: VaultState;
  targets: Target[];
  prices: Price[];
  assets: AssetUnits[];
  policy: { bandBps: number; minTradeUsd: number };
};

function model(w: World) {
  const decimals = new Map(w.assets.map((a) => [a.id, a.decimals]));
  const priceOf = new Map(w.prices.map((p) => [p.asset, parseDecimal(p.usdPerToken)]));
  // Cash is one dollar whatever the prices say.
  const cashPrice = 10n ** 18n;
  /** What one raw unit is worth, in 1e-36 dollars. */
  const unit = (id: string) =>
    (id === CASH ? cashPrice : (priceOf.get(id) ?? 0n)) *
    10n ** BigInt(18 - (decimals.get(id) ?? 0));
  const target = new Map(w.targets.map((t) => [t.asset, BigInt(t.weightBps)]));
  const book: Book = {
    cash: BigInt(w.v.cash.raw),
    held: new Map(w.v.positions.map((p) => [p.asset, BigInt(p.raw)])),
  };
  const worth = (id: string) => (book.held.get(id) ?? 0n) * unit(id);
  const total = () =>
    [...book.held.keys()].reduce((n, id) => n + worth(id), book.cash * unit(CASH));
  /** Positive when the asset is over its target, in 1e-36 dollar-bps. */
  const over = (id: string) => worth(id) * 10_000n - (target.get(id) ?? 0n) * total();
  const ids = () => [...new Set([...book.held.keys(), ...target.keys()])];
  const cashShare = 10_000n - [...target.values()].reduce((n, t) => n + t, 0n);
  /** Positive when there is more cash than the targets leave for it. */
  const cashOver = () => book.cash * unit(CASH) * 10_000n - cashShare * total();
  /** What is outside the band: an asset either way, or the cash over its share. */
  const outside = (bandBps: number) => {
    const band = BigInt(bandBps) * total();
    const out = ids().filter((id) => (over(id) < 0n ? -over(id) : over(id)) > band);
    return cashOver() > band ? [...out, CASH] : out;
  };
  return { book, unit, total, over, ids, worth, cashOver, outside };
}

function apply(w: World, trades: Trade[]) {
  const m = model(w);
  let buying = false;
  for (const t of trades) {
    expect(Trade.parse(t)).toEqual(t);
    const amount = BigInt(t.amountInRaw);
    expect(amount > 0n).toBe(true);
    expect([t.sell, t.buy].filter((id) => id === CASH)).toHaveLength(1);
    if (t.buy === CASH) {
      // A sale: never after a purchase, only of what is over its target, and not past it.
      expect(buying, 'sales come first').toBe(false);
      expect(m.over(t.sell) > 0n, `${t.sell} is over its target`).toBe(true);
      expect((m.book.held.get(t.sell) ?? 0n) >= amount).toBe(true);
      m.book.held.set(t.sell, (m.book.held.get(t.sell) ?? 0n) - amount);
      m.book.cash += (amount * m.unit(t.sell)) / m.unit(CASH);
      expect(m.over(t.sell) >= 0n, `${t.sell} is not sold past its target`).toBe(true);
    } else {
      buying = true;
      expect(m.over(t.buy) < 0n, `${t.buy} is under its target`).toBe(true);
      expect(m.book.cash >= amount, 'the cash is there').toBe(true);
      m.book.cash -= amount;
      const bought = (amount * m.unit(CASH)) / m.unit(t.buy);
      expect(bought > 0n).toBe(true);
      m.book.held.set(t.buy, (m.book.held.get(t.buy) ?? 0n) + bought);
      expect(m.over(t.buy) <= 0n, `${t.buy} is not bought past its target`).toBe(true);
    }
  }
  return m;
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => `solana:${x}`);
const dollars = fc
  .tuple(fc.integer({ min: 0, max: 9_999 }), fc.integer({ min: 0, max: 999_999 }))
  .map(([whole, frac]) => `${whole}.${frac.toString().padStart(6, '0')}`)
  .filter((p) => parseDecimal(p) >= parseDecimal('0.01'));

/** Whole weights that add up to `total`, some of them zero. */
const split = (count: number, total: number) =>
  fc.array(fc.integer({ min: 0, max: 100 }), { minLength: count, maxLength: count }).map((w) => {
    const sum = w.reduce((n, x) => n + x, 0);
    if (sum === 0) return w.map((_, i) => (i === 0 ? total : 0));
    const out = w.map((x) => Math.floor((x * total) / sum));
    out[0] = (out[0] ?? 0) + total - out.reduce((n, x) => n + x, 0);
    return out;
  });

const world = (minTradeUsd: fc.Arbitrary<number>): fc.Arbitrary<World> =>
  fc
    .record({
      count: fc.integer({ min: 1, max: 8 }),
      seed: fc.array(
        fc.record({
          decimals: fc.constantFrom(6, 8, 9, 18),
          price: dollars,
          // What the vault holds of it, in cents of a dollar.
          heldCents: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 50_000_000 })),
        }),
        { minLength: 8, maxLength: 8 },
      ),
      cashCents: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 50_000_000 })),
      cashPrice: fc.constantFrom(null, '1', '0.9991', '1.0004'),
      // 100% of the time the targets leave at most this much as cash.
      targetSum: fc.constantFrom(10_000, 10_000, 10_000, 9000, 5000),
      bandBps: fc.integer({ min: 25, max: 500 }),
      minTradeUsd,
    })
    .chain((r) => split(r.count, r.targetSum).map((weights) => ({ ...r, weights })))
    .map((r) => {
      const rows = r.seed.slice(0, r.count).map((s, i) => ({ ...s, id: IDS[i] ?? 'solana:z' }));
      const rawOf = (cents: number, priceText: string, decimals: number) =>
        (BigInt(cents) * 10n ** 16n * 10n ** BigInt(decimals)) / parseDecimal(priceText);
      return {
        v: vault(
          (BigInt(r.cashCents) * 10_000n).toString(),
          Object.fromEntries(
            rows
              .filter((x) => x.heldCents > 0)
              .map((x) => [x.id, [rawOf(x.heldCents, x.price, x.decimals).toString(), 0]]),
          ),
        ),
        targets: rows
          .map((x, i) => ({ asset: x.id, weightBps: r.weights[i] ?? 0 }))
          .filter((t) => t.weightBps > 0),
        prices: [
          ...rows.map((x) => price(x.id, x.price)),
          ...(r.cashPrice === null ? [] : [price(CASH, r.cashPrice)]),
        ],
        assets: [USDC, ...rows.map((x) => asset(x.id, { decimals: x.decimals }))],
        policy: { bandBps: r.bandBps, minTradeUsd: r.minTradeUsd },
      };
    });

const plan = (w: World) => planRebalance(w.v, w.targets, w.prices, w.policy, w.assets);
/** A vault worth at least $1,000, so that one raw unit of anything is far under a bp of it. */
const large = (w: World) => model(w).total() >= 1000n * 10n ** 36n;

// Generated cases take a second or two alone and several when the machine is busy.
describe('planRebalance, on generated vaults', { timeout: 60_000 }, () => {
  it('never trades away from a target and never past one, and always has the cash', () => {
    let traded = 0;
    fc.assert(
      fc.property(world(fc.constantFrom(0, 0.5, 1, 5)), (w) => {
        const trades = plan(w);
        apply(w, trades);
        if (trades.length > 0) traded += 1;
      }),
      { numRuns: 3000 },
    );
    expect(traded).toBeGreaterThan(1500);
  });

  it('lands every weight inside the band when its trades are applied at the given prices', () => {
    let rebalanced = 0;
    fc.assert(
      fc.property(world(fc.constant(0)).filter(large), (w) => {
        const before = model(w);
        const trades = plan(w);
        if (before.outside(w.policy.bandBps).length === 0) {
          expect(trades).toEqual([]);
          return;
        }
        rebalanced += 1;
        expect(trades.length).toBeGreaterThan(0);
        expect(apply(w, trades).outside(w.policy.bandBps)).toEqual([]);
      }),
      { numRuns: 3000 },
    );
    expect(rebalanced).toBeGreaterThan(2000);
  });

  it('with a dust threshold, misses a target by no more than the dust it would not trade', () => {
    fc.assert(
      fc.property(world(fc.constantFrom(0.25, 1, 5)).filter(large), (w) => {
        const after = apply(w, plan(w));
        const total = after.total();
        // Band, plus one refused trade per asset and for the cash, plus a cent for whole units.
        const dust = BigInt(Math.round(w.policy.minTradeUsd * 100)) * 10n ** 34n;
        const allowed =
          BigInt(w.policy.bandBps) * total +
          (BigInt(after.ids().length + 2) * dust + 10n ** 34n) * 10_000n;
        for (const id of after.ids()) {
          const gap = after.over(id);
          expect((gap < 0n ? -gap : gap) <= allowed, id).toBe(true);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('with a cost, a batch sent together has the cash for every purchase', () => {
    let batches = 0;
    fc.assert(
      fc.property(
        world(fc.constantFrom(0, 1)),
        fc.constantFrom(1, 10, 75, 125, 300),
        (w, costBps) => {
          const trades = planRebalance(
            w.v,
            w.targets,
            w.prices,
            { ...w.policy, costBps },
            w.assets,
          );
          // Every trade loses exactly the cost, taken as a pool takes it: off the whole units paid.
          const m = model(w);
          const keep = 10_000n - BigInt(costBps);
          for (const t of trades) {
            const amount = BigInt(t.amountInRaw);
            if (t.buy === CASH) {
              m.book.held.set(t.sell, (m.book.held.get(t.sell) ?? 0n) - amount);
              m.book.cash += (((amount * m.unit(t.sell)) / m.unit(CASH)) * keep) / 10_000n;
              expect(m.over(t.sell) >= 0n, `${t.sell} is not sold past its target`).toBe(true);
            } else {
              expect(m.book.cash >= amount, `short by ${amount - m.book.cash}`).toBe(true);
              m.book.cash -= amount;
              const bought = (((amount * m.unit(CASH)) / m.unit(t.buy)) * keep) / 10_000n;
              m.book.held.set(t.buy, (m.book.held.get(t.buy) ?? 0n) + bought);
            }
          }
          if (trades.some((t) => t.buy === CASH) && trades.some((t) => t.sell === CASH))
            batches += 1;
        },
      ),
      { numRuns: 3000 },
    );
    expect(batches).toBeGreaterThan(1000);
  });

  it('never plans a sale worth under 1 bp of the vault in an asset that has a target', () => {
    fc.assert(
      fc.property(world(fc.constantFrom(0, 1)), (w) => {
        const m = model(w);
        const targeted = new Set(w.targets.map((t) => t.asset));
        for (const t of plan(w)) {
          if (t.buy !== CASH || !targeted.has(t.sell)) continue;
          expect(BigInt(t.amountInRaw) * m.unit(t.sell) * 10_000n >= m.total() - 10n ** 20n).toBe(
            true,
          );
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('gives the same plan for the same inputs, and nothing more once it has been applied', () => {
    fc.assert(
      fc.property(world(fc.constant(0)).filter(large), (w) => {
        const trades = plan(w);
        expect(plan(w)).toEqual(trades);
        const after = apply(w, trades);
        const settled = vault(
          after.book.cash.toString(),
          Object.fromEntries([...after.book.held].map(([id, raw]) => [id, [raw.toString(), 0]])),
        );
        expect(plan({ ...w, v: settled })).toEqual([]);
      }),
      { numRuns: 1000 },
    );
  });
});
