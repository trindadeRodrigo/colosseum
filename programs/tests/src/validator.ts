import type { ChildProcess } from 'node:child_process';
import {
  type Address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  type createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit';

// What the two scripts that drive a local validator share: waiting for it to come up, and sending
// one transaction and waiting for a confirmed block.

export type LocalRpc = ReturnType<typeof createSolanaRpc>;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntilUp(rpc: LocalRpc, validator: ChildProcess): Promise<void> {
  for (let i = 0; i < 480; i++) {
    if (validator.exitCode !== null) throw new Error('the validator stopped while starting');
    try {
      // Healthy, and a few confirmed slots in: a transaction sent at slot 0 is refused.
      const healthy = (await rpc.getHealth().send()) === 'ok';
      if (healthy && (await rpc.getSlot({ commitment: 'confirmed' }).send()) > 3n) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error('the validator did not come up in four minutes');
}

export type Sent = {
  signature: string;
  failed: boolean;
  /** The error the chain recorded, as the node reports it. */
  err: unknown;
  /** How many bytes the transaction is on the wire. */
  bytes: number;
};

/**
 * Sends one transaction and waits for a confirmed block. With `tables`, the addresses they hold are
 * named by index. `skipPreflight` sends without the node's dry run, which would refuse a transaction
 * that fails before it lands.
 */
export async function sendAndWait(
  rpc: LocalRpc,
  payer: TransactionSigner,
  instructions: Instruction[],
  options: { skipPreflight?: boolean; tables?: Record<Address, Address[]> } = {},
): Promise<Sent> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, options.tables ?? {}),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  const bytes = getTransactionEncoder().encode(transaction).length;
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: 'base64',
      skipPreflight: options.skipPreflight ?? false,
      preflightCommitment: 'confirmed',
    })
    .send();
  for (let i = 0; i < 240; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized')
      return { signature, failed: status.err !== null, err: status.err, bytes };
    await sleep(250);
  }
  throw new Error(`transaction ${signature} did not confirm`);
}
