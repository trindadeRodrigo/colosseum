import { PersonalSheet } from '@colosseum/engine/personal';
import {
  BasketProposal,
  OrderError,
  PlanCandidate,
  PlanCandidateNotShown,
  RiskRollUp,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { OrderDeps } from '../../orders/legs';
import { homeChain } from '../../orders/person';
import { type PlanInputs, personalize } from '../../orders/personalize';
import { insertProposal, loadFamilies } from '../../orders/store';
import { signedIn } from './orders';

// The plan routes (DESIGN-VAULT 3.6 and section 7). The web's side is apps/web/features/goal/build-plan.ts.

/**
 * The sheet a plan is made from: the shared `BasketSheet`, with the person's limits where they set
 * any, naming exactly one chain (the engine's `PersonalSheet`).
 */
export const PersonalizeRequest = z.object({ sheet: PersonalSheet });
export type PersonalizeRequest = z.infer<typeof PersonalizeRequest>;

/**
 * The stored plan's id, which a buy names (`proposalId`), the plan, and its risk roll-up; and the
 * candidates of gate THREE-PLANS, each stored with its own id, in a fixed order with none marked,
 * and those not shown with why.
 */
export const PersonalizeResponse = z.object({
  id: z.string().uuid(),
  proposal: BasketProposal,
  rollUp: RiskRollUp,
  candidates: z.array(PlanCandidate).min(1).max(3),
  candidatesNotShown: z.array(PlanCandidateNotShown).max(2),
});
export type PersonalizeResponse = z.infer<typeof PersonalizeResponse>;

export function registerBasketRoutes(scope: FastifyInstance, deps: OrderDeps, inputs: PlanInputs) {
  const f = scope.withTypeProvider<ZodTypeProvider>();

  f.post(
    '/v1/baskets/personalize',
    {
      config: { auth: 'user', limit: 'build' },
      schema: {
        tags: ['plans'],
        summary: 'Make a plan from a goal and its limits, and store it. Nothing is bought',
        description:
          "The sheet is validated before anything is computed, and a sheet that does not validate answers 400: the engine never runs on it. The plan is made by a deterministic engine on the chain the signed-in person's plans live on (`GET /v1/me`), from the assets listed there and the shared portfolios that have a recipe there. The sheet names that one chain: another answers 422, and a person with no chain yet gets 409. Stock tokens are never in a plan whose goal is to protect or to earn an income. A line's ceiling comes from the measured exit of its token where there is one; where there is none it is its tier's, and the line and `flags` say so (`ceiling_from_tier:<asset>`). Every line has its reasons; every figure the plan stands on is in `observations` with its source, time, method and provenance. `rollUp` is the plan's concentration by issuer, chain and class and its exit figures, from the same figures; with no stored quote before a buy, its quoted exit is null. The answer's `id` is what `POST /v1/orders` buys (`proposalId`). `candidates` are the plans of the same goal made three ways inside the same limits (Cover, Spread, Carry), each stored with its own `id`, in that fixed order, none marked or selected; each has its `scorecard` (months covered, months paid now and under each named stress, carry observed, exit cost, concentration, credit share, open FX for a goal not in dollars) and, with withdrawals to come, its `status` with the ways to close a gap. Two that come out as one choice, or one that another matches or betters on every line of the scorecard, are not shown: `candidatesNotShown` says why. No odds and no projected return. The plan is not advice: see `disclaimer`.",
        body: PersonalizeRequest,
        response: { 200: PersonalizeResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonalizeResponse> => {
      const principal = signedIn(req);
      const made = await personalize(req.body.sheet, {
        chains: deps.chains,
        homeChain: () => homeChain(deps.db, principal),
        loadFamilies: (chain) => loadFamilies(deps.db, chain),
        inputs: (chain, assets) => inputs({ db: deps.db, chain, assets }),
        now: deps.now().toISOString(),
      });
      const owner = principal.userId ?? null;
      // The plan and each candidate, stored so a buy can name it: all of them or none. A candidate
      // that is the same plan (Carry is the plan the table makes) has the same inputs and one row.
      const { id, candidates } = await deps.db.transaction(async (tx) => {
        const id = await insertProposal(tx, made.proposal, owner);
        const candidates = [];
        for (const c of made.candidates)
          candidates.push({ ...c, id: await insertProposal(tx, c.proposal, owner) });
        return { id, candidates };
      });
      return {
        id,
        proposal: made.proposal,
        rollUp: made.rollUp,
        candidates,
        candidatesNotShown: made.notShown,
      };
    },
  );
}
