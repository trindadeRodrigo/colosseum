import {
  afterTransferFee,
  buildPoolSim,
  decodeClmmPool,
  type PoolSim,
  ROUTE_CHUNKS,
  type RoutedTrade,
  type RouteLeg,
  type RoutePool,
  routeTrade,
  type TwoHop,
  type TwoHopPool,
  twoHopSwap,
  usdCurves,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import { captureBytes, loadCapture } from '../../scripts/risk/lib-split';

// PLAN-UNIVERSE RU.11 — the router with two hops (stock → another stock → dollars). On real mainnet accounts frozen
// 2026-10-06T21:21:16Z by `pnpm risk:split-capture --two-hop --only QQQx` (fixtures/risk/route): the dollar and SOL
// pools of QQQx, SPYx and AMZNx, and the six pools that pair two of them. Every simulator is built here from the
// account bytes with buildPoolSim, the way scripts/risk/split-snapshot.ts builds them, and the SOL price is the one
// frozen in the file, so no price enters from outside the fixture and nothing calls the network. Two rules have no
// case in the fixture, a pool with no usable mid and a tie between the two paths: those two tests run on made-up
// pools (`stubSim`) and say so.
const cap = loadCapture('fixtures/risk/route/qqqx-two-hop-20261006T2121.json.gz');
type Row = (typeof cap.direct)[number];
// the dollar stablecoins, as the snapshot tells them from SOL (mints, not prices)
const USD_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const SOL = 'So11111111111111111111111111111111111111112';
const solUsd = cap.solUsd as number;

const build = (row: Row) => {
  const head = captureBytes(cap, row.address);
  if (!head) throw new Error(`${row.address}: not in the fixture`);
  const cfg =
    row.venue === 'raydium_clmm' ? captureBytes(cap, decodeClmmPool(head).ammConfig) : undefined;
  const kids = (cap.children[row.address] ?? [])
    .map((k) => captureBytes(cap, k))
    .filter((d): d is Uint8Array => !!d);
  return buildPoolSim(row, head, kids, cfg);
};
// the registry files a pool under one of its two tokens (its "asset"); the other is its quote
const filed = (row: Row) => ({
  decAsset: row.assetIsToken0 ? row.decimals0 : row.decimals1,
  decQuote: row.assetIsToken0 ? row.decimals1 : row.decimals0,
  feeAsset: row.assetIsToken0 ? row.transferFeeBps0 : row.transferFeeBps1,
  feeQuote: row.assetIsToken0 ? row.transferFeeBps1 : row.transferFeeBps0,
});

// each stock's dollar and SOL pools, in registry order
const direct = new Map<string, RoutePool[]>();
for (const row of cap.direct) {
  if (!USD_MINTS.has(row.quoteMint) && row.quoteMint !== SOL)
    throw new Error(`${row.address}: quote ${row.quoteMint} is neither a dollar nor SOL`);
  const quoteUsd = USD_MINTS.has(row.quoteMint) ? 1 : solUsd;
  const built = build(row);
  const f = filed(row);
  const midUsd = usdCurves(built.sim, f.decAsset, f.decQuote, quoteUsd, [100]).midUsd;
  if (!(midUsd > 0)) continue;
  direct.set(row.assetMint, [
    ...(direct.get(row.assetMint) ?? []),
    {
      pool: row.address,
      sim: built.sim,
      decAsset: f.decAsset,
      decQuote: f.decQuote,
      quoteUsd,
      midUsd,
      tvlUsd: row.tvlUsd,
      feeRate: built.feeRate,
      transferFeeBps: { asset: f.feeAsset, quote: f.feeQuote },
    },
  ]);
}
const mintOf = (symbol: string) =>
  (cap.direct.find((r) => r.assetSymbol === symbol) as Row).assetMint;
const QQQX = mintOf('QQQx');
const SPYX = mintOf('SPYx');
const AMZNX = mintOf('AMZNx');
const ASSETS = [
  ['QQQx', QQQX],
  ['SPYx', SPYX],
  ['AMZNx', AMZNX],
] as const;
const poolsOf = (mint: string) => direct.get(mint) as RoutePool[];

// the six stock-to-stock pools; one is a two-hop pool for either of its tokens
const stockPairs = cap.twoHopPools.map((row) => ({ row, built: build(row) }));
const hopPool = (
  { row, built }: (typeof stockPairs)[number],
  assetIsSimAsset: boolean,
): TwoHopPool => {
  const f = filed(row);
  return {
    pool: row.address,
    sim: built.sim,
    assetIsSimAsset,
    via: assetIsSimAsset ? row.quoteMint : row.assetMint,
    decAsset: assetIsSimAsset ? f.decAsset : f.decQuote,
    decVia: assetIsSimAsset ? f.decQuote : f.decAsset,
    tvlUsd: row.tvlUsd,
    feeRate: built.feeRate,
    transferFeeBps: {
      asset: assetIsSimAsset ? f.feeAsset : f.feeQuote,
      via: assetIsSimAsset ? f.feeQuote : f.feeAsset,
    },
  };
};
/** What the caller passes for one stock: its stock-to-stock pools, and the own pools of each tracked via token. */
const twoHopOf = (mint: string): TwoHop => {
  const pools = stockPairs
    .filter(({ row }) => row.assetMint === mint || row.quoteMint === mint)
    .map((sp) => hopPool(sp, sp.row.assetMint === mint));
  const via = new Map<string, RoutePool[]>();
  for (const p of pools)
    if (cap.tracked.includes(p.via) && direct.has(p.via)) via.set(p.via, poolsOf(p.via));
  return { pools, via };
};

const GRID = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const SIDES = ['sell', 'buy'] as const;
type Side = (typeof SIDES)[number];
/** Relative difference; 0 when the two are the same number. */
const rel = (a: number, b: number) =>
  a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
const TOL = 1e-12;
const sum = (xs: number[]) => xs.reduce((t, v) => t + v, 0);
const largest = (ps: readonly RoutePool[]) =>
  ps.reduce((best, p) => (p.tvlUsd > best.tvlUsd ? p : best));
const smallest = (ps: readonly RoutePool[]) =>
  ps.reduce((best, p) => (p.tvlUsd < best.tvlUsd ? p : best));
const hopLegs = (r: RoutedTrade) =>
  r.legs.filter((l): l is RouteLeg & { via: NonNullable<RouteLeg['via']> } => !!l.via);
const on = (pools: readonly RoutePool[], n: number, side: Side, th: TwoHop) =>
  routeTrade(pools, n, side, ROUTE_CHUNKS, th);
/** Every number anywhere in a route. */
const figures = (v: unknown): number[] =>
  typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(figures) : [];
/**
 * A made-up simulator with no fee and no limit: `pays` raw units out for each raw unit in, either way. Its mid is
 * whatever the test says, apart from what it pays.
 */
const stubSim = (midRaw: number, pays = 1): PoolSim => ({
  midRaw,
  sellAsset: (raw) => ({ out: raw * pays, unfilledShare: 0 }),
  buyAsset: (raw) => ({ out: raw * pays, unfilledShare: 0 }),
  depthWithin: () => ({ sellQuoteOut: 0, buyAssetOut: 0 }),
});

// ---- the router before RU.11, verbatim from packages/risk/src/pools/route.ts at 44d5e65c (RA.3) ----
const tf = (bps: number) => ({ bps, maximumFee: Number.MAX_SAFE_INTEGER });
function routeBefore(
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
// ---- end of the verbatim copy ----

// ---- by hand: each swap as one direct call of the pool's simulator ----
/** A dollar or SOL pool sells `x` whole tokens of its stock: the dollars, counted as the router counts them. */
const handSell = (e: RoutePool, x: number) => {
  const r = e.sim.sellAsset(Math.floor(x * 10 ** e.decAsset));
  return {
    usd: (r.out / 10 ** e.decQuote) * e.quoteUsd * (1 - r.unfilledShare),
    unfilledShare: r.unfilledShare,
  };
};
/** A dollar or SOL pool buys its stock with `usd`: the tokens, and their value at `refMidUsd`. */
const handBuy = (e: RoutePool, usd: number, refMidUsd: number) => {
  const r = e.sim.buyAsset(Math.floor((usd / e.quoteUsd) * 10 ** e.decQuote));
  return {
    tokens: (r.out / 10 ** e.decAsset) * (1 - r.unfilledShare),
    usd: (r.out / 10 ** e.decAsset) * refMidUsd * (1 - r.unfilledShare),
    unfilledShare: r.unfilledShare,
  };
};
/** A stock-to-stock pool takes `x` whole tokens of the traded stock and pays the via token. */
const handHopSell = (p: TwoHopPool, x: number) => {
  const raw = Math.floor(x * 10 ** p.decAsset);
  // the traded stock is the side the pool is filed under: selling it; otherwise it is the quote, which buys the other
  const r = p.assetIsSimAsset ? p.sim.sellAsset(raw) : p.sim.buyAsset(raw);
  return { out: (r.out / 10 ** p.decVia) * (1 - r.unfilledShare), unfilledShare: r.unfilledShare };
};
/** A stock-to-stock pool takes `v` whole via tokens and pays the traded stock. */
const handHopBuy = (p: TwoHopPool, v: number) => {
  const raw = Math.floor(v * 10 ** p.decVia);
  const r = p.assetIsSimAsset ? p.sim.buyAsset(raw) : p.sim.sellAsset(raw);
  return {
    out: (r.out / 10 ** p.decAsset) * (1 - r.unfilledShare),
    unfilledShare: r.unfilledShare,
  };
};
/** A two-hop pool's mid: via tokens per traded token at the pool, valued at the via token's reference mid. */
const handHopMid = (p: TwoHopPool, viaRefMidUsd: number) =>
  (p.assetIsSimAsset ? p.sim.midRaw : 1 / p.sim.midRaw) *
  10 ** (p.decAsset - p.decVia) *
  viaRefMidUsd;

/**
 * One route taken apart and put together again from its own legs: every swap by a direct simulator call, every sum
 * and every share. Returns how many two-hop legs it checked.
 */
function reproduce(
  r: RoutedTrade,
  pools: readonly RoutePool[],
  th: TwoHop,
  n: number,
  side: Side,
  label: string,
): number {
  const ref = largest(pools);
  expect(r.refPool, label).toBe(ref.pool);
  expect(r.refMidUsd, label).toBe(ref.midUsd);
  const total = side === 'sell' ? n / ref.midUsd : n;
  const hops = hopLegs(r);
  const directLegs = r.legs.filter((l) => !l.via);
  // direct legs come first, then the two-hop legs, each in input order
  expect(
    r.legs.map((l) => l.pool),
    label,
  ).toEqual([
    ...pools.filter((p) => directLegs.some((l) => l.pool === p.pool)).map((p) => p.pool),
    ...th.pools.filter((p) => hops.some((l) => l.pool === p.pool)).map((p) => p.pool),
  ]);
  for (const l of directLegs) {
    const e = pools.find((p) => p.pool === l.pool) as RoutePool;
    const h = side === 'sell' ? handSell(e, l.amountIn) : handBuy(e, l.amountIn, ref.midUsd);
    expect(rel(l.outUsd, h.usd), `${label} direct ${l.pool}`).toBeLessThan(TOL);
    expect(l.unfilledShare, label).toBe(h.unfilledShare);
    expect(l.midUsd, label).toBe(e.midUsd);
    expect(l.feeRate, label).toBe(e.feeRate);
  }
  // one via trade per via token used, in the order the two-hop legs first name it
  const vias = [...new Set(hops.map((l) => l.via.mint))];
  expect(
    (r.viaTrades ?? []).map((v) => v.via),
    label,
  ).toEqual(vias);
  expect('viaTrades' in r, label).toBe(hops.length > 0);
  for (const vt of r.viaTrades ?? []) {
    const viaPools = th.via.get(vt.via) as RoutePool[];
    const viaRef = largest(viaPools);
    expect(vt.refPool, label).toBe(viaRef.pool);
    expect(vt.refMidUsd, label).toBe(viaRef.midUsd);
    const mine = hops.filter((l) => l.via.mint === vt.via);
    const poolOf = (l: RouteLeg) => th.pools.find((p) => p.pool === l.pool) as TwoHopPool;
    for (const l of mine) {
      expect(rel(l.midUsd, handHopMid(poolOf(l), viaRef.midUsd)), label).toBeLessThan(TOL);
      expect(l.feeRate, label).toBe(poolOf(l).feeRate);
    }
    if (side === 'sell') {
      // first hop: each pool pays via tokens for the stock it was sent
      for (const l of mine) {
        const h = handHopSell(poolOf(l), l.amountIn);
        expect(rel(l.via.amount, h.out), `${label} hop ${l.pool}`).toBeLessThan(TOL);
        expect(l.unfilledShare, label).toBe(h.unfilledShare);
      }
      // the via tokens of the group are added and sold once, on the via token's own pools
      expect(rel(vt.amount, sum(mine.map((l) => l.via.amount))), label).toBeLessThan(TOL);
      expect(rel(sum(vt.legs.map((l) => l.amountIn)), vt.amount), label).toBeLessThan(TOL);
      for (const vl of vt.legs) {
        const e = viaPools.find((p) => p.pool === vl.pool) as RoutePool;
        const h = handSell(e, vl.amountIn);
        expect(rel(vl.outUsd, h.usd), `${label} via ${vl.pool}`).toBeLessThan(TOL);
        expect(vl.unfilledShare, label).toBe(h.unfilledShare);
      }
      expect(rel(sum(vt.legs.map((l) => l.outUsd)), vt.usd), label).toBeLessThan(TOL);
      // a leg's dollars are its share, by via tokens, of what they sold for
      for (const l of mine)
        expect(rel(l.outUsd, (vt.usd * l.via.amount) / vt.amount), label).toBeLessThan(TOL);
    } else {
      // first hop: the dollars of the group buy the via token once, on its own pools
      expect(rel(vt.usd, sum(mine.map((l) => l.amountIn))), label).toBeLessThan(TOL);
      expect(rel(sum(vt.legs.map((l) => l.amountIn)), vt.usd), label).toBeLessThan(TOL);
      let bought = 0;
      for (const vl of vt.legs) {
        const e = viaPools.find((p) => p.pool === vl.pool) as RoutePool;
        const h = handBuy(e, vl.amountIn, viaRef.midUsd);
        expect(rel(vl.outUsd, h.usd), `${label} via ${vl.pool}`).toBeLessThan(TOL);
        expect(vl.unfilledShare, label).toBe(h.unfilledShare);
        bought += h.tokens;
      }
      expect(rel(vt.amount, bought), label).toBeLessThan(TOL);
      // second hop: each pool gets its share of the via tokens, by dollars, and pays the stock
      for (const l of mine) {
        expect(rel(l.via.amount, (vt.amount * l.amountIn) / vt.usd), label).toBeLessThan(TOL);
        const h = handHopBuy(poolOf(l), l.via.amount);
        expect(rel(l.outUsd, h.out * ref.midUsd), `${label} hop ${l.pool}`).toBeLessThan(TOL);
        expect(l.unfilledShare, label).toBe(h.unfilledShare);
      }
    }
  }
  expect(rel(sum(r.legs.map((l) => l.outUsd)), r.outUsd), label).toBeLessThan(TOL);
  expect(rel(sum(r.legs.map((l) => l.amountIn)), total), label).toBeLessThan(TOL);
  expect(r.poolsUsed, label).toBe(r.legs.length);
  expect(rel(r.costPct, (1 - r.outUsd / n) * 100), label).toBeLessThan(TOL);
  return hops.length;
}

// ---- the item's algorithm written out plainly: nothing kept between chunks, every group valued from scratch ----
function oneHopPlain(ps: readonly RoutePool[], total: number, side: Side) {
  const ref = largest(ps);
  const outAt = (e: RoutePool, x: number) =>
    x <= 0 ? 0 : side === 'sell' ? handSell(e, x).usd : handBuy(e, x, ref.midUsd).usd;
  const chunk = total / ROUTE_CHUNKS;
  const alloc = ps.map(() => 0);
  const cur = ps.map(() => 0);
  for (let k = 0; k < ROUTE_CHUNKS; k++) {
    let bi = 0;
    let bGain = Number.NEGATIVE_INFINITY;
    ps.forEach((e, i) => {
      const g = outAt(e, (alloc[i] as number) + chunk) - (cur[i] as number);
      if (g > bGain) {
        bGain = g;
        bi = i;
      }
    });
    alloc[bi] = (alloc[bi] as number) + chunk;
    cur[bi] = outAt(ps[bi] as RoutePool, alloc[bi] as number);
  }
  return { alloc, cur };
}
function routePlain(pools: readonly RoutePool[], n: number, side: Side, th: TwoHop) {
  const ref = largest(pools);
  const hops = th.pools.filter((p) => (th.via.get(p.via)?.length ?? 0) > 0);
  const vias = [...new Set(hops.map((p) => p.via))];
  /** What one via token's group is worth with `a[j]` sent to two-hop pool j. */
  const groupUsd = (via: string, a: number[]) => {
    const viaPools = th.via.get(via) as RoutePool[];
    const members = hops.map((_, j) => j).filter((j) => (hops[j] as TwoHopPool).via === via);
    if (side === 'sell') {
      const t = sum(
        members.map((j) =>
          (a[j] as number) > 0 ? handHopSell(hops[j] as TwoHopPool, a[j] as number).out : 0,
        ),
      );
      return t > 0 ? sum(oneHopPlain(viaPools, t, side).cur) : 0;
    }
    const usd = sum(members.map((j) => a[j] as number));
    if (!(usd > 0)) return 0;
    const viaRef = largest(viaPools);
    const bought = sum(
      oneHopPlain(viaPools, usd, side).alloc.map((x, i) =>
        x > 0 ? handBuy(viaPools[i] as RoutePool, x, viaRef.midUsd).tokens : 0,
      ),
    );
    return sum(
      members.map((j) => {
        const v = (bought * (a[j] as number)) / usd;
        return v > 0 ? handHopBuy(hops[j] as TwoHopPool, v).out * ref.midUsd : 0;
      }),
    );
  };
  const outAt = (e: RoutePool, x: number) =>
    x <= 0 ? 0 : side === 'sell' ? handSell(e, x).usd : handBuy(e, x, ref.midUsd).usd;
  const total = side === 'sell' ? n / ref.midUsd : n;
  const chunk = total / ROUTE_CHUNKS;
  const alloc = pools.map(() => 0);
  const cur = pools.map(() => 0);
  const a = hops.map(() => 0);
  for (let k = 0; k < ROUTE_CHUNKS; k++) {
    let bi = 0;
    let bj = -1;
    let bGain = Number.NEGATIVE_INFINITY;
    pools.forEach((e, i) => {
      const g = outAt(e, (alloc[i] as number) + chunk) - (cur[i] as number);
      if (g > bGain) {
        bGain = g;
        bi = i;
      }
    });
    const now = new Map(vias.map((via) => [via, groupUsd(via, a)]));
    hops.forEach((p, j) => {
      const g =
        groupUsd(
          p.via,
          a.map((v, i) => (i === j ? v + chunk : v)),
        ) - (now.get(p.via) as number);
      if (g > bGain) {
        bGain = g;
        bj = j;
      }
    });
    if (bj >= 0) a[bj] = (a[bj] as number) + chunk;
    else {
      alloc[bi] = (alloc[bi] as number) + chunk;
      cur[bi] = outAt(pools[bi] as RoutePool, alloc[bi] as number);
    }
  }
  return {
    outUsd: sum(cur) + sum(vias.map((via) => groupUsd(via, a))),
    direct: pools.map((p, i) => ({ pool: p.pool, amountIn: alloc[i] as number })),
    hops: hops.map((p, j) => ({ pool: p.pool, amountIn: a[j] as number })),
  };
}

/** The cases every check below walks: each stock's full set of dollar and SOL pools, then only its smallest. */
const CASES = ASSETS.flatMap(([symbol, mint]) => [
  { name: symbol, mint, pools: poolsOf(mint), th: twoHopOf(mint), reduced: false },
  {
    name: `${symbol}, smallest direct pool only`,
    mint,
    pools: [smallest(poolsOf(mint))],
    th: twoHopOf(mint),
    reduced: true,
  },
]);
// a case's route with two hops on is computed once and read by every check that needs it
const routes = new Map<string, RoutedTrade>();
const routed = (c: (typeof CASES)[number], side: Side, size: number) => {
  const key = `${c.name} ${side} ${size}`;
  const r = routes.get(key) ?? on(c.pools, size, side, c.th);
  routes.set(key, r);
  return r;
};

describe('routeTrade with two hops', () => {
  it('the fixture holds what the tests say it holds', () => {
    expect(cap.fetchedAt.slice(0, 19)).toBe('2026-10-06T21:21:16');
    expect([cap.direct.length, cap.twoHopPools.length, cap.tracked.length]).toEqual([21, 6, 18]);
    expect(ASSETS.map(([, m]) => poolsOf(m).length)).toEqual([7, 10, 4]);
    // QQQx: five pools with SPYx (three filed under QQQx, two under SPYx) and one with AMZNx
    const q = twoHopOf(QQQX);
    expect(q.pools.map((p) => [p.via, p.assetIsSimAsset])).toEqual([
      [SPYX, true],
      [SPYX, true],
      [SPYX, true],
      [SPYX, false],
      [AMZNX, true],
      [SPYX, false],
    ]);
    expect([...q.via.keys()]).toEqual([SPYX, AMZNX]);
    expect(twoHopOf(SPYX).pools.map((p) => p.via)).toEqual([QQQX, QQQX, QQQX, QQQX, QQQX]);
    expect(twoHopOf(AMZNX).pools.map((p) => [p.via, p.assetIsSimAsset])).toEqual([[QQQX, false]]);
    // no token of the fixture charges a transfer fee
    for (const r of [...cap.direct, ...cap.twoHopPools])
      expect([r.transferFeeBps0, r.transferFeeBps1]).toEqual([0, 0]);
  });

  it('identity: without two hops, and with no routable two-hop pool, the result is the router before RU.11, bit for bit', () => {
    let n = 0;
    for (const { pools, th } of CASES)
      for (const side of SIDES)
        for (const size of GRID) {
          const before = routeBefore(pools, size, side);
          const want = JSON.stringify(before);
          const noEntry: TwoHop = { pools: th.pools, via: new Map() };
          const emptyEntry: TwoHop = {
            pools: th.pools,
            via: new Map(th.pools.map((p) => [p.via, []])),
          };
          for (const r of [
            routeTrade(pools, size, side),
            routeTrade(pools, size, side, ROUTE_CHUNKS),
            routeTrade(pools, size, side, ROUTE_CHUNKS, undefined),
            routeTrade(pools, size, side, ROUTE_CHUNKS, { pools: [], via: new Map() }),
            routeTrade(pools, size, side, ROUTE_CHUNKS, { pools: [], via: th.via }),
            routeTrade(pools, size, side, ROUTE_CHUNKS, noEntry),
            routeTrade(pools, size, side, ROUTE_CHUNKS, emptyEntry),
          ]) {
            expect(r).toStrictEqual(before);
            expect(JSON.stringify(r)).toBe(want);
            expect(Object.keys(r)).toEqual(Object.keys(before));
            expect('viaTrades' in r).toBe(false);
            expect(r.legs.some((l) => 'via' in l)).toBe(false);
          }
          n++;
        }
    expect(n).toBe(CASES.length * SIDES.length * GRID.length);
    // another chunk count goes through the same code
    for (const chunks of [1, 7, 64])
      expect(JSON.stringify(routeTrade(poolsOf(QQQX), 50_000, 'sell', chunks))).toBe(
        JSON.stringify(routeBefore(poolsOf(QQQX), 50_000, 'sell', chunks)),
      );
  });

  it('one two-hop swap equals the simulator called directly: six pools, both sides, both orientations', () => {
    let n = 0;
    for (const sp of stockPairs)
      for (const assetIsSimAsset of [true, false]) {
        const p = hopPool(sp, assetIsSimAsset);
        const { sim } = sp.built;
        const traded = assetIsSimAsset ? sp.row.assetMint : sp.row.quoteMint;
        const tradedMid = largest(poolsOf(traded)).midUsd;
        const viaMid = largest(poolsOf(p.via)).midUsd;
        for (const usd of [10, 100, 2_500, 50_000, 1_000_000]) {
          // a sale: `x` whole tokens of the traded stock in, via tokens out
          const x = usd / tradedMid;
          const rawX = Math.floor(x * 10 ** p.decAsset);
          const s = assetIsSimAsset ? sim.sellAsset(rawX) : sim.buyAsset(rawX);
          const sold = twoHopSwap(p, x, 'sell');
          expect(sold.out).toBe((s.out / 10 ** p.decVia) * (1 - s.unfilledShare));
          expect(sold.unfilledShare).toBe(s.unfilledShare);
          // a purchase: `v` whole via tokens in, the traded stock out, valued at its reference mid
          const v = usd / viaMid;
          const rawV = Math.floor(v * 10 ** p.decVia);
          const b = assetIsSimAsset ? sim.buyAsset(rawV) : sim.sellAsset(rawV);
          const bought = twoHopSwap(p, v, 'buy');
          expect(bought.out * tradedMid).toBe(
            (b.out / 10 ** p.decAsset) * (1 - b.unfilledShare) * tradedMid,
          );
          expect(bought.unfilledShare).toBe(b.unfilledShare);
          if (usd === 10) {
            // the direction is the right one: a small swap trades near the two stocks' own prices, not their inverse
            expect(sold.unfilledShare).toBe(0);
            expect(bought.unfilledShare).toBe(0);
            expect(Math.abs((sold.out * viaMid) / usd - 1)).toBeLessThan(0.02);
            expect(Math.abs((bought.out * tradedMid) / usd - 1)).toBeLessThan(0.02);
          }
          n++;
        }
        expect(twoHopSwap(p, 0, 'sell')).toEqual({ out: 0, unfilledShare: 0 });
        expect(twoHopSwap(p, 0, 'buy')).toEqual({ out: 0, unfilledShare: 0 });
      }
    expect(n).toBe(6 * 2 * 5);
  });

  // With a stock's full set of pools the two-hop pools are not always used: QQQx uses them at every size but a $1M
  // sale, SPYx only at $5M, AMZNx from $250k (sale) and $1M (purchase). With only the smallest dollar or SOL pool
  // left they carry part of every trade, so every line of the reproduction runs on both sides.
  it('a whole route is reproduced by hand from its own legs, full pool sets and reduced ones', () => {
    const used: Record<string, boolean[]> = {};
    let withHops = 0;
    for (const c of CASES)
      for (const side of SIDES) {
        const row: boolean[] = [];
        for (const size of GRID) {
          const r = routed(c, side, size);
          const k = reproduce(r, c.pools, c.th, size, side, `${c.name} ${side} ${size}`);
          row.push(k > 0);
          if (k > 0) withHops++;
        }
        used[`${c.name} ${side}`] = row;
      }
    const T = true;
    const F = false;
    expect(used).toEqual({
      'QQQx sell': [T, T, T, T, T, T, F, T],
      'QQQx buy': [T, T, T, T, T, T, T, T],
      'QQQx, smallest direct pool only sell': [T, T, T, T, T, T, T, T],
      'QQQx, smallest direct pool only buy': [T, T, T, T, T, T, T, T],
      'SPYx sell': [F, F, F, F, F, F, F, T],
      'SPYx buy': [F, F, F, F, F, F, F, T],
      'SPYx, smallest direct pool only sell': [T, T, T, T, T, T, T, T],
      'SPYx, smallest direct pool only buy': [T, T, T, T, T, T, T, T],
      'AMZNx sell': [F, F, F, F, F, T, T, T],
      'AMZNx buy': [F, F, F, F, F, F, T, T],
      'AMZNx, smallest direct pool only sell': [T, T, T, T, T, T, T, T],
      'AMZNx, smallest direct pool only buy': [T, T, T, T, T, T, T, T],
    });
    // 22 of the 48 routes on the full sets, and all 48 on the reduced ones
    expect(withHops).toBe(22 + 48);
  });

  it('equals the algorithm written out plainly, with nothing kept between chunks', {
    timeout: 60_000,
  }, () => {
    let n = 0;
    for (const c of CASES)
      for (const side of SIDES)
        for (const size of GRID) {
          const r = routed(c, side, size);
          const p = routePlain(c.pools, size, side, c.th);
          const label = `${c.name} ${side} ${size}`;
          expect(rel(r.outUsd, p.outUsd), label).toBeLessThan(TOL);
          expect(
            r.legs.filter((l) => !l.via).map((l) => ({ pool: l.pool, amountIn: l.amountIn })),
            label,
          ).toEqual(p.direct.filter((l) => l.amountIn > 0));
          expect(
            hopLegs(r).map((l) => ({ pool: l.pool, amountIn: l.amountIn })),
            label,
          ).toEqual(p.hops.filter((l) => l.amountIn > 0));
          n++;
        }
    expect(n).toBe(CASES.length * SIDES.length * GRID.length);
  });

  it('a pool whose via token has no pools of its own is left out, and the others are routed as if it were not there', () => {
    const pools = poolsOf(QQQX);
    const th = twoHopOf(QQQX);
    const onlyAmzn: TwoHop = { pools: th.pools, via: new Map([[AMZNX, poolsOf(AMZNX)]]) };
    const filtered: TwoHop = { pools: th.pools.filter((p) => p.via === AMZNX), via: onlyAmzn.via };
    let withHops = 0;
    for (const side of SIDES)
      for (const size of GRID) {
        const r = on(pools, size, side, onlyAmzn);
        expect(JSON.stringify(r)).toBe(JSON.stringify(on(pools, size, side, filtered)));
        expect(hopLegs(r).every((l) => l.via.mint === AMZNX)).toBe(true);
        if (hopLegs(r).length) withHops++;
      }
    expect(withHops).toBeGreaterThan(0);
    // the reference is a direct pool: two-hop pools alone do not make a route
    expect(() => routeTrade([], 100, 'sell', ROUTE_CHUNKS, th)).toThrow('routeTrade: no pools');
  });

  // No pool of the fixture has a broken mid, so this one is made up: the labels of a real QQQx/SPYx pool on a simulator
  // that pays two for one. The greedy wants such a pool, so what keeps it out of the route is its mid and nothing else.
  it('a pool whose mid is not a positive finite number is left out by the router, and the others are routed as if it were not there', {
    timeout: 60_000,
  }, () => {
    const c = CASES.find((x) => x.mint === QQQX && !x.reduced) as (typeof CASES)[number];
    const real = c.th.pools.find((p) => p.via === SPYX) as TwoHopPool;
    const madeUp = (midRaw: number, assetIsSimAsset: boolean): TwoHopPool => ({
      ...real,
      pool: 'made-up',
      sim: stubSim(midRaw, 2),
      assetIsSimAsset,
    });
    let n = 0;
    for (const side of SIDES)
      for (const size of GRID) {
        const without = routed(c, side, size);
        const before = routeBefore(c.pools, size, side);
        expect(figures(without).every(Number.isFinite), `${side} ${size}`).toBe(true);
        // the mid is read both ways round: as the simulator gives it, and inverted
        for (const assetIsSimAsset of [true, false]) {
          // with a mid of one the made-up pool is routed and carries an amount
          const usable: TwoHop = {
            pools: [madeUp(1, assetIsSimAsset), ...c.th.pools],
            via: c.th.via,
          };
          expect(
            hopLegs(on(c.pools, size, side, usable)).some((l) => l.pool === 'made-up'),
            `${side} ${size} ${assetIsSimAsset}`,
          ).toBe(true);
          for (const midRaw of [0, Number.POSITIVE_INFINITY, Number.NaN, -1]) {
            const label = `${side} ${size} ${assetIsSimAsset} mid ${midRaw}`;
            const bad = madeUp(midRaw, assetIsSimAsset);
            // first in the list, ahead of the real pools: the route is the one without it
            const r = on(c.pools, size, side, { pools: [bad, ...c.th.pools], via: c.th.via });
            expect(r, label).toStrictEqual(without);
            expect(JSON.stringify(r), label).toBe(JSON.stringify(without));
            expect(figures(r).every(Number.isFinite), label).toBe(true);
            // alone, it leaves nothing to route through two hops: the router before RU.11, bit for bit
            const alone = on(c.pools, size, side, { pools: [bad], via: c.th.via });
            expect(alone, label).toStrictEqual(before);
            expect(JSON.stringify(alone), label).toBe(JSON.stringify(before));
            expect('viaTrades' in alone, label).toBe(false);
            n++;
          }
        }
      }
    expect(n).toBe(SIDES.length * GRID.length * 2 * 4);
  });

  // The fixture has no tie either. Three made-up pools with no fee and no limit that pay one raw unit for each raw unit
  // in, every mid one: a chunk returns exactly the same dollars sold to the direct pool or sent through two hops.
  it('tie: a two-hop pool that adds exactly what the direct pool adds does not take the chunk, on either side', () => {
    const DEC = 6;
    const dollarPool = (pool: string): RoutePool => ({
      pool,
      sim: stubSim(1),
      decAsset: DEC,
      decQuote: DEC,
      quoteUsd: 1,
      midUsd: 1,
      tvlUsd: 1,
      feeRate: 0,
      transferFeeBps: { asset: 0, quote: 0 },
    });
    const own = dollarPool('direct');
    const viaPool = dollarPool('via token to dollars');
    const hop = (pays: number): TwoHopPool => ({
      pool: 'stock to stock',
      sim: stubSim(1, pays),
      assetIsSimAsset: true,
      via: 'VIA',
      decAsset: DEC,
      decVia: DEC,
      tvlUsd: 1,
      feeRate: 0,
      transferFeeBps: { asset: 0, via: 0 },
    });
    const th = (pays: number): TwoHop => ({
      pools: [hop(pays)],
      via: new Map([['VIA', [viaPool]]]),
    });
    let n = 0;
    for (const side of SIDES)
      for (const size of GRID) {
        const label = `${side} ${size}`;
        // one chunk down each path, by hand: the same dollars to the last bit
        const chunk = size / ROUTE_CHUNKS;
        const oneHop =
          side === 'sell' ? handSell(own, chunk).usd : handBuy(own, chunk, own.midUsd).usd;
        const twoHops =
          side === 'sell'
            ? handSell(viaPool, handHopSell(hop(1), chunk).out).usd
            : handHopBuy(hop(1), handBuy(viaPool, chunk, viaPool.midUsd).tokens).out * own.midUsd;
        expect(twoHops, label).toBe(oneHop);
        expect(oneHop, label).toBe(chunk);
        // the direct pool keeps every chunk: one leg, and no trace of two hops in the result
        const r = on([own], size, side, th(1));
        expect(r, label).toStrictEqual(routeTrade([own], size, side));
        expect(r.legs, label).toEqual([
          { pool: 'direct', amountIn: size, unfilledShare: 0, outUsd: size, midUsd: 1, feeRate: 0 },
        ]);
        expect(r.poolsUsed, label).toBe(1);
        expect('viaTrades' in r, label).toBe(false);
        expect(
          r.legs.some((l) => 'via' in l),
          label,
        ).toBe(false);
        // the stock-to-stock pool is routable all the same: paying two for one, it takes every chunk
        const better = on([own], size, side, th(2));
        expect(
          better.legs.map((l) => [l.pool, l.amountIn, l.via?.mint]),
          label,
        ).toEqual([['stock to stock', size, 'VIA']]);
        expect(
          better.viaTrades?.map((v) => v.via),
          label,
        ).toEqual(['VIA']);
        n++;
      }
    expect(n).toBe(SIDES.length * GRID.length);
  });

  it('shared via: the via tokens of several pools are added and traded once, so impact is charged on the sum', () => {
    const seen = { sell: 0, buy: 0 };
    const dearer = { sell: 0, buy: 0 };
    for (const c of CASES) {
      if (c.mint !== QQQX) continue;
      const spy = poolsOf(SPYX);
      const spyMid = largest(spy).midUsd;
      for (const side of SIDES)
        for (const size of GRID) {
          const r = routed(c, side, size);
          const mine = hopLegs(r).filter((l) => l.via.mint === SPYX);
          if (mine.length < 2) continue;
          const label = `${c.name} ${side} ${size}`;
          const vt = (r.viaTrades ?? []).find((v) => v.via === SPYX);
          if (!vt) throw new Error(`${label}: no SPYx via trade`);
          seen[side]++;
          if (side === 'sell') {
            // the dollars are those of ONE sale of the summed SPYx on SPYx's own pools, by the router before RU.11
            const once = routeBefore(spy, sum(mine.map((l) => l.via.amount)) * spyMid, 'sell');
            expect(rel(vt.usd, once.outUsd), label).toBeLessThan(1e-9);
            expect(rel(sum(mine.map((l) => l.outUsd)), once.outUsd), label).toBeLessThan(1e-9);
            // and not more than each pool's SPYx sold on its own, which would count the pools' depth once per leg
            const apart = sum(
              mine.map((l) => routeBefore(spy, l.via.amount * spyMid, 'sell').outUsd),
            );
            expect(vt.usd, label).toBeLessThanOrEqual(apart * (1 + 1e-12));
            if (vt.usd < apart * (1 - 1e-6)) dearer.sell++;
          } else {
            // the SPYx is bought once with the summed dollars
            const tokens = (usd: number) =>
              sum(
                routeBefore(spy, usd, 'buy').legs.map(
                  (l) =>
                    handBuy(spy.find((p) => p.pool === l.pool) as RoutePool, l.amountIn, spyMid)
                      .tokens,
                ),
              );
            const usdIn = sum(mine.map((l) => l.amountIn));
            expect(rel(vt.usd, usdIn), label).toBeLessThan(TOL);
            expect(rel(vt.amount, tokens(usdIn)), label).toBeLessThan(1e-9);
            expect(rel(sum(mine.map((l) => l.via.amount)), vt.amount), label).toBeLessThan(TOL);
            // and not more SPYx than each leg's dollars spent on their own would buy
            const apart = sum(mine.map((l) => tokens(l.amountIn)));
            expect(vt.amount, label).toBeLessThanOrEqual(apart * (1 + 1e-12));
            if (vt.amount < apart * (1 - 1e-6)) dearer.buy++;
          }
        }
    }
    // at least two legs through SPYx on both sides, and cases where trading the sum is plainly dearer
    expect(seen.sell).toBeGreaterThan(0);
    expect(seen.buy).toBeGreaterThan(0);
    expect(dearer.sell).toBeGreaterThan(0);
    expect(dearer.buy).toBeGreaterThan(0);
  });

  it('never worse than one hop on the fixture: every stock, size and side, full pool sets and reduced ones', () => {
    const worse: string[] = [];
    for (const c of CASES)
      for (const side of SIDES)
        for (const size of GRID) {
          const off = routeTrade(c.pools, size, side);
          const r = routed(c, side, size);
          if (!(r.outUsd >= off.outUsd - 1e-9 * size))
            worse.push(`${c.name} ${side} ${size}: ${r.outUsd} < ${off.outUsd}`);
        }
    expect(worse).toEqual([]);
  });

  /** The fee, transfer-fee and basis dollars of one route, hop by hop, from its legs. */
  const splitByHand = (r: RoutedTrade, pools: readonly RoutePool[], th: TwoHop, side: Side) => {
    const ref = largest(pools);
    let poolFeeUsd = 0;
    let transferFeeUsd = 0;
    let basisUsd = 0;
    // a dollar or SOL pool, of the stock or of a via token, against its own reference
    const directLeg = (l: RouteLeg, e: RoutePool, refMid: number) => {
      const filled = 1 - l.unfilledShare;
      if (side === 'sell') {
        const raw = Math.floor(l.amountIn * 10 ** e.decAsset);
        const feeUnits =
          (raw - afterTransferFee(raw, tf(e.transferFeeBps.asset))) / 10 ** e.decAsset;
        const q = e.transferFeeBps.quote / 10_000;
        poolFeeUsd += (l.amountIn - feeUnits) * filled * e.midUsd * e.feeRate;
        transferFeeUsd += feeUnits * e.midUsd * filled + (q > 0 ? (l.outUsd * q) / (1 - q) : 0);
        basisUsd += l.amountIn * filled * (refMid - e.midUsd);
      } else {
        const raw = Math.floor((l.amountIn / e.quoteUsd) * 10 ** e.decQuote);
        const feeQuote =
          ((raw - afterTransferFee(raw, tf(e.transferFeeBps.quote))) / 10 ** e.decQuote) *
          e.quoteUsd;
        const a = e.transferFeeBps.asset / 10_000;
        poolFeeUsd += (l.amountIn - feeQuote) * filled * e.feeRate;
        transferFeeUsd += feeQuote * filled + (a > 0 ? (l.outUsd * a) / (1 - a) : 0);
        basisUsd += l.amountIn * filled * (1 - refMid / e.midUsd);
      }
    };
    for (const l of r.legs.filter((x) => !x.via))
      directLeg(l, pools.find((p) => p.pool === l.pool) as RoutePool, ref.midUsd);
    for (const l of hopLegs(r)) {
      const p = th.pools.find((x) => x.pool === l.pool) as TwoHopPool;
      const viaMid = largest(th.via.get(p.via) as RoutePool[]).midUsd;
      const filled = 1 - l.unfilledShare;
      if (side === 'sell') {
        const raw = Math.floor(l.amountIn * 10 ** p.decAsset);
        const feeUnits =
          (raw - afterTransferFee(raw, tf(p.transferFeeBps.asset))) / 10 ** p.decAsset;
        const q = p.transferFeeBps.via / 10_000;
        poolFeeUsd += (l.amountIn - feeUnits) * filled * l.midUsd * p.feeRate;
        transferFeeUsd +=
          feeUnits * l.midUsd * filled + (q > 0 ? (l.via.amount * viaMid * q) / (1 - q) : 0);
        basisUsd += l.amountIn * filled * (ref.midUsd - l.midUsd);
      } else {
        const raw = Math.floor(l.via.amount * 10 ** p.decVia);
        const feeVia = (raw - afterTransferFee(raw, tf(p.transferFeeBps.via))) / 10 ** p.decVia;
        const a = p.transferFeeBps.asset / 10_000;
        poolFeeUsd += (l.via.amount - feeVia) * viaMid * filled * p.feeRate;
        transferFeeUsd += feeVia * viaMid * filled + (a > 0 ? (l.outUsd * a) / (1 - a) : 0);
        basisUsd += l.via.amount * viaMid * filled * (1 - ref.midUsd / l.midUsd);
      }
    }
    for (const vt of r.viaTrades ?? []) {
      const viaPools = th.via.get(vt.via) as RoutePool[];
      for (const vl of vt.legs)
        directLeg(vl, viaPools.find((p) => p.pool === vl.pool) as RoutePool, vt.refMidUsd);
    }
    return { poolFeeUsd, transferFeeUsd, basisUsd };
  };

  it('the four parts of the split sum to the total, and each part is its legs, hop by hop', () => {
    let n = 0;
    for (const c of CASES)
      for (const side of SIDES)
        for (const size of GRID) {
          const r = routed(c, side, size);
          if (!hopLegs(r).length) continue;
          const label = `${c.name} ${side} ${size}`;
          const s = r.split;
          expect(
            Math.abs(s.poolFee + s.transferFee + s.basis + s.impact - s.total),
            label,
          ).toBeLessThan(1e-15);
          expect(rel(s.total, 1 - r.outUsd / size), label).toBeLessThan(TOL);
          const h = splitByHand(r, c.pools, c.th, side);
          expect(rel(s.poolFee, h.poolFeeUsd / size), label).toBeLessThan(TOL);
          expect(rel(s.basis, h.basisUsd / size), label).toBeLessThan(1e-9);
          // no token of the fixture charges a transfer fee
          expect(s.transferFee, label).toBe(0);
          expect(s.poolFee, label).toBeGreaterThan(0);
          n++;
        }
    expect(n).toBe(22 + 48);
  });

  it('a small two-hop trade pays both pools: the fee part is each pool rate on the dollars through it', () => {
    const c = CASES.find((x) => x.mint === QQQX && x.reduced) as (typeof CASES)[number];
    for (const side of SIDES) {
      const r = routed(c, side, 100);
      const through = (ls: RouteLeg[]) => sum(ls.map((l) => l.outUsd * l.feeRate));
      const own = through(r.legs.filter((l) => !l.via));
      const hop = through(hopLegs(r));
      const via = through((r.viaTrades ?? []).flatMap((v) => v.legs));
      expect(hopLegs(r).length, side).toBeGreaterThan(0);
      // the via token's pools are a real part of the fee here, so leaving them out would show
      expect(via / (own + hop + via), side).toBeGreaterThan(0.05);
      // a small trade exhausts no pool: the dollars out of a pool are the dollars through it, to well under 1%
      expect(Math.abs((r.split.poolFee * 100) / (own + hop + via) - 1), side).toBeLessThan(0.01);
    }
  });

  // The fixture's tokens charge no transfer fee, so the bps below are made up to run those lines of the split. Only the
  // labels change: the simulators are the same, so the route is the same and only the split moves.
  it('transfer fees on a two-hop route land in transferFee: made-up rates on the labels, the same route', () => {
    const c = CASES.find((x) => x.mint === QQQX && x.reduced) as (typeof CASES)[number];
    const th: TwoHop = {
      pools: c.th.pools.map((p) => ({ ...p, transferFeeBps: { asset: 30, via: 50 } })),
      via: new Map(
        [...c.th.via].map(([m, ps]) => [
          m,
          ps.map((p) => ({ ...p, transferFeeBps: { asset: 20, quote: 10 } })),
        ]),
      ),
    };
    let n = 0;
    for (const side of SIDES)
      for (const size of [100, 10_000, 1_000_000]) {
        const a = routed(c, side, size);
        const t = on(c.pools, size, side, th);
        const label = `${side} ${size}`;
        expect(t.outUsd, label).toBe(a.outUsd);
        expect(t.legs, label).toEqual(a.legs);
        expect(t.viaTrades, label).toEqual(a.viaTrades);
        expect(t.split.total, label).toBe(a.split.total);
        expect(t.split.basis, label).toBe(a.split.basis);
        expect(a.split.transferFee, label).toBe(0);
        const h = splitByHand(t, c.pools, th, side);
        expect(h.transferFeeUsd, label).toBeGreaterThan(0);
        expect(rel(t.split.transferFee, h.transferFeeUsd / size), label).toBeLessThan(TOL);
        expect(rel(t.split.poolFee, h.poolFeeUsd / size), label).toBeLessThan(TOL);
        const s = t.split;
        expect(
          Math.abs(s.poolFee + s.transferFee + s.basis + s.impact - s.total),
          label,
        ).toBeLessThan(1e-15);
        n++;
      }
    expect(n).toBe(6);
  });

  it('deterministic: the same inputs give the same JSON twice, and so do inputs built again from the same bytes', () => {
    for (const c of CASES)
      for (const side of SIDES)
        for (const size of GRID) {
          const first = JSON.stringify(routed(c, side, size));
          expect(JSON.stringify(on(c.pools, size, side, c.th))).toBe(first);
          if (size === 10_000)
            expect(JSON.stringify(on(c.pools, size, side, twoHopOf(c.mint)))).toBe(first);
        }
  });
});
