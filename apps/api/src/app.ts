import { DISCLAIMER, type EnvLike, parseFlags } from '@colosseum/schemas';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { V1_SECURITY_SCHEMES, v1Transform } from './openapi';
import { corsAllowlist, corsByPath } from './plugins/cors';
import { requireDeclared } from './plugins/limits';
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
  // Before any route: a path under /v1 is held to default deny wherever it is registered.
  const inScope = requireDeclared(app);
  // /v1 answers a browser only from the allowlist (CORS_ORIGINS). Every other route, the risk layer's
  // /risk/* included, reflects any origin as it always has.
  await app.register(cors, { delegator: corsByPath(corsAllowlist(env)) });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Colosseum structuring API',
        version: '0.1.0',
        description: `Goal-based structuring for self-custody wallets: goals in BRL, allocations across on-chain legs, BRL cash-flow schedule with stresses, per-leg risk sheet, and unsigned transactions for the partner wallet to sign.\n\n**${DISCLAIMER.en}**\n\n${DISCLAIMER.pt}`,
      },
      servers: [{ url: process.env.PUBLIC_API_URL ?? 'http://localhost:3001' }],
      // The two tokens a signed-in /v1 route takes. No other route names them.
      components: { securitySchemes: V1_SECURITY_SCHEMES },
    },
    // jsonSchemaTransform for every route; a /v1 route also shows who may call it.
    transform: v1Transform,
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
  const monitor = await registerMonitorRoutes(app);
  // One route of the structurer's monitor loads a key file and signs with it on the server: the
  // rebalance. It is switched off, not deleted: with LEGACY_STRUCTURER off (the default) its file is
  // never loaded, so no route that reaches a signer is registered and no code that reads a key is in
  // the process. The monitor's reads and its unsigned revoke are always served.
  // tests/boundaries.test.ts holds this import to this `if`.
  if (flags.legacyStructurer) {
    const { registerMonitorRebalanceRoute } = await import('./routes/monitor-rebalance');
    registerMonitorRebalanceRoute(app, monitor);
  }
  await registerRiskRoutes(app);
  await registerV1Routes(app, env, { ...deps.v1, inScope });

  return app;
}
