import { ApiError, ChainError, ChainErrorCode, OrderErrorCode } from '@colosseum/schemas';
import { z } from 'zod';

// What an order route answers when it says no (DESIGN-VAULT 3.3): the existing error shape plus `code`
// and `fix`. A refusal that came from a chain keeps the chain's own code and its `retryable` in
// `details`, so a client can tell "try again" from "change something first".

export const RefusalBody = ApiError.extend({
  /** One of the ten order codes, where one fits. Absent for a refusal that is none of them. */
  code: OrderErrorCode.optional(),
  fix: z.string().optional(),
  details: z
    .object({
      /** The chain adapter's own code. */
      chainCode: ChainErrorCode.optional(),
      /** True when the same request can succeed later with nothing changed by the person. */
      retryable: z.boolean().optional(),
    })
    .optional(),
});
export type RefusalBody = z.infer<typeof RefusalBody>;

/** Thrown anywhere under /v1 and turned into its status and body by the scope's error handler. */
export class Refusal extends Error {
  readonly status: number;
  readonly extra: Omit<RefusalBody, 'error'>;
  constructor(status: number, message: string, extra: Omit<RefusalBody, 'error'> = {}) {
    super(message);
    this.name = 'Refusal';
    this.status = status;
    this.extra = extra;
  }
  body(): RefusalBody {
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

export function refusalFromChainError(e: ChainError): Refusal {
  const mapped = CHAIN_TO_ORDER[e.code] ?? { status: 409 };
  return new Refusal(mapped.status, e.message, {
    ...(mapped.code ? { code: mapped.code } : {}),
    ...(mapped.fix ? { fix: mapped.fix } : {}),
    details: { chainCode: e.code, retryable: e.retryable },
  });
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
