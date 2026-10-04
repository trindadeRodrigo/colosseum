import {
  type AttemptFate,
  AttemptRef,
  type Carried,
  ChainError,
  type TxProbe,
} from '@colosseum/schemas';
import {
  type Address,
  type Base64EncodedWireTransaction,
  type Commitment,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isSignature,
  type Signature,
  type SignatureBytes,
  type Transaction,
  verifySignature,
} from '@solana/kit';
import { messageBytesOf, refusalOf, sha256Hex } from './compose';
import { ask, type VaultWriteRpc } from './rpc';

// Broadcast and the probe (DESIGN-VAULT 3.2 `TxProbe`): what ties signed bytes and a landed transaction
// back to what was built. It holds no key, signs nothing and keeps no record of what it built: the
// order layer stores each attempt's message hash and asks. The API may import it.

/** How many of a signer's transactions one page of the node's list holds. */
const FATE_PAGE = 100;
/**
 * How many pages `fate` reads, at most, back to the slot the attempt could first land in. Anyone can
 * name an address in a transaction (a transfer of dust to it), so the list can be long; past this many
 * pages `fate` cannot tell, and answers `open`, never `gone`.
 */
const FATE_PAGES = 10;
/** A blockhash can be used for this many blocks after the one it was taken at. */
const BLOCKHASH_BLOCKS = 150n;

const base58 = getBase58Decoder();

/** Signed bytes from a wallet: base64 of the whole serialized transaction. BadInput when unreadable. */
export function readSignedTx(signedTx: string): { wire: Uint8Array; tx: Transaction } {
  const unreadable = () =>
    new ChainError('BadInput', 'signedTx: not a serialized Solana transaction in base64');
  if (typeof signedTx !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signedTx)) throw unreadable();
  const wire = new Uint8Array(Buffer.from(signedTx, 'base64'));
  if (!messageBytesOf(wire)) throw unreadable();
  try {
    const tx = getTransactionDecoder().decode(wire);
    // The message read and written again is the same length: no bytes are left over after it, and
    // there is exactly one signature for each signer it names.
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const again = getCompiledTransactionMessageEncoder().encode(message);
    if (
      again.length !== tx.messageBytes.length ||
      message.header.numSignerAccounts !== Object.keys(tx.signatures).length
    )
      throw unreadable();
    return { wire, tx };
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw unreadable();
  }
}

/** The id of a transaction: its first signature, the fee payer's. */
function txIdOf(tx: Transaction): Signature | null {
  const first = Object.values(tx.signatures)[0];
  return first ? (base58.decode(first) as Signature) : null;
}

/** Every signature is there and is the signer's over these message bytes. */
async function signedByAll(tx: Transaction): Promise<boolean> {
  for (const [signer, signature] of Object.entries(tx.signatures)) {
    if (!signature) return false;
    const key = await getPublicKeyFromAddress(signer as Address);
    if (!(await verifySignature(key, signature as SignatureBytes, tx.messageBytes))) return false;
  }
  return true;
}

export type SolanaProbe = TxProbe;

export function createSolanaProbe(options: {
  rpc: VaultWriteRpc;
  program: Address;
  commitment?: Commitment;
}): SolanaProbe {
  const { rpc, program } = options;
  const commitment =
    options.commitment === 'processed' ? 'confirmed' : (options.commitment ?? 'confirmed');

  /** The message hash of the transaction the node has under this id, or null when it has none. */
  async function hashOnChain(signature: Signature): Promise<string | null> {
    const found = await ask('getTransaction', () =>
      rpc
        .getTransaction(signature, {
          commitment,
          encoding: 'base64',
          maxSupportedTransactionVersion: 0,
        })
        .send(),
    );
    if (!found) return null;
    const wire = new Uint8Array(Buffer.from(found.transaction[0], 'base64'));
    const parts = messageBytesOf(wire);
    return parts ? sha256Hex(parts.message) : null;
  }

  const statusOf = async (signature: Signature) => {
    const statuses = await ask('getSignatureStatuses', () =>
      rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(),
    );
    return statuses.value[0] ?? null;
  };

  /**
   * Looks through the signer's transactions, newest first, for one that carries the message, back to
   * the first slot the attempt's blockhash could have landed in. `looked` is true when the whole window
   * was read: the node listed a slot under it, or its list ended. Only then can "not found" mean it.
   */
  async function findLanded(
    attempt: AttemptRef,
  ): Promise<{ found: Signature | null; looked: boolean }> {
    const floor =
      attempt.validUntil === null ? null : BigInt(attempt.validUntil) - BLOCKHASH_BLOCKS;
    let before: Signature | undefined;
    for (let page = 0; page < FATE_PAGES; page++) {
      const signatures = await ask('getSignaturesForAddress', () =>
        rpc
          .getSignaturesForAddress(attempt.signer as Address, {
            limit: FATE_PAGE,
            commitment,
            ...(before ? { before } : {}),
          })
          .send(),
      );
      for (const entry of signatures) {
        // A block's height is never above its slot, so a transaction from a slot under the floor was
        // in a block too early to carry the attempt's blockhash.
        if (floor !== null && BigInt(entry.slot) < floor) return { found: null, looked: true };
        if ((await hashOnChain(entry.signature)) === attempt.messageHash)
          return { found: entry.signature, looked: true };
      }
      if (signatures.length < FATE_PAGE) return { found: null, looked: true };
      before = signatures[signatures.length - 1]?.signature;
    }
    return { found: null, looked: false };
  }

  return {
    async messageHashOf(signedTx) {
      const { tx } = readSignedTx(signedTx);
      return sha256Hex(new Uint8Array(tx.messageBytes));
    },

    async relay(signedTx) {
      const { tx } = readSignedTx(signedTx);
      const txId = txIdOf(tx);
      if (!txId || !(await signedByAll(tx)))
        throw new ChainError(
          'BadInput',
          "signedTx: a signature is missing or is not its signer's over these bytes",
        );
      try {
        await ask('sendTransaction', () =>
          rpc
            .sendTransaction(signedTx as Base64EncodedWireTransaction, {
              encoding: 'base64',
              preflightCommitment: commitment,
            })
            .send(),
        );
        return { txId };
      } catch (sendError) {
        // The same bytes sent twice: the node has them already, and they land once.
        if (await statusOf(txId)) return { txId };
        // Otherwise ask what the chain would say of them, in the program's own words.
        const simulated = await ask('simulateTransaction', () =>
          rpc
            .simulateTransaction(signedTx as Base64EncodedWireTransaction, {
              encoding: 'base64',
              sigVerify: true,
              commitment,
            })
            .send(),
        ).catch(() => null);
        if (simulated?.value.err)
          throw refusalOf(simulated.value.err, simulated.value.logs ?? null, program);
        if (sendError instanceof ChainError) throw sendError;
        throw new ChainError('Unavailable', 'the node did not take the transaction');
      }
    },

    async carries(txId, messageHash): Promise<Carried> {
      if (!isSignature(txId))
        throw new ChainError('BadInput', 'txId: expected a transaction signature');
      const hash = await hashOnChain(txId);
      if (hash === null) return 'unseen';
      return hash === messageHash ? 'this' : 'another';
    },

    async fate(attempt): Promise<AttemptFate> {
      const parsed = AttemptRef.safeParse(attempt);
      if (!parsed.success)
        throw new ChainError('BadInput', 'attempt: not an attempt this chain stores');
      const first = await findLanded(parsed.data);
      if (first.found) return { state: 'landed', txId: first.found };
      if (parsed.data.validUntil === null) return { state: 'open' };
      const lastValid = BigInt(parsed.data.validUntil);
      // The finalized height, from the same node as the list: a height read from a fork that is later
      // dropped, or from a node ahead of the one listing, could be past the last valid block while the
      // transaction still lands or is not listed yet.
      const height = await ask('getBlockHeight', () =>
        rpc.getBlockHeight({ commitment: 'finalized' }).send(),
      );
      if (BigInt(height) <= lastValid) return { state: 'open' };
      // Past it. It may have landed between the two questions: look once more before saying gone, and
      // say gone only when the whole window was read and it is not there.
      const late = await findLanded(parsed.data);
      if (late.found) return { state: 'landed', txId: late.found };
      return late.looked && first.looked ? { state: 'gone' } : { state: 'open' };
    },

    async nonceOf(seen) {
      // Solana has no nonce of record: an attempt is its message, and it expires with its blockhash.
      if ('signedTx' in seen) readSignedTx(seen.signedTx);
      return null;
    },
  };
}
