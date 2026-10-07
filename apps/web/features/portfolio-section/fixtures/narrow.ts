import type {
  PortfolioExposureResponse,
  PortfolioHistoryResponse,
  PortfolioPlansResponse,
  PortfolioRebalancesResponse,
} from '@colosseum/schemas';
import { EXPOSURE_BY_VAULT, EXPOSURE_OF_NOTHING } from './answers';

// The sample answers narrowed as the routes narrow theirs (`chain`, `address`, `limit`), for the tests
// of a page that asks for one vault and for the e2e stub. `chain` keeps that chain's entry and no
// other, among the read and the unavailable alike; `address` keeps that vault and answers nothing for
// any other address, never an error.

export type Narrow = { chain?: string; address?: string };

/** An EVM address is read in any case, as the API reads one. */
const same = (a: string, b: string) =>
  a === b || (a.startsWith('0x') && a.toLowerCase() === b.toLowerCase());

const onChain = <T extends { chain: string }>(entries: readonly T[], chain?: string): T[] =>
  entries.filter((entry) => chain === undefined || entry.chain === chain);

export function narrowPlans(answer: PortfolioPlansResponse, q: Narrow): PortfolioPlansResponse {
  const { address } = q;
  return {
    ...answer,
    chains: onChain(answer.chains, q.chain).map((entry) => ({
      ...entry,
      plans:
        address === undefined
          ? entry.plans
          : entry.plans.filter((plan) => same(plan.address, address)),
    })),
    unavailable: onChain(answer.unavailable, q.chain),
  };
}

export function narrowHistory(
  answer: PortfolioHistoryResponse,
  q: Narrow,
): PortfolioHistoryResponse {
  const { address } = q;
  return {
    ...answer,
    chains: onChain(answer.chains, q.chain).map((entry) => ({
      ...entry,
      vaults:
        address === undefined
          ? entry.vaults
          : entry.vaults.filter((series) => same(series.address, address)),
    })),
    unavailable: onChain(answer.unavailable, q.chain),
  };
}

/** `limit` is the most entries a chain's list keeps, newest first. */
export function narrowRebalances(
  answer: PortfolioRebalancesResponse,
  q: Narrow & { limit?: number },
): PortfolioRebalancesResponse {
  const { address, limit } = q;
  return {
    ...answer,
    chains: onChain(answer.chains, q.chain).map((entry) => ({
      ...entry,
      entries: entry.entries
        .filter(
          (step) => address === undefined || (step.vault !== null && same(step.vault, address)),
        )
        .slice(0, limit),
    })),
    unavailable: onChain(answer.unavailable, q.chain),
  };
}

/**
 * With `address` the answer is that vault's alone: the one made for it (`EXPOSURE_BY_VAULT`), or
 * nothing on every chain. With `chain` alone, that chain's entry, and a total that is that chain's.
 */
export function narrowExposure(
  answer: PortfolioExposureResponse,
  q: Narrow,
): PortfolioExposureResponse {
  const { address } = q;
  const whole =
    address === undefined
      ? answer
      : (Object.entries(EXPOSURE_BY_VAULT).find(([vault]) => same(vault, address))?.[1] ??
        EXPOSURE_OF_NOTHING);
  if (q.chain === undefined) return whole;
  const chains = onChain(whole.chains, q.chain);
  const [only] = chains;
  return {
    ...whole,
    chains,
    unavailable: onChain(whole.unavailable, q.chain),
    total:
      only && only.observedAt !== null
        ? {
            valueUsd: only.valueUsd,
            provenance: only.provenance,
            byUnderlying: only.byUnderlying,
            byIssuer: only.byIssuer,
          }
        : null,
  };
}
