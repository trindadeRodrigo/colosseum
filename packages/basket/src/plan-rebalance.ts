import type { Price, Target, Trade, VaultState } from '@colosseum/schemas';
import { ONE_USD, rawFor, unitValue, usdFromNumber, usdValue } from './amounts';
import { type AssetUnits, lookups } from './view';

// The trades that bring a vault back to its targets. Pure: the vault, the targets, the prices and the
// asset list come in as arguments, and the same inputs give the same trades.

export class RebalanceError extends Error {
  readonly code: 'AssetNotPriced' | 'BadTargets' | 'BadPolicy';
  constructor(code: RebalanceError['code'], message: string) {
    super(message);
    this.name = 'RebalanceError';
    this.code = code;
  }
}

export type RebalancePolicy = {
  /** A weight within this many bps of its target is in place. */
  bandBps: number;
  /**
   * The dust threshold: no trade worth less than this many dollars. A float, and safe as one: it is a
   * setting that a value is compared against, never an amount that moves.
   */
  minTradeUsd: number;
  /**
   * LOCAL FIELD, not in DESIGN-VAULT 3.6. What a trade is expected to lose, in bps. The buys are sized
   * as if each sale brought in this much less, so that a batch of sales and buys sent together does
   * not run out of cash. Default 0: the plan is exact at the given prices.
   */
  costBps?: number;
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
const byValueThenAsset = <T extends { asset: string; value: bigint }>(a: T, b: T) =>
  a.value === b.value ? (a.asset < b.asset ? -1 : 1) : a.value > b.value ? -1 : 1;

/**
 * The trades that bring `v` to `targets` at `prices`.
 *
 * - Nothing is planned while every asset is within the band of its target. Once one is outside, the
 *   plan brings every asset to its target, so the cash a purchase needs is there.
 * - Sales come first, then purchases, and every trade has the chain's cash token on one side.
 * - A sale is only of an asset above its target and stops at the target; a purchase is only of one
 *   below and stops at the target. Rounding is always on the near side: a trade never goes past.
 * - No trade worth less than `minTradeUsd`. What such a trade would have moved stays where it is.
 * - A position that is held and is not a target is sold whole. Cash keeps what the targets leave of
 *   100%.
 * - Weights are shares of everything the vault holds, cash included.
 * - Every asset that is held or is a target needs a price and its decimals, or the plan is refused
 *   with `AssetNotPriced`: a vault that cannot be valued cannot be weighed.
 *
 * The amounts are exact at the given prices with no trading cost. A caller that sends one trade at a
 * time plans again from fresh state after each; one that sends several together passes `costBps`.
 * Split the result with `batchTrades` to respect a chain's limit per transaction.
 */
export function planRebalance(
  v: VaultState,
  targets: Target[],
  prices: readonly Price[],
  policy: RebalancePolicy,
  assets: readonly AssetUnits[],
): Trade[] {
  const cost = BigInt(policy.costBps ?? 0);
  if (!Number.isInteger(policy.bandBps) || policy.bandBps < 0 || policy.bandBps > 10_000)
    throw new RebalanceError('BadPolicy', 'the band is a whole number of bps from 0 to 10,000');
  if (!Number.isInteger(policy.costBps ?? 0) || cost < 0n || cost > BPS)
    throw new RebalanceError('BadPolicy', 'the cost is a whole number of bps from 0 to 10,000');
  const band = BigInt(policy.bandBps);
  const minTrade = usdFromNumber(policy.minTradeUsd);

  const cashId = v.cash.asset;
  const { decimalsOf, priceOf } = lookups(prices, assets);
  const cashDecimals = decimalsOf.get(cashId);
  if (cashDecimals === undefined)
    throw new RebalanceError('AssetNotPriced', `${cashId} is not on the asset list`);
  const cashPrice = priceOf.get(cashId) ?? ONE_USD;
  const cashRaw = BigInt(v.cash.raw);

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
  for (const p of v.positions) held.set(p.asset, (held.get(p.asset) ?? 0n) + BigInt(p.raw));
  const rows: Row[] = [];
  for (const asset of new Set([...targetOf.keys(), ...held.keys()])) {
    const raw = held.get(asset) ?? 0n;
    const targetBps = targetOf.get(asset) ?? 0n;
    if (raw === 0n && targetBps === 0n) continue;
    const decimals = decimalsOf.get(asset);
    const price = priceOf.get(asset);
    if (decimals === undefined || price === undefined)
      throw new RebalanceError('AssetNotPriced', `${asset} has no price to weigh it by`);
    rows.push({ asset, raw, decimals, price, value: usdValue(raw, price, decimals), targetBps });
  }

  const total = rows.reduce((n, r) => n + r.value, usdValue(cashRaw, cashPrice, cashDecimals));
  if (total === 0n) return [];
  const abs = (n: bigint) => (n < 0n ? -n : n);
  const outside = rows.some((r) => abs(r.value * BPS - r.targetBps * total) > band * total);
  if (!outside) return [];

  // Sales: down to the target, rounded so that what is kept is never under it.
  const sales: { asset: string; value: bigint; raw: bigint; proceedsRaw: bigint }[] = [];
  for (const r of rows) {
    if (r.value * BPS <= r.targetBps * total) continue;
    const keep = ceilDiv(r.targetBps * total, BPS);
    const raw = r.targetBps === 0n ? r.raw : rawFor(r.value - keep, r.price, r.decimals);
    const value = usdValue(raw, r.price, r.decimals);
    const proceedsRaw = rawFor((value * (BPS - cost)) / BPS, cashPrice, cashDecimals);
    if (raw === 0n || proceedsRaw === 0n || value < minTrade) continue;
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

  // What there is to spend: the cash held and what the sales bring in, less the cash the targets
  // leave uninvested.
  const reserveRaw = ceilDiv(
    ceilDiv((BPS - targetSum) * total, BPS) * 10n ** BigInt(cashDecimals),
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
    const bought = rawFor(usdValue(amountIn, cashPrice, cashDecimals), w.row.price, w.row.decimals);
    if (amountIn === 0n || bought === 0n) continue;
    budgetRaw -= amountIn;
    trades.push({ sell: cashId, buy: w.asset, amountInRaw: amountIn.toString() });
  }
  return trades;
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
