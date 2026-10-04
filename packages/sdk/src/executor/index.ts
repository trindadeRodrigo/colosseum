import { guardTransaction } from '../guard';
import { makeExecute } from './execute';

/**
 * Walks an order to its end: for each step, build, guard, sign, report, and wait for the chain.
 * `order` is the order as the person approved it on the review screen. The answer says how far it got
 * and why it stopped; running the same order again picks up where the API says it is.
 */
export const execute = makeExecute(guardTransaction);

export { type ApiFetch, ApiRefusal, createOrderApi, isApiRefusal, type OrderApi } from './api';
export {
  type ChainRead,
  chainReadOf,
  type EvmReads,
  type Fate,
  type SolanaReads,
} from './chain-read';
export {
  DEFAULT_PATIENCE,
  type ExecutionEvent,
  type ExecutionResult,
  type ExecutorDeps,
  type OrderSigner,
  type Patience,
  type SignedRecord,
  type SignedStore,
  signedKey,
} from './execute';
