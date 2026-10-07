import { OrderError, PortfolioHistoryQuery, PortfolioHistoryResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';

export function registerPortfolioHistoryRoute(scope: FastifyInstance, _deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/history',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: "The signed-in person's vaults over time, from the snapshots kept of them",
        querystring: PortfolioHistoryQuery,
        response: { 200: PortfolioHistoryResponse, default: OrderError },
      },
    },
    async () => {
      throw new Refusal(501, 'the history of a portfolio is not built yet');
    },
  );
}
