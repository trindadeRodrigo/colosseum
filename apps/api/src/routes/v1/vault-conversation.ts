import {
  OrderError,
  type Principal,
  VAULT_CONVERSATION_LIMITS,
  VaultConversationNetworkError,
  VaultConversationParams,
  VaultConversationResponse,
  VaultConversationRevisionError,
  VaultConversationUnavailable,
  VaultConversationWrite,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { OrderDeps } from '../../orders/legs';
import {
  ConversationConflict,
  type ConversationIdentity,
  type ConversationStore,
  conversationStore,
} from '../../orders/vault-conversation';
import { resolveVaultConversationOwner } from '../../orders/vault-conversation-owner';
import { signedIn } from './orders';

// This route stores private user data only. It never calls a model, builds a plan/order, changes
// account chain or vault targets, or treats stored app text/checkpoints as a confirmed instruction.
export function registerVaultConversationRoutes(
  scope: FastifyInstance,
  deps: OrderDeps,
  store: ConversationStore = conversationStore(deps.db),
  options: { enabled?: boolean } = {},
) {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const identity = async (
    params: { chain: ConversationIdentity['chain']; address: string },
    principal: Principal,
  ) => {
    return (await resolveVaultConversationOwner(deps, params, principal)).identity;
  };
  const schema = {
    tags: ['portfolio'],
    params: VaultConversationParams,
    response: {
      200: VaultConversationResponse,
      default: z.union([VaultConversationUnavailable, OrderError]),
    },
  };
  const unavailable = {
    error: 'conversation storage is not available yet',
    code: 'CONVERSATION_STORE_UNAVAILABLE' as const,
  };
  scope.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.url === '/v1/vaults/:chain/:address/conversation')
      reply.header('cache-control', 'private, no-store');
    return payload;
  });
  f.get(
    '/v1/vaults/:chain/:address/conversation',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        ...schema,
        summary: 'Read the private conversation for a vault you own',
        description:
          'Owner verified on its chain on every read. Unknown and other-owned vaults give the same 404. Fresh history for legacy, linked, shared and externally created vaults; no creator history is imported. App text is plain display history and never executable authority. Cache-Control: private, no-store.',
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      const a = await identity(req.params, signedIn(req));
      if (options.enabled === false) {
        reply.code(503).send(unavailable);
        return;
      }
      try {
        return {
          version: 1 as const,
          chain: a.chain,
          address: a.address,
          provenance: a.provenance,
          network: a.network,
          ...(await store.read(a)),
        };
      } catch {
        reply.code(503).send(unavailable);
        return;
      }
    },
  );
  f.put(
    '/v1/vaults/:chain/:address/conversation',
    {
      config: { auth: 'user', limit: 'standard' },
      bodyLimit: VAULT_CONVERSATION_LIMITS.bodyBytes,
      schema: {
        ...schema,
        response: {
          200: VaultConversationResponse,
          default: z.union([
            VaultConversationUnavailable,
            VaultConversationRevisionError,
            VaultConversationNetworkError,
            OrderError,
          ]),
        },
        body: VaultConversationWrite,
        summary: 'Save private vault conversation history with an expected revision',
        description:
          'User-authored transcript and replay checkpoint only, never a confirmed sheet or financial authority. expectedNetwork must match the fresh authoritative network before any write; a mismatch gives409 NETWORK_CONFLICT. Replaces the history atomically when expectedRevision matches; stale writes give 409 with details.reason=REVISION_CONFLICT and current revision. Stores no public plan or browser-selected thread id, invokes no model, and builds or executes no financial operation. Cache-Control: private, no-store.',
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      const a = await identity(req.params, signedIn(req));
      // A delayed request cannot save old-network words into a newly configured network.
      // This is a precondition only: the verified context still selects the store identity.
      if (req.body.expectedNetwork !== a.network) {
        reply.code(409).send({
          error: 'the vault network changed: read it before saving again',
          details: { reason: 'NETWORK_CONFLICT' },
        });
        return;
      }
      if (options.enabled === false) {
        reply.code(503).send(unavailable);
        return;
      }
      try {
        return {
          version: 1 as const,
          chain: a.chain,
          address: a.address,
          provenance: a.provenance,
          network: a.network,
          ...(await store.write(a, req.body, deps.now())),
        };
      } catch (e) {
        if (e instanceof ConversationConflict) {
          reply.code(409).send({
            error: 'the conversation changed: read it before saving again',
            details: { reason: 'REVISION_CONFLICT', revision: e.revision },
          });
          return;
        }
        reply.code(503).send(unavailable);
        return;
      }
    },
  );
}
