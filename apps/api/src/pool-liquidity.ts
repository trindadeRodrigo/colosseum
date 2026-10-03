import {
  CLMM_TICK_ARRAY_POOL_OFFSET,
  type ClState,
  clmmState,
  DLMM_BIN_ARRAY_PAIR_OFFSET,
  type DlmmBin,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeDlmmBinArray,
  decodeDlmmPair,
  decodeWhirlpool,
  decodeWpTickArray,
  sqrtPriceAtTick,
  WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET,
  WP_FIXED_TICK_ARRAY_POOL_OFFSET,
  whirlpoolState,
} from '@colosseum/risk';

/**
 * Liquidity distribution of one pool around its current price (`GET /risk/pools/:address/liquidity`), for a bar
 * chart: equal-width price bands across mid × (1 ± rangePct), the asset side above the price, the quote side
 * below. Pure functions over the pool head and its tick or bin arrays as decoded by packages/risk/src/pools; the
 * route reads the bytes over RPC. Nothing outside the fetched tick or bin arrays is counted.
 */
export const POOL_LIQUIDITY_METHOD_VERSION = 'pool-liquidity-0.1';

export type LiquidityBand = {
  /** Quote per asset, UI units. */
  priceLow: number;
  priceHigh: number;
  side: 'asset' | 'quote';
  /** UI units of the side's token. */
  amount: number;
  /** null when the quote token has no USD price. */
  amountUsd: number | null;
  /** Concentrated liquidity L at the band's middle (sqrt-price space); null for bin pools. */
  liquidity: number | null;
};

export type Distribution = {
  midPrice: number;
  bands: LiquidityBand[];
  totalAsset: number;
  totalQuote: number;
  totalAssetUsd: number | null;
  totalQuoteUsd: number | null;
};

/**
 * Band edges across mid × (1 ± rangePct), with mid inserted as an edge when it falls inside a band, so every
 * returned interval is wholly above or wholly below the price (the band holding the price is split at it).
 */
export function bandEdges(mid: number, bands: number, rangePct: number): Array<[number, number]> {
  const lo = mid * (1 - rangePct);
  const w = (2 * mid * rangePct) / bands;
  // an edge within rounding of the price is the price, so `lo >= mid` tells the side exactly
  const snap = (x: number) => (Math.abs(x - mid) <= 1e-9 * mid ? mid : x);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < bands; k++) {
    const a = snap(lo + k * w);
    const b = snap(k === bands - 1 ? mid * (1 + rangePct) : lo + (k + 1) * w);
    if (a < mid && mid < b) out.push([a, mid], [mid, b]);
    else out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------- concentrated liquidity

/** Liquidity segments in sqrt-price space: L between consecutive initialized ticks, cumulative liquidityNet. */
export function clSegments(s: ClState): Array<{ lo: number; hi: number; L: number }> {
  const out: Array<{ lo: number; hi: number; L: number }> = [];
  let L = 0;
  for (let i = 0; i < s.ticks.length; i++) {
    const t = s.ticks[i] as { tick: number; liquidityNet: number };
    L += t.liquidityNet;
    const next = s.ticks[i + 1];
    if (!next || L <= 0) continue;
    out.push({ lo: sqrtPriceAtTick(t.tick), hi: sqrtPriceAtTick(next.tick), L });
  }
  return out;
}

/**
 * Raw token amounts held by the liquidity between sqrt prices a < b: token0 when the range is above the current
 * price (L·(1/x − 1/y)), token1 when below (L·(y − x)). The caller keeps the range on one side of the price.
 */
export function clTokenBetween(
  segs: Array<{ lo: number; hi: number; L: number }>,
  a: number,
  b: number,
  token: 0 | 1,
): number {
  let sum = 0;
  for (const g of segs) {
    const x = Math.max(a, g.lo);
    const y = Math.min(b, g.hi);
    if (y <= x) continue;
    sum += token === 0 ? g.L * (1 / x - 1 / y) : g.L * (y - x);
  }
  return sum;
}

const liquidityAt = (segs: Array<{ lo: number; hi: number; L: number }>, s: number) =>
  segs.find((g) => g.lo <= s && s < g.hi)?.L ?? 0;

export function clDistribution(
  s: ClState,
  o: {
    assetIs0: boolean;
    decAsset: number;
    decQuote: number;
    quoteUsd: number | null;
    bands: number;
    rangePct: number;
  },
): Distribution {
  const [d0, d1] = o.assetIs0 ? [o.decAsset, o.decQuote] : [o.decQuote, o.decAsset];
  const p = s.sqrtPrice ** 2; // raw token1 per raw token0
  // UI quote-per-asset price ↔ raw sqrt price
  const mid = o.assetIs0 ? p * 10 ** (d0 - d1) : 10 ** (d1 - d0) / p;
  const sqrtOf = (P: number) => Math.sqrt(o.assetIs0 ? P * 10 ** (d1 - d0) : 10 ** (d1 - d0) / P);
  const segs = clSegments(s);
  const sc = s.sqrtPrice;
  const bands: LiquidityBand[] = bandEdges(mid, o.bands, o.rangePct).map(([lo, hi]) => {
    const above = lo >= mid;
    const [sa, sb] = [sqrtOf(lo), sqrtOf(hi)].sort((x, y) => x - y) as [number, number];
    // above the UI price: the asset side; in raw terms token0 above sc when the asset is token0, else token1 below
    const raw = above
      ? o.assetIs0
        ? clTokenBetween(segs, Math.max(sa, sc), sb, 0)
        : clTokenBetween(segs, sa, Math.min(sb, sc), 1)
      : o.assetIs0
        ? clTokenBetween(segs, sa, Math.min(sb, sc), 1)
        : clTokenBetween(segs, Math.max(sa, sc), sb, 0);
    const amount = raw / 10 ** (above ? o.decAsset : o.decQuote);
    const usd =
      o.quoteUsd === null ? null : above ? amount * mid * o.quoteUsd : amount * o.quoteUsd;
    return {
      priceLow: lo,
      priceHigh: hi,
      side: above ? 'asset' : 'quote',
      amount,
      amountUsd: usd,
      liquidity: liquidityAt(segs, (sa + sb) / 2),
    };
  });
  return totals(mid, bands, o.quoteUsd);
}

// ---------------------------------------------------------------- bins (Meteora DLMM)

export function dlmmDistribution(
  pair: { activeId: number; binStep: number },
  bins: DlmmBin[],
  o: {
    assetIsX: boolean;
    decAsset: number;
    decQuote: number;
    quoteUsd: number | null;
    bands: number;
    rangePct: number;
  },
): Distribution {
  const [dx, dy] = o.assetIsX ? [o.decAsset, o.decQuote] : [o.decQuote, o.decAsset];
  const ui = (rawYperX: number) =>
    o.assetIsX ? rawYperX * 10 ** (dx - dy) : 1 / (rawYperX * 10 ** (dx - dy));
  const mid = ui((1 + pair.binStep / 10_000) ** pair.activeId);
  const edges = bandEdges(mid, o.bands, o.rangePct);
  const amounts = edges.map(() => 0);
  const place = (P: number, amount: number, side: 'asset' | 'quote') => {
    // the asset sits at or above the price, the quote at or below; the active bin holds both at the price
    const at = side === 'asset' ? Math.max(P, mid) : Math.min(P, mid);
    const k = edges.findIndex(
      ([lo, hi], i) =>
        (side === 'asset' ? lo >= mid : hi <= mid) &&
        at >= lo &&
        (at < hi || (i === edges.length - 1 && at === hi) || (side === 'quote' && at === hi)),
    );
    if (k >= 0) amounts[k] = (amounts[k] as number) + amount;
  };
  for (const b of bins) {
    const P = ui(b.price);
    const x = b.amountX / 10 ** dx;
    const y = b.amountY / 10 ** dy;
    place(P, o.assetIsX ? x : y, 'asset');
    place(P, o.assetIsX ? y : x, 'quote');
  }
  const bands: LiquidityBand[] = edges.map(([lo, hi], k) => {
    const above = lo >= mid;
    const amount = amounts[k] as number;
    return {
      priceLow: lo,
      priceHigh: hi,
      side: above ? 'asset' : 'quote',
      amount,
      amountUsd:
        o.quoteUsd === null ? null : above ? amount * mid * o.quoteUsd : amount * o.quoteUsd,
      liquidity: null,
    };
  });
  return totals(mid, bands, o.quoteUsd);
}

function totals(mid: number, bands: LiquidityBand[], quoteUsd: number | null): Distribution {
  const sum = (side: 'asset' | 'quote', k: 'amount' | 'amountUsd') =>
    bands.filter((b) => b.side === side).reduce((s, b) => s + ((b[k] as number | null) ?? 0), 0);
  return {
    midPrice: mid,
    bands,
    totalAsset: sum('asset', 'amount'),
    totalQuote: sum('quote', 'amount'),
    totalAssetUsd: quoteUsd === null ? null : sum('asset', 'amountUsd'),
    totalQuoteUsd: quoteUsd === null ? null : sum('quote', 'amountUsd'),
  };
}

// ---------------------------------------------------------------- from account bytes

export type PoolRow = {
  address: string;
  venue: string;
  assetMint: string;
  decimals0: number;
  decimals1: number;
  assetIsToken0: number;
};

/** Offsets at which a pool's tick or bin arrays hold the pool address: the collector's discovery filters. */
export const CHILD_OFFSETS: Record<string, number[]> = {
  raydium_clmm: [CLMM_TICK_ARRAY_POOL_OFFSET],
  orca_whirlpool: [WP_FIXED_TICK_ARRAY_POOL_OFFSET, WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET],
  meteora_dlmm: [DLMM_BIN_ARRAY_PAIR_OFFSET],
};

export const decimalsOf = (p: PoolRow) =>
  p.assetIsToken0
    ? { decAsset: p.decimals0, decQuote: p.decimals1 }
    : { decAsset: p.decimals1, decQuote: p.decimals0 };

/** The distribution from the pool head and its child accounts' bytes; null for a venue without ticks or bins. */
export function distributionFromBytes(
  p: PoolRow,
  head: Uint8Array,
  kids: Uint8Array[],
  o: { quoteUsd: number | null; bands: number; rangePct: number },
): Distribution | null {
  const dec = decimalsOf(p);
  if (p.venue === 'raydium_clmm') {
    const h = decodeClmmPool(head);
    const arrays = kids
      .map(decodeClmmTickArray)
      .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === p.address);
    return clDistribution(clmmState(h, 0, arrays), {
      assetIs0: h.mint0 === p.assetMint,
      ...dec,
      ...o,
    });
  }
  if (p.venue === 'orca_whirlpool') {
    const h = decodeWhirlpool(head);
    const arrays = kids
      .map((k) => decodeWpTickArray(k, h.tickSpacing))
      .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === p.address);
    return clDistribution(whirlpoolState(h, arrays), {
      assetIs0: h.mintA === p.assetMint,
      ...dec,
      ...o,
    });
  }
  if (p.venue === 'meteora_dlmm') {
    const h = decodeDlmmPair(head);
    const bins = kids
      .map(decodeDlmmBinArray)
      .filter((a) => a.pair === p.address)
      .flatMap((a) => a.bins);
    return dlmmDistribution(h, bins, { assetIsX: h.mintX === p.assetMint, ...dec, ...o });
  }
  return null;
}
