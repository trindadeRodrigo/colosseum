import { OrderError, PortfolioPlansQuery, PortfolioPlansResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';

export function registerPortfolioPlansRoute(scope: FastifyInstance, _deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/plans',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary:
          "The signed-in person's plans, each with what was put in, its value and its status",
        querystring: PortfolioPlansQuery,
        response: { 200: PortfolioPlansResponse, default: OrderError },
      },
    },
    async () => {
      throw new Refusal(501, 'the plans of a portfolio is not built yet');
    },
  );
}
