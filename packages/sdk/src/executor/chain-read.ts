import type { ChainId, ReportLegRequest } from '@colosseum/schemas';
import { base64Decode } from '../bytes';
import { familyOf } from '../guard/context';
import { parseSolanaTransaction } from '../guard/solana/wire';
import { isObject } from '../guard/strict';
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
  /**
   * Asked before a step is signed, with the transaction the guard passed. Solana: the block height of
   * the caller's node once that node knows the blockhash the transaction is bound to, or null while it
   * does not, and then nothing is signed. It is kept with the signature: the transaction cannot land
   * once the chain is more than 150 blocks past it. Elsewhere: 0, as there is nothing to bound.
   */
  heightBefore(tx: { chain: ChainId; payload: string }): Promise<number | null>;
  /**
   * The fate of what the wallet handed back for a step: `proof` is exactly what was reported for it,
   * and `height` what `heightBefore` answered when it was signed (null when nothing was asked).
   */
  fateOf(signed: {
    chain: ChainId;
    owner: string;
    proof: ReportLegRequest;
    height: number | null;
  }): Promise<Fate>;
};

/**
 * One JSON-RPC connection to one node: a method and its parameters in, the `result` out, and a throw on
 * an error or no answer. Every read of a chain goes through one of these, so all of them are answered
 * by the same node. A URL that balances calls across nodes is not one node: a node that is behind can
 * then answer one read and a node that is ahead the next.
 */
export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/** `RpcCall` over HTTP to `url`, with the platform's `fetch` unless another is given. */
export function rpcAt(url: string, fetchFn: typeof fetch = fetch): RpcCall {
  let id = 0;
  return async (method, params) => {
    id += 1;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: the node answered ${res.status}`);
    const body: unknown = await res.json();
    if (!isObject(body) || body.id !== id || 'error' in body || !('result' in body))
      throw new Error(`${method}: the node answered no result`);
    return body.result;
  };
}

/** Blocks a Solana transaction stays good for after its blockhash: the chain's own rule. */
export const SOLANA_VALID_BLOCKS = 150;
/** Blocks added on top before a transaction is taken as gone, for a node a little behind or ahead. */
export const SOLANA_MARGIN_BLOCKS = 30;

const height = (v: unknown): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error('not a block height');
  return v as number;
};
const flag = (v: unknown): boolean => {
  if (!isObject(v) || typeof v.value !== 'boolean') throw new Error('not a yes or a no');
  return v.value;
};
const quantity = (v: unknown): number => {
  if (typeof v !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v))
    throw new Error('not a number');
  const n = Number.parseInt(v.slice(2), 16);
  if (!Number.isSafeInteger(n)) throw new Error('not a number');
  return n;
};

/** The reads of a Solana node the rule needs, all on one connection. */
function solanaOf(rpc: RpcCall) {
  return {
    /** `isBlockhashValid` at `processed`: true once this node has the blockhash, while it is good. */
    knows: async (blockhash: string) =>
      flag(await rpc('isBlockhashValid', [blockhash, { commitment: 'processed' }])),
    height: async (commitment: 'processed' | 'finalized') =>
      height(await rpc('getBlockHeight', [{ commitment }])),
    /** `getSignatureStatuses` with the history searched: the chain has it, landed or reverted. */
    has: async (signature: string) => {
      const out = await rpc('getSignatureStatuses', [
        [signature],
        { searchTransactionHistory: true },
      ]);
      if (!isObject(out) || !Array.isArray(out.value) || out.value.length !== 1)
        throw new Error('no status');
      return out.value[0] !== null;
    },
  };
}

/** The reads of an EVM node the rule needs, all on one connection. */
function evmOf(rpc: RpcCall) {
  return {
    /** The nonce the account's next transaction takes, at a block that will not be undone. */
    nonce: async (address: string) =>
      quantity(await rpc('eth_getTransactionCount', [address, 'finalized'])),
    /** `eth_getTransactionReceipt`: the chain has it, landed or reverted. */
    has: async (hash: string) => {
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      if (receipt !== null && !isObject(receipt)) throw new Error('no receipt');
      return receipt !== null;
    },
  };
}

/**
 * The rule, over one connection per family that the caller makes to its own node.
 *
 * Solana: a transaction can land only while the chain is within 150 blocks of its blockhash. Before it
 * is signed, the node is asked whether it has that blockhash, and its block height then is kept with
 * the signature. The node's finalized height past that, plus 150 and a margin, with no transaction of
 * that signature on the chain, is gone: no later block can take it. Whether the blockhash is still
 * valid is never the test: a node answers no for one it has not seen yet, and a blockhash newer than
 * the finalized block is one of those.
 *
 * EVM: a signed transaction never expires. It can no longer land only when the account's nonce, at a
 * finalized block, has moved past the one it was signed on and the chain does not have it: another
 * transaction took its place.
 *
 * A transaction the wallet sent by itself is known by its id only, which says whether it landed and
 * nothing about whether it still can: that is `unknown`. So is anything that cannot be read.
 */
export function chainReadOf(rpcs: { solana?: RpcCall; evm?: RpcCall }): ChainRead {
  return {
    async heightBefore({ chain, payload }) {
      if (familyOf(chain) !== 'solana') return 0;
      if (!rpcs.solana) return null;
      const node = solanaOf(rpcs.solana);
      const { blockhash } = parseSolanaTransaction(base64Decode(payload));
      // In this order: a node that has the blockhash is at least at its height when asked after.
      if (!(await node.knows(blockhash))) return null;
      return node.height('processed');
    },
    async fateOf({ chain, owner, proof, height: before }) {
      if (familyOf(chain) === 'solana') {
        if (!rpcs.solana) return 'unknown';
        const node = solanaOf(rpcs.solana);
        if ('txId' in proof) return (await node.has(proof.txId)) ? 'landed' : 'unknown';
        const { signature } = signedSolana(proof.signedTx);
        // In this order: once the finalized height is past the last block that could take it, a
        // transaction that is not there now cannot arrive later.
        const finalized = await node.height('finalized');
        if (await node.has(signature)) return 'landed';
        if (before === null) return 'unknown';
        return finalized > before + SOLANA_VALID_BLOCKS + SOLANA_MARGIN_BLOCKS ? 'gone' : 'open';
      }
      if (!rpcs.evm) return 'unknown';
      const node = evmOf(rpcs.evm);
      if ('txId' in proof) return (await node.has(proof.txId)) ? 'landed' : 'unknown';
      const { hash, nonce } = signedEvm(proof.signedTx);
      // In this order: a nonce that is used now was used by a transaction the chain already has.
      const next = await node.nonce(owner);
      if (await node.has(hash)) return 'landed';
      return next > nonce ? 'gone' : 'open';
    },
  };
}
