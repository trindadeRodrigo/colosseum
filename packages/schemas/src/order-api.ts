import { z } from 'zod';
import { BasketTx } from './basket-tx';
import { ChainId } from './chain';
import { Provenance } from './enums';
import { ChainMode } from './flags';
import { Attempt, ConsentKind, OrderBase } from './order';
import { Price, VaultView } from './vault';

// The bodies of the order routes (DESIGN-VAULT 3.3), named once so the API, the SDK and the web share
// them. POST /v1/orders takes an IntentRequest. Every order route but the build answers with an
// OrderDetail, and every refusal is an OrderError (order.ts).

/**
 * What every order route answers: the Order plus every attempt at its legs, oldest first. A client that
 * reads it as an Order loses nothing. It extends the plain object, so the Order's own cross-field
 * checks (every leg is the order's, on a chain its owner has an address for) are the server's to run
 * before it answers.
 */
export const OrderDetail = OrderBase.extend({ attempts: z.array(Attempt) });
export type OrderDetail = z.infer<typeof OrderDetail>;

/** The path of GET /v1/orders/{id}. */
export const OrderRouteParams = z.object({ id: z.uuid() });
export type OrderRouteParams = z.infer<typeof OrderRouteParams>;

/** The path of the three leg routes: .../legs/{legId}/build, /report and /cancel. */
export const LegRouteParams = z.object({ id: z.uuid(), legId: z.uuid() });
export type LegRouteParams = z.infer<typeof LegRouteParams>;

/**
 * POST /v1/orders/{id}/legs/{legId}/cancel. No body: the person says the transaction of the leg's
 * latest attempt will not be sent, so the leg can be built again. The answer is the order. Refused
 * with 409 on Solana while the transaction can still land, and when it has landed.
 */
export const CancelLegResponse = OrderDetail;
export type CancelLegResponse = OrderDetail;

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

/**
 * GET /v1/portfolio: the signed-in person's vaults, one entry per chain that is not switched off.
 * `provenance` is the label on every figure under it: `mock` when the chain runs on the mock,
 * `sandbox` on a test network, `live` on mainnet only.
 */
export const PortfolioResponse = z.object({
  chains: z.array(
    z.object({
      chain: ChainId,
      name: z.string(),
      mode: ChainMode,
      provenance: Provenance,
      /** The caller's vaults, each with its value, and the weight and drift of every position. */
      vaults: z.array(VaultView.extend({ provenance: Provenance })),
      /** The reference prices the values were worked out with, each with its source and time. */
      prices: z.array(Price),
    }),
  ),
  disclaimer: z.string(),
});
export type PortfolioResponse = z.infer<typeof PortfolioResponse>;
