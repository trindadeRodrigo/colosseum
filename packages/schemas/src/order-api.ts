import { z } from 'zod';
import { BasketTx } from './basket-tx';
import { Attempt, ConsentKind } from './order';

// The bodies of the order routes (DESIGN-VAULT 3.3), named once so the API, the SDK and the web share
// them. POST /v1/orders takes an IntentRequest and answers with an Order, as does GET /v1/orders/{id}.

/** POST /v1/orders/{id}/legs/{legId}/build: a fresh transaction and the attempt that records it. */
export const BuildLegResponse = z.object({ tx: BasketTx, attempt: Attempt });
export type BuildLegResponse = z.infer<typeof BuildLegResponse>;

/**
 * POST /v1/orders/{id}/legs/{legId}/report. `txId` when the wallet sent it itself; `signedTx` (Solana)
 * when the server should send it, which it does only if the bytes hash to an attempt it built.
 * Exactly one of the two. The answer is the Order.
 */
export const ReportLegRequest = z.union([
  z.strictObject({ txId: z.string().min(1) }),
  z.strictObject({ signedTx: z.string().min(1) }),
]);
export type ReportLegRequest = z.infer<typeof ReportLegRequest>;

/**
 * POST /v1/orders/{id}/consent, signed-in owner only. The server stores it against the order, the
 * caller's address and a hash of the legs it covers. The answer is the Order.
 */
export const ConsentRequest = z.object({
  kinds: z.array(ConsentKind).min(1),
  /** The version of the consent text the person saw. */
  textVersion: z.string().min(1),
});
export type ConsentRequest = z.infer<typeof ConsentRequest>;
