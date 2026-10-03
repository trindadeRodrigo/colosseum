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

/**
 * The least one trade of a transaction accepts, as the numbers are in its bytes: `inRaw` of `sell`
 * goes in, and the transaction reverts if less than `minOutRaw` of `buy` comes out.
 */
export const TradeMinimum = z
  .object({ sell: AssetId, buy: AssetId, inRaw: RawAmount, minOutRaw: RawAmount })
  .refine((m) => m.sell !== m.buy, 'a trade has two different sides');
export type TradeMinimum = z.infer<typeof TradeMinimum>;

/** What the transaction will do, shown on the review screen before anything is signed. */
export const TxPreview = Sourced.extend({
  summary: z.string().min(1),
  /** True when the adapter ran the transaction against chain state before returning it. */
  simulated: z.boolean(),
  feeNativeRaw: RawAmount,
  changes: z.array(
    z.object({ holder: z.enum(['wallet', 'vault']), asset: AssetId, deltaRaw: RawDelta }),
  ),
  /**
   * One entry per trade whose minimum is in the transaction's bytes, in the order the transaction
   * makes them, with the amounts as the bytes carry them. Always stated: a transaction that trades
   * nothing states an empty list. The guard holds the bytes to it, and to what the review screen
   * showed (`Leg.expected[i].minOutRaw`).
   *
   * An owner's trade always carries its minimum. A keeper leg states one only where its bytes carry
   * one: EVM's `keeperSwap` takes `minOut` in its call data, so the list has that entry; Solana's
   * `keeper_leg` takes an amount in and nothing else, the program works the minimum out from the
   * reference price, and the list is empty.
   */
  minimums: z.array(TradeMinimum),
});
export type TxPreview = z.infer<typeof TxPreview>;

/**
 * The EVM half of a built transaction: `to`, `value` and `chainId` as tx.ts has them, with the nonce
 * and the gas limit the adapter states.
 */
export const EvmCall = z.object({
  to: z.string(),
  value: z.string(),
  chainId: z.number(),
  /**
   * The nonce to sign with: the signer's next nonce when the transaction was built, or the one a
   * rebuild was given. An embedded wallet signs with it. An outside wallet may ignore it; the nonce of
   * record is then the one in the signed or sent transaction (`TxProbe.nonceOf`). An adapter always
   * states it.
   */
  nonce: z.number().int().nonnegative().optional(),
  /**
   * The gas limit to sign with. An adapter always states it. A transaction that reverted with
   * `GasTooLow` is built again with a higher one.
   */
  gas: z.number().int().positive().optional(),
});
export type EvmCall = z.infer<typeof EvmCall>;

export const BuiltTxBase = UnsignedTx.omit({
  kind: true,
  legAssetId: true,
  executionId: true,
}).extend({
  evm: EvmCall.optional(),
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
   *   signer, to, value, data), without the nonce, the gas limit or the fees. The adapter states a
   *   nonce and a gas limit (`evm.nonce`, `evm.gas`), but a wallet may sign with others, and the
   *   fees are the wallet's, so the bytes that are signed do not exist when the transaction is
   *   built. Two builds of the same call have the same hash, so the hash alone does not name an
   *   attempt on EVM: the pair (messageHash, nonce) does.
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
  const onChain = (asset: string) => asset.startsWith(`${tx.chainId}:`);
  if (!tx.preview.minimums.every((m) => onChain(m.sell) && onChain(m.buy)))
    fail('preview', "every trade is in assets of the tx's chain");
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
