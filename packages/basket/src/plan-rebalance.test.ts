import { type Price, type Target, Trade, type VaultState } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDecimal } from './amounts';
import { batchTrades, planRebalance, RebalanceError } from './plan-rebalance';
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
    // SPY is $100 over: one whole token, 8 decimals.
    expect(plan[0]).toEqual({ sell: 'solana:spy', buy: CASH, amountInRaw: '100000000' });
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
    expect(plan[0]?.amountInRaw).toBe('5100000');
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
    expect(plan).toEqual([{ sell: 'solana:spy', buy: CASH, amountInRaw: '2000000' }]);
  });

  it('sizes the purchases for what the sales are expected to bring when given a cost', () => {
    const v = vault('0', { 'solana:spy': ['1000000000', 5000] });
    const t = targets({ spy: 5000, nvda: 5000 });
    const exact = planRebalance(v, t, PRICES, POLICY, ASSETS);
    const careful = planRebalance(v, t, PRICES, { ...POLICY, costBps: 100 }, ASSETS);
    expect(exact[0]).toEqual(careful[0]);
    // $500 of SPY sold; at 1% the purchase counts on $495.
    expect(BigInt(careful[1]?.amountInRaw ?? 0)).toBe(495_000_000n);
    expect(BigInt(exact[1]?.amountInRaw ?? 0) > 499_999_990n).toBe(true);
  });

  it('refuses a vault it cannot weigh, and targets that make no sense', () => {
    const v = vault('1000000000', { 'solana:spy': ['100000000', 5000] });
    const t = targets({ spy: 5000, nvda: 5000 });
    const noNvda = PRICES.filter((p) => p.asset !== 'solana:nvda');
    expect(code(() => planRebalance(v, t, noNvda, POLICY, ASSETS))).toBe('AssetNotPriced');
    const zero = [...noNvda, price('solana:nvda', '0')];
    expect(code(() => planRebalance(v, t, zero, POLICY, ASSETS))).toBe('AssetNotPriced');
    const unlisted = ASSETS.filter((a) => a.id !== 'solana:nvda');
    expect(code(() => planRebalance(v, t, PRICES, POLICY, unlisted))).toBe('AssetNotPriced');
    expect(code(() => planRebalance(v, t, PRICES, POLICY, []))).toBe('AssetNotPriced');
    const plan = (list: Target[]) => () => planRebalance(v, list, PRICES, POLICY, ASSETS);
    expect(code(plan([{ asset: CASH, weightBps: 10_000 }]))).toBe('BadTargets');
    expect(code(plan(targets({ spy: 6000, nvda: 5000 })))).toBe('BadTargets');
    expect(code(plan([...targets({ spy: 5000 }), ...targets({ spy: 5000 })]))).toBe('BadTargets');
    expect(code(plan(targets({ spy: 50.5, nvda: 5000 })))).toBe('BadTargets');
    expect(code(() => planRebalance(v, t, PRICES, { bandBps: -1, minTradeUsd: 1 }, ASSETS))).toBe(
      'BadPolicy',
    );
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
  const cashPrice = priceOf.get(CASH) ?? 10n ** 18n;
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
  return { book, unit, total, over, ids, worth };
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

describe('planRebalance, on generated vaults', () => {
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
        const band = BigInt(w.policy.bandBps);
        const outside = (m: ReturnType<typeof model>) =>
          m.ids().filter((id) => {
            const gap = m.over(id);
            return (gap < 0n ? -gap : gap) > band * m.total();
          });
        const trades = plan(w);
        if (outside(before).length === 0) {
          expect(trades).toEqual([]);
          return;
        }
        rebalanced += 1;
        expect(trades.length).toBeGreaterThan(0);
        expect(outside(apply(w, trades))).toEqual([]);
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
