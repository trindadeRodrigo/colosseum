import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@colosseum/db';
import { ChainError, type EnvLike, parseChainConfigs, parseFlags } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { type ChainRegistry, createChainRegistry } from '../../orders/chains';
import { Refusal, refusalFromChainError } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { authFromEnv, registerAuth, type TokenIssuer } from '../../plugins/auth';
import { registerConfigRoute } from './config';
import { registerMockRoutes } from './mock';
import { registerOrderRoutes } from './orders';
import { registerPortfolioRoute } from './portfolio';

/**
 * What the /v1 routes run on. Left out, each comes from the environment the app hands in. A test hands
 * in its own: the issuer whose tokens it signs, and the chains it wants to reach into.
 */
export type V1Deps = {
  /** Whose tokens are trusted. Default: the Privy app named by PRIVY_APP_ID, or nobody. */
  auth?: TokenIssuer | null;
  chains?: ChainRegistry;
  db?: Db;
  now?: () => Date;
};

/** Every /v1 route. The app hands in its environment once; nothing under here reads process.env. */
export async function registerV1Routes(app: FastifyInstance, env: EnvLike, deps: V1Deps = {}) {
  // First, so a flag or a chain config that cannot be read stops the app with its own message.
  await registerConfigRoute(app, env);

  const flags = parseFlags(env);
  const issuer = deps.auth === undefined ? authFromEnv(env) : deps.auth;
  const chains =
    deps.chains ??
    createChainRegistry(flags, parseChainConfigs(env), {
      seed: `${Date.now()}:${randomUUID()}`,
      now: deps.now,
    });
  let db = deps.db;
  if (!db) {
    // Opens no connection until the first query.
    const own = createDb();
    db = own.db;
    app.addHook('onClose', () => own.client.end());
  }
  const orderDeps: OrderDeps = { db, chains, now: deps.now ?? (() => new Date()) };

  // Its own scope: the sign-in hook and the error shape apply to these routes and to no others.
  await app.register(async (scope) => {
    registerAuth(scope, issuer);
    scope.setErrorHandler((err, req, reply) => {
      const refusal =
        err instanceof Refusal
          ? err
          : err instanceof ChainError
            ? refusalFromChainError(err)
            : null;
      if (refusal) return reply.code(refusal.status).send(refusal.body());
      if (err instanceof Error && 'validation' in err && err.validation)
        return reply.code(400).send({ error: err.message });
      req.log.error({ err }, 'a /v1 route failed');
      // The request id and nothing else: no SQL, no stack.
      return reply.code(500).send({ error: `the server failed on this request (${req.id})` });
    });
    registerOrderRoutes(scope, orderDeps);
    registerPortfolioRoute(scope, orderDeps);
    // Out of the route table altogether unless a chain runs on the mock.
    if (chains.active().some((entry) => entry.mock)) registerMockRoutes(scope, orderDeps);
  });
}
