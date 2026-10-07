import type { BasketSheet, PlanCandidate, PlanCandidateId } from '@colosseum/schemas';
import { proposalFor } from '../../goal/test/plan';

// The candidates of one goal as POST /v1/baskets/personalize answers them (gate THREE-PLANS), for the
// tests of the pane. Every figure here is made up.

export const CANDIDATE_ID: Record<PlanCandidateId, string> = {
  cover: '11111111-1111-4111-8111-111111111111',
  spread: '22222222-2222-4222-8222-222222222222',
  carry: '33333333-3333-4333-8333-333333333333',
};

const OBSERVATIONS = (['yield', 'liquidity'] as const).map((kind) => ({
  id: `obs-${kind}`,
  kind,
  source: 'a test',
  method: 'fixture',
  fetchedAt: '2026-10-05T12:00:00.000Z',
  provenance: 'sandbox' as const,
}));

/** One candidate of a sheet's goal, with a scorecard of its own. */
export function candidateFor(
  sheet: BasketSheet,
  candidate: PlanCandidateId,
  over: Partial<PlanCandidate> = {},
): PlanCandidate {
  const at = { cover: 0, spread: 1, carry: 2 }[candidate];
  const proposal = proposalFor(sheet, 'sandbox');
  return {
    candidate,
    id: CANDIDATE_ID[candidate],
    proposal: {
      ...proposal,
      candidate,
      observations: OBSERVATIONS,
      card: {
        ...proposal.card,
        expectedReturn: { ...proposal.card.expectedReturn, lossInFallUsd: 1000 * (at + 1) },
      },
    },
    rollUp: {
      byIssuer: [{ key: 'issuer one', bps: 6000 }],
      byChain: [{ key: sheet.chains[0] as string, bps: 10_000 }],
      byClass: [{ key: 'stock', bps: 6000 }],
      flags: [],
      exit: { quotedBps: null, quotedAt: null, measuredWorstBps: 30, measuredShareBps: 6000 },
    },
    scorecard: {
      monthsCovered: null,
      base: null,
      stresses: [],
      carryObservedBps: 100 * (at + 2),
      exit: { costBps: 10 * (at + 1), measuredShareBps: 6000 },
      concentration: {
        byIssuer: [{ key: 'issuer one', bps: 6000 }],
        byClass: [
          { key: 'stock', bps: 6000 },
          { key: 'cash', bps: 4000 },
        ],
        largestIssuerBps: 6000,
        issuers: 2 + at,
      },
      creditBasisBps: 500 * at,
    },
    ...over,
  };
}

/** The answer of the route for a sheet: the three candidates, in an order that is not the fixed one. */
export function builtFor(
  sheet: BasketSheet,
  names: PlanCandidateId[] = ['carry', 'cover', 'spread'],
) {
  const candidates = names.map((name) => candidateFor(sheet, name));
  const first = candidates[0] as PlanCandidate;
  return {
    id: '00000000-0000-4000-8000-000000000000',
    proposal: first.proposal,
    rollUp: first.rollUp,
    candidates,
    candidatesNotShown: (['cover', 'spread', 'carry'] as const)
      .filter((name) => !names.includes(name))
      .map((candidate) => ({ candidate, why: `${candidate} came out the same as another.` })),
  };
}
