import {
  ChainError,
  ChainErrorCode,
  type OrderError,
  type OrderErrorCode,
} from '@colosseum/schemas';

// What an order route answers when it says no is the shared `OrderError` (DESIGN-VAULT 3.3): the
// existing error shape plus `code`, `fix` and `details`. A refusal that came from a chain keeps the
// chain's own code and its `retryable` in `details`, so a client can tell "try again" from "change
// something first".

/** Thrown anywhere under /v1 and turned into its status and body by the scope's error handler. */
export class Refusal extends Error {
  readonly status: number;
  readonly extra: Omit<OrderError, 'error'>;
  constructor(status: number, message: string, extra: Omit<OrderError, 'error'> = {}) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.extra = extra;
  }
  body(): OrderError {
    return { error: this.message, ...this.extra };
  }
}

type Mapped = { code?: OrderErrorCode; status: number; fix?: string };

/**
 * A chain's refusal as the API reports it. Only the codes with a counterpart among the order codes get
 * one; the rest answer 409 with the chain's code in `details`.
 */
const CHAIN_TO_ORDER: Partial<Record<ChainErrorCode, Mapped>> = {
  NotFunded: {
    code: 'NOT_FUNDED',
    status: 409,
    fix: 'Add cash to the wallet on this chain, then build the step again.',
  },
  NoGas: {
    code: 'NOT_FUNDED',
    status: 409,
    fix: 'Add the network fee token to the wallet on this chain, then build the step again.',
  },
  MintNotAccepted: { code: 'ASSET_NOT_ELIGIBLE', status: 422 },
  AssetNotPriced: { code: 'ASSET_NOT_ELIGIBLE', status: 422 },
  NewAssetNeedsOwner: { code: 'NEW_ASSET_NEEDS_APPROVAL', status: 409 },
  VersionMismatch: { code: 'VERSION_CHANGED', status: 409, fix: 'Read the plan again.' },
  VersionNotEffective: { code: 'VERSION_CHANGED', status: 409 },
  CreatorLimit: { code: 'CREATOR_LIMIT', status: 422 },
  Unavailable: { code: 'CHAIN_UNAVAILABLE', status: 503, fix: 'Try again in a moment.' },
  BadInput: { status: 422 },
  // An adapter throws Unknown for its own bugs: not something the caller can fix.
  Unknown: { status: 500 },
};

/**
 * What an answer says for a chain error whose own text is not ours to show: one the adapter made from
 * something it did not expect (`Unknown`), or one that wraps a raw error (`cause`). A library's message
 * can carry the node's URL, and a node URL can carry its key ("HTTP request failed. URL: …").
 */
export const UNSAID_CHAIN_ERROR = 'the chain could not be read or reached as expected just now';

export function refusalFromChainError(e: ChainError): Refusal {
  const mapped = CHAIN_TO_ORDER[e.code] ?? { status: 409 };
  const sayable = e.code !== 'Unknown' && e.cause === undefined;
  const refusal = new Refusal(mapped.status, sayable ? e.message : UNSAID_CHAIN_ERROR, {
    ...(mapped.code ? { code: mapped.code } : {}),
    ...(mapped.fix ? { fix: mapped.fix } : {}),
    details: { chainCode: e.code, retryable: e.retryable },
  });
  // The raw error stays for the server's log, never for the answer.
  refusal.cause = e;
  return refusal;
}

/** Runs chain work and reports a ChainError as a Refusal. Anything else is a bug and passes through. */
export async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof ChainError) throw refusalFromChainError(e);
    throw e;
  }
}

/** What a leg stores about a transaction that reverted: the chain's code, and whether a new build can work. */
export function legErrorFromRevert(error: { code: string; message: string } | undefined) {
  const known = ChainErrorCode.safeParse(error?.code);
  const code = known.success ? known.data : 'Unknown';
  const message = error?.message ?? 'the transaction reverted';
  return { code, message, retryable: new ChainError(code, message).retryable };
}
