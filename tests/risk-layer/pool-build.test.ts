import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  buildPoolSim,
  clmmState,
  clSim,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeDlmmBinArray,
  decodeDlmmPair,
  decodeWhirlpool,
  decodeWpTickArray,
  dlmmFeeRate,
  dlmmSim,
  whirlpoolState,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 4: buildPoolSim (the collector's `build` as a pure function) gives the same simulator as the
// venue decoders assembled by hand, on the frozen mainnet pools of fixtures/risk/pools.
type Fx = {
  pool: string;
  inMint: string;
  accounts: Record<string, string>;
  children: Record<string, string>;
};
const load = (f: string) =>
  JSON.parse(gunzipSync(readFileSync(`fixtures/risk/pools/${f}`)).toString()) as Fx;
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const kids = (fx: Fx) => Object.values(fx.children).map(b);
const ref = (
  fx: Fx,
  venue: 'raydium_clmm' | 'orca_whirlpool' | 'meteora_dlmm',
  assetIsToken0: boolean,
) => ({
  address: fx.pool,
  venue,
  assetMint: fx.inMint,
  assetIsToken0,
  transferFeeBps0: 0,
  transferFeeBps1: 0,
});
const sizes = [1e6, 1e8, 1e10, 1e12];

describe('buildPoolSim', () => {
  it('Raydium CLMM: same sim and fee rate as the decoders by hand', () => {
    const fx = load('raydium-GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG.json.gz');
    const h = decodeClmmPool(b(fx.accounts[fx.pool] as string));
    const cfg = b(fx.accounts[h.ammConfig] as string);
    const arrays = kids(fx)
      .map(decodeClmmTickArray)
      .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === fx.pool);
    const s = clmmState(h, decodeClmmAmmConfig(cfg).tradeFeeRate, arrays);
    const hand = clSim(s, h.mint0 === fx.inMint);
    const built = buildPoolSim(
      ref(fx, 'raydium_clmm', h.mint0 === fx.inMint),
      b(fx.accounts[fx.pool] as string),
      kids(fx),
      cfg,
    );
    expect(built.feeRate).toBe(s.feeRate);
    expect(built.invariantRelErr).toBeLessThan(1e-9);
    for (const x of sizes) expect(built.sim.sellAsset(x)).toEqual(hand.sellAsset(x));
  });

  it('Orca: same sim and fee rate', () => {
    const fx = load('orca-Fae5dWVntUt6zbWu2voXxioDpMii7SqQwtsxBmoVCsHR.json.gz');
    const head = b(fx.accounts[fx.pool] as string);
    const h = decodeWhirlpool(head);
    const arrays = kids(fx)
      .map((k) => decodeWpTickArray(k, h.tickSpacing))
      .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === fx.pool);
    const s = whirlpoolState(h, arrays);
    const hand = clSim(s, h.mintA === fx.inMint);
    const built = buildPoolSim(ref(fx, 'orca_whirlpool', h.mintA === fx.inMint), head, kids(fx));
    expect(built.feeRate).toBe(s.feeRate);
    for (const x of sizes) expect(built.sim.sellAsset(x)).toEqual(hand.sellAsset(x));
  });

  it('Meteora DLMM: same sim and fee rate', () => {
    const fx = load('dlmm-5JWX8pQhJNpFMjPwKhFSSVWRpss4wSyoqgRGnBNJfyuX.json.gz');
    const head = b(fx.accounts[fx.pool] as string);
    const p = decodeDlmmPair(head);
    const bins = kids(fx)
      .map(decodeDlmmBinArray)
      .filter((a) => a.pair === fx.pool)
      .flatMap((a) => a.bins);
    const hand = dlmmSim(
      { activeId: p.activeId, feeRate: dlmmFeeRate(p), bins },
      p.mintX === fx.inMint,
    );
    const built = buildPoolSim(ref(fx, 'meteora_dlmm', p.mintX === fx.inMint), head, kids(fx));
    expect(built.feeRate).toBe(dlmmFeeRate(p));
    for (const x of sizes) expect(built.sim.sellAsset(x)).toEqual(hand.sellAsset(x));
  });
});
