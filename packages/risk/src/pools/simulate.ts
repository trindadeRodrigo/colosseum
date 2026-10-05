import { type ClState, sqrtPriceAtTick, swapExactIn } from './cl-math';
import { type DlmmState, dlmmSwapExactIn } from './meteora-dlmm';
import { afterTransferFee, type CpState, cpSwapExactIn, type TransferFee } from './raydium-cpmm';

/**
 * One interface over every venue. Amounts are raw base units. "Asset" is the xStock side of the pool,
 * "quote" the other side. Transfer fees apply to whichever leg's mint charges them.
 */
export type PoolSim = {
  /** Mid price: quote raw units per asset raw unit. */
  midRaw: number;
  sellAsset: (assetRaw: number) => { out: number; unfilledShare: number };
  buyAsset: (quoteRaw: number) => { out: number; unfilledShare: number };
  /** Quote obtainable selling the asset down to −pct, and asset obtainable buying up to +pct (raw units). */
  depthWithin: (pct: number) => { sellQuoteOut: number; buyAssetOut: number };
};

export type SimFees = { asset?: TransferFee; quote?: TransferFee };

export function clSim(s: ClState, assetIs0: boolean, fees: SimFees = {}): PoolSim {
  const p01 = s.sqrtPrice ** 2; // token1 per token0
  const midRaw = assetIs0 ? p01 : 1 / p01;
  const run = (amount: number, zeroForOne: boolean) => swapExactIn(s, amount, zeroForOne);
  return {
    midRaw,
    sellAsset: (a) => {
      const r = run(afterTransferFee(a, fees.asset), assetIs0);
      return {
        out: afterTransferFee(r.amountOut, fees.quote),
        unfilledShare: a > 0 ? r.unfilledIn / a : 0,
      };
    },
    buyAsset: (q) => {
      const r = run(afterTransferFee(q, fees.quote), !assetIs0);
      return {
        out: afterTransferFee(r.amountOut, fees.asset),
        unfilledShare: q > 0 ? r.unfilledIn / q : 0,
      };
    },
    depthWithin: (pct) => ({
      sellQuoteOut: clDepthToPrice(s, assetIs0, pct, true),
      buyAssetOut: clDepthToPrice(s, assetIs0, pct, false),
    }),
  };
}

/**
 * Output obtainable moving the asset price by `pct` (sell: down, buy: up). Walks ticks with a price limit.
 * Selling the asset when it is token0 moves sqrtPrice down; when it is token1, moves it up.
 */
function clDepthToPrice(s: ClState, assetIs0: boolean, pct: number, sell: boolean): number {
  const zeroForOne = sell === assetIs0;
  // asset price change of ±pct → token1/token0 price change: same sign if asset is token0, inverse otherwise
  const factor01 = assetIs0 ? (sell ? 1 - pct : 1 + pct) : sell ? 1 / (1 - pct) : 1 / (1 + pct);
  const spLimit = s.sqrtPrice * Math.sqrt(factor01);
  let sp = s.sqrtPrice;
  let L = s.liquidity;
  let out = 0;
  const ticks = s.ticks;
  if (zeroForOne) {
    let i = ticks.length - 1;
    while (i >= 0 && (ticks[i] as { tick: number }).tick > s.tickCurrent) i--;
    while (sp > spLimit) {
      const next = i >= 0 ? ticks[i] : undefined;
      const spT = Math.max(next ? sqrtPriceAtTick(next.tick) : 0, spLimit);
      if (L > 0) out += L * (sp - spT); // token1 out
      sp = spT;
      if (!next || spT === spLimit) break;
      L -= next.liquidityNet;
      i--;
    }
  } else {
    let i = ticks.findIndex((t) => t.tick > s.tickCurrent);
    if (i < 0) i = ticks.length;
    while (sp < spLimit) {
      const next = i < ticks.length ? ticks[i] : undefined;
      const spT = Math.min(next ? sqrtPriceAtTick(next.tick) : Number.POSITIVE_INFINITY, spLimit);
      if (L > 0) out += L * (1 / sp - 1 / spT); // token0 out
      sp = spT;
      if (!next || spT === spLimit) break;
      L += next.liquidityNet;
      i++;
    }
  }
  return out;
}

export function dlmmSim(s: DlmmState, assetIsX: boolean, fees: SimFees = {}): PoolSim {
  const active = s.bins.find((b) => b.id === s.activeId);
  const nearest =
    active ??
    [...s.bins].sort((a, b) => Math.abs(a.id - s.activeId) - Math.abs(b.id - s.activeId))[0];
  const pYX = nearest?.price ?? 0; // y per x
  const midRaw = assetIsX ? pYX : pYX > 0 ? 1 / pYX : 0;
  return {
    midRaw,
    sellAsset: (a) => {
      const r = dlmmSwapExactIn(s, afterTransferFee(a, fees.asset), assetIsX);
      return {
        out: afterTransferFee(r.amountOut, fees.quote),
        unfilledShare: a > 0 ? r.unfilledIn / a : 0,
      };
    },
    buyAsset: (q) => {
      const r = dlmmSwapExactIn(s, afterTransferFee(q, fees.quote), !assetIsX);
      return {
        out: afterTransferFee(r.amountOut, fees.asset),
        unfilledShare: q > 0 ? r.unfilledIn / q : 0,
      };
    },
    depthWithin: (pct) => {
      // asset sell moves asset price down: bins at or below active (X→Y) if asset is X, else at or above
      const lo = pYX * (assetIsX ? 1 - pct : 1);
      const hi = pYX * (assetIsX ? 1 : 1 / (1 - pct));
      const loB = pYX * (assetIsX ? 1 : 1 / (1 + pct));
      const hiB = pYX * (assetIsX ? 1 + pct : 1);
      let sellQuoteOut = 0;
      let buyAssetOut = 0;
      for (const b of s.bins) {
        if (assetIsX) {
          if (b.id <= s.activeId && b.price >= lo && b.price <= hi) sellQuoteOut += b.amountY;
          if (b.id >= s.activeId && b.price >= loB && b.price <= hiB) buyAssetOut += b.amountX;
        } else {
          if (b.id >= s.activeId && b.price >= lo && b.price <= hi) sellQuoteOut += b.amountX;
          if (b.id <= s.activeId && b.price >= loB && b.price <= hiB) buyAssetOut += b.amountY;
        }
      }
      return { sellQuoteOut, buyAssetOut };
    },
  };
}

export function cpSim(
  reserveAsset: number,
  reserveQuote: number,
  feeRate: number,
  fees: SimFees = {},
): PoolSim {
  const sellState: CpState = { reserveIn: reserveAsset, reserveOut: reserveQuote, feeRate };
  const buyState: CpState = { reserveIn: reserveQuote, reserveOut: reserveAsset, feeRate };
  return {
    midRaw: reserveAsset > 0 ? reserveQuote / reserveAsset : 0,
    sellAsset: (a) => ({
      out: afterTransferFee(cpSwapExactIn(sellState, afterTransferFee(a, fees.asset)), fees.quote),
      unfilledShare: 0,
    }),
    buyAsset: (q) => ({
      out: afterTransferFee(cpSwapExactIn(buyState, afterTransferFee(q, fees.quote)), fees.asset),
      unfilledShare: 0,
    }),
    // constant product: price ratio r = (x0/x)^2 → selling down to (1−pct): Δquote = y0(1 − sqrt(1−pct))
    depthWithin: (pct) => ({
      sellQuoteOut: reserveQuote * (1 - Math.sqrt(1 - pct)),
      buyAssetOut: reserveAsset * (1 - 1 / Math.sqrt(1 + pct)),
    }),
  };
}

export type CurvePoint = {
  notionalUsd: number;
  outUsd: number;
  costPct: number;
  unfilledShare: number;
};

/**
 * Sell and buy curves in USD. `quoteUsd` is the USD value of one quote UI unit (1 for USDC; SOL price for
 * SOL pools, recorded with its source by the caller). Cost = 1 − outUsd / notionalUsd at the pool's mid.
 */
export function usdCurves(
  sim: PoolSim,
  decAsset: number,
  decQuote: number,
  quoteUsd: number,
  notionals: number[],
): { midUsd: number; sell: CurvePoint[]; buy: CurvePoint[] } {
  const midUi = sim.midRaw * 10 ** (decAsset - decQuote); // quote UI per asset UI
  const midUsd = midUi * quoteUsd;
  const sell = notionals.map((n) => {
    const assetRaw = Math.floor((n / midUsd) * 10 ** decAsset);
    const r = sim.sellAsset(assetRaw);
    const outUsd = (r.out / 10 ** decQuote) * quoteUsd;
    return {
      notionalUsd: n,
      outUsd,
      costPct: (1 - outUsd / n) * 100,
      unfilledShare: r.unfilledShare,
    };
  });
  const buy = notionals.map((n) => {
    const quoteRaw = Math.floor((n / quoteUsd) * 10 ** decQuote);
    const r = sim.buyAsset(quoteRaw);
    const outUsd = (r.out / 10 ** decAsset) * midUsd;
    return {
      notionalUsd: n,
      outUsd,
      costPct: (1 - outUsd / n) * 100,
      unfilledShare: r.unfilledShare,
    };
  });
  return { midUsd, sell, buy };
}
