import { DISCLAIMER } from '@colosseum/schemas';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerMonitorRoutes } from './routes/monitor';
import { registerPlanRoutes } from './routes/plans';
import { registerReadRoutes } from './routes/read';
import { registerRiskRoutes } from './routes/risk';
import { registerTransactionRoutes } from './routes/transactions';
import { registerV1Routes, type V1Deps } from './routes/v1';

// Chain amounts are bigint; serialise them as strings in every response.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

/** `deps.v1` replaces what the /v1 routes run on. A test passes it; the server passes nothing. */
export async function buildApp(deps: { v1?: V1Deps } = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cors, { origin: true });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Colosseum structuring API',
        version: '0.1.0',
        description: `Goal-based structuring for self-custody wallets: goals in BRL, allocations across on-chain legs, BRL cash-flow schedule with stresses, per-leg risk sheet, and unsigned transactions for the partner wallet to sign.\n\n**${DISCLAIMER.en}**\n\n${DISCLAIMER.pt}`,
      },
      servers: [{ url: process.env.PUBLIC_API_URL ?? 'http://localhost:3001' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, { routePrefix: '/docs' });

  app.get(
    '/health',
    { schema: { response: { 200: z.object({ ok: z.boolean(), disclaimer: z.string() }) } } },
    async () => ({
      ok: true,
      disclaimer: DISCLAIMER.en,
    }),
  );

  await registerPlanRoutes(app);
  await registerTransactionRoutes(app);
  await registerReadRoutes(app);
  await registerMonitorRoutes(app);
  await registerRiskRoutes(app);
  await registerV1Routes(app, process.env, deps.v1);

  return app;
}
