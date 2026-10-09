import {
  type BasketSheet,
  type ChainId,
  OrderError,
  VaultAgentReplyShape,
  VaultAgentRequest,
  VaultRouteParams,
  warningsBelong,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { type PlanInputs, preparePersonalInputs } from '../../orders/personalize';
import { planSheetOf } from '../../orders/plan-join';
import {
  type AgentAnalytics,
  analyticsGap,
  buildVaultAgentContext,
  readAgentAnalytics,
  replyToVaultConversation,
  vaultNotionalUsd,
} from '../../orders/vault-agent';
import { resolveVaultConversationOwner } from '../../orders/vault-conversation-owner';
import type { VaultAgentModel } from '../../vault-agent-model';
import { signedIn } from './orders';

export const VaultConversationReply = VaultAgentReplyShape.extend({
  chain: VaultRouteParams.shape.chain,
  address: VaultRouteParams.shape.address,
}).superRefine(warningsBelong);
export const VaultConversationReplyError = z.strictObject({
  error: z.string(),
  code: z.literal('VAULT_AGENT_UNAVAILABLE'),
  reason: z.enum(['unavailable', 'timeout', 'budget', 'invalid']),
});

/**
 * The goal of the plan the vault was opened for, as the server holds it: the one the review of the
 * vault's targets checks a mix against (`MixStore.planOf`). Never taken from the request.
 */
export type VaultPlanGoal = (
  chain: ChainId,
  address: string,
  privyId: string,
) => Promise<Pick<BasketSheet, 'goal' | 'risk'> | null>;

/** One private preview: no DB writes, allocation engine, financial order or target mutation. */
export function registerVaultConversationReplyRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  model: VaultAgentModel | null,
  inputs: PlanInputs = async () => ({}),
  analytics?: AgentAnalytics,
  planOf: VaultPlanGoal = (chain, address, privyId) =>
    planSheetOf(deps.db, chain, address, privyId),
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
          'Fresh chain ownership on every call; missing and other-owned vaults return the same 404. The model receives the supplied conversation, real current vault state, listed assets and sourced risk inputs. It picks assets and the server sets the preview weights, without calling the allocation engine. The goal is the one of the plan the vault was opened for, read on the server as `POST /v1/vaults/{chain}/{address}/targets` reads it, never from the request: in an income or protect plan a stock is proposed only where the person asked for it in their own words, with the warning `outside_goal_requested`, and any other pick outside the goal is left out with the note `pick_outside_goal`, since the targets review would refuse it. A vault the server holds no plan for has no goal to check against, and `proposal.unknowns` says so. Sources and numerical metrics are server-authored. The model writes no number: where it states a measured figure it names one the server gave it, and the server writes the value in its place in `message`, `question` and the prose of the proposal (plain text, no markup). `figures` is then present: `figures.prose` is the same prose with each figure a `{{fact:<id>}}` placeholder and `figures.facts` what each one is, with its value, unit, shown text, source, fetchedAt, method, provenance and, for a price past the age the chain accepts, `staleAgeSec`; a figure that is not measured has a null value and its reason, and its text says so. A reference to anything the server did not measure never becomes a number: its sentence is left out. No history, plan, order, target or account-chain change is stored. Existing configured model and shared intake call quota apply. Cache-Control: private, no-store.',
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
        const [prices, prepared, read, plan] = await Promise.all([
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
          // The stored plan's goal, which the picks are held to as the review of the targets holds them.
          planOf(identity.chain, state.address, identity.privyId),
        ]);
        const gap = analyticsGap(read);
        if (gap)
          req.log.warn(
            { code: gap, chain: identity.chain },
            'the vault conversation went on without its analytics',
          );
        return buildVaultAgentContext({
          state,
          entry,
          prices,
          prepared,
          person: identity.privyId,
          analytics: read,
          // No plan of this person's for the vault: no goal, and the reply says it was not checked.
          ...(plan ? { currentGoals: [{ goal: plan.goal, risk: plan.risk }] } : {}),
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
      if (result.repair?.outcome === 'prose_figure_trimmed')
        // A code and a count: never the sentences, the person's words or the model's reply.
        req.log.warn(
          {
            detail: 'prose_figure_trimmed',
            sentencesCut: result.repair.sentencesCut ?? 0,
            repair: result.repair,
            chain: identity.chain,
          },
          'the vault conversation reply was served without the sentences that stated a figure',
        );
      else if (result.repair)
        req.log.warn(
          { repair: result.repair, chain: identity.chain },
          result.repair.outcome === 'repaired'
            ? 'the vault conversation reply passed on its repair attempt'
            : 'the vault conversation reply is the one the server corrected: its repair attempt failed a check too',
        );
      if (result.figures)
        // Counts only: never an id, a value, the person's words or the model's reply.
        req.log.info(
          { figures: result.figures, chain: identity.chain },
          'the vault conversation reply stated figures by reference',
        );
      return { ...result.reply, chain: identity.chain, address: identity.address };
    },
  );
}
