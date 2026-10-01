import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  afterTransferFee,
  type ClState,
  clmmState,
  cpSwapExactIn,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeDlmmBinArray,
  decodeDlmmPair,
  decodeWhirlpool,
  decodeWpTickArray,
  dlmmFeeRate,
  dlmmSwapExactIn,
  swapExactIn,
  whirlpoolState,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Fixtures: raw mainnet accounts plus Jupiter direct quotes through the same pool, captured together by
// scripts/risk/capture-pool-fixture.ts. Tolerances are per venue and documented in docs/risk/PLAN-RISK.md:
// Raydium CLMM is exact to float precision; DLMM and Orca carry dynamic fees not yet modelled.
type Fixture = {
  venue: 'raydium' | 'orca' | 'dlmm' | 'cpmm';
  outTransferFeeBps?: number;
  pool: string;
  inMint: string;
  accounts: Record<string, string>;
  children: Record<string, string>;
  quotes: Array<{ amountIn: string; outAmount: string | null; samePool: boolean }>;
};
const dir = 'fixtures/risk/pools';
const fixtures: Fixture[] = readdirSync(dir).map((f) =>
  JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString()),
);
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const TOL = { raydium: 1e-6, dlmm: 1e-4, orca: 1e-3, cpmm: 1e-9 };
// SPL token account: amount u64 at offset 64.
const tokenAmount = (d: Uint8Array) =>
  Number(new DataView(d.buffer, d.byteOffset).getBigUint64(64, true));

function simulate(fx: Fixture): { simulate: (amountIn: number) => number; invariant?: number } {
  const head = b(fx.accounts[fx.pool] as string);
  const kids = Object.values(fx.children).map(b);
  if (fx.venue === 'cpmm') {
    const p = decodeCpmmPool(head);
    const cfg = decodeCpmmAmmConfig(b(fx.accounts[p.ammConfig] as string));
    const r0 = tokenAmount(b(fx.accounts[p.vault0] as string)) - Number(p.owed0);
    const r1 = tokenAmount(b(fx.accounts[p.vault1] as string)) - Number(p.owed1);
    const zeroIn = p.mint0 === fx.inMint;
    const feeRate = (cfg.tradeFeeRate + (p.enableCreatorFee ? cfg.creatorFeeRate : 0)) / 1e6;
    const s = { reserveIn: zeroIn ? r0 : r1, reserveOut: zeroIn ? r1 : r0, feeRate };
    const fee = fx.outTransferFeeBps
      ? { bps: fx.outTransferFeeBps, maximumFee: Number.MAX_SAFE_INTEGER }
      : undefined;
    return { simulate: (x) => afterTransferFee(cpSwapExactIn(s, x), fee) };
  }
  if (fx.venue === 'dlmm') {
    const p = decodeDlmmPair(head);
    const bins = kids
      .map(decodeDlmmBinArray)
      .filter((a) => a.pair === fx.pool)
      .flatMap((a) => a.bins);
    const s = { activeId: p.activeId, feeRate: dlmmFeeRate(p), bins };
    return { simulate: (x) => dlmmSwapExactIn(s, x, p.mintX === fx.inMint).amountOut };
  }
  let state: ClState;
  let mint0: string;
  if (fx.venue === 'raydium') {
    const h = decodeClmmPool(head);
    const fee = decodeClmmAmmConfig(b(fx.accounts[h.ammConfig] as string)).tradeFeeRate;
    const arrays = kids.map(decodeClmmTickArray).filter((a) => a !== null && a.pool === fx.pool);
    state = clmmState(h, fee, arrays as NonNullable<(typeof arrays)[number]>[]);
    mint0 = h.mint0;
  } else {
    const h = decodeWhirlpool(head);
    const arrays = kids
      .map((k) => decodeWpTickArray(k, h.tickSpacing))
      .filter((a) => a !== null && a.pool === fx.pool);
    state = whirlpoolState(h, arrays as NonNullable<(typeof arrays)[number]>[]);
    mint0 = h.mintA;
  }
  const rebuilt = state.ticks
    .filter((t) => t.tick <= state.tickCurrent)
    .reduce((s, t) => s + t.liquidityNet, 0);
  return {
    simulate: (x) => swapExactIn(state, x, mint0 === fx.inMint).amountOut,
    invariant: Math.abs(rebuilt - state.liquidity) / state.liquidity,
  };
}

describe('pool decoders against frozen mainnet accounts', () => {
  for (const fx of fixtures) {
    it(`${fx.venue} ${fx.pool.slice(0, 6)}: decodes, rebuilds liquidity, matches Jupiter same-pool quotes`, () => {
      const sim = simulate(fx);
      if (sim.invariant !== undefined) expect(sim.invariant).toBeLessThan(1e-12);
      const checked = fx.quotes.filter((q) => q.samePool && q.outAmount);
      expect(checked.length).toBeGreaterThan(0);
      for (const q of checked) {
        const out = sim.simulate(Number(q.amountIn));
        const rel = Math.abs(out - Number(q.outAmount)) / Number(q.outAmount);
        expect(rel).toBeLessThan(TOL[fx.venue]);
      }
    });
  }
  it('is deterministic: same bytes, same output', () => {
    const fx = fixtures[0] as Fixture;
    const amt = Number(fx.quotes[0]?.amountIn);
    expect(simulate(fx).simulate(amt)).toBe(simulate(fx).simulate(amt));
  });
});
