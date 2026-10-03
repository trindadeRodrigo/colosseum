import { z } from 'zod';
import {
  Address,
  AssetId,
  ChainId,
  chainFamily,
  EvmAddress,
  Hex32,
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
  /**
   * What ties signed bytes and a landed transaction back to this build: 32 bytes of lower-case hex,
   * a SHA-256, defined per family.
   * - Solana: the SHA-256 of the message bytes, which is the serialized transaction in `payload`
   *   less its signatures (the leading count and 64 bytes each). Signing changes the signatures and
   *   not the message, so the signed transaction hashes to the same value.
   * - EVM: the SHA-256 of the UTF-8 bytes of `evmCallPreimage(...)`: the call alone (chain id,
   *   signer, to, value, data). The wallet sets the nonce and the fees, so the bytes that are signed
   *   do not exist when the transaction is built. Two builds of the same call have the same hash.
   */
  messageHash: Hex32,
  preview: TxPreview,
});

/**
 * The text whose SHA-256 is an EVM transaction's `messageHash`:
 * `evm:<chain id>:<signer>:<to>:<value>:<data>`, the two addresses and the data in lower case, the
 * chain id (`evm.chainId`, the network's own number) and the value in wei as decimal numbers. Pure, so
 * the adapter that builds, the server that checks signed bytes and the guard in the browser agree on
 * it to the byte. Throws on a field that is not in that form.
 */
export function evmCallPreimage(call: {
  chainId: number;
  signer: string;
  to: string;
  value: string;
  data: string;
}): string {
  const data = call.data.toLowerCase();
  if (!Number.isSafeInteger(call.chainId) || call.chainId < 0)
    throw new Error('chainId: expected a whole number');
  if (!/^0x(?:[0-9a-f]{2})*$/.test(data)) throw new Error('data: expected whole bytes of 0x hex');
  const signer = EvmAddress.parse(call.signer.toLowerCase());
  const to = EvmAddress.parse(call.to.toLowerCase());
  return `evm:${call.chainId}:${signer}:${to}:${RawAmount.parse(call.value)}:${data}`;
}

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
