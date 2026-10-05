import { readFileSync } from 'node:fs';
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionEncoder,
  type Instruction,
  isSolanaError,
  type KeyPairSigner,
  pipe,
  type RpcTransport,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { failed, sendMeasured } from '../env';

// What the test-network set-up needs of a chain, and nothing else: send a transaction, read an
// account, ask what bytes cost. A real cluster answers over RPC; LiteSVM answers in memory, so the
// same set-up runs in the test suite.

export type AccountView = { data: Uint8Array; owner: Address; lamports: bigint };

export type Sent = { signature: string; bytes: number };

export type Chain = {
  /** Sends one transaction and waits until it is confirmed. Throws when it fails. */
  send(
    payer: TransactionSigner,
    instructions: Instruction[],
    tables?: Record<Address, Address[]>,
  ): Promise<Sent>;
  /** What an account of this many bytes must hold to be exempt from rent. */
  rent(bytes: bigint): Promise<bigint>;
  account(address: Address): Promise<AccountView | null>;
  /** The cluster's clock, in unix seconds. */
  now(): Promise<bigint>;
  /** A recent slot, for a lookup table's address. */
  slot(): Promise<bigint>;
};

const CLOCK = address('SysvarC1ock11111111111111111111111111111111');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mainnet's first block. A cluster that answers with it is never set up from here. */
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** Which cluster a URL and its genesis hash are: devnet, or a validator on this machine. Anything
 * else throws before a transaction is built, mainnet first of all. */
export function clusterOf(url: string, genesis: string): 'devnet' | 'local' {
  if (genesis === MAINNET_GENESIS)
    throw new Error('this cluster is mainnet: the test-network set-up never runs there');
  if (genesis === DEVNET_GENESIS) return 'devnet';
  const host = new URL(url).hostname;
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return 'local';
  throw new Error(
    `the cluster at ${host} is neither devnet nor on this machine (genesis ${genesis}): nothing is sent`,
  );
}

/** A signer from a key file in the Solana CLI's form: a JSON list of 64 bytes. Whatever goes wrong,
 * the error names the path and nothing of what the file holds: a parser's message quotes its input. */
export async function keypairFromFile(path: string): Promise<KeyPairSigner> {
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new Error(
      code ? `the key file ${path} cannot be read (${code})` : `the key file ${path} is not JSON`,
    );
  }
  const valid =
    Array.isArray(bytes) &&
    bytes.length === 64 &&
    bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (!valid) throw new Error(`the key file ${path} is not a list of 64 bytes`);
  try {
    return await createKeyPairSignerFromBytes(new Uint8Array(bytes as number[]));
  } catch {
    throw new Error(`the key file ${path} does not hold a key pair whose halves match`);
  }
}

export type RpcChain = Chain & { genesisHash(): Promise<string> };

/** A transport that waits and asks again when the node answers 429. The public devnet endpoint rate
 * limits a run of 46 transactions and their reads; a repeated read changes nothing, and a repeated
 * send carries the same signed bytes, so it is the same transaction. Any other error is thrown. */
export function retryOn429(
  transport: RpcTransport,
  {
    tries = 8,
    firstWaitMs = 500,
    wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = {},
): RpcTransport {
  return (async (config: Parameters<RpcTransport>[0]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await transport(config);
      } catch (error) {
        const limited =
          isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
          error.context.statusCode === 429;
        if (!limited || attempt >= tries) throw error;
        await wait(firstWaitMs * 2 ** (attempt - 1));
      }
    }
  }) as RpcTransport;
}

/** A cluster over its JSON RPC. Every read and every confirmation is at `confirmed`. */
export function rpcChain(url: string): RpcChain {
  const rpc = createSolanaRpcFromTransport(retryOn429(createDefaultRpcTransport({ url })));
  const base64 = getBase64Encoder();
  const account = async (target: Address): Promise<AccountView | null> => {
    const { value } = await rpc
      .getAccountInfo(target, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!value) return null;
    return {
      data: new Uint8Array(base64.encode(value.data[0])),
      owner: value.owner,
      lamports: value.lamports,
    };
  };
  return {
    account,
    genesisHash: () => rpc.getGenesisHash().send(),
    rent: (bytes) => rpc.getMinimumBalanceForRentExemption(bytes).send(),
    // A lookup table is made from a slot the transaction's bank holds in its slot hashes. The node
    // checks a transaction at its confirmed bank, whose own slot is not among them: a finalized
    // slot is, for some 500 slots.
    slot: () => rpc.getSlot({ commitment: 'finalized' }).send(),
    async now() {
      const clock = await account(CLOCK);
      if (!clock) throw new Error('the cluster has no clock account');
      return new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true);
    },
    async send(payer, instructions, tables = {}) {
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
      );
      const transaction = await signTransactionMessageWithSigners(message);
      const signature = getSignatureFromTransaction(transaction);
      const bytes = getTransactionEncoder().encode(transaction).length;
      // The node's dry run refuses a transaction that would fail, with its logs, before it lands.
      try {
        await rpc
          .sendTransaction(getBase64EncodedWireTransaction(transaction), {
            encoding: 'base64',
            preflightCommitment: 'confirmed',
          })
          .send();
      } catch (error) {
        const context = (error as { context?: { logs?: string[]; err?: unknown } }).context;
        const why = context
          ? `${JSON.stringify(context.err ?? null, bigintAsText)}\n${(context.logs ?? []).join('\n')}`
          : '';
        throw new Error(`${error instanceof Error ? error.message : error}\n${why}`);
      }
      for (let i = 0; i < 240; i++) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (
          status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized'
        ) {
          if (status.err !== null)
            throw new Error(
              `transaction ${signature} failed: ${JSON.stringify(status.err, bigintAsText)}`,
            );
          return { signature, bytes };
        }
        await sleep(250);
      }
      throw new Error(`transaction ${signature} was not confirmed in a minute`);
    },
  };
}

const bigintAsText = (_: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

/** LiteSVM as a chain: the same set-up, in memory, for the test suite. */
export function liteChain(svm: LiteSVM): Chain {
  let sent = 0;
  return {
    async send(payer, instructions, tables = {}) {
      const { result, bytes } = await sendMeasured(svm, payer, instructions, tables);
      if (failed(result))
        throw new Error(`transaction failed: ${result.toString()}\n${result.meta().prettyLogs()}`);
      sent += 1;
      return { signature: `litesvm-${sent}`, bytes };
    },
    rent: async (bytes) => svm.minimumBalanceForRentExemption(bytes),
    async account(target) {
      const found = svm.getAccount(target);
      if (!found.exists) return null;
      return {
        data: new Uint8Array(found.data),
        owner: found.programAddress,
        lamports: found.lamports,
      };
    },
    now: async () => svm.getClock().unixTimestamp,
    slot: async () => svm.getClock().slot,
  };
}
