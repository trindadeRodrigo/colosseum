import { Q64, Reader } from './bytes';
import type { ClState, InitTick } from './cl-math';

/**
 * Raydium CLMM. Offsets checked against live pools on 2026-10-01. Byreal's pool account has this layout
 * (`decodeClmmPool` reads it); most of its tick arrays do not: they are a second kind of account, which
 * `decodeClmmTickArray` does not read, and its fee is its own (PLAN-UNIVERSE RU.13, 2026-10-07). Byreal is decoded
 * in `byreal-clmm.ts` (RU.15), which uses the readers of this file as they are.
 */
export const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
export const BYREAL_CLMM_PROGRAM = 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2';
export const CLMM_POOL_SIZE = 1544;
/** Tick arrays reference the pool at this offset (memcmp filter for getProgramAccounts). */
export const CLMM_TICK_ARRAY_POOL_OFFSET = 8;
const TICKS_PER_ARRAY = 60;
const TICK_SIZE = 168;

export type ClmmPool = {
  ammConfig: string;
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  decimals0: number;
  decimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
};

export function decodeClmmPool(data: Uint8Array): ClmmPool {
  const r = new Reader(data);
  if (data.length !== CLMM_POOL_SIZE) throw new Error(`clmm pool: size ${data.length}`);
  return {
    ammConfig: r.pubkey(9),
    mint0: r.pubkey(73),
    mint1: r.pubkey(105),
    vault0: r.pubkey(137),
    vault1: r.pubkey(169),
    decimals0: r.u8(233),
    decimals1: r.u8(234),
    tickSpacing: r.u16(235),
    liquidity: r.u128(237),
    sqrtPriceX64: r.u128(253),
    tickCurrent: r.i32(269),
  };
}

/** AmmConfig: trade_fee_rate in millionths. */
export function decodeClmmAmmConfig(data: Uint8Array): {
  tradeFeeRate: number;
  tickSpacing: number;
} {
  const r = new Reader(data);
  return { tradeFeeRate: r.u32(47), tickSpacing: r.u16(51) };
}

export type ClmmTickArray = { pool: string; startTickIndex: number; ticks: InitTick[] };

/** Returns null for accounts that are not fixed tick arrays (e.g. the bitmap extension). */
export function decodeClmmTickArray(data: Uint8Array): ClmmTickArray | null {
  const r = new Reader(data);
  if (data.length < 44 + TICKS_PER_ARRAY * TICK_SIZE) return null;
  const pool = r.pubkey(8);
  const startTickIndex = r.i32(40);
  const ticks: InitTick[] = [];
  for (let k = 0; k < TICKS_PER_ARRAY; k++) {
    const o = 44 + k * TICK_SIZE;
    const gross = r.u128(o + 20);
    if (gross === 0n) continue;
    const net = r.i128(o + 4);
    ticks.push({ tick: r.i32(o), liquidityNet: Number(net), net, gross });
  }
  return { pool, startTickIndex, ticks };
}

export function clmmState(
  pool: ClmmPool,
  feeRateMillionths: number,
  arrays: ClmmTickArray[],
): ClState {
  const ticks = arrays
    .flatMap((a) => a.ticks.map(({ tick, liquidityNet }) => ({ tick, liquidityNet })))
    .sort((a, b) => a.tick - b.tick);
  return {
    sqrtPrice: Number(pool.sqrtPriceX64) / Q64,
    tickCurrent: pool.tickCurrent,
    liquidity: Number(pool.liquidity),
    feeRate: feeRateMillionths / 1e6,
    ticks,
  };
}
