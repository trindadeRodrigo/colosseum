import { byrealClState } from './byreal-clmm';
import type { ClState } from './cl-math';
import { decodeDlmmBinArray, decodeDlmmPair, dlmmFeeRate } from './meteora-dlmm';
import { decodeWhirlpool, decodeWpTickArray, whirlpoolState } from './orca-whirlpool';
import {
  clmmState,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmTickArray,
} from './raydium-clmm';
import { decodeCpmmAmmConfig, decodeCpmmPool } from './raydium-cpmm';
import { clSim, cpSim, dlmmSim, type PoolSim } from './simulate';

/**
 * One pool's simulator and fee rate from its account bytes (PLAN-ANALYTICS item 4): the pool collector's `build`
 * (scripts/risk/collector/pools.ts, not edited before Oct 12) as a pure function, decoding the tick or bin arrays
 * from the child accounts as the collector does when it refreshes its tick map.
 */
export type PoolRef = {
  address: string;
  /** `byreal_clmm` is never in the collector's registry: only a caller that found the pool itself names it. */
  venue: 'raydium_clmm' | 'orca_whirlpool' | 'meteora_dlmm' | 'raydium_cpmm' | 'byreal_clmm';
  assetMint: string;
  assetIsToken0: boolean;
  transferFeeBps0: number;
  transferFeeBps1: number;
};

export type BuiltPool = {
  sim: PoolSim;
  /** Pool fee rate as a fraction (Orca: the static rate; DLMM: at the current volatility accumulator). */
  feeRate: number;
  /** Concentrated liquidity: |Σ liquidityNet below the price − liquidity| ÷ liquidity; null for other venues. */
  invariantRelErr: number | null;
};

export function buildPoolSim(
  p: PoolRef,
  head: Uint8Array,
  children: Uint8Array[],
  config?: Uint8Array,
  vaults: [Uint8Array | undefined, Uint8Array | undefined] = [undefined, undefined],
): BuiltPool {
  const fees = {
    asset: {
      bps: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
      maximumFee: Number.MAX_SAFE_INTEGER,
    },
    quote: {
      bps: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
      maximumFee: Number.MAX_SAFE_INTEGER,
    },
  };
  const inv = (s: ClState) => {
    const rebuilt = s.ticks
      .filter((t) => t.tick <= s.tickCurrent)
      .reduce((a, t) => a + t.liquidityNet, 0);
    return s.liquidity > 0 ? Math.abs(rebuilt - s.liquidity) / s.liquidity : rebuilt === 0 ? 0 : 1;
  };
  if (p.venue === 'raydium_clmm') {
    const h = decodeClmmPool(head);
    const fee = config ? decodeClmmAmmConfig(config).tradeFeeRate : 0;
    const arrays = children
      .map(decodeClmmTickArray)
      .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === p.address);
    const s = clmmState(h, fee, arrays);
    return {
      sim: clSim(s, h.mint0 === p.assetMint, fees),
      feeRate: s.feeRate,
      invariantRelErr: inv(s),
    };
  }
  if (p.venue === 'orca_whirlpool') {
    const h = decodeWhirlpool(head);
    const arrays = children
      .map((c) => decodeWpTickArray(c, h.tickSpacing))
      .filter((a): a is NonNullable<typeof a> => a !== null && a.pool === p.address);
    const s = whirlpoolState(h, arrays);
    return {
      sim: clSim(s, h.mintA === p.assetMint, fees),
      feeRate: s.feeRate,
      invariantRelErr: inv(s),
    };
  }
  if (p.venue === 'byreal_clmm') {
    // Raydium's pool account with Byreal's own arrays and fee. Unlike the four above, it is not built at all without
    // its fee config, with a fee it cannot price or with arrays that do not add up exactly: `byrealClState` throws.
    if (!config) throw new Error('byreal pool: no fee config read');
    const { pool: h, state: s } = byrealClState(p.address, head, config, children);
    return {
      sim: clSim(s, h.mint0 === p.assetMint, fees),
      feeRate: s.feeRate,
      invariantRelErr: inv(s),
    };
  }
  if (p.venue === 'meteora_dlmm') {
    const h = decodeDlmmPair(head);
    const bins = children
      .map(decodeDlmmBinArray)
      .filter((a) => a.pair === p.address)
      .flatMap((a) => a.bins);
    const feeRate = dlmmFeeRate(h);
    return {
      sim: dlmmSim({ activeId: h.activeId, feeRate, bins }, h.mintX === p.assetMint, fees),
      feeRate,
      invariantRelErr: null,
    };
  }
  const h = decodeCpmmPool(head);
  const c = config ? decodeCpmmAmmConfig(config) : { tradeFeeRate: 0, creatorFeeRate: 0 };
  const amt = (d?: Uint8Array) =>
    d && d.length >= 72 ? Number(new DataView(d.buffer, d.byteOffset).getBigUint64(64, true)) : 0;
  const r0 = amt(vaults[0]) - Number(h.owed0);
  const r1 = amt(vaults[1]) - Number(h.owed1);
  const assetIs0 = h.mint0 === p.assetMint;
  const feeRate = (c.tradeFeeRate + (h.enableCreatorFee ? c.creatorFeeRate : 0)) / 1e6;
  return {
    sim: cpSim(assetIs0 ? r0 : r1, assetIs0 ? r1 : r0, feeRate, fees),
    feeRate,
    invariantRelErr: null,
  };
}
