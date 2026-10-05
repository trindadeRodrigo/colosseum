/**
 * Concentrated-liquidity swap simulation (Uniswap-v3 family: Raydium CLMM, Orca Whirlpool, forks).
 * Works in real numbers: sqrtPrice = sqrt(token1 per token0) in raw units, liquidity L as a float.
 * Double precision is ~1e-15 relative, far below the precision a depth curve needs. The fee is taken
 * from the input before stepping (on-chain takes it per step; the difference is below one fee rounding).
 */
/** `net` / `gross` keep the exact on-chain i128 / u128 (the history replay compares them exactly). */
export type InitTick = { tick: number; liquidityNet: number; net?: bigint; gross?: bigint };

export type ClState = {
  sqrtPrice: number;
  tickCurrent: number;
  liquidity: number;
  /** Fee rate as a fraction (e.g. trade_fee_rate / 1e6). */
  feeRate: number;
  /** Initialized ticks, sorted ascending by tick. */
  ticks: InitTick[];
};

export const sqrtPriceAtTick = (tick: number) => Math.sqrt(1.0001 ** tick);

export type SwapResult = {
  amountIn: number;
  amountOut: number;
  /** Input left unfilled because liquidity ran out in the known tick range. */
  unfilledIn: number;
  sqrtPriceAfter: number;
  ticksCrossed: number;
};

/**
 * Exact-input swap. `zeroForOne` sells token0 for token1 (price falls). Amounts in raw base units.
 * Stops when the input is used or no further initialized tick is known (liquidity outside the fetched
 * tick arrays is treated as absent, which can only understate depth).
 */
export function swapExactIn(s: ClState, amountIn: number, zeroForOne: boolean): SwapResult {
  let remaining = amountIn * (1 - s.feeRate);
  let sp = s.sqrtPrice;
  let L = s.liquidity;
  let out = 0;
  let crossed = 0;
  if (zeroForOne) {
    // ticks at or below the current tick, descending
    let i = upperBound(s.ticks, s.tickCurrent) - 1;
    while (remaining > 0) {
      const next = i >= 0 ? s.ticks[i] : undefined;
      const spT = next ? sqrtPriceAtTick(next.tick) : 0;
      if (L > 0) {
        const dxToTarget = next ? L * (1 / spT - 1 / sp) : Number.POSITIVE_INFINITY;
        if (remaining < dxToTarget) {
          const spNew = (L * sp) / (L + remaining * sp);
          out += L * (sp - spNew);
          sp = spNew;
          remaining = 0;
          break;
        }
        out += L * (sp - spT);
        remaining -= dxToTarget;
      }
      if (!next) break;
      sp = spT;
      L -= next.liquidityNet;
      crossed++;
      i--;
    }
  } else {
    let i = upperBound(s.ticks, s.tickCurrent);
    while (remaining > 0) {
      const next = i < s.ticks.length ? s.ticks[i] : undefined;
      const spT = next ? sqrtPriceAtTick(next.tick) : Number.POSITIVE_INFINITY;
      if (L > 0) {
        const dyToTarget = next ? L * (spT - sp) : Number.POSITIVE_INFINITY;
        if (remaining < dyToTarget) {
          const spNew = sp + remaining / L;
          out += L * (1 / sp - 1 / spNew);
          sp = spNew;
          remaining = 0;
          break;
        }
        out += L * (1 / sp - 1 / spT);
        remaining -= dyToTarget;
      }
      if (!next) break;
      sp = spT;
      L += next.liquidityNet;
      crossed++;
      i++;
    }
  }
  const unfilledIn = remaining / (1 - s.feeRate);
  return {
    amountIn: amountIn - unfilledIn,
    amountOut: out,
    unfilledIn,
    sqrtPriceAfter: sp,
    ticksCrossed: crossed,
  };
}

/** First index whose tick is > t. */
function upperBound(ticks: InitTick[], t: number): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ticks[mid] as InitTick).tick <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
