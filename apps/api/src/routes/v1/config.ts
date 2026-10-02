import {
  type ChainId,
  ConfigResponse,
  chainProvenance,
  type EnvLike,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const ORDER: ChainId[] = ['solana', 'robinhood', 'base'];

/**
 * The flags and one entry per chain. Each entry's `provenance` is the label every figure from that chain
 * carries as it is run now: `mock` on the mock, `sandbox` on a test network or a local copy, `live` on
 * mainnet only. Nothing here is a secret: a chain config holds no RPC URL.
 * Throws on a variable it cannot read, so a typo stops the API at start.
 */
export function buildConfig(env: EnvLike): ConfigResponse {
  const flags = parseFlags(env);
  const configs = parseChainConfigs(env);
  return {
    flags,
    chains: ORDER.map((id) => {
      const mode = flags.chainMode[id];
      return { ...configs[id], mode, provenance: chainProvenance(configs[id].network, mode) };
    }),
  };
}

export async function registerConfigRoute(app: FastifyInstance, env: EnvLike) {
  const config = buildConfig(env);
  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/config',
    {
      schema: {
        summary: 'Feature flags and the chains this deployment runs on',
        description:
          'A feature shows only when its flag and the chain allow it. Each chain names its network (mainnet, testnet or local) and the provenance label its figures carry: anything that is not `live` is shown as a test network or as MOCK.',
        response: { 200: ConfigResponse },
      },
    },
    async () => config,
  );
}
