import {
  type AttemptFate,
  type AttemptRef,
  type Carried,
  type ChainConfig,
  ChainError,
  type TxProbe,
} from '@colosseum/schemas';
import {
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  type TransactionSerialized,
} from 'viem';
import { callHash } from './compose';
import { revertDataOf, revertToChainError } from './errors';
import { ask, type EvmRpc, isRevert } from './rpc';

// The probe of the EVM adapter (`TxProbe`): it ties signed bytes and landed transactions back to what
// was built. It holds no key. An attempt on EVM is the pair (message hash, nonce): two builds of one
// call share the hash, and only one transaction can take a nonce.

/** The first step back from the head when `fate` looks for the block that took a nonce; it doubles. */
export const FATE_FIRST_STEP = 64n;

const HASH = /^0x[0-9a-f]{64}$/;

type SignedCall = {
  from: string;
  to: string;
  value: bigint;
  data: Hex;
  chainId: number;
  nonce: number;
};

/** Signed bytes as a call: who signed, to whom, what. `BadInput` for anything that is not one signed EVM transaction. */
async function readSigned(signedTx: string): Promise<SignedCall> {
  if (typeof signedTx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signedTx))
    throw new ChainError('BadInput', 'signedTx: expected a signed EVM transaction as 0x hex');
  try {
    const serialized = signedTx.toLowerCase() as TransactionSerialized;
    const tx = parseTransaction(serialized);
    if (!tx.to) throw new Error('no target');
    if (tx.chainId === undefined) throw new Error('no chain id');
    if (tx.r === undefined || tx.s === undefined) throw new Error('not signed');
    const from = await recoverTransactionAddress({ serializedTransaction: serialized });
    return {
      from: from.toLowerCase(),
      to: tx.to.toLowerCase(),
      value: tx.value ?? 0n,
      data: (tx.data ?? '0x') as Hex,
      chainId: tx.chainId,
      nonce: tx.nonce ?? 0,
    };
  } catch {
    throw new ChainError('BadInput', 'signedTx: not a signed EVM transaction with a target');
  }
}

const hashOfCall = (c: Omit<SignedCall, 'nonce'>) =>
  callHash({
    chainId: c.chainId,
    signer: c.from,
    to: c.to,
    value: c.value.toString(),
    data: c.data,
  });

/** A transaction's id: the Keccak-256 of its signed bytes. */
export const txIdOf = (signedTx: string): string => keccak256(signedTx.toLowerCase() as Hex);

export function createEvmProbe(options: { config: ChainConfig; rpc: EvmRpc }): TxProbe {
  const { config, rpc } = options;
  const chainId = config.evmChainId;
  if (chainId === null) throw new Error(`${config.id} has no EVM chain id`);

  const sent = (hash: string) =>
    ask('eth_getTransactionByHash', () =>
      rpc.getTransaction({ hash: hash as Hex }).catch((e) => {
        if (e instanceof TransactionNotFoundError) return null;
        throw e;
      }),
    );

  const probe: TxProbe = {
    async messageHashOf(signedTx) {
      const call = await readSigned(signedTx);
      if (call.chainId !== chainId)
        throw new ChainError('BadInput', `signedTx is for chain ${call.chainId}, not ${chainId}`);
      return hashOfCall(call);
    },

    async relay(signedTx) {
      const call = await readSigned(signedTx);
      if (call.chainId !== chainId)
        throw new ChainError(
          'NotBuiltHere',
          `signedTx is for chain ${call.chainId}, not ${chainId}`,
        );
      const txId = keccak256(signedTx.toLowerCase() as Hex);
      // As a preflight: bytes that would revert now are refused in the contract's words, and not sent.
      try {
        await ask('eth_call', () =>
          rpc.call({
            account: call.from as Hex,
            to: call.to as Hex,
            data: call.data,
            value: call.value,
          }),
        );
      } catch (e) {
        if (isRevert(e)) {
          // Nothing was sent: the bytes never left this process.
          const refused = revertToChainError(revertDataOf(e));
          throw new ChainError(refused.code, refused.message, refused.retryable, { unsent: true });
        }
        throw e;
      }
      try {
        await ask('eth_sendRawTransaction', () =>
          rpc.sendRawTransaction({ serializedTransaction: signedTx.toLowerCase() as Hex }),
        );
      } catch (e) {
        // Sent twice, the node has it already: the same id. Anything else is the node's refusal, in
        // words of our own: its message can carry its address.
        if ((await sent(txId)) !== null) return { txId };
        const said = e instanceof Error ? e.message : '';
        if (/nonce too low|nonce.*already/i.test(said))
          throw new ChainError('Expired', 'the signer has used that nonce: build the step again');
        if (/insufficient funds/i.test(said))
          throw new ChainError('NoGas', 'the signer cannot pay for the gas');
        if (e instanceof ChainError) throw e;
        throw new ChainError('Unknown', 'the node refused the transaction');
      }
      return { txId };
    },

    async carries(txId, messageHash) {
      if (!HASH.test(txId)) throw new ChainError('BadInput', 'txId: expected a transaction hash');
      const tx = await sent(txId);
      if (!tx) return 'unseen' satisfies Carried;
      if (!tx.to || tx.chainId === undefined) return 'another';
      const hash = hashOfCall({
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        value: tx.value,
        data: tx.input,
        chainId: tx.chainId,
      });
      return hash === messageHash ? 'this' : 'another';
    },

    async fate(attempt: AttemptRef): Promise<AttemptFate> {
      if (attempt.nonce === null) return { state: 'open' };
      const nonce = attempt.nonce;
      const signer = attempt.signer as Hex;
      // One block for both reads: the head first, then the nonce at that very block. Behind a pool of
      // nodes, a nonce read at `latest` from one and a head from another could say `gone` for a
      // transaction the second already holds.
      const head = await ask('eth_getBlockByNumber', () => rpc.getBlock({ blockTag: 'latest' }));
      if (head.number === null) return { state: 'open' };
      const top = head.number;
      const countAt = (blockNumber: bigint) =>
        ask('eth_getTransactionCount', () =>
          rpc.getTransactionCount({ address: signer, blockNumber }),
        );
      if ((await countAt(top)) <= nonce) {
        // The nonce is still free. A trade signed with a deadline cannot land past it.
        const deadline = attempt.validUntil === null ? null : BigInt(attempt.validUntil);
        return deadline !== null && head.timestamp > deadline
          ? { state: 'gone' }
          : { state: 'open' };
      }
      // The nonce is taken: the block that took it is the first whose count is past it. It is found by
      // doubling a step back from the head until the count is not past it, then halving between the
      // two. A node that no longer holds the state of a height it is asked for cannot tell: open,
      // never gone for a call that may have landed.
      try {
        let high = top;
        let low = top;
        for (let step = FATE_FIRST_STEP; ; step *= 2n) {
          low = top > step ? top - step : 0n;
          if ((await countAt(low)) <= nonce) break;
          high = low;
          if (low === 0n) return { state: 'open' };
        }
        while (high - low > 1n) {
          const mid = (low + high) / 2n;
          if ((await countAt(mid)) > nonce) high = mid;
          else low = mid;
        }
        const block = await ask('eth_getBlockByNumber', () =>
          rpc.getBlock({ blockNumber: high, includeTransactions: true }),
        );
        const found = block.transactions.find(
          (tx) =>
            typeof tx !== 'string' &&
            tx.from.toLowerCase() === signer.toLowerCase() &&
            tx.nonce === nonce,
        );
        if (!found || typeof found === 'string') return { state: 'open' };
        if (!found.to || found.chainId === undefined) return { state: 'gone' };
        const hash = hashOfCall({
          from: found.from.toLowerCase(),
          to: found.to.toLowerCase(),
          value: found.value,
          data: found.input,
          chainId: found.chainId,
        });
        return hash === attempt.messageHash
          ? { state: 'landed', txId: found.hash }
          : { state: 'gone' };
      } catch (e) {
        if (e instanceof ChainError && e.code === 'Unavailable') return { state: 'open' };
        throw e;
      }
    },

    async nonceOf(seen) {
      if ('signedTx' in seen) return (await readSigned(seen.signedTx)).nonce;
      if (!HASH.test(seen.txId))
        throw new ChainError('BadInput', 'txId: expected a transaction hash');
      const tx = await sent(seen.txId);
      return tx ? tx.nonce : null;
    },
  };
  return probe;
}
