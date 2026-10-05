import { Q64, Reader } from './bytes';

/**
 * Meteora DLMM: liquidity sits in discrete price bins with explicit token amounts, so depth is a walk
 * over bins from the active bin. Price per bin = y per x in raw units (Q64.64 on-chain).
 * Fee: base fee plus the variable fee at the pool's current volatility accumulator, applied to input.
 * The variable fee grows as a swap crosses bins; holding it at the current value understates the fee for
 * large swaps (a known optimism, measured against Jupiter in validation).
 */
export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const DLMM_BIN_ARRAY_PAIR_OFFSET = 24;
const BINS_PER_ARRAY = 70;
const BIN_SIZE = 144;
const FEE_PRECISION = 1e9;

export type DlmmPair = {
  baseFactor: number;
  variableFeeControl: number;
  baseFeePowerFactor: number;
  volatilityAccumulator: number;
  activeId: number;
  binStep: number;
  mintX: string;
  mintY: string;
  reserveX: string;
  reserveY: string;
};

export function decodeDlmmPair(data: Uint8Array): DlmmPair {
  const r = new Reader(data);
  return {
    baseFactor: r.u16(8),
    variableFeeControl: r.u32(16),
    baseFeePowerFactor: r.u8(34),
    volatilityAccumulator: r.u32(40),
    activeId: r.i32(76),
    binStep: r.u16(80),
    mintX: r.pubkey(88),
    mintY: r.pubkey(120),
    reserveX: r.pubkey(152),
    reserveY: r.pubkey(184),
  };
}

export type DlmmBin = { id: number; amountX: number; amountY: number; price: number };

export function decodeDlmmBinArray(data: Uint8Array): { pair: string; bins: DlmmBin[] } {
  const r = new Reader(data);
  const index = Number(r.i64(8));
  const pair = r.pubkey(DLMM_BIN_ARRAY_PAIR_OFFSET);
  const bins: DlmmBin[] = [];
  for (let k = 0; k < BINS_PER_ARRAY; k++) {
    const o = 56 + k * BIN_SIZE;
    const amountX = Number(r.u64(o));
    const amountY = Number(r.u64(o + 8));
    if (amountX === 0 && amountY === 0) continue;
    bins.push({
      id: index * BINS_PER_ARRAY + k,
      amountX,
      amountY,
      price: Number(r.u128(o + 16)) / Q64,
    });
  }
  return { pair, bins };
}

/** Total fee rate as a fraction, at the pool's current volatility accumulator, capped at 10%. */
export function dlmmFeeRate(p: DlmmPair): number {
  const base = p.baseFactor * p.binStep * 10 * 10 ** p.baseFeePowerFactor;
  const v = p.volatilityAccumulator * p.binStep;
  const variable = p.variableFeeControl > 0 ? Math.ceil((v * v * p.variableFeeControl) / 1e11) : 0;
  return Math.min(base + variable, 1e8) / FEE_PRECISION;
}

export type DlmmState = { activeId: number; feeRate: number; bins: DlmmBin[] };

/** Exact-input swap over bins. `xForY` sells token X for token Y (walks bins downward from the active bin). */
export function dlmmSwapExactIn(
  s: DlmmState,
  amountIn: number,
  xForY: boolean,
): { amountIn: number; amountOut: number; unfilledIn: number; binsCrossed: number } {
  let remaining = amountIn * (1 - s.feeRate);
  let out = 0;
  let crossed = 0;
  const bins = [...s.bins]
    .filter((b) =>
      xForY ? b.id <= s.activeId && b.amountY > 0 : b.id >= s.activeId && b.amountX > 0,
    )
    .sort((a, b) => (xForY ? b.id - a.id : a.id - b.id));
  for (const b of bins) {
    if (remaining <= 0) break;
    if (xForY) {
      const canIn = b.amountY / b.price;
      const take = Math.min(remaining, canIn);
      out += take * b.price;
      remaining -= take;
    } else {
      const canIn = b.amountX * b.price;
      const take = Math.min(remaining, canIn);
      out += take / b.price;
      remaining -= take;
    }
    crossed++;
  }
  const unfilledIn = remaining / (1 - s.feeRate);
  return { amountIn: amountIn - unfilledIn, amountOut: out, unfilledIn, binsCrossed: crossed };
}
