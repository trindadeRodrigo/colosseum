import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  clmmState,
  clSim,
  cpSim,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmTickArray,
  swapExactIn,
  usdCurves,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Uses the frozen QQQx/USDC Raydium CLMM fixture (raw mainnet accounts). Checks that the price-limited
// depth walk agrees with a fee-free swap ending at the same price, and that USD curves are monotone.
const fx = JSON.parse(
  gunzipSync(
    readFileSync(
      'fixtures/risk/pools/raydium-GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG.json.gz',
    ),
  ).toString(),
) as { pool: string; accounts: Record<string, string>; children: Record<string, string> };
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const h = decodeClmmPool(b(fx.accounts[fx.pool] as string));
const fee = decodeClmmAmmConfig(b(fx.accounts[h.ammConfig] as string)).tradeFeeRate;
const arrays = Object.values(fx.children)
  .map((c) => decodeClmmTickArray(b(c)))
  .filter((a) => a !== null && a.pool === fx.pool);
const state = clmmState(h, fee, arrays as NonNullable<(typeof arrays)[number]>[]);

describe('pool simulation interface', () => {
  it('depthWithin(pct) equals a fee-free swap that ends at the same price', () => {
    const feeless = { ...state, feeRate: 0 };
    const sim = clSim(feeless, true);
    for (const pct of [0.005, 0.02, 0.05]) {
      const target = state.sqrtPrice * Math.sqrt(1 - pct);
      // bisection on input amount until the swap ends at the target sqrt price
      let lo = 0;
      let hi = 1e18;
      for (let k = 0; k < 200; k++) {
        const mid = (lo + hi) / 2;
        if (swapExactIn(feeless, mid, true).sqrtPriceAfter > target) lo = mid;
        else hi = mid;
      }
      const viaSwap = swapExactIn(feeless, lo, true).amountOut;
      const viaWalk = sim.depthWithin(pct).sellQuoteOut;
      expect(Math.abs(viaWalk - viaSwap) / viaSwap).toBeLessThan(1e-6);
    }
  });

  it('USD sell and buy costs rise with size and are deterministic', () => {
    const sim = clSim(state, h.mint0 === 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ');
    const notionals = [100, 1_000, 10_000, 100_000];
    const c1 = usdCurves(sim, h.decimals0, h.decimals1, 1, notionals);
    const c2 = usdCurves(sim, h.decimals0, h.decimals1, 1, notionals);
    expect(c1).toEqual(c2);
    for (const side of [c1.sell, c1.buy]) {
      for (let i = 1; i < side.length; i++)
        expect((side[i] as { costPct: number }).costPct).toBeGreaterThanOrEqual(
          (side[i - 1] as { costPct: number }).costPct - 1e-9,
        );
      // the smallest trade costs at least the pool fee
      expect((side[0] as { costPct: number }).costPct).toBeGreaterThanOrEqual(fee / 1e4 - 1e-6);
    }
  });

  it('constant product depth matches its closed form', () => {
    const sim = cpSim(1_000_000, 5_000_000, 0);
    const d = sim.depthWithin(0.02);
    // selling until price falls 2%: Δx = x0(1/√0.98 − 1); output = y0 − k/(x0+Δx)
    const dx = 1_000_000 * (1 / Math.sqrt(0.98) - 1);
    const out = 5_000_000 - (1_000_000 * 5_000_000) / (1_000_000 + dx);
    expect(Math.abs(d.sellQuoteOut - out) / out).toBeLessThan(1e-12);
  });
});
