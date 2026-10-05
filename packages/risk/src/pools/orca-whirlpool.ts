import { Q64, Reader } from './bytes';
import type { ClState, InitTick } from './cl-math';

/** Orca Whirlpool. Offsets checked against live pools on 2026-10-01 (invariant + Jupiter same-pool quotes). */
export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const TICKS_PER_ARRAY = 88;
/** Fixed tick array: 8 disc + 4 start + 88 × 113 ticks, then the whirlpool pubkey. */
export const WP_FIXED_TICK_ARRAY_POOL_OFFSET = 8 + 4 + TICKS_PER_ARRAY * 113;
/** Dynamic tick array: 8 disc + 4 start, then the whirlpool pubkey. */
export const WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET = 12;

export type WhirlpoolHeader = {
  tickSpacing: number;
  feeRate: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  mintA: string;
  vaultA: string;
  mintB: string;
  vaultB: string;
};

export function decodeWhirlpool(data: Uint8Array): WhirlpoolHeader {
  const r = new Reader(data);
  return {
    tickSpacing: r.u16(41),
    feeRate: r.u16(45),
    liquidity: r.u128(49),
    sqrtPriceX64: r.u128(65),
    tickCurrent: r.i32(81),
    mintA: r.pubkey(101),
    vaultA: r.pubkey(133),
    mintB: r.pubkey(181),
    vaultB: r.pubkey(213),
  };
}

export type WpTickArray = {
  pool: string;
  startTickIndex: number;
  ticks: InitTick[];
  kind: 'fixed' | 'dynamic';
};

export function decodeWpTickArray(data: Uint8Array, tickSpacing: number): WpTickArray | null {
  const r = new Reader(data);
  const start = r.i32(8);
  const ticks: InitTick[] = [];
  if (data.length === WP_FIXED_TICK_ARRAY_POOL_OFFSET + 32) {
    for (let k = 0; k < TICKS_PER_ARRAY; k++) {
      const o = 12 + k * 113;
      if (r.u8(o) === 0) continue;
      const net = r.i128(o + 1);
      ticks.push({
        tick: start + k * tickSpacing,
        liquidityNet: Number(net),
        net,
        gross: r.u128(o + 17),
      });
    }
    return {
      pool: r.pubkey(WP_FIXED_TICK_ARRAY_POOL_OFFSET),
      startTickIndex: start,
      ticks,
      kind: 'fixed',
    };
  }
  // dynamic: whirlpool at 12, tick bitmap u128 at 44, then per tick a tag byte (0 = empty, 1 = 112-byte data)
  let o = 60;
  for (let k = 0; k < TICKS_PER_ARRAY && o < data.length; k++) {
    const tag = r.u8(o);
    o += 1;
    if (tag === 0) continue;
    const net = r.i128(o);
    ticks.push({
      tick: start + k * tickSpacing,
      liquidityNet: Number(net),
      net,
      gross: r.u128(o + 16),
    });
    o += 112;
  }
  return {
    pool: r.pubkey(WP_DYNAMIC_TICK_ARRAY_POOL_OFFSET),
    startTickIndex: start,
    ticks,
    kind: 'dynamic',
  };
}

export function whirlpoolState(h: WhirlpoolHeader, arrays: WpTickArray[]): ClState {
  return {
    sqrtPrice: Number(h.sqrtPriceX64) / Q64,
    tickCurrent: h.tickCurrent,
    liquidity: Number(h.liquidity),
    feeRate: h.feeRate / 1e6,
    ticks: arrays
      .flatMap((a) => a.ticks.map(({ tick, liquidityNet }) => ({ tick, liquidityNet })))
      .filter((t) => t.liquidityNet !== 0)
      .sort((a, b) => a.tick - b.tick),
  };
}
