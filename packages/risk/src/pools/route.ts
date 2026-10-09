import { afterTransferFee } from './raydium-cpmm';
import type { PoolSim } from './simulate';

/**
 * The routed sale and purchase of one asset across its dollar and SOL exit pools (PLAN-ANALYTICS item 3): the greedy
 * split the pool collector uses (`writeRoutedCurves` in scripts/risk/collector/pools.ts, which keeps its own copy until
 * Oct 12), as a pure function. It returns what the collector's rows lack: the amount sent to each pool, and the cost
 * split of §5 (pool fee, transfer fee, basis against the reference pool, and impact as the rest), so the four parts
 * sum to the total exactly. Given a `TwoHop`, the same greedy also weighs the pools that pair the asset with another
 * stock token (PLAN-UNIVERSE RU.11); without one, or with none of its pools routable, the result is the one-hop
 * route, bit for bit.
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

/**
 * A pool that pairs the asset with another stock token, the "via" token: one hop of a two-hop route (PLAN-UNIVERSE
 * RU.11). A sale goes asset → via through this pool, then via → dollars through the via token's own pools; a
 * purchase goes dollars → via, then via → asset through this pool.
 */
export type TwoHopPool = {
  pool: string;
  /** The pool's simulator as the registry files it: `sim.sellAsset` sells the stock the pool is filed under. */
  sim: PoolSim;
  /** True when the traded asset is the sim's asset side; false when it is the sim's quote side. */
  assetIsSimAsset: boolean;
  /** Mint of the other stock: what a sale receives from this pool and a purchase pays into it. */
  via: string;
  decAsset: number;
  decVia: number;
  tvlUsd: number;
  /** Pool fee rate as a fraction at this snapshot. */
  feeRate: number;
  /** Token-2022 transfer fees on the asset and via legs, basis points. */
  transferFeeBps: { asset: number; via: number };
};

/**
 * What `routeTrade` needs to route through two hops. Absent, the route is the one-hop route and nothing else.
 * `pools` are distinct, one entry per pool address: the same pool listed twice would be routed as two pools. A
 * pool's via is never the traded asset. `via` holds, per via mint, that token's own dollar and SOL pools from the
 * same snapshot: the caller decides which tokens may be a via (a tracked stock) and passes no entry for the others.
 * A pool whose via has no entry, or an empty one, is left out of the route; the caller lists it. So is a pool whose
 * mid, in via tokens per asset token, is not a positive finite number: its legs could not be valued.
 */
export type TwoHop = {
  pools: readonly TwoHopPool[];
  via: ReadonlyMap<string, readonly RoutePool[]>;
};

export type RouteLeg = {
  pool: string;
  /** Sent to the pool: asset units for a sale, USD for a purchase. */
  amountIn: number;
  /** Share of `amountIn` the pool could not fill. */
  unfilledShare: number;
  outUsd: number;
  midUsd: number;
  feeRate: number;
  /**
   * On a two-hop leg only: the via token, and the whole tokens of it this pool paid out (sale) or took in (purchase).
   * `amountIn` is then the asset units sent to this pool (sale) or the USD sent down this route (purchase), `outUsd`
   * this leg's dollars (sale: its share, by via amount, of what the via tokens sold for; purchase: the asset it
   * returned at the reference mid), `midUsd` the pool's mid in via tokens valued at the via token's reference mid.
   * The amount is counted after the unfilled share, as everywhere in the router (a pool's output times
   * (1 − unfilledShare)): on a sale what this pool paid, on a purchase its share of what the via token's pools paid.
   */
  via?: { mint: string; amount: number };
};

/** The trade on one via token's own pools: every two-hop leg that pays or takes that token goes through it once. */
export type ViaTrade = {
  via: string;
  /**
   * Whole via tokens sold for dollars (sale) or bought with dollars (purchase): the sum over the two-hop legs.
   * Counted after the unfilled share, as everywhere in the router: the output of each pool that paid them times
   * (1 − unfilledShare).
   */
  amount: number;
  /** Dollars received for them (sale) or paid for them (purchase). */
  usd: number;
  refPool: string;
  refMidUsd: number;
  /** The via token's pools, as the legs of a one-hop route: `amountIn` in via tokens (sale) or USD (purchase). */
  legs: RouteLeg[];
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
  /** Present only when at least one two-hop leg carries an amount: one entry per via token used. */
  viaTrades?: ViaTrade[];
};

const tf = (bps: number) => ({ bps, maximumFee: Number.MAX_SAFE_INTEGER });

type Side = 'sell' | 'buy';

/** The reference pool is the largest by TVL; ties keep the input order (the collector's stable sort). */
const largest = (pools: readonly RoutePool[]) =>
  [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd)[0] as RoutePool;

const run = (e: RoutePool, x: number, side: Side) =>
  side === 'sell'
    ? e.sim.sellAsset(Math.floor(x * 10 ** e.decAsset))
    : e.sim.buyAsset(Math.floor((x / e.quoteUsd) * 10 ** e.decQuote));

/** Dollars one pool returns for `x`: asset units sold, or USD spent with the asset valued at `refMidUsd`. */
const outAt = (e: RoutePool, x: number, side: Side, refMidUsd: number) => {
  if (x <= 0) return 0;
  const r = run(e, x, side);
  return side === 'sell'
    ? (r.out / 10 ** e.decQuote) * e.quoteUsd * (1 - r.unfilledShare)
    : (r.out / 10 ** e.decAsset) * refMidUsd * (1 - r.unfilledShare);
};

/** What competes with the direct pools for each chunk: asked what the chunk would add, told when it wins it. */
type Candidates = {
  count: number;
  gain: (j: number, chunk: number) => number;
  take: (j: number, chunk: number) => void;
};

/**
 * The greedy split: `total` (asset units for a sale, USD for a purchase) cut in `chunks` equal chunks, each sent where
 * it adds the most dollars. The earlier pool keeps a tie, and a direct pool keeps one against any candidate.
 */
function greedy(
  pools: readonly RoutePool[],
  refMidUsd: number,
  total: number,
  side: Side,
  chunks: number,
  extra?: Candidates,
): { alloc: number[]; cur: number[] } {
  const chunk = total / chunks;
  const alloc = pools.map(() => 0);
  const cur = pools.map(() => 0);
  for (let k = 0; k < chunks; k++) {
    let bi = 0;
    let bGain = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pools.length; i++) {
      const g =
        outAt(pools[i] as RoutePool, (alloc[i] as number) + chunk, side, refMidUsd) -
        (cur[i] as number);
      if (g > bGain) {
        bGain = g;
        bi = i;
      }
    }
    let bj = -1;
    if (extra)
      for (let j = 0; j < extra.count; j++) {
        const g = extra.gain(j, chunk);
        if (g > bGain) {
          bGain = g;
          bj = j;
        }
      }
    if (extra && bj >= 0) {
      extra.take(bj, chunk);
      continue;
    }
    alloc[bi] = (alloc[bi] as number) + chunk;
    cur[bi] = outAt(pools[bi] as RoutePool, alloc[bi] as number, side, refMidUsd);
  }
  return { alloc, cur };
}

/** The legs of the pools that carry an amount, with their fee and basis dollars against `ref`. */
function legsOf(
  pools: readonly RoutePool[],
  ref: RoutePool,
  alloc: readonly number[],
  cur: readonly number[],
  side: Side,
) {
  const legs: RouteLeg[] = [];
  let poolFeeUsd = 0;
  let transferFeeUsd = 0;
  let basisUsd = 0;
  pools.forEach((e, i) => {
    const x = alloc[i] as number;
    if (!(x > 0)) return;
    const r = run(e, x, side);
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
  return { legs, poolFeeUsd, transferFeeUsd, basisUsd };
}

/**
 * One swap through a two-hop pool, in whole tokens: a sale sends `amount` of the asset in and gets the via token out,
 * a purchase sends `amount` of the via token in and gets the asset out. `out` already counts what the pool left
 * unfilled the way the router counts it everywhere: the output times (1 − unfilledShare).
 */
export function twoHopSwap(
  p: TwoHopPool,
  amount: number,
  side: 'sell' | 'buy',
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

/** Whole via tokens per whole asset token at a two-hop pool's mid. */
const viaPerAsset = (p: TwoHopPool) => {
  const raw = p.assetIsSimAsset ? p.sim.midRaw : p.sim.midRaw > 0 ? 1 / p.sim.midRaw : 0;
  return raw * 10 ** (p.decAsset - p.decVia);
};

/** A via token's own one-hop route: `total` via tokens sold for `out` USD, or `total` USD spent on `out` via tokens. */
type ViaRun = { total: number; alloc: number[]; cur: number[]; out: number };

/** A via token's group at one set of amounts to its two-hop pools. */
type GroupAt = {
  /** The group's dollars: what its via tokens sell for, or the asset its pools return at the reference mid. */
  usd: number;
  /** Whole via tokens through the via trade: the sum of what the pools paid out, or what the dollars bought. */
  viaAmount: number;
  /** Per pool: the via tokens out of it (sale) or into it (purchase), its unfilled share, and its dollars. */
  via: number[];
  unfilled: number[];
  out: number[];
  run: ViaRun | null;
};

/** The two-hop pools that pay or take one via token, and that token's own pools, where it is traded once. */
type Group = {
  via: string;
  pools: readonly RoutePool[];
  ref: RoutePool;
  /** Positions of its pools among the routable two-hop pools, in input order. */
  members: number[];
  at: GroupAt;
  /** The via trade by amount: the greedy is deterministic, so one amount is routed once. */
  runs: Map<number, ViaRun>;
};

/**
 * The two-hop side of one trade: the routable pools as candidates for the greedy, and what they carried once it is
 * done. A pool is routable when its via token has pools of its own and its mid is a positive finite number. Null
 * when no pool is routable.
 */
function twoHopRoutes(twoHop: TwoHop, ref: RoutePool, side: Side, chunks: number) {
  const hops: TwoHopPool[] = [];
  const groupOf: Group[] = [];
  const groups = new Map<string, Group>();
  for (const p of twoHop.pools) {
    const viaPools = twoHop.via.get(p.via);
    if (!viaPools?.length) continue;
    // a pool with no usable mid is left out the same way: a zero mid would divide a purchase's basis
    const mid = viaPerAsset(p);
    if (!(mid > 0 && Number.isFinite(mid))) continue;
    let g = groups.get(p.via);
    if (!g) {
      g = {
        via: p.via,
        pools: viaPools,
        ref: largest(viaPools),
        members: [],
        at: { usd: 0, viaAmount: 0, via: [], unfilled: [], out: [], run: null },
        runs: new Map(),
      };
      groups.set(p.via, g);
    }
    g.members.push(hops.length);
    g.at.via.push(0);
    g.at.unfilled.push(0);
    g.at.out.push(0);
    hops.push(p);
    groupOf.push(g);
  }
  if (!hops.length) return null;
  const alloc = hops.map(() => 0);
  // what each group would be with the next chunk sent to pool j; kept until a pool of the group takes a chunk
  const next: Array<GroupAt | null> = hops.map(() => null);

  const viaRun = (g: Group, total: number): ViaRun | null => {
    if (!(total > 0)) return null;
    let r = g.runs.get(total);
    if (!r) {
      const { alloc: a, cur } = greedy(g.pools, g.ref.midUsd, total, side, chunks);
      const out =
        side === 'sell'
          ? cur.reduce((t, v) => t + v, 0)
          : g.pools.reduce((t, e, i) => {
              const x = a[i] as number;
              if (!(x > 0)) return t;
              const s = run(e, x, side);
              return t + (s.out / 10 ** e.decAsset) * (1 - s.unfilledShare);
            }, 0);
      r = { total, alloc: a, cur, out };
      g.runs.set(total, r);
    }
    return r;
  };

  const withChunk = (g: Group, j: number, chunk: number): GroupAt => {
    if (side === 'sell') {
      // only pool j's swap changes; the via tokens of every pool of the group are added and sold once
      const pos = g.members.indexOf(j);
      const s = twoHopSwap(hops[j] as TwoHopPool, (alloc[j] as number) + chunk, side);
      const via = g.at.via.map((v, i) => (i === pos ? s.out : v));
      const unfilled = g.at.unfilled.map((u, i) => (i === pos ? s.unfilledShare : u));
      const viaAmount = via.reduce((t, v) => t + v, 0);
      const r = viaRun(g, viaAmount);
      const usd = r ? r.out : 0;
      // a pool's dollars are its share, by via amount, of what the via tokens sold for
      const out = via.map((v) => (viaAmount > 0 ? (usd * v) / viaAmount : 0));
      return { usd, viaAmount, via, unfilled, out, run: r };
    }
    // the dollars of the group buy the via token once; each pool gets its share of it, by dollars
    const usdIn = g.members.map((m) => (alloc[m] as number) + (m === j ? chunk : 0));
    const total = usdIn.reduce((t, v) => t + v, 0);
    const r = viaRun(g, total);
    const viaAmount = r ? r.out : 0;
    const via = usdIn.map((a) => (total > 0 ? (viaAmount * a) / total : 0));
    const swaps = g.members.map((m, i) =>
      twoHopSwap(hops[m] as TwoHopPool, via[i] as number, side),
    );
    const out = swaps.map((s) => s.out * ref.midUsd);
    return {
      usd: out.reduce((t, v) => t + v, 0),
      viaAmount,
      via,
      unfilled: swaps.map((s) => s.unfilledShare),
      out,
      run: r,
    };
  };

  const candidates: Candidates = {
    count: hops.length,
    gain: (j, chunk) => {
      const g = groupOf[j] as Group;
      if (!next[j]) next[j] = withChunk(g, j, chunk);
      return (next[j] as GroupAt).usd - g.at.usd;
    },
    take: (j, chunk) => {
      const g = groupOf[j] as Group;
      g.at = next[j] ?? withChunk(g, j, chunk);
      alloc[j] = (alloc[j] as number) + chunk;
      for (const m of g.members) next[m] = null;
    },
  };

  /** The two-hop legs and via trades with their fee and basis dollars; null when no two-hop pool took a chunk. */
  const result = () => {
    const legs: RouteLeg[] = [];
    const used: Group[] = [];
    let poolFeeUsd = 0;
    let transferFeeUsd = 0;
    let basisUsd = 0;
    hops.forEach((p, j) => {
      const x = alloc[j] as number;
      if (!(x > 0)) return;
      const g = groupOf[j] as Group;
      const pos = g.members.indexOf(j);
      const viaAmount = g.at.via[pos] as number;
      const unfilledShare = g.at.unfilled[pos] as number;
      const legUsd = g.at.out[pos] as number;
      const filled = 1 - unfilledShare;
      const viaMidUsd = g.ref.midUsd;
      const midUsd = viaPerAsset(p) * viaMidUsd;
      if (!used.includes(g)) used.push(g);
      legs.push({
        pool: p.pool,
        amountIn: x,
        unfilledShare,
        outUsd: legUsd,
        midUsd,
        feeRate: p.feeRate,
        via: { mint: p.via, amount: viaAmount },
      });
      if (side === 'sell') {
        // as a direct sale, with the via token in the quote's place, valued at its reference mid
        const raw = Math.floor(x * 10 ** p.decAsset);
        const feeUnits =
          (raw - afterTransferFee(raw, tf(p.transferFeeBps.asset))) / 10 ** p.decAsset;
        const inPool = (x - feeUnits) * filled;
        poolFeeUsd += inPool * midUsd * p.feeRate;
        const q = p.transferFeeBps.via / 10_000;
        transferFeeUsd +=
          feeUnits * midUsd * filled + (q > 0 ? (viaAmount * viaMidUsd * q) / (1 - q) : 0);
        basisUsd += x * filled * (ref.midUsd - midUsd);
      } else {
        // as a direct purchase paid in the via token, which is valued at its reference mid
        const raw = Math.floor(viaAmount * 10 ** p.decVia);
        const feeVia = (raw - afterTransferFee(raw, tf(p.transferFeeBps.via))) / 10 ** p.decVia;
        poolFeeUsd += (viaAmount - feeVia) * viaMidUsd * filled * p.feeRate;
        const a = p.transferFeeBps.asset / 10_000;
        transferFeeUsd += feeVia * viaMidUsd * filled + (a > 0 ? (legUsd * a) / (1 - a) : 0);
        basisUsd += viaAmount * viaMidUsd * filled * (1 - ref.midUsd / midUsd);
      }
    });
    if (!legs.length) return null;
    // each via token's own trade, with the fee and basis dollars of its one-hop route
    let outUsd = 0;
    const viaTrades: ViaTrade[] = used.map((g) => {
      const r = g.at.run;
      const d = r ? legsOf(g.pools, g.ref, r.alloc, r.cur, side) : null;
      outUsd += g.at.usd;
      poolFeeUsd += d ? d.poolFeeUsd : 0;
      transferFeeUsd += d ? d.transferFeeUsd : 0;
      basisUsd += d ? d.basisUsd : 0;
      return {
        via: g.via,
        amount: g.at.viaAmount,
        usd: side === 'sell' ? g.at.usd : r ? r.total : 0,
        refPool: g.ref.pool,
        refMidUsd: g.ref.midUsd,
        legs: d ? d.legs : [],
      };
    });
    return { legs, viaTrades, outUsd, poolFeeUsd, transferFeeUsd, basisUsd };
  };

  return { candidates, result };
}

/**
 * One sale (`side: 'sell'`, `notionalUsd` of asset at the reference mid) or purchase (`notionalUsd` USD in). With
 * `twoHop`, each chunk may also go asset → via token → dollars (a purchase: dollars → via token → asset) through a
 * routable pool of it (`TwoHop` says which are). Every pool that pays or takes one via token shares one trade on that
 * token's pools, so its impact is charged on the combined amount. A two-hop pool wins a chunk only when it adds
 * strictly more than every direct pool. The reference stays the largest direct pool, so `pools` may not be empty.
 */
export function routeTrade(
  pools: readonly RoutePool[],
  notionalUsd: number,
  side: 'sell' | 'buy',
  chunks = ROUTE_CHUNKS,
  twoHop?: TwoHop,
): RoutedTrade {
  if (!pools.length) throw new Error('routeTrade: no pools');
  const ref = largest(pools);
  const total = side === 'sell' ? notionalUsd / ref.midUsd : notionalUsd;
  const hops = twoHop ? twoHopRoutes(twoHop, ref, side, chunks) : null;
  const { alloc, cur } = greedy(pools, ref.midUsd, total, side, chunks, hops?.candidates);
  const direct = legsOf(pools, ref, alloc, cur, side);
  const viaLegs = hops ? hops.result() : null;
  let outUsd = cur.reduce((t, v) => t + v, 0);
  let { poolFeeUsd, transferFeeUsd, basisUsd } = direct;
  const legs = direct.legs;
  let poolsUsed = alloc.filter((a) => a > 0).length;
  if (viaLegs) {
    outUsd += viaLegs.outUsd;
    poolFeeUsd += viaLegs.poolFeeUsd;
    transferFeeUsd += viaLegs.transferFeeUsd;
    basisUsd += viaLegs.basisUsd;
    legs.push(...viaLegs.legs);
    poolsUsed += viaLegs.legs.length;
  }
  const costTotal = 1 - outUsd / notionalUsd;
  const poolFee = poolFeeUsd / notionalUsd;
  const transferFee = transferFeeUsd / notionalUsd;
  const basis = basisUsd / notionalUsd;
  return {
    side,
    notionalUsd,
    outUsd,
    costPct: costTotal * 100,
    poolsUsed,
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
    ...(viaLegs ? { viaTrades: viaLegs.viaTrades } : {}),
  };
}
