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
import { buildLeg, cancelLeg, type OrderDeps, refreshOrder, reportLeg } from '../../orders/legs';
import { prepareIntent } from '../../orders/prepare';
import { insertOrder, loadOrder, loadProposal, type StoredOrder } from '../../orders/store';
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
      config: { auth: 'user' },
      schema: {
        tags,
        summary: 'Plan an order from an intent. Nothing is built or signed',
        description:
          "Today: a buy of a stored plan (`proposalId`) on one or more chains. The deposit is the chain's dollar token, and the trades buy the plan's assets in its proportions. The answer lists one leg per step per chain, in the order they are signed. `owner` must be wallets of the signed-in person. A chain that is switched off answers `CHAIN_UNAVAILABLE`. Every leg carries `provenance`: `mock` on the mock chain.",
        body: IntentRequest,
        response: { 200: OrderDetail, default: OrderError },
      },
    },
    async (req) => {
      const order = await prepareIntent(req.body, {
        principal: signedIn(req),
        chains: deps.chains,
        loadProposal: (id) => loadProposal(deps.db, id),
        now: deps.now().toISOString(),
      });
      await insertOrder(deps.db, Order.parse(order), req.body);
      return detail({ order, request: req.body, attempts: [] });
    },
  );

  f.get(
    '/v1/orders/:id',
    {
      config: { auth: 'user' },
      schema: {
        tags,
        summary: 'An order with its legs and every attempt at them',
        description:
          'Only the wallets that made the order can read it. A leg that was sent and has not settled is tracked on the chain again before the answer.',
        params: OrderRouteParams,
        response: { 200: OrderDetail, default: OrderError },
      },
    },
    async (req) => detail(await refreshOrder(deps, await ownOrder(deps, req, req.params.id))),
  );

  f.post(
    '/v1/orders/:id/legs/:legId/build',
    {
      config: { auth: 'user' },
      schema: {
        tags,
        summary: 'Build one leg: a fresh unsigned transaction and the attempt that records it',
        description:
          "Legs on one chain are built in order, each just before it is signed. Every build is a new attempt with a fresh quote. A leg is not built again while the transaction built before can still land: on Solana until it has expired, on an EVM chain until it is reported or cancelled. The signer is the order's own wallet. The server signs nothing. A chain's refusal answers with the order code where one fits, the chain's own code and `retryable` in `details`.",
        params: LegRouteParams,
        response: { 200: BuildLegResponse, default: OrderError },
      },
    },
    async (req) => buildLeg(deps, await ownOrder(deps, req, req.params.id), req.params.legId),
  );

  f.post(
    '/v1/orders/:id/legs/:legId/report',
    {
      config: { auth: 'user' },
      schema: {
        tags,
        summary: 'Report a leg as sent, by its transaction id or by signed bytes to relay',
        description:
          'Exactly one of `txId` and `signedTx`. Both are matched against every attempt at the leg, and the leg settles on the attempt that landed. Signed bytes are relayed only for an attempt that was built and never sent. A transaction that carries the bytes of no attempt, successful or not, is refused and changes nothing. A transaction the chain has not seen yet answers 409 with `details.retryable` true: report it again in a moment. Reporting the same transaction again answers with the order as it stands.',
        params: LegRouteParams,
        body: ReportLegRequest,
        response: { 200: OrderDetail, default: OrderError },
      },
    },
    async (req) =>
      detail(
        await reportLeg(deps, await ownOrder(deps, req, req.params.id), req.params.legId, req.body),
      ),
  );

  f.post(
    '/v1/orders/:id/legs/:legId/cancel',
    {
      config: { auth: 'user' },
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
