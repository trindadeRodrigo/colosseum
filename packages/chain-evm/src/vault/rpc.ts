import { ChainError } from '@colosseum/schemas';
import {
  AbiDecodingZeroDataError,
  BaseError,
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  ExecutionRevertedError,
  http,
  type PublicClient,
  RawContractError,
} from 'viem';

// The node the reader asks, made by the caller from its own RPC URL. No URL is ever part of a message:
// it can carry a key.

/** What the reader needs of a node: viem's public client, over any transport. */
export type EvmRpc = PublicClient;

/**
 * A client on one URL. Requests made together go as one JSON-RPC batch, so the reads of one moment
 * (every call names the same block) cost one round trip.
 */
export function createEvmRpc(url: string, options: { timeoutMs?: number } = {}): EvmRpc {
  return createPublicClient({
    transport: http(url, { batch: true, timeout: options.timeoutMs ?? 30_000, retryCount: 2 }),
  });
}

/**
 * True when the node answered and the call reverted or returned nothing: the contract said no, or
 * there is no contract. False when the node did not answer at all.
 */
export function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return Boolean(
    e.walk(
      (inner) =>
        inner instanceof ContractFunctionRevertedError ||
        inner instanceof ContractFunctionZeroDataError ||
        inner instanceof ExecutionRevertedError ||
        inner instanceof RawContractError ||
        inner instanceof AbiDecodingZeroDataError,
    ),
  );
}

/**
 * Runs one request of the node. A node that does not answer is `Unavailable`, worth asking again; its
 * own message is not passed on, since it can carry the URL. A revert is left to the caller.
 */
export async function ask<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ChainError || isRevert(e)) throw e;
    // A call error that is not a revert is the node's: a timeout, a refused request.
    const kind =
      e instanceof ContractFunctionExecutionError || e instanceof CallExecutionError
        ? 'the call'
        : 'the request';
    const error = new ChainError('Unavailable', `the EVM RPC did not answer ${what} (${kind})`);
    error.cause = e;
    throw error;
  }
}
