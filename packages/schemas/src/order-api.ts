import { z } from 'zod';
import { BasketCard, BasketSheet, ObservationRef, Verdict } from './basket-sheet';
import { BasketTx } from './basket-tx';
import { ChainId } from './chain';
import { Provenance } from './enums';
import { ChainMode } from './flags';
import { Attempt, ConsentKind, OrderBase } from './order';
import { Price, VaultName, VaultView } from './vault';

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

/** One plan of a person's, as `GET /v1/me/plans` lists it. */
export const PersonPlan = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  /** Made from a link (an agent's): its vault is numbered from the plan and the buyer. */
  fromLink: z.boolean(),
  chain: ChainId,
  /** The goal the plan was built for. */
  sheet: BasketSheet,
  card: BasketCard,
  verdict: Verdict.nullable(),
  /** A buy's deposit is confirmed on chain. */
  bought: z.boolean(),
  orders: z.array(
    z.object({
      id: z.string().uuid(),
      createdAt: z.string(),
      amountUsd: z.number(),
      status: OrderBase.shape.status,
      deposited: z.boolean(),
    }),
  ),
  /** The vault the buys opened, by its chain and its number there; null while nothing was ordered. */
  vault: z.object({ chain: ChainId, basketId: z.string().min(1) }).nullable(),
});
export type PersonPlan = z.infer<typeof PersonPlan>;

/**
 * The signed-in person's plans, newest first: each with the goal it was built for (`sheet`), what the
 * plan screen says of it (`card`, and `verdict` for an income goal), its chain, the buys of it and the
 * vault they opened. The portfolio joins a vault to its goal by `vault`.
 */
export const PersonPlansResponse = z.object({
  plans: z.array(PersonPlan),
  /**
   * What to send as `before` for the page after this one: the time the last plan here was made.
   * Null on the last page.
   */
  next: z.string().nullable(),
});

/** The query of `GET /v1/me/plans`: a page of at most `limit` plans made before `before`. */
export const PersonPlansQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  before: z.string().datetime().optional(),
});
export type PersonPlansQuery = z.infer<typeof PersonPlansQuery>;
export type PersonPlansResponse = z.infer<typeof PersonPlansResponse>;

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
 * The plan a vault was opened for, as the server's join holds it (`vaults.basket_id`, DESIGN-VAULT
 * section 4): what the portfolio section's routes answer a vault with. `personal` is a plan made to
 * measure, with the stored plan's id; `follow` is a vault opened to follow a shared portfolio, with the
 * family's id and no sheet. The sheet, the card, the verdict and the observations are the stored plan's
 * own, as the engine made them, and come the four together or not at all: left out where the plan has
 * none stored, where one of them no longer reads, and for a plan that is not this person's to read
 * back (one another person made in the app, or one stored with no person and not made from a link).
 * The card's range and exit cost and the verdict's gap were worked out from the readings in
 * `observations`, each with its own source, time, method and provenance. `verdict` is null for a plan
 * whose goal is not an income.
 */
export const VaultPlan = z.object({
  kind: z.enum(['personal', 'follow']),
  /** When the order that opened the vault was made, as an ISO instant: the goal's date counts from it. */
  placedAt: z.string().datetime(),
  proposalId: z.uuid().optional(),
  familyId: z.string().optional(),
  sheet: BasketSheet.optional(),
  card: BasketCard.optional(),
  verdict: Verdict.nullable().optional(),
  observations: z.array(ObservationRef).optional(),
});
export type VaultPlan = z.infer<typeof VaultPlan>;

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
      vaults: z.array(
        VaultView.extend({
          provenance: Provenance,
          /** The name its owner gave it; null when they gave none. Left out by a server older than names. */
          name: VaultName.nullable().optional(),
          /** The caller's plan this vault was opened from; null when it follows a shared portfolio or the plan is not theirs to read. */
          planId: z.string().uuid().nullable().optional(),
        }),
      ),
      /** The reference prices the values were worked out with, each with its source and time. */
      prices: z.array(Price),
    }),
  ),
  /**
   * The chains of the person's that could not be read this time, each with why: one switched off on
   * this server (`CHAIN_UNAVAILABLE`, not retryable), or one whose read failed. The chains that were
   * read are in `chains` all the same. Left out by a server older than this field: none.
   */
  unavailable: z
    .array(
      z.object({
        chain: ChainId,
        name: z.string(),
        code: z.string(),
        error: z.string(),
        retryable: z.boolean(),
      }),
    )
    .default([]),
  disclaimer: z.string(),
});
export type PortfolioResponse = z.infer<typeof PortfolioResponse>;

/**
 * PUT /v1/vaults/{chain}/{address}/name: the name a person gives a vault of theirs, or null to give it
 * none again. Plain text, shown as text.
 */
export const VaultNameRequest = z.object({ name: VaultName.nullable() });
export type VaultNameRequest = z.infer<typeof VaultNameRequest>;
export const VaultNameResponse = z.object({
  chain: ChainId,
  address: z.string(),
  name: VaultName.nullable(),
});
export type VaultNameResponse = z.infer<typeof VaultNameResponse>;

/** The path of GET /v1/vaults/{chain}/{address}: any vault, read from its chain. */
export const VaultRouteParams = z.object({ chain: ChainId, address: z.string().min(1).max(64) });
export type VaultRouteParams = z.infer<typeof VaultRouteParams>;

/**
 * GET /v1/vaults/{chain}/{address}: one vault as its chain has it, for anybody (DESIGN-VAULT section
 * 11, the public vault page). The same figures as the portfolio's, read for this answer.
 */
export const VaultResponse = z.object({
  chain: ChainId,
  name: z.string(),
  mode: ChainMode,
  provenance: Provenance,
  vault: VaultView.extend({ provenance: Provenance }),
  prices: z.array(Price),
  disclaimer: z.string(),
});
export type VaultResponse = z.infer<typeof VaultResponse>;
