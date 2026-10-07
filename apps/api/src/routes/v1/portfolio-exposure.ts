import { OrderError, PortfolioExposureQuery, PortfolioExposureResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import type { PlanInputs } from '../../orders/personalize';

export function registerPortfolioExposureRoute(
  scope: FastifyInstance,
  _deps: OrderDeps,
  _inputs: PlanInputs,
) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/exposure',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: 'What the signed-in person holds across their vaults, by underlying and by issuer',
        querystring: PortfolioExposureQuery,
        response: { 200: PortfolioExposureResponse, default: OrderError },
      },
    },
    async () => {
      throw new Refusal(501, 'the exposure of a portfolio is not built yet');
    },
  );
}
