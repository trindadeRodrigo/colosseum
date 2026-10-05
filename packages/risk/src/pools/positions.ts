import { Reader } from './bytes';
import type { ClState } from './cl-math';

/**
 * Concentrated-liquidity positions (Raydium CLMM personal positions, Orca Whirlpool positions) and LP
 * concentration. A position is the unit an LP withdraws; owners are resolved separately (position NFT holder).
 * Check: the liquidity of positions spanning the current tick sums to the pool's active liquidity.
 */
export const CLMM_POSITION_SIZE = 281;
export const CLMM_POSITION_POOL_OFFSET = 41;
export const WP_POSITION_SIZE = 216;
export const WP_POSITION_POOL_OFFSET = 8;

export type ClPosition = {
  address: string;
  nftMint: string;
  tickLower: number;
  tickUpper: number;
  liquidity: number;
};

export function decodeClmmPosition(
  address: string,
  data: Uint8Array,
): ClPosition & { pool: string } {
  const r = new Reader(data);
  return {
    address,
    nftMint: r.pubkey(9),
    pool: r.pubkey(41),
    tickLower: r.i32(73),
    tickUpper: r.i32(77),
    liquidity: Number(r.u128(81)),
  };
}

export function decodeWpPosition(address: string, data: Uint8Array): ClPosition & { pool: string } {
  const r = new Reader(data);
  return {
    address,
    pool: r.pubkey(8),
    nftMint: r.pubkey(40),
    liquidity: Number(r.u128(72)),
    tickLower: r.i32(88),
    tickUpper: r.i32(92),
  };
}

/** Active liquidity implied by positions at `tick` (positions with tickLower ≤ tick < tickUpper). */
export const activeFromPositions = (ps: ClPosition[], tick: number) =>
  ps.reduce((s, p) => s + (p.tickLower <= tick && tick < p.tickUpper ? p.liquidity : 0), 0);

/**
 * Liquidity a position contributes inside the band [tickCurrent − w, tickCurrent + w], measured as
 * liquidity × overlapping tick width (a proxy for in-band depth that is additive across positions).
 */
export function inBandWeight(p: ClPosition, tickCurrent: number, bandTicks: number): number {
  const lo = Math.max(p.tickLower, tickCurrent - bandTicks);
  const hi = Math.min(p.tickUpper, tickCurrent + bandTicks);
  return hi > lo ? p.liquidity * (hi - lo) : 0;
}

/** Ticks spanned by a ±pct price move: ln(1 ± pct) / ln(1.0001). */
export const bandTicksFor = (pct: number) => Math.ceil(Math.log(1 + pct) / Math.log(1.0001));

export type Concentration = {
  positions: number;
  inBandPositions: number;
  /** Share of in-band weight held by the top 1, 3 and 10 holders (owners when known, else positions). */
  top1: number;
  top3: number;
  top10: number;
  holderKind: 'owner' | 'position';
};

export function concentration(
  ps: ClPosition[],
  tickCurrent: number,
  bandPct: number,
  ownerOf?: (p: ClPosition) => string | undefined,
): Concentration {
  const w = bandTicksFor(bandPct);
  const byHolder = new Map<string, number>();
  let inBand = 0;
  for (const p of ps) {
    const x = inBandWeight(p, tickCurrent, w);
    if (x <= 0) continue;
    inBand++;
    const k = ownerOf?.(p) ?? p.address;
    byHolder.set(k, (byHolder.get(k) ?? 0) + x);
  }
  const vals = [...byHolder.values()].sort((a, b) => b - a);
  const total = vals.reduce((s, v) => s + v, 0);
  const top = (n: number) => (total > 0 ? vals.slice(0, n).reduce((s, v) => s + v, 0) / total : 0);
  return {
    positions: ps.length,
    inBandPositions: inBand,
    top1: top(1),
    top3: top(3),
    top10: top(10),
    holderKind: ownerOf ? 'owner' : 'position',
  };
}

/**
 * The pool state with the given positions withdrawn: each removed position subtracts its liquidity at
 * tickLower (liquidityNet −= L) and adds it back at tickUpper (liquidityNet += L), and leaves the active
 * liquidity if it spans the current tick. This is the LP-exit stress.
 */
export function withoutPositions(s: ClState, removed: ClPosition[]): ClState {
  const net = new Map(s.ticks.map((t) => [t.tick, t.liquidityNet]));
  let L = s.liquidity;
  for (const p of removed) {
    net.set(p.tickLower, (net.get(p.tickLower) ?? 0) - p.liquidity);
    net.set(p.tickUpper, (net.get(p.tickUpper) ?? 0) + p.liquidity);
    if (p.tickLower <= s.tickCurrent && s.tickCurrent < p.tickUpper) L -= p.liquidity;
  }
  const ticks = [...net.entries()]
    .filter(([, v]) => Math.abs(v) > 0)
    .map(([tick, liquidityNet]) => ({ tick, liquidityNet }))
    .sort((a, b) => a.tick - b.tick);
  return { ...s, liquidity: Math.max(0, L), ticks };
}
