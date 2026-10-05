import { base58Encode, base64Decode, hexDecode, hexEncode, sameBytes } from '../bytes';
import type { Guarded } from '../guard/run';
import { parseSolanaTransaction } from '../guard/solana/wire';
import type { GuardDeployment } from '../guard/types';
import { keccak256 } from '../hash';

// A signed transaction, read from its own bytes: what names it on its chain, what its lifetime hangs
// on, and whether it is the transaction the guard passed. The executor reads what a wallet handed back
// with these, and never takes the API's word for any of it.

/** What a signed Solana transaction says of itself. */
export type SignedSolana = {
  /** The first signature, as base58: the transaction's id. */
  signature: string;
  /** The recent blockhash its message is bound to. Past that blockhash's last valid height it cannot land. */
  blockhash: string;
  /** The bytes that were signed. */
  message: Uint8Array;
};

/** Reads base64 of a whole signed transaction. Throws on anything else, and on one nobody signed. */
export function signedSolana(signedTx: string): SignedSolana {
  const tx = parseSolanaTransaction(base64Decode(signedTx));
  const first = tx.signatures[0];
  if (!first || first.every((b) => b === 0)) throw new Error('the transaction is not signed');
  return { signature: base58Encode(first), blockhash: tx.blockhash, message: tx.message };
}

type Rlp = Uint8Array | Rlp[];

/** One RLP item and where it ends. Only the shortest spelling of each length is read. */
function rlpItem(bytes: Uint8Array, at: number): { item: Rlp; end: number } {
  const first = bytes[at];
  if (first === undefined) throw new Error('the transaction ends early');
  const span = (from: number, length: number) => {
    if (from + length > bytes.length) throw new Error('the transaction ends early');
    return bytes.slice(from, from + length);
  };
  /** A length written after the first byte, in `width` bytes: for anything longer than 55. */
  const long = (width: number) => {
    const digits = span(at + 1, width);
    if (digits[0] === 0) throw new Error('a length is written the long way');
    let length = 0;
    for (const d of digits) length = length * 256 + d;
    if (length <= 55) throw new Error('a length is written the long way');
    return { from: at + 1 + width, length };
  };
  const list = (from: number, length: number) => {
    const items: Rlp[] = [];
    span(from, length);
    let next = from;
    while (next < from + length) {
      const read = rlpItem(bytes, next);
      items.push(read.item);
      next = read.end;
    }
    if (next !== from + length) throw new Error('a list runs past its length');
    return { item: items, end: next };
  };
  if (first < 0x80) return { item: bytes.slice(at, at + 1), end: at + 1 };
  if (first <= 0xb7) {
    const text = span(at + 1, first - 0x80);
    if (text.length === 1 && (text[0] as number) < 0x80)
      throw new Error('a byte is written the long way');
    return { item: text, end: at + 1 + text.length };
  }
  if (first <= 0xbf) {
    const { from, length } = long(first - 0xb7);
    return { item: span(from, length), end: from + length };
  }
  if (first <= 0xf7) return list(at + 1, first - 0xc0);
  const { from, length } = long(first - 0xf7);
  return list(from, length);
}

const bytesOf = (item: Rlp | undefined, what: string): Uint8Array => {
  if (!(item instanceof Uint8Array)) throw new Error(`${what} is not bytes`);
  return item;
};
/** A number as RLP carries it: big-endian, with no leading zero. */
const numberOf = (item: Rlp | undefined, what: string): bigint => {
  const bytes = bytesOf(item, what);
  if (bytes[0] === 0 || bytes.length > 32) throw new Error(`${what} is not a number`);
  return bytes.length ? BigInt(`0x${hexEncode(bytes)}`) : 0n;
};

/** What a signed EVM transaction says of itself. */
export type SignedEvm = {
  /** Its hash: the transaction's id. */
  hash: string;
  /** 0 for a legacy transaction, else the type byte: 1 (access list) or 2 (fee market). */
  type: 0 | 1 | 2;
  /** Null for a legacy transaction signed for no chain in particular. */
  chainId: bigint | null;
  nonce: number;
  /** Lower case. Null when the transaction creates a contract. */
  to: string | null;
  value: bigint;
  data: Uint8Array;
  /** How many entries its access list has. */
  accessList: number;
};

/**
 * Reads a 0x-prefixed serialized signed transaction: legacy, type 1 or type 2. Throws on anything
 * else, which includes a transaction that carries an authorization list (type 4) or blobs (type 3).
 */
export function signedEvm(signedTx: string): SignedEvm {
  const raw = hexDecode(signedTx);
  const first = raw[0];
  if (first === undefined) throw new Error('the transaction is empty');
  const type = first >= 0xc0 ? 0 : first;
  if (type !== 0 && type !== 1 && type !== 2)
    throw new Error('a transaction type the executor does not read');
  const body = type === 0 ? raw : raw.slice(1);
  const { item, end } = rlpItem(body, 0);
  if (end !== body.length) throw new Error('bytes are left over after the transaction');
  if (!Array.isArray(item)) throw new Error('the transaction is not a list');
  const fields = type === 0 ? 9 : type === 1 ? 11 : 12;
  if (item.length !== fields) throw new Error('the transaction has the wrong number of fields');

  // legacy: nonce, gasPrice, gas, to, value, data, v, r, s
  // type 1: chainId, nonce, gasPrice, gas, to, value, data, accessList, yParity, r, s
  // type 2: chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList, yParity, r, s
  const at =
    type === 0 ? { nonce: 0, to: 3 } : type === 1 ? { nonce: 1, to: 4 } : { nonce: 1, to: 5 };
  const nonce = numberOf(item[at.nonce], 'the nonce');
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the nonce is out of range');
  const to = bytesOf(item[at.to], 'the target');
  if (to.length !== 0 && to.length !== 20) throw new Error('the target is not an address');
  let chainId: bigint | null;
  let accessList = 0;
  if (type === 0) {
    // A legacy signature names its chain inside `v` (EIP-155), or names none.
    const v = numberOf(item[6], 'v');
    chainId = v === 27n || v === 28n ? null : (v - 35n) / 2n;
    if (chainId !== null && v < 35n) throw new Error('v is not a recovery value');
  } else {
    chainId = numberOf(item[0], 'the chain id');
    const list = item[at.to + 3];
    if (!Array.isArray(list)) throw new Error('the access list is not a list');
    accessList = list.length;
  }
  for (const [i, what] of [
    [fields - 2, 'r'],
    [fields - 1, 's'],
  ] as const)
    if (numberOf(item[i], what) === 0n) throw new Error('the transaction is not signed');
  return {
    hash: `0x${hexEncode(keccak256(raw))}`,
    type,
    chainId,
    nonce: Number(nonce),
    to: to.length ? `0x${hexEncode(to)}` : null,
    value: numberOf(item[at.to + 1], 'the value'),
    data: bytesOf(item[at.to + 2], 'the call data'),
    accessList,
  };
}

/**
 * Throws unless what the wallet handed back is the transaction the guard passed, signed, and nothing
 * more. On Solana: the same message, byte for byte. On EVM the guard passes a call, and the wallet makes
 * the transaction around it: it has to be for the deployment's chain, to the same target, with no value,
 * the same call data, an empty access list, and of a type that can carry nothing else. A mock chain's
 * transactions are the mock's own and are not read here.
 */
export function heldToPass(pass: Guarded, deployment: GuardDeployment, signedTx: string): void {
  const { tx } = pass;
  if (deployment.family === 'solana') {
    const signed = signedSolana(signedTx);
    const given = parseSolanaTransaction(base64Decode(tx.payload));
    if (!sameBytes(signed.message, given.message))
      throw new Error('the wallet signed another message than the one it was given');
    return;
  }
  if (deployment.family === 'evm') {
    const signed = signedEvm(signedTx);
    if (
      signed.chainId !== BigInt(deployment.evmChainId) ||
      signed.to !== tx.evm?.to.toLowerCase() ||
      signed.value !== 0n ||
      !sameBytes(signed.data, hexDecode(tx.payload)) ||
      signed.accessList !== 0
    )
      throw new Error('the wallet signed another transaction than the call it was given');
  }
}
