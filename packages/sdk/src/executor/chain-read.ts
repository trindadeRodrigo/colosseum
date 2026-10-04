import type { ChainId, ReportLegRequest } from '@colosseum/schemas';
import { familyOf } from '../guard/context';
import { signedEvm, signedSolana } from './signed';

// What became of a transaction the wallet signed, asked of the chain itself. The executor signs an
// approved step once. It signs it a second time only when this says the first signature can never land,
// and this is the caller's own connection to the chain: never the API that builds the transactions,
// which is the one party that gains from a second signature.

/**
 * - `landed`: the chain has the transaction, whatever became of it.
 * - `open`: it is not there, and it can still land.
 * - `gone`: it is not there, and it never can be.
 * - `unknown`: this read cannot tell.
 */
export type Fate = 'landed' | 'open' | 'gone' | 'unknown';

export type ChainRead = {
  /** The fate of what the wallet handed back for a step: `proof` is exactly what was reported for it. */
  fateOf(signed: { chain: ChainId; owner: string; proof: ReportLegRequest }): Promise<Fate>;
};

/** The two reads of a Solana RPC the rule needs. */
export type SolanaReads = {
  /**
   * `isBlockhashValid` at commitment `finalized`: false once the blockhash is past its last valid block
   * height, so that no later block can take a transaction bound to it.
   */
  blockhashValid(blockhash: string): Promise<boolean>;
  /**
   * `getSignatureStatuses` with `searchTransactionHistory`: true when the chain has a transaction with
   * this signature, landed or reverted.
   */
  hasTransaction(signature: string): Promise<boolean>;
};

/** The two reads of an EVM RPC the rule needs. */
export type EvmReads = {
  /**
   * `eth_getTransactionCount(address)` at a block that will not be undone (`finalized`, or `latest` on a
   * chain with one sequencer): the nonce the account's next transaction takes.
   */
  nonceOf(chain: ChainId, address: string): Promise<number>;
  /** `eth_getTransactionReceipt`: true when the chain has a transaction with this hash, landed or reverted. */
  hasTransaction(chain: ChainId, hash: string): Promise<boolean>;
};

/**
 * The rule, over reads the caller makes with its own RPC connection.
 *
 * Solana: a signed transaction can land only while its blockhash is valid. Once the blockhash is past
 * its last valid height and the chain has no transaction with that signature, it never will.
 *
 * EVM: a signed transaction never expires. It can no longer land only when the account's nonce has
 * moved past the one it was signed on and the chain does not have it: another transaction took its
 * place.
 *
 * A transaction the wallet sent by itself is known by its id only, which says whether it landed and
 * nothing about whether it still can: that is `unknown`. So is anything that cannot be read.
 */
export function chainReadOf(reads: { solana?: SolanaReads; evm?: EvmReads }): ChainRead {
  return {
    async fateOf({ chain, owner, proof }) {
      const family = familyOf(chain);
      if (family === 'solana') {
        const { solana } = reads;
        if (!solana) return 'unknown';
        if ('txId' in proof)
          return (await solana.hasTransaction(proof.txId)) ? 'landed' : 'unknown';
        const { signature, blockhash } = signedSolana(proof.signedTx);
        // In this order: once the blockhash is known to be dead, a transaction that is not there now
        // cannot arrive later.
        const valid = await solana.blockhashValid(blockhash);
        const has = await solana.hasTransaction(signature);
        if (typeof valid !== 'boolean' || typeof has !== 'boolean') return 'unknown';
        return has ? 'landed' : valid ? 'open' : 'gone';
      }
      const { evm } = reads;
      if (!evm) return 'unknown';
      if ('txId' in proof)
        return (await evm.hasTransaction(chain, proof.txId)) ? 'landed' : 'unknown';
      const { hash, nonce } = signedEvm(proof.signedTx);
      // In this order: a nonce that is used now was used by a transaction the chain already has.
      const next = await evm.nonceOf(chain, owner);
      const has = await evm.hasTransaction(chain, hash);
      if (!Number.isSafeInteger(next) || typeof has !== 'boolean') return 'unknown';
      return has ? 'landed' : next > nonce ? 'gone' : 'open';
    },
  };
}
