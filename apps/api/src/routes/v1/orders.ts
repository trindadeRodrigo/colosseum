import {
  BuildLegResponse,
  IntentRequest,
  LegRouteParams,
  Order,
  OrderDetail,
  OrderError,
  OrderRouteParams,
  type Principal,
  ReportLegRequest,
} from '@colosseum/schemas';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal } from '../../orders/errors';
import { familyByNameKey, familyBySlug } from '../../orders/families';
import { buildLeg, cancelLeg, type OrderDeps, refreshOrder, reportLeg } from '../../orders/legs';
import { homeChain } from '../../orders/person';
import { prepareOrder } from '../../orders/prepare';
import { recordPublished } from '../../orders/shared';
import {
  insertOrder,
  isLinkedProposal,
  loadFamilies,
  loadOrder,
  loadProposal,
  type StoredOrder,
} from '../../orders/store';
import { holds } from '../../plugins/auth';

// The bodies and answers of these routes are named in packages/schemas (order-api.ts), so the SDK and
// the web read the same shapes.

/** The caller, on a route whose `config.auth` is `user`. */
export function signedIn(req: FastifyRequest): Principal {
  if (!req.principal) throw new Refusal(401, 'sign in first');
  return req.principal;
}

/**
 * The order, for the wallets that made it. Anybody else gets the answer an id that does not exist
 * gets, so an order's id says nothing to a stranger.
 *
 * An order that no longer reads as one is refused here, before any route does anything with it: one
 * stored with steps on two chains, from before an order was held to one, is the case there is. Its
 * owner is told to make it again, and nothing is tracked, built or written for it.
 */
export async function ownOrder(
  deps: OrderDeps,
  req: FastifyRequest,
  id: string,
): Promise<StoredOrder> {
  const principal = signedIn(req);
  const stored = await loadOrder(deps.db, id);
  if (!stored || !holds(principal, stored.order.owner))
    throw new Refusal(404, 'no order with that id');
  const read = Order.safeParse(stored.order);
  if (!read.success) {
    const chains = new Set(stored.order.legs.map((l) => l.chain)).size;
    throw new Refusal(
      409,
      chains > 1 && stored.order.type !== 'publish'
        ? `this order has steps on ${chains} chains, and an order is on one: it can no longer be used`
        : 'this order is stored in a form the server no longer takes: it can no longer be used',
      { fix: 'Make the order again.', details: { retryable: false } },
    );
  }
  return stored;
}

/**
 * A publish order whose step has confirmed: its family and recipe are written as the chain has them
 * (orders/shared.ts). Done on the read and on the report, the two routes a step settles through.
 */
async function published(
  deps: OrderDeps,
  req: FastifyRequest,
  stored: StoredOrder,
): Promise<StoredOrder> {
  const { order, request } = stored;
  if (
    request.type === 'publish' &&
    order.legs.some((l) => l.kind === 'publish' && l.status === 'confirmed')
  )
    await recordPublished(
      { db: deps.db, chains: deps.chains, principal: signedIn(req) },
      order,
      request,
      (message) => req.log.warn(message),
    );
  return stored;
}

// The Order schema's own checks (every leg is the order's, on a chain its owner has an address for)
// run here, since the response schema is the plain object.
const detail = (stored: StoredOrder): OrderDetail => ({
  ...Order.parse(stored.order),
  attempts: stored.attempts,
});

export function registerOrderRoutes(scope: FastifyInstance, deps: OrderDeps) {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const tags = ['orders'];

  f.post(
    '/v1/orders',
    {
      config: { auth: 'user', limit: 'build' },
      schema: {
        tags,
        summary: 'Plan an order from an intent. Nothing is built or signed',
        description:
          "Today: a buy of a stored plan (`proposalId`). An order is on one chain, the chain the signed-in person's plans live on (`GET /v1/me`), and the plan has to be one made for that chain. The whole amount is deposited in the chain's dollar token: `depositRaw` on the order. Each step it concerns repeats it as `cashRaw`, the approval and the step that deposits alike, so the steps' figures are not added up. The trades buy the plan's assets with the invested share, in its proportions, and what the plan keeps in cash stays in the vault as cash. The answer lists one leg per step, in the order they are signed. `owner` must be wallets of the signed-in person. A chain that is switched off answers `CHAIN_UNAVAILABLE`. Every leg carries `provenance`: `mock` on the mock chain.",
        body: IntentRequest,
        response: { 200: OrderDetail, default: OrderError },
      },
    },
    async (req) => {
      const { order, request } = await prepareOrder(req.body, {
        principal: signedIn(req),
        chains: deps.chains,
        loadProposal: (id) => loadProposal(deps.db, id),
        isLinkedPlan: (id) => isLinkedProposal(deps.db, id),
        homeChain: () => homeChain(deps.db, signedIn(req)),
        loadFamilies: (chain) => loadFamilies(deps.db, chain),
        shared: {
          db: deps.db,
          bySlug: (slug) => familyBySlug(deps.db, slug),
          byNameKey: (key) => familyByNameKey(deps.db, key),
        },
        now: deps.now().toISOString(),
      });
      // Stored as the order holds to it: a follow's version, a publish's family id.
      await insertOrder(deps.db, Order.parse(order), request);
      return detail({ order, request, attempts: [] });
    },
  );

  f.get(
    '/v1/orders/:id',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'An order with its legs and every attempt at them',
        description:
          'Only the wallets that made the order can read it. A leg that was sent and has not settled is tracked on the chain again before the answer.',
        params: OrderRouteParams,
        response: { 200: OrderDetail, default: OrderError },
      },
    },
    async (req) =>
      detail(
        await published(
          deps,
          req,
          await refreshOrder(deps, await ownOrder(deps, req, req.params.id)),
        ),
      ),
  );

  f.post(
    '/v1/orders/:id/legs/:legId/build',
    {
      config: { auth: 'user', limit: 'build' },
      schema: {
        tags,
        summary: 'Build one leg: a fresh unsigned transaction and the attempt that records it',
        description:
          "Legs are built in order, each just before it is signed. Every build is a new attempt with a fresh quote. A leg is not built again while the transaction built before can still land: on Solana until it has expired, on an EVM chain until it is reported or cancelled. On an EVM chain a wallet has one next nonce, so a step is not built either while another order of the same wallet holds a transaction that can still land: the answer is 409 and `details.blocking` names that order and step. The signer is the order's own wallet. The server signs nothing. A chain's refusal answers with the order code where one fits, the chain's own code and `retryable` in `details`.",
        params: LegRouteParams,
        response: { 200: BuildLegResponse, default: OrderError },
      },
    },
    async (req) =>
      buildLeg(
        deps,
        await ownOrder(deps, req, req.params.id),
        req.params.legId,
        signedIn(req).userId,
      ),
  );

  f.post(
    '/v1/orders/:id/legs/:legId/report',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'Report a leg as sent, by its transaction id or by signed bytes to relay',
        description:
          'Exactly one of `txId` and `signedTx`. Both are matched against every attempt at the leg, and the leg settles on the attempt that landed. On an EVM chain an attempt is the pair (message, nonce): the nonce is read from the transaction itself, the attempt is left carrying the nonce the wallet really used, and of two attempts that state the same pair the newest that can still land is the one. Signed bytes are relayed only for an attempt that was built and never sent. A transaction that carries the bytes of no attempt, successful or not, is refused and changes nothing, and so is one that was built for another step. A transaction the chain has not seen yet answers 409 with `details.retryable` true: report it again in a moment. Reporting the same transaction again answers with the order as it stands.',
        params: LegRouteParams,
        body: ReportLegRequest,
        response: { 200: OrderDetail, default: OrderError },
      },
    },
    async (req) =>
      detail(
        await published(
          deps,
          req,
          await reportLeg(
            deps,
            await ownOrder(deps, req, req.params.id),
            req.params.legId,
            req.body,
          ),
        ),
      ),
  );

  f.post(
    '/v1/orders/:id/legs/:legId/cancel',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'Cancel the latest attempt at a leg, so the leg can be built again',
        description:
          'A leg is not built again while the transaction built before can still land. On an EVM chain a transaction never expires, so the person says here that it will not be sent. On Solana this is refused until the transaction has expired: only time closes it. If the transaction has landed, the leg settles on it and the answer is 409.',
        params: LegRouteParams,
        response: { 200: OrderDetail, default: OrderError },
      },
    },
    async (req) =>
      detail(await cancelLeg(deps, await ownOrder(deps, req, req.params.id), req.params.legId)),
  );
}
