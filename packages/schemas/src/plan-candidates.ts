import { z } from 'zod';
import { RiskRollUp, Share } from './basket';
import { BasketProposal } from './basket-sheet';
import { Bps } from './chain';

// The three candidate plans of one goal (gate THREE-PLANS, Oct 5; ENG-3 slice 3), what each is
// compared on, and the status of a plan with withdrawals. DESIGN-VAULT 3.6 and section 7.
//
// No odds and no projected return anywhere here: months paid at the rates observed on a stated date
// and under named stresses, and the carry those withdrawals need beside the carry observed.

/** The candidates in their fixed, neutral order. None is marked, selected or ranked. */
export const PlanCandidateId = z.enum(['cover', 'spread', 'carry']);
export type PlanCandidateId = z.infer<typeof PlanCandidateId>;

const Months = z.number().int().nonnegative();
const Counted = z.object({
  monthsPaid: Months,
  monthsWithWithdrawal: Months,
  /** What was owed and not paid, in the goal's currency. */
  shortfall: z.number().nonnegative(),
});

/** One way to close a gap: listed only if the plan it gives is met. */
export const PlanWay = z.object({ change: z.string().min(1), closesGap: z.literal(true) });
export type PlanWay = z.infer<typeof PlanWay>;

/**
 * The status of a plan with withdrawals to come. `observedOn` is the date of the latest yield reading
 * the plan counts. Each stress is named, with its sizes. `carryNeededBps` is the least flat yearly
 * rate on dollar yield that pays every month, null when no rate up to 100% does. `met`: every month
 * paid in the base case and under every stress. `ways` are tried by running the engine again with one
 * input changed; `noAmountCloses` says, beside them, that no larger amount does.
 */
export const PlanStatus = z.object({
  observedOn: z.string().nullable(),
  base: Counted,
  stresses: z.array(
    Counted.extend({ id: z.string().min(1), params: z.record(z.string(), z.number()) }),
  ),
  carryObservedBps: z.number().int(),
  carryNeededBps: z.number().int().nonnegative().nullable(),
  met: z.boolean(),
  ways: z.array(PlanWay),
  noAmountCloses: z.string().optional(),
});
export type PlanStatus = z.infer<typeof PlanStatus>;

/**
 * What a candidate is compared on (section 2.4 of docs/vault/research/portfolio-method.md). Every
 * figure is read from the plan and the figures it was made with. Not here yet: yield confidence and
 * primary redemption, which need data the shelf does not carry.
 */
export const PlanScorecard = z.object({
  /** Months of withdrawals cash and the matching legs pay at par, in order; null with none to come. */
  monthsCovered: Months.nullable(),
  base: Counted.nullable(),
  stresses: z.array(
    z.object({ id: z.string().min(1), monthsPaid: Months, shortfall: z.number().nonnegative() }),
  ),
  carryObservedBps: z.number().int(),
  /** Measured exit cost at the person's size, worst regime; null where nothing is measured. */
  exit: z.object({ costBps: z.number().nonnegative().nullable(), measuredShareBps: Bps }),
  concentration: z.object({
    byIssuer: z.array(Share),
    byClass: z.array(Share),
    largestIssuerBps: Bps,
    issuers: z.number().int().nonnegative(),
  }),
  creditBasisBps: Bps,
  /** Dollars owed in the goal's currency beyond its matching leg. Left out for a goal in dollars. */
  openFxUsd: z.number().nonnegative().optional(),
});
export type PlanScorecard = z.infer<typeof PlanScorecard>;

/** One candidate as the API answers it: stored, so `id` is what a buy names. */
export const PlanCandidate = z.object({
  candidate: PlanCandidateId,
  id: z.string().uuid(),
  proposal: BasketProposal,
  rollUp: RiskRollUp,
  scorecard: PlanScorecard,
  /** Present when the sheet has withdrawals to come. */
  status: PlanStatus.optional(),
});
export type PlanCandidate = z.infer<typeof PlanCandidate>;

/** A candidate that is not shown, and why: one choice with another, dominated, or ahead on nothing. */
export const PlanCandidateNotShown = z.object({
  candidate: PlanCandidateId,
  why: z.string().min(1),
});
export type PlanCandidateNotShown = z.infer<typeof PlanCandidateNotShown>;
