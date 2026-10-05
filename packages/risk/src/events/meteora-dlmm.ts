import { getBase58Encoder } from '@solana/kit';
import { Reader } from '../pools/bytes';
import { METEORA_DLMM_PROGRAM } from '../pools/meteora-dlmm';
import { discOf, eventDisc, type PoolEvent } from './logs';
import type { RpcTx } from './tx';

// Meteora DLMM emits Anchor `emit_cpi!` events: a self-invocation whose instruction data is
// EVENT_IX_TAG (e445a52e51cb9a1d) + event discriminator + fields, so they live in innerInstructions, not
// logs. Layouts (offsets include the 16-byte prefix), checked on live transactions:
//   Swap (145) lbPair@16 from@48 startBinId@80 endBinId@84 amountIn@88 amountOut@96 swapForY@104 fee@105
//     protocolFee@113 feeBps@121 hostFee@137
//   AddLiquidity / RemoveLiquidity (132) lbPair@16 from@48 position@80 amountX@112 amountY@120 activeBinId@128
//   PositionCreate (112) lbPair@16 position@48 owner@80
//   ClaimFee (128) lbPair@16 position@48 owner@80 feeX@112 feeY@120
// X is token 0. Events carry totals, not the per-bin split, so DLMM history has no exact bin layout replay;
// its completeness check is the vault-balance chain.
export const EVENT_IX_TAG = 'e445a52e51cb9a1d';
export const DLMM_EVENTS = {
  swap: eventDisc('Swap'),
  add: eventDisc('AddLiquidity'),
  remove: eventDisc('RemoveLiquidity'),
  create: eventDisc('PositionCreate'),
  claimFee: eventDisc('ClaimFee'),
};
/** Events read, plus ones that change no reserve or layout. 2e7452d7941b544d (163 bytes) repeats the
 *  Swap fields (lbPair, bins, amounts, fee) in a newer layout. */
export const DLMM_KNOWN = new Set([
  ...Object.values(DLMM_EVENTS),
  ...[
    'PositionClose',
    'CompositionFee',
    'ClaimFee2',
    'ClaimReward',
    'ClaimReward2',
    'IncreasePositionLength',
    'DecreasePositionLength',
    'Rebalancing',
    'UpdatePositionLockReleasePoint',
    'DynamicFeeParameterUpdate',
    'IncreaseObservation',
  ].map(eventDisc),
  '2e7452d7941b544d',
]);

const b58 = getBase58Encoder();

/** All DLMM event payloads in a transaction, as [innerGroupIndex, bytes without the 8-byte tag]. */
export function dlmmEventPayloads(
  tx: RpcTx,
  keys: readonly string[],
  program = METEORA_DLMM_PROGRAM,
) {
  const out: Array<[number, Uint8Array]> = [];
  for (const g of tx.meta?.innerInstructions ?? [])
    for (const ix of g.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      const d = new Uint8Array(b58.encode(ix.data));
      if (d.length >= 16 && discOf(d) === EVENT_IX_TAG) out.push([g.index, d]);
    }
  return out;
}

export function decodeDlmmEvents(
  payloads: ReadonlyArray<[number, Uint8Array]>,
  pool: string,
): PoolEvent[] {
  const out: PoolEvent[] = [];
  for (const [ixIndex, d] of payloads) {
    const k = discOf(d.subarray(8));
    const r = new Reader(d);
    if (d.length < 48 || r.pubkey(16) !== pool) continue;
    if (k === DLMM_EVENTS.swap && d.length >= 145) {
      const forY = r.u8(104) === 1;
      const amountIn = r.u64(88) - r.u64(137); // the host fee leaves with the swap, not into the vault
      const amountOut = r.u64(96);
      out.push({
        kind: 'swap',
        pool,
        ixIndex,
        amount0: (forY ? amountIn : amountOut).toString(),
        amount1: (forY ? amountOut : amountIn).toString(),
        zeroForOne: forY,
        activeId: r.i32(84),
      });
    } else if ((k === DLMM_EVENTS.add || k === DLMM_EVENTS.remove) && d.length >= 132)
      out.push({
        kind: 'liquidity',
        pool,
        ixIndex,
        action: k === DLMM_EVENTS.add ? 'increase' : 'decrease',
        amount0: r.u64(112).toString(),
        amount1: r.u64(120).toString(),
        position: r.pubkey(80),
        tick: r.i32(128),
      });
    else if (k === DLMM_EVENTS.create && d.length >= 112)
      out.push({
        kind: 'liquidity',
        pool,
        ixIndex,
        action: 'open',
        amount0: '0',
        amount1: '0',
        position: r.pubkey(48),
        owner: r.pubkey(80),
      });
    else if (k === DLMM_EVENTS.claimFee && d.length >= 128)
      out.push({
        kind: 'fees',
        pool,
        ixIndex,
        amount0: r.u64(112).toString(),
        amount1: r.u64(120).toString(),
        position: r.pubkey(48),
      });
  }
  return out;
}
