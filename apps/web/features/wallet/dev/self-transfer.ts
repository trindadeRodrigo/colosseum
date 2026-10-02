import { BasketTx } from '@colosseum/schemas';
import { base58Decode, base64Encode, bytesToHex } from '../bytes';
import type { WalletChain } from '../chains';
import { evmRpc, solanaRpc } from './rpc';

// The dev page's two harmless transactions: the smallest unit of the gas token, from an account to
// itself. They are built here, in the browser, only because the dev page has to work before the API
// builds anything. In the product every transaction comes from the API.
//
// A self-transfer is not a leg of any order, so `legKind`, `legId` and `attemptId` are stand-ins.

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest)).slice(2);
}

const u64le = (n: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};

/**
 * A v0 transaction with one System Program transfer from `owner` to `owner`, unsigned.
 * Exported for the test that reads it back with @solana/kit.
 */
export function solanaSelfTransferBytes(
  owner: string,
  blockhash: string,
  lamports: bigint,
): { transaction: Uint8Array; message: Uint8Array } {
  const key = base58Decode(owner);
  const recent = base58Decode(blockhash);
  if (key.length !== 32 || recent.length !== 32) throw new Error('expected two 32-byte values');
  const message = Uint8Array.from([
    0x80, // version 0
    ...[1, 0, 1], // one signer; no read-only signer; one read-only account that does not sign
    2, // two accounts: the owner, then the System Program (32 zero bytes)
    ...key,
    ...new Uint8Array(32),
    ...recent,
    1, // one instruction
    ...[1, 2, 0, 0], // program at index 1; two accounts: from (0) and to (0)
    ...[12, 2, 0, 0, 0], // twelve bytes of data: Transfer is instruction 2, then the amount
    ...u64le(lamports),
    0, // no address lookup tables
  ]);
  // One empty signature slot, then the message.
  return { transaction: Uint8Array.from([1, ...new Uint8Array(64), ...message]), message };
}

const LEG = { legKind: 'deposit', legId: 'dev-wallet-check' } as const;

export async function solanaSelfTransfer(chain: WalletChain, owner: string): Promise<BasketTx> {
  const recent = await solanaRpc(chain).latestBlockhash();
  const lamports = 1n;
  const { transaction, message } = solanaSelfTransferBytes(owner, recent.value.blockhash, lamports);
  const summary = `Dev check: send ${lamports} lamport from this account to itself on ${chain.config.networkName}`;
  return BasketTx.parse({
    ...LEG,
    attemptId: `dev-${recent.fetchedAt}`,
    chain: 'solana',
    chainId: chain.config.id,
    payload: base64Encode(transaction),
    description: summary,
    provenance: chain.provenance,
    lastValidBlockHeight: recent.value.lastValidBlockHeight,
    signer: owner,
    feePayer: owner,
    messageHash: await sha256Hex(message),
    preview: {
      source: recent.source,
      method: recent.method,
      fetchedAt: recent.fetchedAt,
      provenance: chain.provenance,
      summary,
      simulated: false,
      // Solana charges 5,000 lamports per signature; this transaction has one.
      feeNativeRaw: '5000',
      changes: [],
    },
  });
}

export async function evmSelfTransfer(chain: WalletChain, owner: string): Promise<BasketTx> {
  const evmChainId = chain.config.evmChainId;
  if (evmChainId === null) throw new Error(`${chain.config.id} is not an EVM chain`);
  const request = {
    to: owner as `0x${string}`,
    data: '0x' as const,
    value: 1n,
    chainId: evmChainId,
  };
  const fees = await evmRpc(chain).fees(owner, request);
  const fetchedAt = new Date().toISOString();
  const summary = `Dev check: send ${request.value} wei from this account to itself on ${chain.config.networkName}`;
  return BasketTx.parse({
    ...LEG,
    attemptId: `dev-${fetchedAt}`,
    chain: 'evm',
    chainId: chain.config.id,
    payload: request.data,
    evm: { to: owner, value: request.value.toString(), chainId: evmChainId },
    description: summary,
    provenance: chain.provenance,
    signer: owner,
    // The wallet sets the nonce and the fee, so the bytes it signs do not exist yet: this is the hash
    // of the call alone.
    messageHash: await sha256Hex(
      new TextEncoder().encode(`${evmChainId}:${owner}:${request.value}:${request.data}`),
    ),
    preview: {
      source: new URL(chain.rpcUrl).host,
      method: 'eth_estimateGas × eth_gasPrice × 2',
      fetchedAt,
      provenance: chain.provenance,
      summary,
      simulated: false,
      feeNativeRaw: (fees.gas * fees.maxFeePerGas).toString(),
      changes: [],
    },
  });
}
