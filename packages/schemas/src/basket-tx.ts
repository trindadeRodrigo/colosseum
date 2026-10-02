import { z } from 'zod';
import {
  Address,
  AssetId,
  ChainId,
  chainFamily,
  isAddressOf,
  RawAmount,
  RawDelta,
  Sourced,
} from './chain';
import { LegKind } from './order';
import { UnsignedTx } from './tx';

// DESIGN-VAULT 3.3. tx.ts is not edited; its fields payload, evm, chain, description, provenance and
// lastValidBlockHeight are reused.
// Two shapes, because a builder takes no leg and cannot know its ids:
//   BuiltTx   what a chain adapter returns.
//   BasketTx  BuiltTx plus `legId` and `attemptId`, stamped by the order layer (the API or the keeper).
//             This is the only shape that leaves the server: the wallet, the web and the guard take it.

/** What the transaction will do, shown on the review screen before anything is signed. */
export const TxPreview = Sourced.extend({
  summary: z.string().min(1),
  /** True when the adapter ran the transaction against chain state before returning it. */
  simulated: z.boolean(),
  feeNativeRaw: RawAmount,
  changes: z.array(
    z.object({ holder: z.enum(['wallet', 'vault']), asset: AssetId, deltaRaw: RawDelta }),
  ),
});
export type TxPreview = z.infer<typeof TxPreview>;

export const BuiltTxBase = UnsignedTx.omit({
  kind: true,
  legAssetId: true,
  executionId: true,
}).extend({
  legKind: LegKind,
  chainId: ChainId,
  signer: Address,
  feePayer: Address.optional(),
  /** Hash of the exact bytes to sign. */
  messageHash: z.string().min(1),
  preview: TxPreview,
});

type TxFields = z.infer<typeof BuiltTxBase>;
/** The fields that must agree with each other. One list for both shapes. */
function checkTx(tx: TxFields, ctx: z.RefinementCtx) {
  const family = chainFamily(tx.chainId);
  const fail = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (tx.chain !== family) fail('chain', `${tx.chainId} is in the ${family} family`);
  if ((tx.evm !== undefined) !== (family === 'evm'))
    fail('evm', 'present on an EVM chain and nowhere else');
  if (family === 'solana' && tx.lastValidBlockHeight === undefined)
    fail('lastValidBlockHeight', 'a Solana transaction says when its blockhash goes stale');
  if (!isAddressOf(family, tx.signer))
    fail('signer', "the signer is in the form of the tx's chain");
  if (!tx.preview.changes.every((c) => c.asset.startsWith(`${tx.chainId}:`)))
    fail('preview', "every change is in an asset of the tx's chain");
}

/** What a chain adapter returns: one unsigned transaction, not yet tied to a leg. */
export const BuiltTx = BuiltTxBase.superRefine(checkTx);
export type BuiltTx = z.infer<typeof BuiltTx>;

export const BasketTxBase = BuiltTxBase.extend({
  legId: z.string().min(1),
  attemptId: z.string().min(1),
});

/** A built transaction tied to the leg and the attempt it belongs to. */
export const BasketTx = BasketTxBase.superRefine(checkTx);
export type BasketTx = z.infer<typeof BasketTx>;

/** The order layer's one step between an adapter and anything that signs. */
export function stampTx(tx: BuiltTx, ids: { legId: string; attemptId: string }): BasketTx {
  return { ...tx, legId: ids.legId, attemptId: ids.attemptId };
}
