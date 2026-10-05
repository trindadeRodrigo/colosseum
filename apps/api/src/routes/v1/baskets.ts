import { PersonalSheet } from '@colosseum/engine/personal';
import { BasketProposal, OrderError } from '@colosseum/schemas';
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

/** The stored plan's id, which a buy names (`proposalId`), and the plan. */
export const PersonalizeResponse = z.object({ id: z.string().uuid(), proposal: BasketProposal });
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
          "The sheet is validated before anything is computed, and a sheet that does not validate answers 400: the engine never runs on it. The plan is made by a deterministic engine on the chain the signed-in person's plans live on (`GET /v1/me`), from the assets listed there and the shared portfolios that have a recipe there. The sheet names that one chain: another answers 422, and a person with no chain yet gets 409. Stock tokens are never in a plan whose goal is to protect or to earn an income. A line's ceiling comes from the measured exit of its token where there is one; where there is none it is its tier's, and the line and `flags` say so (`ceiling_from_tier:<asset>`). Every line has its reasons; every figure the plan stands on is in `observations` with its source, time, method and provenance. The answer's `id` is what `POST /v1/orders` buys (`proposalId`). The plan is not advice: see `disclaimer`.",
        body: PersonalizeRequest,
        response: { 200: PersonalizeResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonalizeResponse> => {
      const principal = signedIn(req);
      const proposal = await personalize(req.body.sheet, {
        chains: deps.chains,
        homeChain: () => homeChain(deps.db, principal),
        loadFamilies: (chain) => loadFamilies(deps.db, chain),
        inputs: (chain, assets) => inputs({ db: deps.db, chain, assets }),
        now: deps.now().toISOString(),
      });
      const id = await insertProposal(deps.db, proposal, principal.userId ?? null);
      return { id, proposal };
    },
  );
}
