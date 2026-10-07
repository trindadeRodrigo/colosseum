import {
  OrderError,
  THREAD_LIMITS,
  ThreadParams,
  ThreadQuery,
  ThreadResponse,
  ThreadTurnRequest,
  ThreadTurnResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { appendTurn, listTurns, ownPlanId } from '../../orders/thread';
import { signedIn } from './orders';

// A plan's thread (gate PLAN-THREAD): read it, and add a turn to it. Both need a sign-in, and both
// answer only the plan's own person: another person's plan, a plan made from a link (which has no
// thread) and an id that names nothing get one 404 in the same words as the plan's own read
// (baskets.ts), so the answer says nothing of what an id names. Nothing of a thread is in any other
// route's answer: not the plan read by its id, not the list of a person's plans, not a shared plan.

/** The most a turn's body may be: the words, and a reply of keys and a few facts. */
const TURN_BODY_BYTES = 16 * 1024;

export function registerThreadRoutes(scope: FastifyInstance, deps: OrderDeps) {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const tags = ['plans'];
  /** The caller's own plan, or the one refusal. */
  const own = async (id: string, privyId: string | undefined) => {
    const planId = await ownPlanId(deps.db, id, privyId ?? null);
    if (!planId) throw new Refusal(404, 'no plan with that id that you can read');
    return planId;
  };

  f.get(
    '/v1/baskets/:id/thread',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'A plan’s thread: what was asked, what was understood, and what happened since',
        description:
          'The signed-in person’s own plan only: another person’s plan, a plan made from a link (it has no thread) and an unknown id all answer the same 404. A page holds the newest turns, oldest first, so the newest turn is last; `before` is what to send for the page of older turns, and null when the page starts at the first turn. A `person` turn is their words as typed. An `app` turn is what the app said back, as keys and the facts it used: the screen says it in the person’s language, and no sentence or formatted figure is stored. An `event` turn is written by the server where an order changes state (the plan was built, an order was made, its deposit landed, the buy was done or stopped, money was taken out): no request writes one. Answered with `Cache-Control: private, no-store`.',
        params: ThreadParams,
        querystring: ThreadQuery,
        response: { 200: ThreadResponse, default: OrderError },
      },
    },
    async (req, reply): Promise<ThreadResponse> => {
      // Before the lookup, so the 404 is as private as the thread.
      reply.header('cache-control', 'private, no-store');
      const planId = await own(req.params.id, signedIn(req).userId);
      const page = await listTurns(deps.db, planId, {
        limit: req.query.limit,
        ...(req.query.before === undefined ? {} : { before: Number(req.query.before) }),
      });
      return { planId, ...page };
    },
  );

  f.post(
    '/v1/baskets/:id/thread',
    {
      // The budget of the routes that read a person's words: ten a minute for one person.
      config: { auth: 'user', limit: 'parse' },
      bodyLimit: TURN_BODY_BYTES,
      schema: {
        tags,
        summary: 'Add a turn to a plan’s thread: the person’s words and what the app said back',
        description: `The signed-in person’s own plan only, with the same 404 as the read. \`text\` is the person’s words as typed: plain text of at most ${THREAD_LIMITS.textMax} characters, with no control characters but a line break and a tab, and none of the marks that reorder text. \`reply\` is what the app said back, as keys and facts and never a sentence: each key is letters and digits with no spaces, and \`facts\` takes the sheet’s own values and no other name. Anything else answers 400 and stores nothing. No model is called, and the plan does not change: this is the record. An event turn cannot be sent. Counted in the \`parse\` class of the rate limits.`,
        params: ThreadParams,
        body: ThreadTurnRequest,
        response: { 200: ThreadTurnResponse, default: OrderError },
      },
    },
    async (req, reply): Promise<ThreadTurnResponse> => {
      reply.header('cache-control', 'private, no-store');
      const planId = await own(req.params.id, signedIn(req).userId);
      return { planId, turns: await appendTurn(deps.db, planId, req.body) };
    },
  );
}
