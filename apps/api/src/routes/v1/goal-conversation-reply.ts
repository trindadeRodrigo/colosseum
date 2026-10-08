import {
  ChainId,
  normalizeAddress,
  OrderError,
  VaultAgentReplyShape,
  VaultAgentRequest,
  warningsBelong,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { type PlanInputs, preparePersonalInputs } from '../../orders/personalize';
import { buildGoalAgentContext, replyToVaultConversation } from '../../orders/vault-agent';
import type { VaultAgentModel } from '../../vault-agent-model';
import { signedIn } from './orders';

export const GoalConversationReply = VaultAgentReplyShape.extend({ chain: ChainId }).superRefine(
  warningsBelong,
);
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
          'Requires matching sign-in tokens and a verified wallet for the active chain. Uses the real listed catalog, prices and sourced planning inputs. There is no existing vault, holdings or confirmed planning amount; size-dependent feasibility is unknown. No allocation engine, storage, funding, order or account-chain mutation. Uses the existing model and shared call quota. A preview requires separate fresh goal and amount confirmation before any financial review.',
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
      if (!model) {
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
        const [prices, prepared] = await Promise.all([
          entry.adapter.getPrices(listed.map((asset) => asset.id)),
          preparePersonalInputs(chain, listed, [], entry.provenance, (on, assets, provenance) =>
            inputs({ db: deps.db, chain: on, assets, provenance }),
          ),
        ]);
        return buildGoalAgentContext({
          chain,
          observedAt: deps.now().toISOString(),
          entry,
          prices,
          prepared,
          person: principal.userId as string,
        });
      });
      const result = await replyToVaultConversation(req.body, context, model);
      if (result.kind === 'failure') {
        // The reason and which check failed: never the person's words or the model's reply.
        req.log.warn(
          {
            reason: result.reason,
            detail: result.detail ?? null,
            repair: result.repair ?? null,
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
      if (result.repair)
        req.log.warn(
          { repair: result.repair, chain },
          result.repair.outcome === 'repaired'
            ? 'the new-goal conversation reply passed on its repair attempt'
            : 'the new-goal conversation reply asks about a stated limit its repair attempt still missed',
        );
      return { ...result.reply, chain };
    },
  );
}
