import { z } from 'zod';
import { AssetClass } from './basket-asset';
import { BasketProposal } from './basket-sheet';
import { AssetId, Bps, ChainId, DecimalString, Sourced } from './chain';
import { Language, Provenance } from './enums';
import { ORDER_LIMITS } from './order';
import { OrderDetail } from './order-api';
import { Target } from './recipe';

// A mix a person takes from the vault or new-goal conversation, or chooses themselves, made into
// something that can be bought (gate ANY-COMPOSITION, Thom, Oct 8). The client sends the lines
// back; the server checks them again against the catalog and prices of the chain as they are now, and
// writes every figure and warning itself. Nothing the model wrote is a number here.

/** Who chose the weights, as the client says: the model in the conversation, or the person. */
export const MixOrigin = z.enum(['model', 'person']);
export type MixOrigin = z.infer<typeof MixOrigin>;

/**
 * One line as the client sends it. The cash line is the chain's dollar token and is the share left in
 * cash; every other line is a listed asset. Shape only: the server's checks are in `MixIssue`.
 */
export const MixLine = z.strictObject({ assetId: AssetId, weightBps: Bps });
export type MixLine = z.infer<typeof MixLine>;

/** At most 64 lines are read, as the conversation's proposal allows; a vault holds 16 (`TOO_MANY_LINES`). */
export const MixLines = z.array(MixLine).min(1).max(64);

/**
 * Why a mix cannot be bought. `NOT_LISTED`, `DUPLICATE`, `NO_PRICE` and `FOREIGN_CASH` carry the
 * asset (`NOT_LISTED:solana:xyz`); the rest stand alone. Sent in `details.issues` of a 422
 * `MIX_NOT_VALID`.
 */
export const MixIssueCode = z.enum([
  /** A weight that is not a whole number of bps from 1 to 10,000. */
  'WEIGHT_NOT_WHOLE',
  /** Not on this chain's asset list now. */
  'NOT_LISTED',
  /** Named twice. */
  'DUPLICATE',
  /** A cash-class token that is not the chain's own dollar token. */
  'FOREIGN_CASH',
  /** The weights, cash included, do not add up to exactly 10,000. */
  'SUM_NOT_10000',
  /** More than 16 lines that are not cash: a vault holds 16. */
  'TOO_MANY_LINES',
  /** No usable price now: the asset has no feed, or the chain's price is older than it trades on. */
  'NO_PRICE',
  /** All cash, for a vault that is already open: a vault's own targets cannot be emptied (orders/README item 9). */
  'ALL_CASH',
]);
export type MixIssueCode = z.infer<typeof MixIssueCode>;

/** A figure a warning or a line stands on, with where it came from. */
export const MixFigure = Sourced.extend({
  label: z.string().min(1),
  value: z.number().finite(),
  unit: z.enum(['USD', 'bps']),
});
export type MixFigure = z.infer<typeof MixFigure>;

/**
 * What the person is told before the mix is bought or applied. None of these stops it: each is
 * confirmed by its `id` in `acceptedWarnings`.
 *
 * - `EXIT_OVER_CAPACITY`: the line is larger than the share of the measured exit a plan counts on.
 * - `EXIT_OVER_TIER_CEILING`: nothing is measured for the asset, and the line is larger than its tier's
 *   ceiling, which stands in (gate EXIT-SOURCE).
 * - `OVER_LISTED_CAP`: the line weighs more than the asset list's cap for the asset.
 * - `NOT_FOR_GOAL`: an asset an income or protect plan does not normally hold, stocks above all (gate
 *   PROTECT-NO-STOCKS, a warning for a mix the person confirms since Oct 8).
 * - `STOPS_FOLLOWING`: the vault follows a shared portfolio or has auto-follow on; its own targets end
 *   both.
 */
export const MixWarningCode = z.enum([
  'EXIT_OVER_CAPACITY',
  'EXIT_OVER_TIER_CEILING',
  'OVER_LISTED_CAP',
  'NOT_FOR_GOAL',
  'STOPS_FOLLOWING',
]);
export type MixWarningCode = z.infer<typeof MixWarningCode>;

export const MixWarning = z.strictObject({
  /** `CODE` or `CODE:assetId`: what `acceptedWarnings` names. */
  id: z.string().min(1).max(200),
  code: MixWarningCode,
  assetId: AssetId.optional(),
  /** Written by the server from a template, in the request's language. */
  text: z.string().min(1),
  figures: z.array(MixFigure),
});
export type MixWarning = z.infer<typeof MixWarning>;

/** One line as the server checked it, with the figures it shows. */
export const MixReviewLine = z.strictObject({
  assetId: AssetId,
  symbol: z.string().min(1),
  cls: AssetClass,
  weightBps: Bps,
  /** The line's share of the amount, in dollars to the cent: the amount times the weight, split to the cent. */
  amountUsd: z.number().nonnegative(),
  /** The reference price used, with its source. Null for cash, counted at one dollar. */
  price: Sourced.extend({ usdPerToken: DecimalString }).nullable(),
  /**
   * The most this line may hold and still be sold as planned: the share of the measured exit a plan
   * counts on, or, where nothing is measured, the tier's ceiling (`measured` false). Null for cash.
   */
  exitCeiling: Sourced.extend({ usd: z.number().nonnegative(), measured: z.boolean() }).nullable(),
});
export type MixReviewLine = z.infer<typeof MixReviewLine>;

/** The server's reading of a mix: the lines, the figures and the warnings. Nothing is stored or built. */
export const MixReview = z.strictObject({
  chain: ChainId,
  origin: MixOrigin,
  /** The goal the stock check was made against; null for a vault whose plan the server does not hold. */
  goal: z.enum(['grow', 'income', 'protect']).nullable(),
  /** The amount the lines split: the buy's amount, or the vault's value at the prices of `lines`. */
  amountUsd: z.number().nonnegative(),
  /** Cash first where there is any, then each asset in the order sent. They add up to 10,000. */
  lines: z.array(MixReviewLine).min(1),
  /** What a vault is given: each asset that is not cash, with its weight. Cash is what they leave. */
  targets: z.array(Target).max(16),
  cashBps: Bps,
  warnings: z.array(MixWarning),
  /** The warnings `acceptedWarnings` does not name yet. Empty: the mix can be confirmed as sent. */
  unconfirmed: z.array(z.string()),
  provenance: Provenance,
  disclaimer: z.string(),
});
export type MixReview = z.infer<typeof MixReview>;

const confirmation = {
  version: z.literal(1),
  origin: MixOrigin,
  language: Language,
  allocations: MixLines,
  /** False: answer the review and store nothing. True: go ahead once every warning is accepted. */
  confirm: z.boolean(),
  /** The ids of the warnings the person confirmed, from the review they saw. */
  acceptedWarnings: z.array(z.string().min(1).max(200)).max(200).default([]),
};

/** `POST /v1/conversations/{chain}/goal/accept`: a mix for a new vault, with the goal and amount the person confirmed. */
export const AcceptGoalMixRequest = z.strictObject({
  ...confirmation,
  goal: z.enum(['grow', 'income', 'protect']),
  risk: z.enum(['low', 'medium', 'high']),
  amountUsd: z.number().min(10).max(ORDER_LIMITS.maxAmountUsd, 'one order buys at most $1,000,000'),
  /** The goal's term. Left out: the goal has no date (`horizonOpen`). */
  horizonMonths: z.number().int().min(1).max(480).optional(),
});
export type AcceptGoalMixRequest = z.infer<typeof AcceptGoalMixRequest>;

/**
 * `review`: nothing stored; `unconfirmed` lists what is left to accept. `stored`: the mix is a plan,
 * and `proposalId` is what `POST /v1/orders` buys, as any plan.
 */
export const AcceptGoalMixResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('review'), review: MixReview }),
  z.strictObject({
    status: z.literal('stored'),
    review: MixReview,
    proposalId: z.uuid(),
    proposal: BasketProposal,
  }),
]);
export type AcceptGoalMixResponse = z.infer<typeof AcceptGoalMixResponse>;

/** `POST /v1/vaults/{chain}/{address}/targets`: new targets for a vault the person owns. */
export const ApplyVaultMixRequest = z.strictObject({
  ...confirmation,
  /** The slippage each trade is built with. Left out, the server's own figure. */
  maxSlippageBps: Bps.max(ORDER_LIMITS.maxSlippageBps).optional(),
});
export type ApplyVaultMixRequest = z.infer<typeof ApplyVaultMixRequest>;

/**
 * `review`: nothing built or stored. `ordered`: an order whose first step sets the targets and whose
 * other steps sell and buy to them, signed and reported as any order (`/v1/orders/{id}/...`).
 */
export const ApplyVaultMixResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('review'), review: MixReview }),
  z.strictObject({ status: z.literal('ordered'), review: MixReview, order: OrderDetail }),
]);
export type ApplyVaultMixResponse = z.infer<typeof ApplyVaultMixResponse>;
