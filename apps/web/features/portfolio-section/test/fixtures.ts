import {
  PortfolioExposureResponse,
  PortfolioHistoryResponse,
  PortfolioPlansResponse,
  PortfolioRebalancesResponse,
} from '@colosseum/schemas';
import type { Plan, PlansChain } from '../api';
import { EXPOSURE, HISTORY, PLANS, REBALANCES } from '../fixtures/answers';
import {
  type Narrow,
  narrowExposure,
  narrowHistory,
  narrowPlans,
  narrowRebalances,
} from '../fixtures/narrow';

// What the four routes of the portfolio section answer, for the tests of its pages: the sample
// answers of ../fixtures/answers.ts (where the figures live, and where each vault is described),
// parsed with the contract's schemas, so a change to a frozen shape breaks these tests first. Each
// call gives a fresh copy, whole or narrowed as the route narrows it (`chain`, `address`, `limit`):
// a test changes its copy freely.
//
//   plans()                         every vault of the person's, on both chains
//   plans({ address: SOL_INCOME })  that vault alone, as a plan's page asks for it
//
// A page's test mounts with them through `serve` (./api.ts) and `inSection` (./screen.tsx).

export * from '../fixtures/answers';
export type { Narrow } from '../fixtures/narrow';

/** GET /v1/portfolio/plans. */
export const plans = (q: Narrow = {}): PortfolioPlansResponse =>
  PortfolioPlansResponse.parse(narrowPlans(PLANS, q));

/** GET /v1/portfolio/exposure. With `address`, the one made for that vault, or nothing. */
export const exposure = (q: Narrow = {}): PortfolioExposureResponse =>
  PortfolioExposureResponse.parse(narrowExposure(EXPOSURE, q));

/** GET /v1/portfolio/rebalances, newest first. */
export const rebalances = (q: Narrow & { limit?: number } = {}): PortfolioRebalancesResponse =>
  PortfolioRebalancesResponse.parse(narrowRebalances(REBALANCES, q));

/** GET /v1/portfolio/history: a week by the day. */
export const history = (q: Narrow = {}): PortfolioHistoryResponse =>
  PortfolioHistoryResponse.parse(narrowHistory(HISTORY, q));

/** One vault of the sample answer, with the chain's entry it is under. */
export function planAt(address: string): { chain: PlansChain; plan: Plan } {
  for (const chain of plans().chains)
    for (const plan of chain.plans) if (plan.address === address) return { chain, plan };
  throw new Error(`no vault ${address} in the sample plans`);
}
