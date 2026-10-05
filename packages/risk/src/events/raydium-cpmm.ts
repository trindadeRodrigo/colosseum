import { Reader } from '../pools/bytes';
import { RAYDIUM_CPMM_PROGRAM } from '../pools/raydium-cpmm';
import { discOf, eventDisc, type LogFrame, type PoolEvent } from './logs';

// Raydium CPMM events, checked against live transactions (tests/risk-layer/events.test.ts):
//   SwapEvent (170) pool@8 inputVaultBefore@40 outputVaultBefore@48 input@56 output@64 inputTransferFee@72
//     outputTransferFee@80 baseInput@88 inputMint@89 outputMint@121 tradeFee@153 creatorFee@161
//     creatorFeeOnInput@169
//   LpChangeEvent: user@8 pool@40 lpBefore@72 vault0Before@80 vault1Before@88 amount0@96 amount1@104
//     transferFee0@112 transferFee1@120 changeType@128 (0 = deposit, 1 = withdraw)
// A constant-product pool's state is its two reserves, so the vault balances in each row are the state.
export const CPMM_EVENTS = { swap: eventDisc('SwapEvent'), lp: eventDisc('LpChangeEvent') };

export function decodeCpmmFrames(
  frames: readonly LogFrame[],
  pool: string,
  mint0: string,
  program = RAYDIUM_CPMM_PROGRAM,
): PoolEvent[] {
  const out: PoolEvent[] = [];
  frames.forEach((f, ixIndex) => {
    if (f.program !== program || !f.ok) return;
    for (const d of f.data) {
      const k = discOf(d);
      const r = new Reader(d);
      if (k === CPMM_EVENTS.swap && d.length >= 153 && r.pubkey(8) === pool) {
        const zeroForOne = r.pubkey(89) === mint0;
        const input = r.u64(56);
        const output = r.u64(64);
        out.push({
          kind: 'swap',
          pool,
          ixIndex,
          amount0: (zeroForOne ? input : output).toString(),
          amount1: (zeroForOne ? output : input).toString(),
          zeroForOne,
        });
      } else if (k === CPMM_EVENTS.lp && d.length >= 129 && r.pubkey(40) === pool) {
        const withdraw = r.u8(128) === 1;
        out.push({
          kind: 'liquidity',
          pool,
          ixIndex,
          action: withdraw ? 'decrease' : 'increase',
          amount0: r.u64(96).toString(),
          amount1: r.u64(104).toString(),
          owner: r.pubkey(8),
        });
      }
    }
  });
  return out;
}
