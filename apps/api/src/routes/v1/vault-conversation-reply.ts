import {
  OrderError,
  VaultAgentReply,
  VaultAgentRequest,
  VaultRouteParams,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { type PlanInputs, preparePersonalInputs } from '../../orders/personalize';
import {
  type AgentAnalytics,
  buildVaultAgentContext,
  readAgentAnalytics,
  replyToVaultConversation,
  vaultNotionalUsd,
} from '../../orders/vault-agent';
import { resolveVaultConversationOwner } from '../../orders/vault-conversation-owner';
import type { VaultAgentModel } from '../../vault-agent-model';
import { signedIn } from './orders';

export const VaultConversationReply = VaultAgentReply.extend({
  chain: VaultRouteParams.shape.chain,
  address: VaultRouteParams.shape.address,
});
export const VaultConversationReplyError = z.strictObject({
  error: z.string(),
  code: z.literal('VAULT_AGENT_UNAVAILABLE'),
  reason: z.enum(['unavailable', 'timeout', 'budget', 'invalid']),
});

/** One private preview: no DB writes, allocation engine, financial order or target mutation. */
export function registerVaultConversationReplyRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  model: VaultAgentModel | null,
  inputs: PlanInputs = async () => ({}),
  analytics?: AgentAnalytics,
) {
  const path = '/v1/vaults/:chain/:address/conversation/reply';
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
        tags: ['portfolio'],
        summary: 'Discuss an owned vault and preview a model-proposed strategy',
        description:
          'Fresh chain ownership on every call; missing and other-owned vaults return the same 404. The model receives the supplied conversation, real current vault state, listed assets and sourced risk inputs. It may choose preview weights, which the server validates without calling the allocation engine. Sources and numerical metrics are server-authored. No history, plan, order, target or account-chain change is stored. Existing configured model and shared intake call quota apply. Cache-Control: private, no-store.',
        params: VaultRouteParams,
        body: VaultAgentRequest,
        response: {
          200: VaultConversationReply,
          default: z.union([OrderError, VaultConversationReplyError]),
        },
      },
    },
    async (req, reply) => {
      const principal = signedIn(req);
      const { identity, state, entry } = await resolveVaultConversationOwner(
        deps,
        req.params,
        principal,
      );
      if (!model) {
        req.log.warn(
          { reason: 'unavailable', detail: 'no_model', chain: identity.chain },
          'the vault conversation has no model configured',
        );
        return reply.code(503).send({
          error: 'The vault conversation is not available yet.',
          code: 'VAULT_AGENT_UNAVAILABLE',
          reason: 'unavailable',
        });
      }
      const context = await refusing(async () => {
        const listed = await entry.adapter.listAssets();
        const pricing = entry.adapter.getPrices(listed.map((asset) => asset.id));
        const [prices, prepared, read] = await Promise.all([
          pricing,
          preparePersonalInputs(
            identity.chain,
            listed,
            [],
            entry.provenance,
            (chain, assets, provenance) => inputs({ db: deps.db, chain, assets, provenance }),
          ),
          // Bearing's analytics at the vault's value, which needs its prices; they never fail the reply.
          pricing.then((prices) =>
            readAgentAnalytics(analytics, {
              db: deps.db,
              chain: identity.chain,
              assets: listed,
              provenance: entry.provenance,
              sizeUsd: vaultNotionalUsd(state, prices),
            }),
          ),
        ]);
        if (read && 'unavailable' in read)
          req.log.warn(
            { code: read.unavailable, chain: identity.chain },
            'the vault conversation went on without its analytics',
          );
        return buildVaultAgentContext({
          state,
          entry,
          prices,
          prepared,
          person: identity.privyId,
          analytics: read,
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
            chain: identity.chain,
          },
          'the vault conversation returned no reply',
        );
        return reply.code(503).send({
          error: 'A valid strategy preview could not be returned. Your vault has not changed.',
          code: 'VAULT_AGENT_UNAVAILABLE',
          reason: result.reason,
        });
      }
      if (result.repair)
        req.log.warn(
          { repair: result.repair, chain: identity.chain },
          result.repair.outcome === 'repaired'
            ? 'the vault conversation reply passed on its repair attempt'
            : 'the vault conversation reply asks about a stated limit its repair attempt still missed',
        );
      return { ...result.reply, chain: identity.chain, address: identity.address };
    },
  );
}
