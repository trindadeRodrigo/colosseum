import {
  factsNotHeld,
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
import { failureOf, type OrderDeps } from '../../orders/legs';
import { appendTurn, listTurns, ownPlan, sheetOfPlan, threadOf } from '../../orders/thread';
import { signedIn } from './orders';

// A plan's thread (gate PLAN-THREAD): read it, and add a turn to it. The thread is the conversation's:
// every plan built in it reads the same one, whole (orders/thread.ts). Both need a sign-in, and both
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
    const plan = await ownPlan(deps.db, id, privyId ?? null);
    if (!plan) throw new Refusal(404, 'no plan with that id that you can read');
    return plan;
  };

  /** Missing migration or query failures are a safe unavailable record, never private driver text. */
  const available = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      if (e instanceof Refusal) throw e;
      deps.onRecordError?.(failureOf(e));
      throw new Refusal(503, 'the thread is not available: try again in a moment', {
        details: { retryable: true },
      });
    }
  };

  f.get(
    '/v1/baskets/:id/thread',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'A plan’s thread: what was asked, what was understood, and what happened since',
        description:
          'The signed-in person’s own plan only: another person’s plan, a plan made from a link (it has no thread) and an unknown id all answer the same 404. The thread is the conversation’s: a plan built again in it is in the same thread, so the id of any plan of the conversation answers the whole of it, from the first sentence through every rebuild to the buy and what happened to the vault since. A page holds the newest turns, oldest first, so the newest turn is last; `before` is what to send for the page of older turns, and null when the page starts at the first turn. A `person` turn is their words as typed. An `app` turn is what the app said back, as keys and the facts it used: the screen says it in the person’s language, and no sentence or formatted figure is stored. An `event` turn is written by the server where an order changes state (the plan was built, or built again with the names of the sheet’s fields that changed, an order was made, its deposit landed, the buy was done or stopped, money was taken out): no request writes one. Answered with `Cache-Control: private, no-store`.',
        params: ThreadParams,
        querystring: ThreadQuery,
        response: { 200: ThreadResponse, default: OrderError },
      },
    },
    async (req, reply): Promise<ThreadResponse> =>
      available(async () => {
        // Before the lookup, so the 404 is as private as the thread.
        reply.header('cache-control', 'private, no-store');
        const plan = await own(req.params.id, signedIn(req).userId);
        const page = await listTurns(deps.db, plan.threadId, {
          limit: req.query.limit,
          ...(req.query.before === undefined ? {} : { before: Number(req.query.before) }),
        });
        return { planId: plan.id, ...page };
      }),
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
        description: `The signed-in person’s own plan only, with the same 404 as the read. \`text\` is the person’s words as typed: plain text of at most ${THREAD_LIMITS.textMax} characters, with no control characters but a line break and a tab, and none of the marks that reorder text. \`reply\` is what the app said back, as keys and facts and never a sentence: \`facts\` takes the sheet’s own values and no other name. A key is one of a closed list (\`ThreadSay\`), a fact is named from the list of five, and each fact given must be the one the plan’s sheet holds: a figure that is not the plan’s answers 422, naming the fact. Anything else answers 400 and stores nothing. A line break sent as CR LF is stored as LF. No model is called, and the plan does not change: this is the record. An event turn cannot be sent. Counted in the \`parse\` class of the rate limits.`,
        params: ThreadParams,
        body: ThreadTurnRequest,
        response: { 200: ThreadTurnResponse, default: OrderError },
      },
    },
    async (req, reply): Promise<ThreadTurnResponse> =>
      available(async () => {
        reply.header('cache-control', 'private, no-store');
        const plan = await own(req.params.id, signedIn(req).userId);
        // What the reply says the facts are is said back to the person as the app's: each one given is
        // the plan's own, or the turn is refused. Named by the fact, never by the value.
        const sheet = await sheetOfPlan(deps.db, plan.id);
        if (!sheet) throw new Refusal(422, 'the plan has no readable sheet for this reply');
        const off = factsNotHeld(req.body.reply.facts, sheet);
        if (off.length > 0)
          throw new Refusal(
            422,
            `the reply holds what the plan’s sheet does not: ${off.join(', ')}`,
            {
              fix: 'send each fact as the plan’s sheet has it, and leave out a fact that is not in the plan yet',
            },
          );
        try {
          const at = { threadId: await threadOf(deps.db, plan), planId: plan.id };
          return { planId: plan.id, turns: await appendTurn(deps.db, at, req.body) };
        } catch (e) {
          // The words are in the request, and a database's error repeats what it was sent: the store
          // lets out the failure's name and code alone (`ThreadWriteError`), that is what is logged,
          // and the answer is one fixed line. Nothing else of this request reaches a log.
          deps.onRecordError?.(failureOf(e));
          throw new Refusal(503, 'the turn could not be stored: send it again in a moment', {
            details: { retryable: true },
          });
        }
      }),
  );
}
