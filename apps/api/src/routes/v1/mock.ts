import { ChainId, Holding, LegRouteParams, OrderError } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { ownOrder, signedIn } from './orders';

// MOCK only. These routes stand in for what a wallet and a faucet do on a real chain, so a test or a
// demo can take an order to the end with no chain behind it. They are registered only when at least one
// chain runs on packages/chain-mock, they act only on such a chain, and a server with no mock chain has
// no such routes at all.

const MockLanded = z.object({ txId: z.string(), provenance: z.literal('mock') });
const MockFunded = z.object({
  chain: ChainId,
  provenance: z.literal('mock'),
  wallets: z.array(z.object({ address: z.string(), holdings: z.array(Holding) })),
});

/** Enough native token for a few hundred mock transactions. */
const MOCK_GAS_RAW = { solana: '1000000000', evm: '1000000000000000000' } as const;

export function registerMockRoutes(scope: FastifyInstance, deps: OrderDeps) {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const tags = ['MOCK'];
  const mockOf = (chain: ChainId) => {
    const entry = deps.chains.get(chain);
    if (!entry.mock) throw new Refusal(404, `${entry.config.name} does not run on the mock`);
    return { entry, mock: entry.mock };
  };

  f.post(
    '/v1/mock/fund',
    {
      config: { auth: 'user' },
      schema: {
        tags,
        summary: 'MOCK: give the signed-in wallets mock cash and mock gas on one chain',
        body: z.object({ chain: ChainId, cashUsd: z.number().positive().max(1_000_000) }),
        response: { 200: MockFunded, default: OrderError },
      },
    },
    async (req) => {
      const { entry, mock } = mockOf(req.body.chain);
      const family = entry.config.family;
      const owners = signedIn(req)
        .wallets.filter((w) => w.family === family)
        .map((w) => w.address);
      if (!owners.length) throw new Refusal(422, `no ${family} wallet is linked to this sign-in`);
      const cash = (await entry.adapter.listAssets()).find((a) => a.id === mock.cash);
      if (!cash) throw new Error('the mock lists no cash token');
      const cents = BigInt(Math.round(req.body.cashUsd * 100));
      const raw = ((cents * 10n ** BigInt(cash.decimals)) / 100n).toString();
      const wallets = [];
      for (const address of owners) {
        mock.fund(address, { gasRaw: MOCK_GAS_RAW[family], assets: { [mock.cash]: raw } });
        wallets.push({ address, holdings: await entry.adapter.getWalletHoldings(address) });
      }
      return { chain: entry.chain, provenance: 'mock' as const, wallets };
    },
  );

  f.post(
    '/v1/mock/orders/:id/legs/:legId/land',
    {
      config: { auth: 'user' },
      schema: {
        tags,
        summary: "MOCK: land the transaction of a leg's latest attempt on the mock chain",
        description:
          'Stands in for the wallet signing and sending. It does not settle the leg: report the returned id with the report route, as a wallet that sent the transaction itself would.',
        params: LegRouteParams,
        response: { 200: MockLanded, default: OrderError },
      },
    },
    async (req) => {
      const stored = await ownOrder(deps, req, req.params.id);
      const leg = stored.order.legs.find((l) => l.id === req.params.legId);
      if (!leg) throw new Refusal(404, 'this order has no such step');
      const attempt = stored.attempts.find((a) => a.legId === leg.id && a.n === leg.attempt);
      if (!attempt) throw new Refusal(409, 'this step has not been built yet');
      const { mock } = mockOf(leg.chain);
      // As a wallet that signs what it was handed: on the nonce the build stated, where there is one.
      const sent = await refusing(() =>
        mock.send({
          messageHash: attempt.messageHash,
          ...(attempt.nonce === null ? {} : { evm: { nonce: attempt.nonce } }),
        }),
      );
      return { txId: sent.txId, provenance: 'mock' as const };
    },
  );
}
