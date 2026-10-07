import {
  OrderError,
  PortfolioRebalancesQuery,
  PortfolioRebalancesResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';

export function registerPortfolioRebalancesRoute(scope: FastifyInstance, _deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/rebalances',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: "The steps that traded in the signed-in person's vaults, newest first",
        querystring: PortfolioRebalancesQuery,
        response: { 200: PortfolioRebalancesResponse, default: OrderError },
      },
    },
    async () => {
      throw new Refusal(501, 'the rebalances of a portfolio is not built yet');
    },
  );
}
