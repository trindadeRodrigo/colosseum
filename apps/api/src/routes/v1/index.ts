import { randomUUID } from 'node:crypto';
import {
  assertNode,
  createVaultRpc,
  deploymentAssets,
  type SolanaDeploymentRecord,
  type VaultNodeRpc,
} from '@colosseum/chain-solana/vault';
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
  /** The deploy's record the addresses came from: `basket_assets` is held to its mints at start. */
  solanaRecord?: SolanaDeploymentRecord | null;
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
      solana:
        deps.solana ??
        (await solanaFromEnv(env, flags.chainMode.solana, db, deps.solanaRecord ?? null)),
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
  record: SolanaDeploymentRecord | null = null,
  connect: (url: string) => VaultNodeRpc = createVaultRpc,
): Promise<SolanaInputs | undefined> {
  if (mode !== 'live' && mode !== 'readonly') return undefined;
  // As written: a URL can carry a key, and keys are case-sensitive (readEnv lower-cases).
  const url = env.SOLANA_RPC_URL?.trim();
  if (!url) throw new Error(`CHAIN_MODE_SOLANA is ${mode}, and SOLANA_RPC_URL is not set`);
  const rows = await db.select().from(basketAssets).where(eq(basketAssets.chainId, 'solana'));
  const assets = rows.map(({ updatedAt: _, chainId, ...row }) =>
    BasketAsset.parse({ ...row, chain: chainId }),
  );
  if (record) holdToRecord(assets, record);
  // The node is asked what network it is: a test label on a mainnet node does not start.
  const rpc = connect(url);
  await assertNode(rpc, record);
  return { rpc, assets };
}

/**
 * `basket_assets` against the deploy's record, at start: every Solana row is a row the record makes
 * (`deploymentAssets`), with the same mint, decimals, class, session, price entry, ceiling and keeper
 * eligibility, and the cash row is the record's cash. A row of a token the record retired is let
 * through. One database serves one network, so a row of another network's deploy,
 * or a hand-edited one (a `priceRef` moved to another entry), stops the API rather than build on it.
 * The table has no token program: the adapter reads it from each mint.
 */
export function holdToRecord(assets: BasketAsset[], record: SolanaDeploymentRecord): void {
  const made = new Map(deploymentAssets(record).map((a) => [a.address, a]));
  const fields = [
    'decimals',
    'cls',
    'session',
    'priceKind',
    'priceRef',
    'maxWeightBps',
    'autoFollowEligible',
  ] as const;
  // A token the deploy retired stays listed on chain and may still be in a vault: its row is tolerated
  // until the fill script takes it out.
  const retired = new Set(record.retired.map((r) => r.mint));
  const wrong = assets.flatMap((a) => {
    if (retired.has(a.address)) return [];
    const want = made.get(a.address);
    if (!want) return [`${a.id} (${a.address}) is not a token of ${record.network}`];
    return fields
      .filter((f) => a[f] !== want[f])
      .map((f) => `${a.id} has ${f} ${a[f]}, and ${record.network} says ${want[f]}`);
  });
  const cash = assets.filter((a) => a.cls === 'cash');
  if (cash.length !== 1 || cash[0]?.address !== record.cash.mint)
    wrong.push(
      `the cash row is not ${record.network}'s cash, ${record.cash.id} (${record.cash.mint})`,
    );
  if (wrong.length)
    throw new Error(
      `basket_assets does not match the record of ${record.network}: ${wrong.slice(0, 3).join('; ')}`,
    );
}
