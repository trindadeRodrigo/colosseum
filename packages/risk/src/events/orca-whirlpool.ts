import { Reader } from '../pools/bytes';
import { ORCA_WHIRLPOOL_PROGRAM } from '../pools/orca-whirlpool';
import { discOf, eventDisc, type LogFrame, type PoolEvent } from './logs';

// Orca Whirlpool events (Anchor `emit!`), checked against live transactions (tests/risk-layer/events.test.ts):
//   Traded (121) whirlpool@8 aToB@40 preSqrtPrice@41 postSqrtPrice@57 input@73 output@81 inputTransferFee@89
//     outputTransferFee@97 lpFee@105 protocolFee@113   (no post liquidity or tick: the replay derives them)
//   LiquidityIncreased / LiquidityDecreased (128) whirlpool@8 position@40 tickLower@72 tickUpper@76
//     liquidity@80 amountA@96 amountB@104 transferFeeA@112 transferFeeB@120
//   PositionOpened (80) whirlpool@8 position@40 tickLower@72 tickUpper@76 (empty; an increase follows)
//   LiquidityRepositioned (186) whirlpool@8 position@40 existingTickLower@72 existingTickUpper@76 newTickLower@80
//     newTickUpper@84 existingLiquidity@88 newLiquidity@104 existingAmountA@120 existingAmountB@128 newAmountA@136
//     newAmountB@144 …   (a position moved to a new range in one instruction, logged without an instruction name:
//     emitted as a decrease of the old range and an increase of the new one; the vaults move by new − existing)
// Token A is token 0. Fees are collected by a separate instruction, so a decrease pays principal only.
export const WP_EVENTS = {
  traded: eventDisc('Traded'),
  increased: eventDisc('LiquidityIncreased'),
  decreased: eventDisc('LiquidityDecreased'),
  opened: eventDisc('PositionOpened'),
  repositioned: eventDisc('LiquidityRepositioned'),
};

export function decodeWhirlpoolFrames(
  frames: readonly LogFrame[],
  pool: string,
  program = ORCA_WHIRLPOOL_PROGRAM,
): PoolEvent[] {
  const out: PoolEvent[] = [];
  frames.forEach((f, ixIndex) => {
    if (f.program !== program || !f.ok) return;
    let opened = false;
    for (const d of f.data) {
      const k = discOf(d);
      const r = new Reader(d);
      if (d.length < 40 || r.pubkey(8) !== pool) continue;
      if (k === WP_EVENTS.traded && d.length === 121) {
        const aToB = r.u8(40) === 1;
        const input = r.u64(73);
        const output = r.u64(81);
        out.push({
          kind: 'swap',
          pool,
          ixIndex,
          amount0: (aToB ? input : output).toString(),
          amount1: (aToB ? output : input).toString(),
          zeroForOne: aToB,
          sqrtPriceX64: r.u128(57).toString(),
          preSqrtPriceX64: r.u128(41).toString(),
        });
      } else if (k === WP_EVENTS.opened && d.length === 80) opened = true;
      else if (k === WP_EVENTS.repositioned && d.length >= 152) {
        const position = r.pubkey(40);
        out.push(
          {
            kind: 'liquidity',
            pool,
            ixIndex,
            action: 'decrease',
            tickLower: r.i32(72),
            tickUpper: r.i32(76),
            liquidityDelta: (-r.u128(88)).toString(),
            amount0: r.u64(120).toString(),
            amount1: r.u64(128).toString(),
            position,
          },
          {
            kind: 'liquidity',
            pool,
            ixIndex,
            action: 'increase',
            tickLower: r.i32(80),
            tickUpper: r.i32(84),
            liquidityDelta: r.u128(104).toString(),
            amount0: r.u64(136).toString(),
            amount1: r.u64(144).toString(),
            position,
          },
        );
      } else if ((k === WP_EVENTS.increased || k === WP_EVENTS.decreased) && d.length === 128) {
        const dec = k === WP_EVENTS.decreased;
        const liq = r.u128(80);
        out.push({
          kind: 'liquidity',
          pool,
          ixIndex,
          action: dec ? 'decrease' : opened ? 'open' : 'increase',
          tickLower: r.i32(72),
          tickUpper: r.i32(76),
          liquidityDelta: (dec ? -liq : liq).toString(),
          amount0: r.u64(96).toString(),
          amount1: r.u64(104).toString(),
          position: r.pubkey(40),
        });
      }
    }
  });
  return out;
}
