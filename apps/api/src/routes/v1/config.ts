import {
  assertChainsReady,
  type ChainId,
  ConfigResponse,
  chainProvenance,
  type EnvLike,
  OrderError,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const ORDER: ChainId[] = ['solana', 'robinhood', 'base'];

/**
 * The flags and one entry per chain. Each entry's `provenance` is the label every figure from that chain
 * carries as it is run now: `mock` on the mock, `sandbox` on a test network or a local copy, `live` on
 * mainnet only, and null for a chain that is off. Nothing here is a secret: a chain config holds no RPC
 * URL.
 * Throws on a variable it cannot read, and on a chain set to `live` or `readonly` that has no router,
 * price source or deployment to run on, so either stops the API at start.
 */
export function buildConfig(
  env: EnvLike,
  contracts: Parameters<typeof parseChainConfigs>[1] = {},
): ConfigResponse {
  const flags = parseFlags(env);
  const configs = parseChainConfigs(env, contracts);
  assertChainsReady(flags, configs);
  return {
    flags,
    chains: ORDER.map((id) => {
      const mode = flags.chainMode[id];
      return { ...configs[id], mode, provenance: chainProvenance(configs[id].network, mode) };
    }),
  };
}

export function registerConfigRoute(app: FastifyInstance, config: ConfigResponse) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/config',
    {
      // Read before anybody is signed in: the web compares its networks with these first.
      config: { auth: 'public', limit: 'standard' },
      schema: {
        summary: 'Feature flags and the chains this deployment runs on',
        description:
          'A feature shows only when its flag and the chain allow it. Each chain names its network (mainnet, testnet or local) and the provenance label its figures carry: anything that is not `live` is shown as a test network or as MOCK.',
        // Open to anybody, and counted like any other /v1 request: a 429 has the one refusal shape.
        response: { 200: ConfigResponse, default: OrderError },
      },
    },
    async () => config,
  );
}
