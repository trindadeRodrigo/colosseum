import { type RoutePool, routeTrade } from '@colosseum/risk';
import type { StoredQuote } from '../lib-routing-gap';
import type { GapShare, QuoteLeg, Side } from './lib';

// PLAN-UNIVERSE RU.13 — how much of the gap to Jupiter a class of pools accounts for, by replay. Our router is run on
// the amount Jupiter did not send through the class, and the class's own legs are added exactly as Jupiter quoted
// them. What comes out is what our route would have returned had it been given those legs: Jupiter's split and the
// venue's price at the quote's moment, so an estimate of what reading the venue would bring, not a route our router
// chose. Pure.

const USDC_DECIMALS = 6;

/**
 * The dollars of one stock leg, raw: its own when it trades the stock against dollars, else the dollars of the one
 * chain of legs that carries its other token to the dollar end (a sale) or brought it from there (a purchase). Null
 * when a leg's amount is split or merged on the way: nothing is apportioned.
 */
export function dollarsOfStockLeg(
  q: StoredQuote,
  legs: readonly QuoteLeg[],
  index: number,
): bigint | null {
  const route = q.route ?? [];
  const sell = q.side === 'sell';
  let at = index;
  for (let step = 0; step < route.length; step++) {
    const hop = route[at];
    const leg = legs[at];
    if (!hop || !leg) return null;
    if (leg.dollarPct !== null) return BigInt((sell ? hop.outAmount : hop.inAmount) as string);
    // the one leg that takes what this one pays (a sale), or that pays what this one takes (a purchase)
    const carried = sell ? hop.outAmount : hop.inAmount;
    const next = route
      .map((h, i) => ({ i, amount: sell ? h.inAmount : h.outAmount }))
      .filter((x) => x.i !== at && x.amount === carried);
    if (next.length !== 1) return null;
    at = (next[0] as { i: number }).i;
  }
  return null;
}

/**
 * The gap, in basis points, with the stock legs at `indexes` taken as Jupiter quoted them and the rest of the amount
 * routed by our router on `pools` (one hop). `base` is the plain gap of the same pair, as `gapOf` gives it: the
 * difference is what those legs account for. Null when a leg's dollars cannot be followed.
 */
export function gapWithLegs(
  q: StoredQuote,
  legs: readonly QuoteLeg[],
  indexes: readonly number[],
  pools: readonly RoutePool[],
  chunks: number,
): { gapBp: number; baseGapBp: number } | null {
  const route = q.route ?? [];
  const sell = q.side === 'sell';
  const ref = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0] as RoutePool;
  const stockUnit = 10 ** ref.decAsset;
  const jupiter = Number(q.outAmount) / (sell ? 10 ** USDC_DECIMALS : stockUnit);
  let dollarsRaw = 0n;
  let stockRaw = 0n;
  for (const i of indexes) {
    const d = dollarsOfStockLeg(q, legs, i);
    const hop = route[i];
    if (d === null || !hop) return null;
    dollarsRaw += d;
    stockRaw += BigInt((sell ? hop.inAmount : hop.outAmount) as string);
  }
  const dollars = Number(dollarsRaw) / 10 ** USDC_DECIMALS;
  const stock = Number(stockRaw) / stockUnit;
  // what our router returns for an amount: dollars for a sale, tokens for a purchase, as gapOf counts them
  const ours = (notional: number) => {
    if (!(notional > 0)) return 0;
    const r = routeTrade(pools, notional, sell ? 'sell' : 'buy', chunks);
    return sell ? r.outUsd : r.outUsd / r.refMidUsd;
  };
  const whole = sell
    ? (Number(q.amountIn) / stockUnit) * ref.midUsd
    : Number(q.amountIn) / 10 ** USDC_DECIMALS;
  const rest = sell ? whole - stock * ref.midUsd : whole - dollars;
  const base = ours(whole);
  // a leg carrying the whole amount leaves nothing for the router; rounding can leave a hair below zero
  const withLegs = ours(rest > whole * 1e-9 ? rest : 0) + (sell ? dollars : stock);
  if (!(base > 0) || !(withLegs > 0)) return null;
  return {
    gapBp: (jupiter / withLegs - 1) * 10_000,
    baseGapBp: (jupiter / base - 1) * 10_000,
  };
}

/** Every class the router does not use, taken together: one more key of a pair's shares. */
export const OUTSIDE = 'outside:all';

/**
 * One compared pair as the gap account reads it: the percent of the stock amount Jupiter traded in each class of
 * pool and, for each class the router does not use, the gap with that class's legs taken as Jupiter quoted them.
 * `OUTSIDE` is every such class at once. `plainGapBp` is the pair's gap as the router report gives it; a replay
 * whose own plain gap is another number was not run on the same pools, and that throws.
 */
export function gapShareOf(
  q: StoredQuote,
  legs: readonly QuoteLeg[],
  plainGapBp: number,
  pools: readonly RoutePool[],
  keyOf: (pool: string) => string,
  routed: (key: string) => boolean,
  chunks: number,
): GapShare {
  const stockPctByClass: Record<string, number> = {};
  const legsOfClass = new Map<string, number[]>();
  legs.forEach((leg, i) => {
    if (leg.stockPct === null) return;
    const key = keyOf(leg.pool);
    stockPctByClass[key] = (stockPctByClass[key] ?? 0) + leg.stockPct;
    legsOfClass.set(key, [...(legsOfClass.get(key) ?? []), i]);
  });
  const outside = [...legsOfClass].filter(([key]) => !routed(key));
  const gapWithClassBp: Record<string, number | null> = {};
  const replay = (indexes: readonly number[]) => {
    const r = gapWithLegs(q, legs, indexes, pools, chunks);
    if (r && Math.abs(r.baseGapBp - plainGapBp) > 1e-6)
      throw new Error(`${q.asset}: the replay's plain gap is not the router report's`);
    return r ? r.gapBp : null;
  };
  for (const [key, indexes] of outside) gapWithClassBp[key] = replay(indexes);
  if (outside.length) {
    stockPctByClass[OUTSIDE] = outside.reduce((t, [key]) => t + (stockPctByClass[key] ?? 0), 0);
    gapWithClassBp[OUTSIDE] = replay(outside.flatMap(([, indexes]) => indexes));
  }
  return {
    asset: q.asset,
    side: q.side as Side,
    notionalUsd: q.notionalUsd,
    gapBp: plainGapBp,
    stockPctByClass,
    gapWithClassBp,
  };
}
