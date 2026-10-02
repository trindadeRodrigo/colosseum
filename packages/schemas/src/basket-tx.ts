import { z } from 'zod';
import { Address, AssetId, ChainId, RawAmount, RawDelta, Sourced } from './chain';
import { LegKind } from './order';
import { UnsignedTx } from './tx';

// DESIGN-VAULT 3.3. tx.ts is not edited; its fields payload, evm, chain, description, provenance and
// lastValidBlockHeight are reused.

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

export const BasketTx = UnsignedTx.omit({
  kind: true,
  legAssetId: true,
  executionId: true,
}).extend({
  // The design types both as strings, but a builder takes no leg and cannot know them. v0 reading:
  // an adapter returns null, and the order layer (API or keeper) stamps both before the transaction
  // leaves the server.
  legId: z.string().min(1).nullable(),
  attemptId: z.string().min(1).nullable(),
  legKind: LegKind,
  chainId: ChainId,
  signer: Address,
  feePayer: Address.optional(),
  /** Hash of the exact bytes to sign. */
  messageHash: z.string().min(1),
  preview: TxPreview,
});
export type BasketTx = z.infer<typeof BasketTx>;
