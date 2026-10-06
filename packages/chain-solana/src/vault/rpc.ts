import { ChainError } from '@colosseum/schemas';
import {
  type Address,
  type Base58EncodedBytes,
  type Commitment,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type GetBalanceApi,
  type GetBlockHeightApi,
  type GetGenesisHashApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetMultipleAccountsApi,
  type GetProgramAccountsApi,
  type GetRecentPrioritizationFeesApi,
  type GetSignatureStatusesApi,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  getBase58Decoder,
  getBase64Encoder,
  type Rpc,
  type RpcTransport,
  type SendTransactionApi,
  type SimulateTransactionApi,
} from '@solana/kit';

// The RPC seam. The caller makes the client (`createSolanaRpc(url)`) and hands it in; nothing here knows
// a URL or reads the environment. These are the only methods the read side calls, so a test can stand in
// for the network with an object that answers them.

export type VaultRpc = Rpc<
  GetBalanceApi &
    GetBlockHeightApi &
    GetMinimumBalanceForRentExemptionApi &
    GetMultipleAccountsApi &
    GetProgramAccountsApi &
    GetSignatureStatusesApi &
    GetTransactionApi
>;

/**
 * What the builders and the probe call on top of the reads: a blockhash, a simulation, the recent
 * priority fees, a send, and a signer's recent signatures. Still no URL here and no key.
 */
export type VaultWriteRpc = Rpc<
  GetBalanceApi &
    GetBlockHeightApi &
    GetMinimumBalanceForRentExemptionApi &
    GetMultipleAccountsApi &
    GetProgramAccountsApi &
    GetSignatureStatusesApi &
    GetTransactionApi &
    GetLatestBlockhashApi &
    SimulateTransactionApi &
    GetRecentPrioritizationFeesApi &
    SendTransactionApi &
    GetSignaturesForAddressApi
>;

export type RawAccount = { address: Address; owner: Address; lamports: bigint; data: Uint8Array };

/** How long one call to the node may take before it counts as not answered. */
export const RPC_TIMEOUT_MS = 30_000;

/**
 * A client for the builders and the probe, from a URL the caller holds. The URL is never logged and
 * never put in a message: an RPC address can carry a key. Every call gives up after `timeoutMs`, so a
 * connection the node holds open and never answers fails that call (`ask` says it did not answer)
 * instead of stalling whoever waits on it, the keeper's round included.
 */
export function createVaultRpc(url: string, timeoutMs = RPC_TIMEOUT_MS): VaultNodeRpc {
  return createSolanaRpcFromTransport(withTimeout(createDefaultRpcTransport({ url }), timeoutMs));
}

/** A transport whose every request is aborted after `ms`, and still by the caller's own signal. */
export function withTimeout<T extends RpcTransport>(transport: T, ms: number): T {
  return (<R>(config: Parameters<RpcTransport>[0]) => {
    const timeout = AbortSignal.timeout(ms);
    return transport<R>({
      ...config,
      signal: config.signal ? AbortSignal.any([config.signal, timeout]) : timeout,
    });
  }) as T;
}

/** The write side's calls and the node's genesis hash: what a server checks at start (`assertNode`). */
export type VaultNodeRpc = VaultWriteRpc & Rpc<GetGenesisHashApi>;

/** The most addresses one getMultipleAccounts call takes. */
const BATCH = 100;

const base64 = getBase64Encoder();
const base58 = getBase58Decoder();

export function toBase58(bytes: Uint8Array): Base58EncodedBytes {
  return base58.decode(bytes) as Base58EncodedBytes;
}

/**
 * Runs one RPC call. A call that fails becomes `Unavailable`: the message says which call, and never
 * repeats the transport's own text, which can carry the RPC's address.
 */
export async function ask<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    if (cause instanceof ChainError) throw cause;
    const error = new ChainError('Unavailable', `the Solana RPC did not answer ${what}`);
    error.cause = cause;
    throw error;
  }
}

/** Accounts in the order asked, null where there is none. Batched by the hundred. */
export async function getAccounts(
  rpc: VaultRpc,
  addresses: Address[],
  commitment: Commitment,
): Promise<(RawAccount | null)[]> {
  const batches: Address[][] = [];
  for (let i = 0; i < addresses.length; i += BATCH) batches.push(addresses.slice(i, i + BATCH));
  const answers = await Promise.all(
    batches.map((batch) =>
      ask('getMultipleAccounts', () =>
        rpc.getMultipleAccounts(batch, { encoding: 'base64', commitment }).send(),
      ),
    ),
  );
  return answers.flatMap((answer, b) =>
    answer.value.map((account, i) => {
      const address = batches[b]?.[i];
      if (!account || !address) return null;
      return {
        address,
        owner: account.owner,
        lamports: BigInt(account.lamports),
        data: new Uint8Array(base64.encode(account.data[0])),
      };
    }),
  );
}

export type Memcmp = { offset: number; bytes: Uint8Array };

/**
 * A program's accounts of one size whose bytes match every filter. `addressesOnly` asks the node for no
 * data at all. The node takes at most four filters, the size included. An account the node hands back
 * under another owner is dropped: a vault-shaped account of another program is not a vault.
 */
export async function getProgramAccounts(
  rpc: VaultRpc,
  program: Address,
  query: { dataSize: number; memcmp: Memcmp[]; addressesOnly?: boolean },
  commitment: Commitment,
): Promise<RawAccount[]> {
  const filters = [
    { dataSize: BigInt(query.dataSize) },
    ...query.memcmp.map((m) => ({
      memcmp: { offset: BigInt(m.offset), bytes: toBase58(m.bytes), encoding: 'base58' as const },
    })),
  ];
  const found = await ask('getProgramAccounts', () =>
    rpc
      .getProgramAccounts(program, {
        encoding: 'base64',
        commitment,
        filters,
        ...(query.addressesOnly ? { dataSlice: { offset: 0, length: 0 } } : {}),
      })
      .send(),
  );
  return found
    .filter(({ account }) => account.owner === program)
    .map(({ pubkey, account }) => ({
      address: pubkey,
      owner: account.owner,
      lamports: BigInt(account.lamports),
      data: new Uint8Array(base64.encode(account.data[0])),
    }));
}
