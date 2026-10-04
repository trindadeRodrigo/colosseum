import { randomUUID } from 'node:crypto';
import { createVaultRpc } from '@colosseum/chain-solana/vault';
import { basketAssets, createDb, type Db } from '@colosseum/db';
import {
  BasketAsset,
  ChainError,
  type EnvLike,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type ChainRegistry, createChainRegistry, type SolanaInputs } from '../../orders/chains';
import { Refusal, refusalFromChainError } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { authFromEnv, enforceSignIn, identify, type TokenIssuer } from '../../plugins/auth';
import { type Limits, registerLimits, requireDeclared } from '../../plugins/limits';
import { buildConfig, registerConfigRoute } from './config';
import { registerFundingRoute } from './funding';
import { registerMeRoutes } from './me';
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
  /**
   * Our deployments on each chain's network, by name (`program` on Solana; `factory` and `registry` on
   * EVM), as a deploy writes them. A chain in `live` or `readonly` does not start without its own.
   */
  contracts?: Parameters<typeof parseChainConfigs>[1];
  /** What Solana runs on in `live` or `readonly`. Default: `SOLANA_RPC_URL` and the `basket_assets` rows. */
  solana?: SolanaInputs;
  db?: Db;
  now?: () => Date;
  /** The rate limits. Default: `LIMITS`, the ones a server runs with. */
  limits?: Limits;
  /**
   * What `requireDeclared(root)` answered, when the app called it before its own routes, so that a
   * /v1 path registered ahead of these is held to the rule too. Left out, it is called here.
   */
  inScope?: (scope: FastifyInstance) => void;
};

/** Every /v1 route. The app hands in its environment once; nothing under here reads process.env. */
export async function registerV1Routes(app: FastifyInstance, env: EnvLike, deps: V1Deps = {}) {
  // First, so a flag or a chain config that cannot be read stops the app with its own message.
  const config = buildConfig(env, deps.contracts);
  // Default deny for every path under /v1, wherever it is registered from here on.
  const inScope = deps.inScope ?? requireDeclared(app);

  const flags = parseFlags(env);
  const issuer = deps.auth === undefined ? authFromEnv(env) : deps.auth;
  let db = deps.db;
  if (!db) {
    // Opens no connection until the first query.
    const own = createDb();
    db = own.db;
    app.addHook('onClose', () => own.client.end());
  }
  const chains =
    deps.chains ??
    createChainRegistry(flags, parseChainConfigs(env, deps.contracts), {
      seed: `${Date.now()}:${randomUUID()}`,
      now: deps.now,
      solana: deps.solana ?? (await solanaFromEnv(env, flags.chainMode.solana, db)),
    });
  const orderDeps: OrderDeps = { db, chains, now: deps.now ?? (() => new Date()) };

  // Its own scope: sign-in, the rate limits and the error shape apply to these routes and to no
  // others. Default deny: a route under /v1 that does not say who may call it and which budget it
  // counts against, or that is registered outside this scope, stops the app at start. A request is
  // counted before it is turned away.
  await app.register(async (scope) => {
    inScope(scope);
    identify(scope, issuer);
    registerLimits(scope, { limits: deps.limits, now: deps.now });
    enforceSignIn(scope);
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
      // A request the server could not read (bad JSON, an empty body, a content type it does not
      // take, a body too large) is the caller's to fix. Fastify's own messages are safe to pass on;
      // a parser's may quote the body, so it gets one fixed line.
      const status = (err as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        const code = (err as { code?: unknown }).code;
        const ours = err instanceof Error && typeof code === 'string' && code.startsWith('FST_');
        return reply
          .code(status)
          .send({ error: ours ? err.message : 'the request body could not be read as JSON' });
      }
      req.log.error({ err }, 'a /v1 route failed');
      // The request id and nothing else: no SQL, no stack.
      return reply.code(500).send({ error: `the server failed on this request (${req.id})` });
    });
    registerConfigRoute(scope, config);
    registerMeRoutes(scope, orderDeps);
    registerFundingRoute(scope, orderDeps);
    registerOrderRoutes(scope, orderDeps);
    registerPortfolioRoute(scope, orderDeps);
    // Out of the route table altogether unless a chain runs on the mock.
    if (chains.active().some((entry) => entry.mock)) registerMockRoutes(scope, orderDeps);
  });
}

/**
 * What Solana runs on when it is `live` or `readonly` and nothing was handed in: the RPC at
 * `SOLANA_RPC_URL` and the network's assets as `basket_assets` holds them. Nothing for any other mode.
 */
export async function solanaFromEnv(
  env: EnvLike,
  mode: string,
  db: Db,
): Promise<SolanaInputs | undefined> {
  if (mode !== 'live' && mode !== 'readonly') return undefined;
  // As written: a URL can carry a key, and keys are case-sensitive (readEnv lower-cases).
  const url = env.SOLANA_RPC_URL?.trim();
  if (!url) throw new Error(`CHAIN_MODE_SOLANA is ${mode}, and SOLANA_RPC_URL is not set`);
  const rows = await db.select().from(basketAssets).where(eq(basketAssets.chainId, 'solana'));
  const assets = rows.map(({ updatedAt: _, chainId, ...row }) =>
    BasketAsset.parse({ ...row, chain: chainId }),
  );
  return { rpc: createVaultRpc(url), assets };
}
