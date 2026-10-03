import { DISCLAIMER, type EnvLike, parseFlags } from '@colosseum/schemas';
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
import { registerPlanRoutes } from './routes/plans';
import { registerReadRoutes } from './routes/read';
import { registerRiskRoutes } from './routes/risk';
import { registerTransactionRoutes } from './routes/transactions';
import { registerV1Routes, type V1Deps } from './routes/v1';

// Chain amounts are bigint; serialise them as strings in every response.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

/**
 * `deps.v1` replaces what the /v1 routes run on, and `deps.env` the environment the flags are read
 * from. A test passes them; the server passes nothing.
 */
export async function buildApp(deps: { v1?: V1Deps; env?: EnvLike } = {}) {
  const env = deps.env ?? process.env;
  // Stops here on a flag it cannot read.
  const flags = parseFlags(env);
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
  // The structurer's monitor routes load a key file and sign with it on the server. They are switched
  // off, not deleted: with LEGACY_STRUCTURER off (the default) the file is never loaded, so no route
  // that reaches a signer is registered and no code that reads a key is in the process.
  // tests/boundaries.test.ts holds this import to this `if`.
  if (flags.legacyStructurer) {
    const { registerMonitorRoutes } = await import('./routes/monitor');
    await registerMonitorRoutes(app);
  }
  await registerRiskRoutes(app);
  await registerV1Routes(app, env, deps.v1);

  return app;
}
