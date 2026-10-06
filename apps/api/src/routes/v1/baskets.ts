import { PersonalSheet } from '@colosseum/engine/personal';
import { BasketProposal, type ChainId, OrderError, RiskRollUp } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { homeChain } from '../../orders/person';
import { type PlanInputs, personalize } from '../../orders/personalize';
import { insertProposal, loadFamilies, loadLinkedProposal } from '../../orders/store';
import { signedIn } from './orders';

// The plan routes (DESIGN-VAULT 3.6 and section 7). The web's side is apps/web/features/goal/build-plan.ts.

/**
 * The sheet a plan is made from: the shared `BasketSheet`, with the person's limits where they set
 * any, naming exactly one chain (the engine's `PersonalSheet`).
 */
export const PersonalizeRequest = z.object({ sheet: PersonalSheet });
export type PersonalizeRequest = z.infer<typeof PersonalizeRequest>;

/** The stored plan's id, which a buy names (`proposalId`), the plan, and its risk roll-up. */
export const PersonalizeResponse = z.object({
  id: z.string().uuid(),
  proposal: BasketProposal,
  rollUp: RiskRollUp,
});
export type PersonalizeResponse = z.infer<typeof PersonalizeResponse>;

/** A plan made from a link, read back by its id: what the plan screen opens on from the link. */
export const LinkedPlanResponse = z.object({
  id: z.string().uuid(),
  proposal: BasketProposal,
});
export type LinkedPlanResponse = z.infer<typeof LinkedPlanResponse>;

export const BasketIdParams = z.object({ id: z.string().uuid() });

export function registerBasketRoutes(
  scope: FastifyInstance,
  deps: OrderDeps,
  inputs: PlanInputs,
  flags: { agentSurface: boolean } = { agentSurface: false },
) {
  /** The plans made from a link are the agent surface's: switched off, they are not there. */
  const surfaced = () => {
    if (!flags.agentSurface)
      throw new Refusal(404, 'plans from a link are switched off on this server (AGENT_SURFACE)');
  };
  const f = scope.withTypeProvider<ZodTypeProvider>();
  /** The plan, made on `chain` from the sheet. */
  const make = (sheet: PersonalizeRequest['sheet'], chain: () => Promise<ChainId>) =>
    personalize(sheet, {
      chains: deps.chains,
      homeChain: chain,
      loadFamilies: (on) => loadFamilies(deps.db, on),
      inputs: (on, assets) => inputs({ db: deps.db, chain: on, assets }),
      now: deps.now().toISOString(),
    });

  f.post(
    '/v1/baskets/personalize',
    {
      config: { auth: 'user', limit: 'build' },
      schema: {
        tags: ['plans'],
        summary: 'Make a plan from a goal and its limits, and store it. Nothing is bought',
        description:
          "The sheet is validated before anything is computed, and a sheet that does not validate answers 400: the engine never runs on it. The plan is made by a deterministic engine on the chain the signed-in person's plans live on (`GET /v1/me`), from the assets listed there and the shared portfolios that have a recipe there. The sheet names that one chain: another answers 422, and a person with no chain yet gets 409. Stock tokens are never in a plan whose goal is to protect or to earn an income. A line's ceiling comes from the measured exit of its token where there is one; where there is none it is its tier's, and the line and `flags` say so (`ceiling_from_tier:<asset>`). Every line has its reasons; every figure the plan stands on is in `observations` with its source, time, method and provenance. `rollUp` is the plan's concentration by issuer, chain and class and its exit figures, from the same figures; with no stored quote before a buy, its quoted exit is null. The answer's `id` is what `POST /v1/orders` buys (`proposalId`). The plan is not advice: see `disclaimer`.",
        body: PersonalizeRequest,
        response: { 200: PersonalizeResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonalizeResponse> => {
      const principal = signedIn(req);
      const { proposal, rollUp } = await make(req.body.sheet, () => homeChain(deps.db, principal));
      const id = await insertProposal(deps.db, proposal, principal.userId ?? null);
      return { id, proposal, rollUp };
    },
  );

  // A plan an agent proposes for a person it cannot sign in as (AGT-2, DESIGN-VAULT section 12): made
  // by the same engine from the same kind of sheet, on the one chain the sheet names, and stored with
  // no person. The person opens it from a link, signed in, and buys it there if it is on their chain.
  f.post(
    '/v1/baskets/propose',
    {
      config: { auth: 'public', limit: 'build' },
      schema: {
        tags: ['plans'],
        summary:
          'Make a plan from a goal and its limits for a person to open from a link. Nothing is bought',
        description:
          'For an agent that works for a person without their sign-in. The plan is made as `POST /v1/baskets/personalize` makes it, on the one chain the sheet names (a chain this server has switched off is refused), and stored with no person: `GET /v1/baskets/{id}` reads it back for anybody holding its id. The person opens `/plan/{id}` in the app, signed in, and buys it there; it can be bought only on the chain their plans live on (gate ONE-CHAIN). Nothing is bought or signed here. The plan is not advice: see `disclaimer`.',
        body: PersonalizeRequest,
        response: { 200: PersonalizeResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonalizeResponse> => {
      surfaced();
      const { sheet } = req.body;
      // The sheet names exactly one chain (`PersonalSheet`): the plan is made there.
      const { proposal, rollUp } = await make(sheet, async () => sheet.chains[0] as ChainId);
      const id = await insertProposal(deps.db, proposal, null);
      return { id, proposal, rollUp };
    },
  );

  f.get(
    '/v1/baskets/:id',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags: ['plans'],
        summary: 'A plan made from a link (`POST /v1/baskets/propose`), by its id',
        description:
          'Answers a plan stored with no person, which is what `POST /v1/baskets/propose` makes, while the agent surface is on. A plan a person made in the app is theirs and answers 404 here, as an id that names no plan does.',
        params: BasketIdParams,
        response: { 200: LinkedPlanResponse, default: OrderError },
      },
    },
    async (req): Promise<LinkedPlanResponse> => {
      surfaced();
      const proposal = await loadLinkedProposal(deps.db, req.params.id);
      if (!proposal) throw new Refusal(404, 'no plan made from a link has that id');
      return { id: req.params.id, proposal };
    },
  );
}
