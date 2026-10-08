import { PersonalSheet } from '@colosseum/engine/personal';
import {
  BasketProposal,
  type ChainId,
  factsNotHeld,
  OrderError,
  PersonPlansQuery,
  PersonPlansResponse,
  PlanCandidate,
  PlanCandidateNotShown,
  RiskRollUp,
  ThreadStart,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Refusal } from '../../orders/errors';
import { failureOf, type OrderDeps } from '../../orders/legs';
import { homeChain } from '../../orders/person';
import { type PlanInputs, personalize } from '../../orders/personalize';
import {
  countLinkedSince,
  forgetUnboughtLinked,
  insertProposal,
  listPersonPlans,
  loadFamilies,
  loadReadablePlan,
} from '../../orders/store';
import { placePlans } from '../../orders/thread';
import { signedIn } from './orders';

// The plan routes (DESIGN-VAULT 3.6 and section 7). The web's side is apps/web/features/goal/build-plan.ts.

/**
 * The sheet a plan is made from: the shared `BasketSheet`, with the person's limits where they set
 * any, naming exactly one chain (the engine's `PersonalSheet`).
 */
export const PersonalizeRequest = z.object({ sheet: PersonalSheet });
export type PersonalizeRequest = z.infer<typeof PersonalizeRequest>;

/**
 * The same, for the signed-in person's own plan, with the thread so far where the conversation began
 * before the plan was theirs (signed out, in the tab): stored once, with the plan (gate PLAN-THREAD).
 * A plan made from a link takes none: `POST /v1/baskets/propose` has no such field.
 */
export const OwnPlanRequest = PersonalizeRequest.extend({
  thread: ThreadStart.optional(),
  /**
   * The plan this one is built after, in the same conversation: the new plan joins that plan's thread.
   * Honoured only when that plan is the caller's own; any other id is as if none was sent.
   */
  previousPlanId: z.string().uuid().optional(),
});
export type OwnPlanRequest = z.infer<typeof OwnPlanRequest>;

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

/**
 * A stored plan read back by its id: what the plan screen opens on from a link, or in a tab that did
 * not build it. `fromLink` says which: a plan made from a link keeps its rules (its vault is numbered
 * from the plan and the buyer).
 */
export const LinkedPlanResponse = z.object({
  id: z.string().uuid(),
  proposal: BasketProposal,
  fromLink: z.boolean(),
});
export type LinkedPlanResponse = z.infer<typeof LinkedPlanResponse>;

export const BasketIdParams = z.object({ id: z.string().uuid() });

/**
 * What plans made from a link may take of the server (gate `AGENT-LINK`): a body of at most 32 KB (a
 * sheet with all 480 withdrawals is about 25 KB), at most `perDay` of them in any 24 hours across every
 * caller together, and an unbought one kept `keepDays` days.
 */
export const LINKED_PLANS = { bodyBytes: 32 * 1024, perDay: 500, keepDays: 7 } as const;
export type LinkedPlanLimits = { perDay: number; keepDays: number };

const DAY_MS = 24 * 60 * 60 * 1000;

export function registerBasketRoutes(
  scope: FastifyInstance,
  deps: OrderDeps,
  inputs: PlanInputs,
  flags: { agentSurface: boolean } = { agentSurface: false },
  linkedPlans: LinkedPlanLimits = LINKED_PLANS,
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
      inputs: (on, assets, provenance) => inputs({ db: deps.db, chain: on, assets, provenance }),
      now: deps.now().toISOString(),
    });

  /**
   * The plan and each candidate, stored so a buy can name it: all of them or none. A candidate that
   * is the same plan (Carry is the plan the table makes) has the same inputs and one row.
   */
  const stored = async (
    made: Awaited<ReturnType<typeof make>>,
    owner: string | null,
    fromLink: boolean,
  ): Promise<PersonalizeResponse> => {
    const { id, candidates } = await deps.db.transaction(async (tx) => {
      const id = await insertProposal(tx, made.proposal, owner, fromLink);
      const candidates = [];
      for (const c of made.candidates)
        candidates.push({ ...c, id: await insertProposal(tx, c.proposal, owner, fromLink) });
      return { id, candidates };
    });
    return {
      id,
      proposal: made.proposal,
      rollUp: made.rollUp,
      candidates,
      candidatesNotShown: made.notShown,
    };
  };

  f.post(
    '/v1/baskets/personalize',
    {
      config: { auth: 'user', limit: 'build' },
      bodyLimit: 512 * 1024,
      schema: {
        tags: ['plans'],
        summary: 'Make a plan from a goal and its limits, and store it. Nothing is bought',
        description:
          "The sheet is validated before anything is computed, and a sheet that does not validate answers 400: the engine never runs on it. The plan is made by a deterministic engine on the chain the signed-in person's plans live on (`GET /v1/me`), from the assets listed there and the shared portfolios that have a recipe there. The sheet names that one chain: another answers 422, and a person with no chain yet gets 409. Stock tokens are never in a plan whose goal is to protect or to earn an income. A line's ceiling comes from the measured exit of its token where there is one; where there is none it is its tier's, and the line and `flags` say so (`ceiling_from_tier:<asset>`). Every line has its reasons; every figure the plan stands on is in `observations` with its source, time, method and provenance. `rollUp` is the plan's concentration by issuer, chain and class and its exit figures, from the same figures; with no stored quote before a buy, its quoted exit is null. The answer's `id` is what `POST /v1/orders` buys (`proposalId`). `candidates` are the plans of the same goal made three ways inside the same limits (Cover, Spread, Carry), each stored with its own `id`, in that fixed order, none marked or selected; each has its `scorecard` (months covered, months paid now and under each named stress, carry observed, exit cost, concentration, credit share, open FX for a goal not in dollars) and, with withdrawals to come, its `status` with the ways to close a gap. Two that come out as one choice, or one that another matches or betters on every line of the scorecard, are not shown: `candidatesNotShown` says why. No odds and no projected return.  `thread` carries bounded guided turns, stored privately once for the whole offered build. `previousPlanId` joins only the caller’s own prior conversation; another owner or linked plan is ignored. These records are separate from model preview history. The plan is not advice: see `disclaimer`.",
        body: OwnPlanRequest,
        response: { 200: PersonalizeResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonalizeResponse> => {
      const principal = signedIn(req);
      // The conversation ends at this plan: what its last reply says the facts are is this sheet's.
      const last = req.body.thread?.at(-1);
      const off = last ? factsNotHeld(last.reply.facts, req.body.sheet) : [];
      if (off.length > 0)
        throw new Refusal(
          422,
          `the thread’s last reply holds what the sheet does not: ${off.join(', ')}`,
        );
      const result = await stored(
        await make(req.body.sheet, () => homeChain(deps.db, principal)),
        principal.userId ?? null,
        false,
      );
      // Link the whole offered build once, retaining every distinct candidate's actual ID.
      try {
        await placePlans(deps.db, {
          planIds: [result.id, ...result.candidates.map((candidate) => candidate.id)],
          privyId: principal.userId ?? null,
          ...(req.body.previousPlanId ? { previousPlanId: req.body.previousPlanId } : {}),
          turns: req.body.thread ?? [],
        });
      } catch (e) {
        deps.onRecordError?.(failureOf(e));
      }
      return result;
    },
  );

  // A plan an agent proposes for a person it cannot sign in as (AGT-2, DESIGN-VAULT section 12): made
  // by the same engine from the same kind of sheet, on the one chain the sheet names, and stored with
  // no person. The person opens it from a link, signed in, and buys it there if it is on their chain.
  f.post(
    '/v1/baskets/propose',
    {
      config: { auth: 'public', limit: 'build' },
      bodyLimit: LINKED_PLANS.bodyBytes,
      schema: {
        tags: ['plans'],
        summary:
          'Make a plan from a goal and its limits for a person to open from a link. Nothing is bought',
        description:
          "For an agent that works for a person without their sign-in. Served while the agent surface is on (`flags.agentSurface` of `GET /v1/config`); off, it answers 404. A theme has to be the slug of a shared portfolio on that chain (422 otherwise); the body is at most 32 KB; the server makes at most a set number of these a day across every caller together, so one caller can use up the day for the rest (429 `RATE_LIMITED` past it), and deletes one nobody bought after 7 days. A buyer's vault is numbered from the plan and the buyer, so the plan's id does not lead to it. The plan is made as `POST /v1/baskets/personalize` makes it, on the one chain the sheet names (a chain this server has switched off is refused), and stored with no person: `GET /v1/baskets/{id}` reads it back for anybody holding its id. The person opens `/plan/{id}` in the app, signed in, and buys it there; it can be bought only on the chain their plans live on (gate ONE-CHAIN). Nothing is bought or signed here. The plan is not advice: see `disclaimer`.",
        body: PersonalizeRequest,
        response: { 200: PersonalizeResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonalizeResponse> => {
      surfaced();
      const { sheet } = req.body;
      // The sheet names exactly one chain (`PersonalSheet`): the plan is made there.
      const chain = sheet.chains[0] as ChainId;
      const now = deps.now().getTime();
      // What nobody bought goes after a few days, before anything new is stored.
      await forgetUnboughtLinked(deps.db, new Date(now - linkedPlans.keepDays * DAY_MS));
      if ((await countLinkedSince(deps.db, new Date(now - DAY_MS))) >= linkedPlans.perDay)
        throw new Refusal(
          429,
          'this server has made as many plans from links as it makes in a day',
          {
            code: 'RATE_LIMITED',
            fix: 'Try again tomorrow, or have the person build the plan in the app.',
            details: { retryable: true },
          },
        );
      // A theme is a shared portfolio on the chain, by its slug. One the shelf does not hold is refused,
      // so no caller's words are stored with the plan.
      const shelf = new Set((await loadFamilies(deps.db, chain)).map((f) => f.meta.slug));
      const themes = [
        ...sheet.themes,
        ...(sheet.sleeves ?? []).flatMap((x) => (x.kind === 'theme' ? [x.theme] : [])),
      ];
      const unknown = themes.filter((t) => !shelf.has(t));
      if (unknown.length > 0)
        throw new Refusal(
          422,
          `${unknown.length === 1 ? 'a theme is' : 'themes are'} not a shared portfolio on ${deps.chains.name(chain)}`,
          { fix: 'Name themes by the slug of a shared portfolio on the shelf (GET /v1/shelf).' },
        );
      // Stored with no person, the plan and its candidates alike, each marked as made from a link.
      return stored(await make(sheet, async () => chain), null, true);
    },
  );

  f.get(
    '/v1/baskets/:id',
    {
      // Open to anybody for a plan from a link; a sign-in, when one is sent, opens the caller's own.
      config: { auth: 'public', limit: 'standard', optionalSignIn: true },
      schema: {
        tags: ['plans'],
        summary: 'A stored plan by its id: one made from a link, or the caller’s own',
        description:
          'Answers a plan made from a link (`POST /v1/baskets/propose`, stored with no person) to anybody holding its id, while the agent surface is on; and a plan a person made in the app (`POST /v1/baskets/personalize`) to that person, signed in, whether the agent surface is on or not. `fromLink` says which it is. Another person’s plan answers 404, as an id that names no plan does, with or without a sign-in.',
        params: BasketIdParams,
        response: { 200: LinkedPlanResponse, default: OrderError },
      },
    },
    async (req, reply): Promise<LinkedPlanResponse> => {
      // Before the lookup, so the 404 carries them too: the answer depends on who asks, and nothing
      // between a person and the server keeps it for the next caller.
      reply.header('cache-control', 'private, no-store');
      reply.header('vary', 'Authorization');
      const plan = await loadReadablePlan(deps.db, req.params.id, req.principal?.userId ?? null);
      // One answer, in the same words, for no plan, another person's plan, and a plan from a link
      // while those are switched off: the answer says nothing of what an id names.
      if (!plan || (plan.fromLink && !flags.agentSurface))
        throw new Refusal(404, 'no plan with that id that you can read');
      return { id: req.params.id, proposal: plan.proposal, fromLink: plan.fromLink };
    },
  );

  f.get(
    '/v1/me/plans',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['plans'],
        summary: 'The signed-in person’s plans, with the goal each was built for and its buys',
        description:
          'The plans the person made in the app, and the plans made from a link that they bought, newest first, a page at a time: at most `limit` plans (50 by default and at most), made before `before` when that is sent. `next` is the `before` of the following page, and null on the last. Every buy of a plan on the page is with it. Each has the goal sheet it was built from, the plan’s card, its chain, its buys (an order is the person’s by the wallets of the verified token) and the vault those buys opened, by its number on chain. A plan another person made is never listed. `GET /v1/baskets/{id}` reads one whole; `GET /v1/orders/{id}` reads a buy and its steps.',
        querystring: PersonPlansQuery,
        response: { 200: PersonPlansResponse, default: OrderError },
      },
    },
    async (req, reply): Promise<PersonPlansResponse> => {
      reply.header('cache-control', 'private, no-store');
      const { plans, next } = await listPersonPlans(deps.db, signedIn(req), {
        limit: req.query.limit,
        ...(req.query.before ? { before: new Date(req.query.before) } : {}),
      });
      return {
        next,
        plans: plans.flatMap((plan) => {
          const { sheet, card, verdict, recipes } = plan.proposal;
          const chain = sheet.chains[0] ?? recipes[0]?.chain;
          if (!chain) return [];
          return [
            {
              id: plan.id,
              createdAt: plan.createdAt,
              fromLink: plan.fromLink,
              chain,
              sheet,
              card,
              verdict: verdict ?? null,
              bought: plan.orders.some((o) => o.deposited),
              orders: plan.orders,
              vault: plan.basketId === null ? null : { chain, basketId: plan.basketId },
            },
          ];
        }),
      };
    },
  );
}
