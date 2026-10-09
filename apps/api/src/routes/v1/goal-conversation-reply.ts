import {
  ChainId,
  normalizeAddress,
  OrderError,
  VaultAgentReplyShape,
  VaultAgentRequest,
  VaultAgentStatedPurpose,
  warningsBelong,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { type PlanInputs, preparePersonalInputs } from '../../orders/personalize';
import type { RelaxedGoalAgent } from '../../orders/relaxed-goal-agent';
import { statedAmountUsd } from '../../orders/stated-amount';
import {
  type AgentAnalytics,
  analyticsGap,
  buildGoalAgentContext,
  readAgentAnalytics,
  replyToVaultConversation,
  statedPurposeIn,
} from '../../orders/vault-agent';
import type { VaultAgentModel } from '../../vault-agent-model';
import { signedIn } from './orders';

/**
 * `goal` and `risk` are what the person said the money is for and the risk they accept, each null
 * until they have said it: a mix is made into a plan with these (`goal/accept`), and one still null is
 * worked out from the mix there and said as such (gate DEPOSIT-DERIVE), never filled in here.
 */
export const GoalConversationReply = VaultAgentReplyShape.extend({
  chain: ChainId,
  agent: z
    .enum(['relaxed', 'model_led'])
    .describe(
      'Which agent wrote this reply: the relaxed intake (gate RELAXED-INTAKE), or the model-led conversation the server answers with when it runs with `GOAL_AGENT=model-led`. Said so that neither is ever taken for the other.',
    ),
  goal: VaultAgentStatedPurpose.shape.goal.describe(
    'What the person said the money is for, read by the server from plain statements in their own messages; the latest one stands. Null until they have plainly said it, and after they take it back or question it. Never the model’s reading, and never filled in here: `goal/accept` works out a null one from the mix and says so.',
  ),
  risk: VaultAgentStatedPurpose.shape.risk.describe(
    'The risk the person said they accept, read the same way. Null until they have plainly said it; never filled in here.',
  ),
  amountUsd: z
    .number()
    .positive()
    .nullable()
    .describe(
      'The sum the person said they start with, in dollars, read by the server from their own messages (gate DEPOSIT-DERIVE): the newest message that writes a sum in dollars, one sum there or none; never a rate a month, an age, a year or the model’s words. A starting value for the deposit step, which the person changes or confirms on the review. Null: not written, not in dollars, or two sums in one message.',
    ),
}).superRefine(warningsBelong);
export const GoalConversationReplyError = z.strictObject({
  error: z.string(),
  code: z.literal('GOAL_AGENT_UNAVAILABLE'),
  reason: z.enum(['unavailable', 'timeout', 'budget', 'invalid']),
});

/** A private new-goal preview. No account chain, history, plan, order, vault or money is changed. */
export function registerGoalConversationReplyRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  model: VaultAgentModel | null,
  inputs: PlanInputs = async () => ({}),
  analytics?: AgentAnalytics,
  // The relaxed intake (gate RELAXED-INTAKE): the goal agent behind /goal whenever it is configured.
  // Null leaves the model-led conversation (`replyToVaultConversation`) to answer.
  relaxed: RelaxedGoalAgent | null = null,
) {
  const path = '/v1/conversations/:chain/goal/reply';
  scope.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.url === path) reply.header('cache-control', 'private, no-store');
    return payload;
  });
  scope.withTypeProvider<ZodTypeProvider>().post(
    path,
    {
      config: { auth: 'user', limit: 'standard' },
      bodyLimit: 512 * 1024,
      schema: {
        tags: ['plans'],
        summary: 'Discuss a new goal and preview model-proposed allocations',
        description:
          'Requires matching sign-in tokens and a verified wallet for the active chain. Uses the real listed catalog, prices and sourced planning inputs. There is no existing vault, holdings or confirmed planning amount; size-dependent feasibility is unknown. No allocation engine, storage, funding, order or account-chain mutation. The relaxed intake answers when a model key is set, unless the server runs with `GOAL_AGENT=model-led`, which chooses the model-led conversation; `agent` says which wrote the reply. Either draws on the shared call quota, sets weights in code from the shares the server reads in the messages (an equal split otherwise), and serves no sentence of the model that states a figure. A preview is not a plan: the amount is confirmed on the review of `POST /v1/conversations/{chain}/goal/accept` before anything is stored. No goal is stored for a new goal yet and none is taken from the request, so no pick is checked against one here and `proposal.unknowns` says so: `goal/accept` checks the mix against the goal the person said, or, where they said none, the one it works out from the mix and names (gate DEPOSIT-DERIVE).',
        params: z.strictObject({ chain: ChainId }),
        body: VaultAgentRequest,
        response: {
          200: GoalConversationReply,
          default: z.union([OrderError, GoalConversationReplyError]),
        },
      },
    },
    async (req, reply) => {
      const principal = signedIn(req);
      const { chain } = req.params;
      const entry = deps.chains.get(chain);
      const canSign = principal.wallets.some((wallet) => {
        if (wallet.family !== entry.config.family) return false;
        try {
          normalizeAddress(wallet.family, wallet.address);
          return true;
        } catch {
          return false;
        }
      });
      if (!principal.userId || !canSign)
        throw new Refusal(
          403,
          'Sign in with a wallet for this chain before discussing a new goal.',
        );
      if (!model && !relaxed) {
        req.log.warn(
          { reason: 'unavailable', detail: 'no_model', chain },
          'the new-goal conversation has no model configured',
        );
        return reply.code(503).send({
          error: 'The new-goal conversation is not available yet.',
          code: 'GOAL_AGENT_UNAVAILABLE',
          reason: 'unavailable',
        });
      }
      const context = await refusing(async () => {
        const listed = await entry.adapter.listAssets();
        // No amount yet: Bearing's analytics at their reference size, which never fail the reply.
        const [prices, prepared, read] = await Promise.all([
          entry.adapter.getPrices(listed.map((asset) => asset.id)),
          preparePersonalInputs(chain, listed, [], entry.provenance, (on, assets, provenance) =>
            inputs({ db: deps.db, chain: on, assets, provenance }),
          ),
          readAgentAnalytics(analytics, {
            db: deps.db,
            chain,
            assets: listed,
            provenance: entry.provenance,
            sizeUsd: null,
          }),
        ]);
        const gap = analyticsGap(read);
        if (gap)
          req.log.warn(
            { code: gap, chain },
            'the new-goal conversation went on without its analytics',
          );
        return buildGoalAgentContext({
          analytics: read,
          chain,
          observedAt: deps.now().toISOString(),
          entry,
          prices,
          prepared,
          person: principal.userId as string,
        });
      });
      const result = relaxed
        ? await relaxed.reply(req.body, context)
        : await replyToVaultConversation(req.body, context, model);
      if (result.kind === 'failure') {
        // The reason and which check failed: never the person's words or the model's reply.
        req.log.warn(
          {
            reason: result.reason,
            detail: result.detail ?? null,
            repair: result.repair ?? null,
            agent: relaxed ? 'relaxed' : 'model_led',
            chain,
          },
          'the new-goal conversation returned no reply',
        );
        return reply.code(503).send({
          error: 'A valid new-goal preview could not be returned. No plan or order was created.',
          code: 'GOAL_AGENT_UNAVAILABLE',
          reason: result.reason,
        });
      }
      if (result.repair?.outcome === 'prose_figure_trimmed')
        // A code and a count: never the sentences, the person's words or the model's reply.
        req.log.warn(
          {
            detail: 'prose_figure_trimmed',
            sentencesCut: result.repair.sentencesCut ?? 0,
            repair: result.repair,
            chain,
          },
          'the new-goal conversation reply was served without the sentences that stated a figure',
        );
      else if (result.repair)
        req.log.warn(
          { repair: result.repair, chain },
          result.repair.outcome === 'repaired'
            ? 'the new-goal conversation reply passed on its repair attempt'
            : 'the new-goal conversation reply asks about a stated limit its repair attempt still missed',
        );
      // Read from the person's messages alone: the same whichever model attempt is served.
      return {
        ...result.reply,
        chain,
        agent: relaxed ? ('relaxed' as const) : ('model_led' as const),
        ...statedPurposeIn(req.body.messages, context),
        amountUsd: statedAmountUsd(req.body.messages),
      };
    },
  );
}
