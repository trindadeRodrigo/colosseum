import type { AssetId, Price, Target, Trade, VaultState } from '@colosseum/schemas';
import {
  BasketInputError,
  ONE_USD,
  parseRaw,
  rawFor,
  unitValue,
  usdFromNumber,
  usdValue,
} from './amounts';
import { type AssetUnits, lookups } from './view';

// The trades that bring a vault back to its targets. Pure: the vault, the targets, the prices and the
// asset list come in as arguments, and the same inputs give the same trades.

export class RebalanceError extends Error {
  readonly code: 'AssetNotPriced' | 'BadTargets' | 'BadPolicy' | 'BadInput';
  constructor(code: RebalanceError['code'], message: string) {
    super(message);
    this.name = 'RebalanceError';
    this.code = code;
  }
}

export type RebalancePolicy = {
  /** A weight within this many bps of its target is in place. 0 when planning a deposit. */
  bandBps: number;
  /**
   * The dust threshold: no trade worth less than this many dollars. A float, and safe as one: it is a
   * setting that a value is compared against, never an amount that moves.
   */
  minTradeUsd: number;
  /**
   * LOCAL FIELD, not in DESIGN-VAULT 3.6. The most a trade is expected to lose, in bps. The purchases
   * count on each sale bringing in this much less, so that sales and purchases sent together do not
   * run out of cash. Default 0: the plan is exact at the given prices.
   */
  costBps?: number;
};

/** A plan, and what it had to leave out. */
export type RebalancePlan = {
  trades: Trade[];
  /**
   * Assets that are held or are targets and have no price (or are not on the asset list). None of
   * them is traded.
   */
  unpriced: AssetId[];
  /**
   * False when one of the unpriced assets is both held and a target. The vault's value is then
   * unknown, every weight with it, and no trade is planned.
   */
  weighed: boolean;
};

type Row = {
  asset: string;
  raw: bigint;
  decimals: number;
  price: bigint;
  value: bigint;
  targetBps: bigint;
};

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const abs = (n: bigint) => (n < 0n ? -n : n);
const byValueThenAsset = <T extends { asset: string; value: bigint }>(a: T, b: T) =>
  a.value === b.value ? (a.asset < b.asset ? -1 : 1) : a.value > b.value ? -1 : 1;

function bps(value: unknown, what: string): bigint {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000)
    throw new RebalanceError('BadPolicy', `${what} is a whole number of bps from 0 to 10,000`);
  return BigInt(value);
}

/**
 * The trades that bring `v` to `targets` at `prices`, and what was left out.
 *
 * - Weights are shares of everything the vault holds, cash included. Cash is one dollar, always.
 * - Nothing is planned while every asset is within the band of its target and the cash is no more
 *   than the band over its own share. Once something is outside, the plan brings every asset to its
 *   target, so the cash a purchase needs is there. Cash over its share counts: what a sale leaves
 *   idle is spent by the next plan.
 * - Sales come first, then purchases, and every trade has the chain's cash token on one side.
 * - A sale is only of an asset above its target and stops at the target or just before; a purchase
 *   is only of one below and stops at the target or just before. Both keep a margin for what turning
 *   a value into whole units can lose, so a trade never goes past at the given prices.
 * - No trade worth less than `minTradeUsd`. And no sale worth less than 1 bp of the vault in an asset
 *   that has a target: after a sale lands at any cost, the asset sits a hair over its target, and
 *   selling that hair is a trade a vault refuses.
 * - A position that is held and is not a target is sold whole. Cash keeps what the targets leave of
 *   100%.
 * - An asset with no price is left out and named in `unpriced`. If it is held and is not a target,
 *   the rest is planned without it. If it is a target and none is held, its share stays in cash. If
 *   it is both held and a target, the vault cannot be weighed: `weighed` is false and nothing is
 *   planned, because any plan for the others would be sized on a guess at what it is worth.
 *
 * The amounts are exact at the given prices with no trading cost. A keeper sends the first trade and
 * plans again from fresh state; an owner sending several together passes `costBps`. Split the trades
 * with `batchTrades` to respect a chain's limit per transaction. `lastKeeperAt` is not read: the
 * cooldown is the keeper's to apply.
 *
 * Throws `RebalanceError`, and nothing else, for input it cannot use: `BadPolicy`, `BadTargets`,
 * `BadInput` (a price or an amount that is not a plain number, two prices for one asset, cash among
 * the positions), `AssetNotPriced` (the cash token is not on the asset list).
 */
export function rebalancePlan(
  v: VaultState,
  targets: Target[],
  prices: readonly Price[],
  policy: RebalancePolicy,
  assets: readonly AssetUnits[],
): RebalancePlan {
  try {
    return plan(v, targets, prices, policy, assets);
  } catch (e) {
    if (e instanceof BasketInputError)
      throw new RebalanceError(
        e.code === 'CashNotListed' ? 'AssetNotPriced' : 'BadInput',
        e.message,
      );
    throw e;
  }
}

/** The trades of `rebalancePlan`, as DESIGN-VAULT 3.6 names the function. */
export function planRebalance(
  v: VaultState,
  targets: Target[],
  prices: readonly Price[],
  policy: RebalancePolicy,
  assets: readonly AssetUnits[],
): Trade[] {
  return rebalancePlan(v, targets, prices, policy, assets).trades;
}

function plan(
  v: VaultState,
  targets: Target[],
  prices: readonly Price[],
  policy: RebalancePolicy,
  assets: readonly AssetUnits[],
): RebalancePlan {
  const band = bps(policy.bandBps, 'the band');
  const cost = bps(policy.costBps ?? 0, 'the cost');
  if (
    typeof policy.minTradeUsd !== 'number' ||
    !Number.isFinite(policy.minTradeUsd) ||
    policy.minTradeUsd < 0
  )
    throw new RebalanceError('BadPolicy', 'the dust threshold is a dollar figure of 0 or more');
  const minTrade = usdFromNumber(policy.minTradeUsd);

  const cashId = v.cash.asset;
  const { decimalsOf, priceOf } = lookups(prices, assets);
  const cashDecimals = decimalsOf.get(cashId);
  if (cashDecimals === undefined)
    throw new BasketInputError('CashNotListed', `${cashId} is not on the asset list`);
  // Cash is one dollar, as the vaults count it. A price given for it is not read.
  const cashPrice = ONE_USD;
  const cashRaw = parseRaw(v.cash.raw);

  const targetOf = new Map<string, bigint>();
  for (const t of targets) {
    if (t.asset === cashId) throw new RebalanceError('BadTargets', 'cash is not a target');
    if (targetOf.has(t.asset))
      throw new RebalanceError('BadTargets', `${t.asset} is a target twice`);
    if (!Number.isInteger(t.weightBps) || t.weightBps < 0)
      throw new RebalanceError('BadTargets', `${t.asset} has a weight that is not whole bps`);
    targetOf.set(t.asset, BigInt(t.weightBps));
  }
  const targetSum = [...targetOf.values()].reduce((n, t) => n + t, 0n);
  if (targetSum > BPS) throw new RebalanceError('BadTargets', 'the targets add up to over 100%');

  const held = new Map<string, bigint>();
  for (const p of v.positions) {
    if (p.asset === cashId)
      throw new RebalanceError('BadInput', 'the cash token is listed among the positions');
    held.set(p.asset, (held.get(p.asset) ?? 0n) + parseRaw(p.raw));
  }

  const rows: Row[] = [];
  const unpriced: AssetId[] = [];
  let weighed = true;
  for (const asset of new Set([...targetOf.keys(), ...held.keys()])) {
    const raw = held.get(asset) ?? 0n;
    const targetBps = targetOf.get(asset) ?? 0n;
    if (raw === 0n && targetBps === 0n) continue;
    const decimals = decimalsOf.get(asset);
    const price = priceOf.get(asset);
    if (decimals === undefined || price === undefined) {
      unpriced.push(asset);
      if (raw > 0n && targetBps > 0n) weighed = false;
      continue;
    }
    rows.push({ asset, raw, decimals, price, value: usdValue(raw, price, decimals), targetBps });
  }
  unpriced.sort();
  if (!weighed) return { trades: [], unpriced, weighed };

  const cashValue = usdValue(cashRaw, cashPrice, cashDecimals);
  const total = rows.reduce((n, r) => n + r.value, cashValue);
  if (total === 0n) return { trades: [], unpriced, weighed };
  // Each value above was rounded down by less than one unit of 1e-18 dollars, so the vault is worth
  // at least `total` and less than `most`.
  const most = total + BigInt(rows.length + 1);
  // What stays in cash: what the targets leave of 100%, and the share of a target that has no price.
  const cashShare = BPS - rows.reduce((n, r) => n + r.targetBps, 0n);

  const outside =
    rows.some((r) => abs(r.value * BPS - r.targetBps * total) > band * total) ||
    cashValue * BPS - cashShare * total > band * total;
  if (!outside) return { trades: [], unpriced, weighed };

  // Sales: down to the target, keeping a hair over it so that rounding never leaves the asset under.
  const sales: { asset: string; value: bigint; raw: bigint; proceedsRaw: bigint }[] = [];
  for (const r of rows) {
    if (r.value * BPS <= r.targetBps * total) continue;
    const keep = ceilDiv(r.targetBps * most, BPS) + 1n;
    const raw =
      r.targetBps === 0n
        ? r.raw
        : r.value > keep
          ? rawFor(r.value - keep, r.price, r.decimals)
          : 0n;
    const value = usdValue(raw, r.price, r.decimals);
    if (raw === 0n || value < minTrade) continue;
    // Under 1 bp of the vault: the hair a sale leaves behind, not a position to sell.
    if (r.targetBps > 0n && value * BPS < total) continue;
    // As a pool pays: whole cash units first, then the cost off them.
    const proceedsRaw = (rawFor(value, cashPrice, cashDecimals) * (BPS - cost)) / BPS;
    if (proceedsRaw === 0n) continue;
    sales.push({ asset: r.asset, value, raw, proceedsRaw });
  }
  sales.sort(byValueThenAsset);

  // Purchases. Turning a value into whole units loses up to one unit each time, which makes the vault
  // worth a hair less than `total` by the time a purchase lands. Each purchase is sized against the
  // least the vault can then be worth, so it stops at its target or just before.
  const under = rows.filter((r) => r.value * BPS < r.targetBps * total);
  const lost =
    BigInt(sales.length) * (unitValue(cashPrice, cashDecimals) + 2n) +
    under.reduce((n, r) => n + unitValue(r.price, r.decimals) + 2n, 0n);
  const least = total > lost ? total - lost : 0n;
  let wanted = under
    .map((r) => ({ asset: r.asset, row: r, value: (r.targetBps * least) / BPS - r.value - 1n }))
    .filter((w) => w.value > 0n && w.value >= minTrade);

  // What there is to spend: the cash held and what the sales bring in, less the cash's own share.
  const reserveRaw = ceilDiv(
    ceilDiv(cashShare * most, BPS) * 10n ** BigInt(cashDecimals),
    cashPrice,
  );
  const haveRaw = sales.reduce((n, s) => n + s.proceedsRaw, cashRaw);
  let budgetRaw = haveRaw > reserveRaw ? haveRaw - reserveRaw : 0n;
  const budget = usdValue(budgetRaw, cashPrice, cashDecimals);
  const want = wanted.reduce((n, w) => n + w.value, 0n);
  if (want > budget)
    wanted = wanted
      .map((w) => ({ ...w, value: (w.value * budget) / want }))
      .filter((w) => w.value > 0n && w.value >= minTrade);
  wanted.sort(byValueThenAsset);

  const trades: Trade[] = sales.map((s) => ({
    sell: s.asset,
    buy: cashId,
    amountInRaw: s.raw.toString(),
  }));
  for (const w of wanted) {
    let amountIn = rawFor(w.value, cashPrice, cashDecimals);
    if (amountIn > budgetRaw) amountIn = budgetRaw;
    const spent = usdValue(amountIn, cashPrice, cashDecimals);
    const bought = rawFor(spent, w.row.price, w.row.decimals);
    if (amountIn === 0n || bought === 0n || spent < minTrade) continue;
    budgetRaw -= amountIn;
    trades.push({ sell: cashId, buy: w.asset, amountInRaw: amountIn.toString() });
  }
  return { trades, unpriced, weighed };
}

/**
 * A plan cut into transactions of at most `maxTradesPerTx` trades (the adapter's
 * `capabilities.maxTradesPerTx`: 1 on Solana, 8 on EVM), in the plan's order, so the sales still come
 * before the purchases they pay for.
 */
export function batchTrades(trades: readonly Trade[], maxTradesPerTx: number): Trade[][] {
  if (!Number.isInteger(maxTradesPerTx) || maxTradesPerTx < 1)
    throw new RangeError('a transaction takes at least one trade');
  const batches: Trade[][] = [];
  for (let i = 0; i < trades.length; i += maxTradesPerTx)
    batches.push(trades.slice(i, i + maxTradesPerTx));
  return batches;
}
