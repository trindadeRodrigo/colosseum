import {
  AcceptGoalMixRequest,
  AcceptGoalMixResponse,
  ApplyVaultMixRequest,
  ApplyVaultMixResponse,
  type BasketProposal,
  type BasketSheet,
  ChainId,
  type IntentRequest,
  normalizeAddress,
  Order,
  OrderError,
  type Principal,
  VaultRouteParams,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertBuilds } from '../../orders/chains';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import {
  checkMix,
  mixContext,
  mixProposal,
  planRetarget,
  reviewMix,
  vaultValueUsd,
} from '../../orders/mix';
import type { PlanInputs } from '../../orders/personalize';
import { plansOf } from '../../orders/plan-join';
import { ORDER_POLICY } from '../../orders/prepare';
import { insertOrder, insertProposal } from '../../orders/store';
import { resolveVaultConversationOwner } from '../../orders/vault-conversation-owner';
import { signedIn } from './orders';

// A mix from the conversation, or the person's own, made fundable (gate MIX-ANY-COMPOSITION, Thom,
// Oct 8; orders/mix.ts). Both routes answer a review first and act only on `confirm` with every
// warning accepted: a new goal's mix becomes a stored plan that `POST /v1/orders` buys, and a vault's
// becomes an order that sets its targets and trades to them.

/** Where the routes write. The database's, unless a test hands in its own. */
export type MixStore = {
  saveProposal(proposal: BasketProposal, privyId: string): Promise<string>;
  saveOrder(order: Order, request: IntentRequest): Promise<void>;
  /** The goal and risk of the plan the person's vault was opened for, where the server holds it. */
  planOf(
    chain: ChainId,
    address: string,
    privyId: string,
  ): Promise<Pick<BasketSheet, 'goal' | 'risk'> | null>;
};

export const dbMixStore = (deps: OrderDeps): MixStore => ({
  saveProposal: (proposal, privyId) => insertProposal(deps.db, proposal, privyId),
  saveOrder: (order, request) => insertOrder(deps.db, order, request),
  async planOf(chain, address, privyId) {
    const sheet = (await plansOf(deps.db, chain, [address], privyId)).get(address)?.plan.sheet;
    return sheet ? { goal: sheet.goal, risk: sheet.risk } : null;
  },
});

/** A wallet of the signed-in person's that signs on this chain, as the conversation routes ask. */
function signsOn(principal: Principal, family: string): boolean {
  return principal.wallets.some((wallet) => {
    if (wallet.family !== family) return false;
    try {
      normalizeAddress(wallet.family, wallet.address);
      return true;
    } catch {
      return false;
    }
  });
}

const DESCRIPTION_CHECKS =
  'The lines are checked again against the chain now, whoever chose them: each a listed asset of this chain or its own cash token, once, in whole basis points of at least 1, at most 16 that are not cash, and all adding up to exactly 10,000; every asset needs a price the vault can trade on. Any failure answers 422 `MIX_NOT_VALID` with `details.issues` (`CODE` or `CODE:assetId`). What would once have kept a line out is a warning instead: a line over its exit ceiling (measured, or its tier where nothing is measured), over the asset list’s cap, or an asset the asset list does not put in an income or protect plan. Each warning has an `id`; with `confirm` false, or with any warning id missing from `acceptedWarnings`, the answer is `status: review` with `unconfirmed`, and nothing is stored or built. Every figure is the server’s and carries its source; `origin` is the client’s statement of who chose the weights, kept with what is stored. Cache-Control: private, no-store.';

export function registerMixRoutes(
  scope: FastifyInstance,
  deps: OrderDeps,
  inputs: PlanInputs = async () => ({}),
  store: MixStore = dbMixStore(deps),
) {
  const paths = ['/v1/conversations/:chain/goal/accept', '/v1/vaults/:chain/:address/targets'];
  scope.addHook('onSend', async (req, reply, payload) => {
    if (paths.includes(req.routeOptions.url ?? ''))
      reply.header('cache-control', 'private, no-store');
    return payload;
  });
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const read = (q: Omit<Parameters<PlanInputs>[0], 'db'>) => inputs({ ...q, db: deps.db });

  f.post(
    '/v1/conversations/:chain/goal/accept',
    {
      config: { auth: 'user', limit: 'standard' },
      bodyLimit: 64 * 1024,
      schema: {
        tags: ['plans'],
        summary: 'Review a mix for a new goal, and store it as a plan once confirmed',
        description: `Requires matching sign-in tokens and a verified wallet for the chain. The goal, risk, amount and term are the ones the person confirmed. ${DESCRIPTION_CHECKS} Confirmed with every warning accepted, the mix is stored as a plan in the engine’s shape (\`engineVersion\` \`mix-1\`, \`origin\`), its lines the weights sent, and \`proposalId\` is bought by \`POST /v1/orders\` like any plan. The same mix confirmed again by the same person answers the same id. Nothing is bought or signed here. The plan is not advice: see \`disclaimer\`.`,
        params: z.strictObject({ chain: ChainId }),
        body: AcceptGoalMixRequest,
        response: { 200: AcceptGoalMixResponse, default: OrderError },
      },
    },
    async (req): Promise<AcceptGoalMixResponse> => {
      const principal = signedIn(req);
      const entry = deps.chains.get(req.params.chain);
      if (!principal.userId || !signsOn(principal, entry.config.family))
        throw new Refusal(403, 'Sign in with a wallet for this chain before choosing a mix.');
      const body = req.body;
      const now = deps.now().toISOString();
      const ctx = await refusing(() => mixContext(entry, read, now));
      const checked = await refusing(() => checkMix(ctx, body.allocations));
      const reviewed = reviewMix(ctx, checked, {
        origin: body.origin,
        goal: body.goal,
        risk: body.risk,
        amountUsd: body.amountUsd,
        ...(body.horizonMonths === undefined ? {} : { horizonMonths: body.horizonMonths }),
        language: body.language,
        accepted: body.acceptedWarnings,
      });
      const { review } = reviewed;
      if (!body.confirm || review.unconfirmed.length) return { status: 'review', review };
      const proposal = mixProposal(ctx, reviewed, checked, {
        person: principal.userId,
        origin: body.origin,
        accepted: body.acceptedWarnings,
        language: body.language,
      });
      const proposalId = await store.saveProposal(proposal, principal.userId);
      return { status: 'stored', review, proposalId, proposal };
    },
  );

  f.post(
    '/v1/vaults/:chain/:address/targets',
    {
      config: { auth: 'user', limit: 'standard' },
      bodyLimit: 64 * 1024,
      schema: {
        tags: ['portfolio'],
        summary: 'Review new targets for a vault you own, and order them once confirmed',
        description: `Ownership is read from the chain on every call; a missing vault and another person’s answer the same 404. The amount the lines split is the vault’s value at the prices of the review. ${DESCRIPTION_CHECKS} A vault that follows a shared portfolio or has auto-follow on is warned that its own targets end both, as they do on chain. All cash is refused (\`ALL_CASH\`): a vault’s targets cannot be emptied once it is open. Confirmed with every warning accepted, the answer is an order (\`type\` rebalance): a \`set_targets\` step, then the trades that sell what is over its new target and buy what is under, at the prices now, each with the minimum it states, as many per step as the chain takes. It is built, signed, reported and cancelled through \`/v1/orders/{id}\` like any order. The keeper does not trade it meanwhile: own targets switch auto-follow off.`,
        params: VaultRouteParams,
        body: ApplyVaultMixRequest,
        response: { 200: ApplyVaultMixResponse, default: OrderError },
      },
    },
    async (req): Promise<ApplyVaultMixResponse> => {
      const principal = signedIn(req);
      const { identity, state, entry } = await resolveVaultConversationOwner(
        deps,
        req.params,
        principal,
      );
      assertBuilds(entry);
      const body = req.body;
      const now = deps.now().toISOString();
      const ctx = await refusing(() => mixContext(entry, read, now));
      const checked = await refusing(() => checkMix(ctx, body.allocations, state));
      const plan = await store.planOf(identity.chain, state.address, identity.privyId);
      const reviewed = reviewMix(ctx, checked, {
        origin: body.origin,
        goal: plan?.goal ?? null,
        risk: plan?.risk ?? 'medium',
        amountUsd: vaultValueUsd(state, checked.prices),
        language: body.language,
        accepted: body.acceptedWarnings,
        vault: state,
      });
      const { review } = reviewed;
      if (!body.confirm || review.unconfirmed.length) return { status: 'review', review };
      // The order is the wallet's as the sign-in names it, so the order routes know it as theirs.
      const family = entry.config.family;
      const owner = principal.wallets.find((w) => {
        if (w.family !== family) return false;
        try {
          return normalizeAddress(family, w.address) === normalizeAddress(family, state.owner);
        } catch {
          return false;
        }
      })?.address;
      if (!owner) throw new Refusal(404, 'no vault with that address that is yours');
      const { order, request } = await refusing(() =>
        planRetarget(ctx, state, checked, {
          slippageBps: body.maxSlippageBps ?? ORDER_POLICY.slippageBps,
          now,
          owner,
        }),
      );
      await store.saveOrder(Order.parse(order), request);
      return { status: 'ordered', review, order: { ...order, attempts: [] } };
    },
  );
}
