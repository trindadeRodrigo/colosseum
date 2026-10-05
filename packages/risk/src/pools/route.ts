import { afterTransferFee } from './raydium-cpmm';
import type { PoolSim } from './simulate';

/**
 * The routed sale and purchase of one asset across its dollar and SOL exit pools (PLAN-ANALYTICS item 3): the greedy
 * split the pool collector uses (`writeRoutedCurves` in scripts/risk/collector/pools.ts, which keeps its own copy until
 * Oct 12), as a pure function. It returns what the collector's rows lack: the amount sent to each pool, and the cost
 * split of §5 (pool fee, transfer fee, basis against the reference pool, and impact as the rest), so the four parts
 * sum to the total exactly.
 */
export type RoutePool = {
  pool: string;
  sim: PoolSim;
  decAsset: number;
  decQuote: number;
  /** USD per whole quote token (1 for a dollar stablecoin, the SOL price for a SOL pool). */
  quoteUsd: number;
  /** The pool's mid in USD per whole asset token. */
  midUsd: number;
  tvlUsd: number;
  /** Pool fee rate as a fraction at this snapshot (Orca: the static rate, until the adaptive fee is modelled). */
  feeRate: number;
  /** Token-2022 transfer fees on the asset and quote legs, basis points. */
  transferFeeBps: { asset: number; quote: number };
};

export const ROUTE_CHUNKS = 32;

export type RouteLeg = {
  pool: string;
  /** Sent to the pool: asset units for a sale, USD for a purchase. */
  amountIn: number;
  /** Share of `amountIn` the pool could not fill. */
  unfilledShare: number;
  outUsd: number;
  midUsd: number;
  feeRate: number;
};

export type CostSplit = {
  /** 1 − out ÷ notional, as the collector computes it. */
  total: number;
  poolFee: number;
  transferFee: number;
  /** The pools used against the reference pool: negative when a smaller pool is priced better. */
  basis: number;
  impact: number;
};

export type RoutedTrade = {
  side: 'sell' | 'buy';
  notionalUsd: number;
  outUsd: number;
  /** Percent, as the collector stores it. */
  costPct: number;
  poolsUsed: number;
  refPool: string;
  refMidUsd: number;
  legs: RouteLeg[];
  split: CostSplit;
};

const tf = (bps: number) => ({ bps, maximumFee: Number.MAX_SAFE_INTEGER });

/** One sale (`side: 'sell'`, `notionalUsd` of asset at the reference mid) or purchase (`notionalUsd` USD in). */
export function routeTrade(
  pools: readonly RoutePool[],
  notionalUsd: number,
  side: 'sell' | 'buy',
  chunks = ROUTE_CHUNKS,
): RoutedTrade {
  if (!pools.length) throw new Error('routeTrade: no pools');
  // the reference pool is the largest by TVL; ties keep the input order (the collector's stable sort)
  const ref = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0] as RoutePool;
  const run = (e: RoutePool, x: number) =>
    side === 'sell'
      ? e.sim.sellAsset(Math.floor(x * 10 ** e.decAsset))
      : e.sim.buyAsset(Math.floor((x / e.quoteUsd) * 10 ** e.decQuote));
  const outAt = (e: RoutePool, x: number) => {
    if (x <= 0) return 0;
    const r = run(e, x);
    return side === 'sell'
      ? (r.out / 10 ** e.decQuote) * e.quoteUsd * (1 - r.unfilledShare)
      : (r.out / 10 ** e.decAsset) * ref.midUsd * (1 - r.unfilledShare);
  };
  const total = side === 'sell' ? notionalUsd / ref.midUsd : notionalUsd;
  const chunk = total / chunks;
  const alloc = pools.map(() => 0);
  const cur = pools.map(() => 0);
  for (let k = 0; k < chunks; k++) {
    let bi = 0;
    let bGain = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pools.length; i++) {
      const g = outAt(pools[i] as RoutePool, (alloc[i] as number) + chunk) - (cur[i] as number);
      if (g > bGain) {
        bGain = g;
        bi = i;
      }
    }
    alloc[bi] = (alloc[bi] as number) + chunk;
    cur[bi] = outAt(pools[bi] as RoutePool, alloc[bi] as number);
  }
  const outUsd = cur.reduce((t, v) => t + v, 0);
  const legs: RouteLeg[] = [];
  let poolFeeUsd = 0;
  let transferFeeUsd = 0;
  let basisUsd = 0;
  pools.forEach((e, i) => {
    const x = alloc[i] as number;
    if (!(x > 0)) return;
    const r = run(e, x);
    const filled = 1 - r.unfilledShare;
    legs.push({
      pool: e.pool,
      amountIn: x,
      unfilledShare: r.unfilledShare,
      outUsd: cur[i] as number,
      midUsd: e.midUsd,
      feeRate: e.feeRate,
    });
    if (side === 'sell') {
      // asset units entering the pool after the asset's transfer fee, valued at this pool's mid
      const raw = Math.floor(x * 10 ** e.decAsset);
      const feeUnits = (raw - afterTransferFee(raw, tf(e.transferFeeBps.asset))) / 10 ** e.decAsset;
      const inPool = (x - feeUnits) * filled;
      poolFeeUsd += inPool * e.midUsd * e.feeRate;
      // the quote leg's transfer fee, grossed up from what arrived
      const q = e.transferFeeBps.quote / 10_000;
      transferFeeUsd +=
        feeUnits * e.midUsd * filled + (q > 0 ? ((cur[i] as number) * q) / (1 - q) : 0);
      basisUsd += x * filled * (ref.midUsd - e.midUsd);
    } else {
      const raw = Math.floor((x / e.quoteUsd) * 10 ** e.decQuote);
      const feeQuote =
        ((raw - afterTransferFee(raw, tf(e.transferFeeBps.quote))) / 10 ** e.decQuote) * e.quoteUsd;
      const inPool = (x - feeQuote) * filled;
      poolFeeUsd += inPool * e.feeRate;
      const a = e.transferFeeBps.asset / 10_000;
      transferFeeUsd += feeQuote * filled + (a > 0 ? ((cur[i] as number) * a) / (1 - a) : 0);
      // a purchase at this pool's mid against the reference: x buys x ÷ P_i units worth x × P_ref ÷ P_i
      basisUsd += x * filled * (1 - ref.midUsd / e.midUsd);
    }
  });
  const costTotal = 1 - outUsd / notionalUsd;
  const poolFee = poolFeeUsd / notionalUsd;
  const transferFee = transferFeeUsd / notionalUsd;
  const basis = basisUsd / notionalUsd;
  return {
    side,
    notionalUsd,
    outUsd,
    costPct: costTotal * 100,
    poolsUsed: alloc.filter((a) => a > 0).length,
    refPool: ref.pool,
    refMidUsd: ref.midUsd,
    legs,
    split: {
      total: costTotal,
      poolFee,
      transferFee,
      basis,
      impact: costTotal - poolFee - transferFee - basis,
    },
  };
}
