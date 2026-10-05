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
import { registerRiskRoutes } from '../../api/src/routes/risk';

/** Standalone liquidity & risk API: mounts only the `/risk/*` plugin (no structurer routes). */
export async function buildRiskApp() {
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
        title: 'Colosseum liquidity & risk API',
        version: '0.1.0',
        description: `Measured exit liquidity for tokenized stocks on Solana: depth curves per time-of-week regime from on-chain pool state, LP concentration and LP-exit stress, recoverable value (DEX vs issuer redemption), liquidity score and breach assessment.\n\n**${DISCLAIMER.en}**`,
      },
      servers: [{ url: process.env.PUBLIC_RISK_API_URL ?? 'http://localhost:3002' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(scalar, { routePrefix: '/docs' });
  await registerRiskRoutes(app);
  return app;
}
