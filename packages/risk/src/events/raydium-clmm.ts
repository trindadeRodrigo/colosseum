import { Reader } from '../pools/bytes';
import { RAYDIUM_CLMM_PROGRAM } from '../pools/raydium-clmm';
import { discOf, eventDisc, type LogFrame, type PoolEvent } from './logs';

// Raydium CLMM events (Anchor `emit!`, so they appear as `Program data:` in the program's own frame).
// Layouts were checked against live transactions (tests/risk-layer/events.test.ts):
//   SwapEvent (205 or 221 bytes) pool@8 … amount0@136 fee0@144 amount1@152 fee1@160 zeroForOne@168
//     sqrtPriceX64@169 liquidity@185 tick@201
//   LiquidityChangeEvent (84) pool@8 tick@40 tickLower@44 tickUpper@48 liquidityBefore@52 liquidityAfter@68
//     (pool active liquidity, so before ≠ after only when the range spans the current tick)
//   CreatePersonalPositionEvent (160) pool@8 minter@40 nftOwner@72 tickLower@104 tickUpper@108 liquidity@112
//     amount0@128 amount1@136
//   IncreaseLiquidityEvent (88) positionNftMint@8 liquidity@40 amount0@56 amount1@64
//   DecreaseLiquidityEvent (128) positionNftMint@8 liquidity@40 amount0@56 amount1@64 fee0@72 fee1@80
//     (the vaults pay amount + fee)
// Each liquidity instruction emits one LiquidityChangeEvent (range) and one Create/Increase/Decrease (delta).
// ClosePosition names no pool and moves no liquidity (it needs liquidity 0), so it is not emitted here.
const D = {
  swap: eventDisc('SwapEvent'),
  change: eventDisc('LiquidityChangeEvent'),
  create: eventDisc('CreatePersonalPositionEvent'),
  increase: eventDisc('IncreaseLiquidityEvent'),
  decrease: eventDisc('DecreaseLiquidityEvent'),
};

export function decodeRaydiumClmmFrames(
  frames: readonly LogFrame[],
  pool: string,
  program = RAYDIUM_CLMM_PROGRAM,
): PoolEvent[] {
  const out: PoolEvent[] = [];
  frames.forEach((f, ixIndex) => {
    if (f.program !== program || !f.ok) return;
    let change: Reader | undefined;
    let delta: { action: 'open' | 'increase' | 'decrease'; r: Reader } | undefined;
    for (const d of f.data) {
      const k = discOf(d);
      const r = new Reader(d);
      if (k === D.swap && d.length >= 205) {
        if (r.pubkey(8) !== pool) continue;
        out.push({
          kind: 'swap',
          pool,
          ixIndex,
          amount0: r.u64(136).toString(),
          amount1: r.u64(152).toString(),
          zeroForOne: r.u8(168) === 1,
          sqrtPriceX64: r.u128(169).toString(),
          liquidity: r.u128(185).toString(),
          tick: r.i32(201),
        });
      } else if (k === D.change && d.length === 84) change = r;
      else if (k === D.create && d.length === 160) delta = { action: 'open', r };
      else if (k === D.increase && d.length === 88) delta = { action: 'increase', r };
      else if (k === D.decrease && d.length === 128) delta = { action: 'decrease', r };
    }
    if (change && delta && change.pubkey(8) === pool) {
      const r = delta.r;
      const open = delta.action === 'open';
      const liq = open ? r.u128(112) : r.u128(40);
      out.push({
        kind: 'liquidity',
        pool,
        ixIndex,
        action: delta.action,
        tickLower: change.i32(44),
        tickUpper: change.i32(48),
        liquidityDelta: (delta.action === 'decrease' ? -liq : liq).toString(),
        amount0: (open ? r.u64(128) : r.u64(56)).toString(),
        amount1: (open ? r.u64(136) : r.u64(64)).toString(),
        ...(open ? { owner: r.pubkey(72) } : { position: r.pubkey(8) }),
        ...(delta.action === 'decrease'
          ? { fee0: r.u64(72).toString(), fee1: r.u64(80).toString() }
          : {}),
        tick: change.i32(40),
        poolLiquidityBefore: change.u128(52).toString(),
        poolLiquidityAfter: change.u128(68).toString(),
      });
    }
  });
  return out;
}
