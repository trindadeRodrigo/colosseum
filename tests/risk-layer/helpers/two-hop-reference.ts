import {
  afterTransferFee,
  type RoutedTrade,
  type RouteLeg,
  type RoutePool,
  type TwoHop,
  type TwoHopPool,
  type ViaTrade,
} from '@colosseum/risk';

// PLAN-UNIVERSE RU.11 — the two-hop router a second time, written from the specification alone by someone who did not
// read the two-hop code of `routeTrade` (packages/risk/src/pools/route.ts). The differential test beside it
// (route-two-hop-reference.test.ts) holds the two against each other on frozen pools. Clarity over speed: a via
// token's own route is run again from nothing for every candidate, and nothing is carried from one chunk to the next
// but the amounts and what each group is worth. It shares with route.ts the types, the simulators' two calls and
// `afterTransferFee`; the one-hop greedy below is rewritten from the router as it stood before two hops. One rule came
// after the review, from someone who had read both: a pool whose mid is not a positive finite number is not routable.

type Side = 'sell' | 'buy';
type Costs = { poolFeeUsd: number; transferFeeUsd: number; basisUsd: number };

const uncapped = (bps: number) => ({ bps, maximumFee: Number.MAX_SAFE_INTEGER });

/** The reference pool: the largest by TVL, the earlier one on a tie. */
function largest(pools: readonly RoutePool[]): RoutePool {
  let best = pools[0] as RoutePool;
  for (const p of pools) if (p.tvlUsd > best.tvlUsd) best = p;
  return best;
}

// ---- one hop: a dollar or SOL pool ----

/** One swap on a dollar or SOL pool: `x` asset units in (sale) or `x` dollars in (purchase). */
const directSwap = (e: RoutePool, x: number, side: Side) =>
  side === 'sell'
    ? e.sim.sellAsset(Math.floor(x * 10 ** e.decAsset))
    : e.sim.buyAsset(Math.floor((x / e.quoteUsd) * 10 ** e.decQuote));

/** What that swap returns in dollars: the quote received (sale), or the asset received at the reference mid. */
function directOutUsd(e: RoutePool, x: number, side: Side, refMidUsd: number): number {
  if (x <= 0) return 0;
  const r = directSwap(e, x, side);
  return side === 'sell'
    ? (r.out / 10 ** e.decQuote) * e.quoteUsd * (1 - r.unfilledShare)
    : (r.out / 10 ** e.decAsset) * refMidUsd * (1 - r.unfilledShare);
}

/** The leg of one dollar or SOL pool holding `x`, the dollars it adds to each part of the split, the asset it bought. */
function directLeg(
  e: RoutePool,
  x: number,
  outUsd: number,
  side: Side,
  refMidUsd: number,
): Costs & { leg: RouteLeg; bought: number } {
  const r = directSwap(e, x, side);
  const filled = 1 - r.unfilledShare;
  const leg: RouteLeg = {
    pool: e.pool,
    amountIn: x,
    unfilledShare: r.unfilledShare,
    outUsd,
    midUsd: e.midUsd,
    feeRate: e.feeRate,
  };
  if (side === 'sell') {
    // the asset's transfer fee is taken before the pool; the quote's is grossed up from what arrived
    const raw = Math.floor(x * 10 ** e.decAsset);
    const feeUnits =
      (raw - afterTransferFee(raw, uncapped(e.transferFeeBps.asset))) / 10 ** e.decAsset;
    const inPool = (x - feeUnits) * filled;
    const q = e.transferFeeBps.quote / 10_000;
    return {
      leg,
      bought: 0,
      poolFeeUsd: inPool * e.midUsd * e.feeRate,
      transferFeeUsd: feeUnits * e.midUsd * filled + (q > 0 ? (outUsd * q) / (1 - q) : 0),
      basisUsd: x * filled * (refMidUsd - e.midUsd),
    };
  }
  const raw = Math.floor((x / e.quoteUsd) * 10 ** e.decQuote);
  const feeQuote =
    ((raw - afterTransferFee(raw, uncapped(e.transferFeeBps.quote))) / 10 ** e.decQuote) *
    e.quoteUsd;
  const inPool = (x - feeQuote) * filled;
  const a = e.transferFeeBps.asset / 10_000;
  return {
    leg,
    bought: (r.out / 10 ** e.decAsset) * (1 - r.unfilledShare),
    poolFeeUsd: inPool * e.feeRate,
    transferFeeUsd: feeQuote * filled + (a > 0 ? (outUsd * a) / (1 - a) : 0),
    basisUsd: x * filled * (1 - refMidUsd / e.midUsd),
  };
}

type OneHop = Costs & {
  ref: RoutePool;
  outUsd: number;
  legs: RouteLeg[];
  /** A purchase: whole tokens bought, every pool added up. Zero for a sale. */
  bought: number;
};

/**
 * The one-hop route of `total` (asset units for a sale, dollars for a purchase): cut in equal chunks, each chunk to
 * the pool that returns the most for it on top of what it already holds; the earlier pool keeps a tie.
 */
function oneHop(pools: readonly RoutePool[], total: number, side: Side, chunks: number): OneHop {
  const ref = largest(pools);
  if (total <= 0)
    return { ref, outUsd: 0, legs: [], bought: 0, poolFeeUsd: 0, transferFeeUsd: 0, basisUsd: 0 };
  const chunk = total / chunks;
  const alloc = pools.map(() => 0);
  const cur = pools.map(() => 0);
  for (let k = 0; k < chunks; k++) {
    let best = 0;
    let bestGain = Number.NEGATIVE_INFINITY;
    pools.forEach((e, i) => {
      const gain =
        directOutUsd(e, (alloc[i] as number) + chunk, side, ref.midUsd) - (cur[i] as number);
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    });
    alloc[best] = (alloc[best] as number) + chunk;
    cur[best] = directOutUsd(pools[best] as RoutePool, alloc[best] as number, side, ref.midUsd);
  }
  const route: OneHop = {
    ref,
    outUsd: cur.reduce((t, v) => t + v, 0),
    legs: [],
    bought: 0,
    poolFeeUsd: 0,
    transferFeeUsd: 0,
    basisUsd: 0,
  };
  pools.forEach((e, i) => {
    const x = alloc[i] as number;
    if (!(x > 0)) return;
    const d = directLeg(e, x, cur[i] as number, side, ref.midUsd);
    route.legs.push(d.leg);
    route.bought += d.bought;
    route.poolFeeUsd += d.poolFeeUsd;
    route.transferFeeUsd += d.transferFeeUsd;
    route.basisUsd += d.basisUsd;
  });
  return route;
}

// ---- two hops: a pool that pairs the asset with another stock, then that stock's own pools ----

/**
 * One swap through a two-hop pool, in whole tokens with the unfilled part taken off. Sale: `amount` of the asset in,
 * via tokens out. Purchase: `amount` of the via token in, the asset out.
 */
function hopSwap(
  p: TwoHopPool,
  amount: number,
  side: Side,
): { out: number; unfilledShare: number } {
  if (amount <= 0) return { out: 0, unfilledShare: 0 };
  if (side === 'sell') {
    const raw = Math.floor(amount * 10 ** p.decAsset);
    const r = p.assetIsSimAsset ? p.sim.sellAsset(raw) : p.sim.buyAsset(raw);
    return {
      out: (r.out / 10 ** p.decVia) * (1 - r.unfilledShare),
      unfilledShare: r.unfilledShare,
    };
  }
  const raw = Math.floor(amount * 10 ** p.decVia);
  const r = p.assetIsSimAsset ? p.sim.buyAsset(raw) : p.sim.sellAsset(raw);
  return {
    out: (r.out / 10 ** p.decAsset) * (1 - r.unfilledShare),
    unfilledShare: r.unfilledShare,
  };
}

/** The pool's mid: via tokens per asset token, whole tokens. */
const viaPerAsset = (p: TwoHopPool) =>
  (p.assetIsSimAsset ? p.sim.midRaw : 1 / p.sim.midRaw) * 10 ** (p.decAsset - p.decVia);

/** Every two-hop pool with the same via token, and what each one holds: asset units (sale) or dollars (purchase). */
type Group = {
  via: string;
  viaPools: readonly RoutePool[];
  pools: TwoHopPool[];
  amounts: number[];
};

type GroupValue = {
  /** What the group returns in dollars: the via tokens sold (sale), or the asset bought at the reference mid. */
  usd: number;
  /** Via tokens sold (sale) or bought (purchase) on the via token's own pools, once for the whole group. */
  viaAmount: number;
  trade: OneHop;
  /** Per pool: the via tokens it paid out (sale) or took in (purchase), its own unfilled share, its dollars. */
  perPool: Array<{ viaAmount: number; unfilledShare: number; outUsd: number }>;
};

const sum = (xs: readonly number[]) => xs.reduce((t, v) => t + v, 0);

/** What a group returns when its pools hold `amounts`: every pool's swap, and the one trade on the via token. */
function groupValue(
  g: Group,
  amounts: readonly number[],
  side: Side,
  chunks: number,
  refMidUsd: number,
): GroupValue {
  if (side === 'sell') {
    // each pool turns its asset into via tokens; the via tokens are added and sold once
    const swaps = g.pools.map((p, j) => hopSwap(p, amounts[j] as number, 'sell'));
    const viaAmount = sum(swaps.map((s) => s.out));
    const trade = oneHop(g.viaPools, viaAmount, 'sell', chunks);
    return {
      usd: trade.outUsd,
      viaAmount,
      trade,
      perPool: swaps.map((s) => ({
        viaAmount: s.out,
        unfilledShare: s.unfilledShare,
        outUsd: viaAmount > 0 ? (trade.outUsd * s.out) / viaAmount : 0,
      })),
    };
  }
  // the group's dollars buy via tokens once; each pool receives them in proportion to its dollars
  const spent = sum(amounts);
  const trade = oneHop(g.viaPools, spent, 'buy', chunks);
  const perPool = g.pools.map((p, j) => {
    const viaIn = spent > 0 ? (trade.bought * (amounts[j] as number)) / spent : 0;
    const s = hopSwap(p, viaIn, 'buy');
    return { viaAmount: viaIn, unfilledShare: s.unfilledShare, outUsd: s.out * refMidUsd };
  });
  return { usd: sum(perPool.map((x) => x.outUsd)), viaAmount: trade.bought, trade, perPool };
}

/** `routeTrade` from the specification: one hop when `twoHop` is absent or holds nothing routable. */
export function referenceRoute(
  pools: readonly RoutePool[],
  notionalUsd: number,
  side: Side,
  chunks: number,
  twoHop?: TwoHop,
): RoutedTrade {
  if (!pools.length) throw new Error('referenceRoute: no pools');
  const ref = largest(pools);
  const total = side === 'sell' ? notionalUsd / ref.midUsd : notionalUsd;
  const chunk = total / chunks;
  const alloc = pools.map(() => 0);
  const cur = pools.map(() => 0);

  // the routable two-hop pools in input order, each with its group and its place in it: a pool is routable when its
  // via token has pools of its own and its own mid can value a leg
  const groups: Group[] = [];
  const hops: Array<{ pool: TwoHopPool; group: Group; slot: number }> = [];
  for (const pool of twoHop?.pools ?? []) {
    const viaPools = twoHop?.via.get(pool.via);
    if (!viaPools || viaPools.length === 0) continue;
    // nor is a pool routable whose mid, in via tokens per asset token, is not a positive finite number
    const mid = viaPerAsset(pool);
    if (!Number.isFinite(mid) || mid <= 0) continue;
    let group = groups.find((g) => g.via === pool.via);
    if (!group) {
      group = { via: pool.via, viaPools, pools: [], amounts: [] };
      groups.push(group);
    }
    hops.push({ pool, group, slot: group.pools.length });
    group.pools.push(pool);
    group.amounts.push(0);
  }
  // what each group is worth with the amounts it holds now
  const worth = (g: Group, amounts: readonly number[]) =>
    groupValue(g, amounts, side, chunks, ref.midUsd);
  const now = new Map(groups.map((g) => [g, worth(g, g.amounts)]));
  const valueNow = (g: Group) => now.get(g) as GroupValue;

  for (let k = 0; k < chunks; k++) {
    let bestGain = Number.NEGATIVE_INFINITY;
    let bestDirect = 0;
    let bestHop = -1; // −1: a dollar or SOL pool takes the chunk
    pools.forEach((e, i) => {
      const gain =
        directOutUsd(e, (alloc[i] as number) + chunk, side, ref.midUsd) - (cur[i] as number);
      if (gain > bestGain) {
        bestGain = gain;
        bestDirect = i;
      }
    });
    hops.forEach(({ group, slot }, h) => {
      const trial = group.amounts.map((a, s) => (s === slot ? a + chunk : a));
      const gain = worth(group, trial).usd - valueNow(group).usd;
      if (gain > bestGain) {
        bestGain = gain;
        bestHop = h;
      }
    });
    const hop = hops[bestHop];
    if (hop) {
      hop.group.amounts[hop.slot] = (hop.group.amounts[hop.slot] as number) + chunk;
      now.set(hop.group, worth(hop.group, hop.group.amounts));
    } else {
      alloc[bestDirect] = (alloc[bestDirect] as number) + chunk;
      cur[bestDirect] = directOutUsd(
        pools[bestDirect] as RoutePool,
        alloc[bestDirect] as number,
        side,
        ref.midUsd,
      );
    }
  }

  const outUsd = cur.reduce((t, v) => t + v, 0) + sum(groups.map((g) => valueNow(g).usd));
  const legs: RouteLeg[] = [];
  let poolFeeUsd = 0;
  let transferFeeUsd = 0;
  let basisUsd = 0;
  pools.forEach((e, i) => {
    const x = alloc[i] as number;
    if (!(x > 0)) return;
    const d = directLeg(e, x, cur[i] as number, side, ref.midUsd);
    legs.push(d.leg);
    poolFeeUsd += d.poolFeeUsd;
    transferFeeUsd += d.transferFeeUsd;
    basisUsd += d.basisUsd;
  });

  const viaTrades: ViaTrade[] = [];
  const traded = new Set<Group>();
  let hopsUsed = 0;
  for (const { pool: p, group, slot } of hops) {
    const amount = group.amounts[slot] as number;
    if (!(amount > 0)) continue;
    hopsUsed++;
    traded.add(group); // a Set keeps the order of first use
    const mine = valueNow(group).perPool[slot] as GroupValue['perPool'][number];
    const viaRefMidUsd = valueNow(group).trade.ref.midUsd;
    const midUsd = viaPerAsset(p) * viaRefMidUsd;
    const filled = 1 - mine.unfilledShare;
    legs.push({
      pool: p.pool,
      amountIn: amount,
      unfilledShare: mine.unfilledShare,
      outUsd: mine.outUsd,
      midUsd,
      feeRate: p.feeRate,
      via: { mint: p.via, amount: mine.viaAmount },
    });
    if (side === 'sell') {
      const raw = Math.floor(amount * 10 ** p.decAsset);
      const feeUnits =
        (raw - afterTransferFee(raw, uncapped(p.transferFeeBps.asset))) / 10 ** p.decAsset;
      const inPool = (amount - feeUnits) * filled;
      poolFeeUsd += inPool * midUsd * p.feeRate;
      // the via token's transfer fee, grossed up from the via tokens that arrived
      const q = p.transferFeeBps.via / 10_000;
      transferFeeUsd +=
        feeUnits * midUsd * filled + (q > 0 ? (mine.viaAmount * viaRefMidUsd * q) / (1 - q) : 0);
      basisUsd += amount * filled * (ref.midUsd - midUsd);
    } else {
      const viaIn = mine.viaAmount;
      const raw = Math.floor(viaIn * 10 ** p.decVia);
      const feeVia = (raw - afterTransferFee(raw, uncapped(p.transferFeeBps.via))) / 10 ** p.decVia;
      poolFeeUsd += (viaIn - feeVia) * viaRefMidUsd * filled * p.feeRate;
      const a = p.transferFeeBps.asset / 10_000;
      transferFeeUsd += feeVia * viaRefMidUsd * filled + (a > 0 ? (mine.outUsd * a) / (1 - a) : 0);
      basisUsd += viaIn * viaRefMidUsd * filled * (1 - ref.midUsd / midUsd);
    }
  }
  for (const g of traded) {
    const { trade, viaAmount, usd } = valueNow(g);
    const spent = sum(g.amounts);
    viaTrades.push({
      via: g.via,
      amount: viaAmount,
      usd: side === 'sell' ? usd : spent,
      refPool: trade.ref.pool,
      refMidUsd: trade.ref.midUsd,
      legs: trade.legs,
    });
    // the via trade's own split is in fractions of its own notional: back to dollars
    const own = side === 'sell' ? viaAmount * trade.ref.midUsd : spent;
    if (own > 0) {
      poolFeeUsd += (trade.poolFeeUsd / own) * own;
      transferFeeUsd += (trade.transferFeeUsd / own) * own;
      basisUsd += (trade.basisUsd / own) * own;
    }
  }

  const costTotal = 1 - outUsd / notionalUsd;
  const poolFee = poolFeeUsd / notionalUsd;
  const transferFee = transferFeeUsd / notionalUsd;
  const basis = basisUsd / notionalUsd;
  const routed: RoutedTrade = {
    side,
    notionalUsd,
    outUsd,
    costPct: costTotal * 100,
    poolsUsed: alloc.filter((a) => a > 0).length + hopsUsed,
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
  if (viaTrades.length) routed.viaTrades = viaTrades;
  return routed;
}
