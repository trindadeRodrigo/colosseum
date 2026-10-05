import { DISCLAIMER } from '@colosseum/schemas';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { IDENTITY_TOKEN_HEADER } from './plugins/auth';
import { registerV1Routes } from './routes/v1';

// The OpenAPI document of /v1, as it is committed at packages/sdk/openapi.json for the SDK to take its
// types from (DESIGN-VAULT section 12). It is the /v1 routes and nothing else: the structurer's routes
// and the risk layer's /risk/* are not in it, so a change to those never touches the committed file.

/** Where the committed document lives, from the repo root. */
export const OPENAPI_FILE = 'packages/sdk/openapi.json';

/**
 * Every chain off: the routes that exist only while a chain runs on the mock (`/v1/mock/*`) are then
 * not registered, so the document is the API as it is on real chains. Nothing else reads the
 * environment, so the document is the same on every machine.
 */
const EMIT_ENV = { CHAIN_MODE_SOLANA: 'off', CHAIN_MODE_ROBINHOOD: 'off', CHAIN_MODE_BASE: 'off' };

export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description: string };
  components: { securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, unknown>>;
};

/**
 * The two headers a signed-in /v1 route takes, as the document declares them. Both are credentials,
 * so both are security schemes and neither is repeated as a parameter of every operation.
 */
export const V1_SECURITY_SCHEMES = {
  accessToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'The access token of the sign-in, sent as `Authorization: Bearer <access token>`. It names the person and proves a live session.',
  },
  identityToken: {
    type: 'apiKey',
    in: 'header',
    name: IDENTITY_TOKEN_HEADER,
    description: `The identity token of the same sign-in, sent as the header \`${IDENTITY_TOKEN_HEADER}\`. It lists the wallets of the person: a wallet is read from here and from nowhere else.`,
  },
} as const;

/** A signed-in route takes both tokens together. */
const SIGNED_IN = [{ accessToken: [], identityToken: [] }];

/**
 * What `jsonSchemaTransform` makes of a route, and for a /v1 route also what the route declares in
 * its `config`: who may call it (`security`: both tokens, or nothing for a public route) and the
 * rate-limit class it counts against (`x-rate-limit`). The document then moves when a route's rule
 * does, so the drift test sees a route that was opened. Any other route is passed on untouched.
 */
export const v1Transform: typeof jsonSchemaTransform = (input) => {
  const out = jsonSchemaTransform(input);
  const { auth, limit } = input.route?.config ?? {};
  if (!auth || !out.schema || (out.schema as { hide?: boolean }).hide) return out;
  return {
    ...out,
    schema: {
      ...out.schema,
      security: auth === 'user' ? SIGNED_IN : [],
      'x-rate-limit': limit,
    },
  };
};

/** The /v1 document, emitted from the routes themselves. Opens no connection and asks no chain. */
export async function emitV1OpenApi(): Promise<OpenApiDocument> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Tenonfi API',
        version: '1.0.0',
        description: `The /v1 routes: who is signed in and the chain their plans live on, what the wallet is missing there, orders with their steps, and the portfolio. The API holds no key and signs nothing: it builds each step's transaction, the person's wallet signs it, and the API matches what was sent to what it built.\n\nA signed-in route takes two headers: \`Authorization: Bearer <access token>\` and \`privy-id-token: <identity token>\`. Each route says under \`security\` whether it needs them, and under \`x-rate-limit\` the class of requests it is counted in. Every answer carries \`ratelimit-limit\`, \`ratelimit-remaining\` and \`ratelimit-reset\`; a 429 carries \`retry-after\` too. Every refusal has one shape, with a \`code\` where one fits and \`details.retryable\`. Every figure carries its source, its time and its method, and \`provenance\`: anything that is not \`live\` is a test network or MOCK.\n\n**${DISCLAIMER.en}**`,
      },
      components: { securitySchemes: V1_SECURITY_SCHEMES },
    },
    transform: v1Transform,
  });
  await registerV1Routes(app, EMIT_ENV, { auth: null });
  await app.ready();
  const { openapi, info, components, paths } = app.swagger() as unknown as OpenApiDocument;
  await app.close();
  // Paths in a fixed order, so the file does not move when a route's file does.
  const sorted = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : 1)));
  const { securitySchemes } = components;
  return JSON.parse(
    JSON.stringify({ openapi, info, components: { securitySchemes }, paths: sorted }),
  );
}
