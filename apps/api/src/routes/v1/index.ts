import { randomUUID } from 'node:crypto';
import {
  assertNode as assertEvmNode,
  createEvmRpc,
  type EvmDeploymentRecord,
  type EvmRpc,
  deploymentAssets as evmDeploymentAssets,
} from '@colosseum/chain-evm/vault';
import {
  assertNode,
  createVaultRpc,
  deploymentAssets,
  type SolanaDeploymentRecord,
  type VaultNodeRpc,
} from '@colosseum/chain-solana/vault';
import { basketAssets, type Db, sharedDb } from '@colosseum/db';
import {
  BasketAsset,
  ChainError,
  type EnvLike,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createTestFunds,
  faucetKeysFrom,
  type TestFunds,
  type TestFundsSender,
} from '../../faucet/test-funds';
import { type IntakeModel, intakeModelFromEnv, intakeSettings } from '../../llm';
import { createModelQuota } from '../../model-quota';
import {
  type ChainRegistry,
  createChainRegistry,
  type EvmInputs,
  type SolanaInputs,
} from '../../orders/chains';
import { Refusal, refusalFromChainError } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import type { PlanInputs } from '../../orders/personalize';
import { type RelaxedGoalAgent, relaxedGoalAgentFromEnv } from '../../orders/relaxed-goal-agent';
import type { AgentAnalytics } from '../../orders/vault-agent';
import { authFromEnv, enforceSignIn, identify, type TokenIssuer } from '../../plugins/auth';
import { refuseNonFinite } from '../../plugins/finite';
import { type Limits, registerLimits, requireDeclared } from '../../plugins/limits';
import { loggable } from '../../plugins/loggable';
import {
  createAnthropicVaultAgentModel,
  type VaultAgentModel,
  vaultAgentEffort,
  vaultAgentModelId,
  vaultAgentTimeoutMs,
} from '../../vault-agent-model';
import { type LinkedPlanLimits, registerBasketRoutes } from './baskets';
import { buildConfig, registerConfigRoute } from './config';
import { registerFundingRoute } from './funding';
import { registerGoalConversationReplyRoute } from './goal-conversation-reply';
import { registerIntakeRoute } from './intake';
import { registerMeRoutes } from './me';
import { registerMixRoutes } from './mix';
import { registerMockRoutes } from './mock';
import { registerOrderRoutes } from './orders';
import { registerPortfolioRoute } from './portfolio';
import { registerPortfolioExposureRoute } from './portfolio-exposure';
import { registerPortfolioHistoryRoute } from './portfolio-history';
import { registerPortfolioPlansRoute } from './portfolio-plans';
import { registerPortfolioRebalancesRoute } from './portfolio-rebalances';
import { registerSharedRoutes } from './shared';
import { registerTestnetRoute } from './testnet';
import { registerThreadRoutes } from './thread';
import { registerVaultRoute } from './vault';
import { registerVaultConversationRoutes } from './vault-conversation';
import { registerVaultConversationReplyRoute } from './vault-conversation-reply';

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
  /** What Robinhood Chain runs on in `live` or `readonly`. Default: `ROBINHOOD_RPC_URL` and the `basket_assets` rows. */
  robinhood?: EvmInputs;
  /** Robinhood Chain's deploy record: `basket_assets` is held to its tokens at start. */
  robinhoodRecord?: EvmDeploymentRecord | null;
  db?: Db;
  now?: () => Date;
  /**
   * Bearing's measured exits and the yields a plan is made with. Default: none, so every line's
   * ceiling is its tier's and says so. The server hands in the reader of the stored figures.
   */
  planInputs?: PlanInputs;
  /**
   * Bearing's per-asset figures the conversations explain each asset with. Default: none, and the
   * model reads only the plan inputs. The server hands in the reader of the fact sheets.
   */
  agentAnalytics?: AgentAnalytics;
  /** Read each live chain's analytics from the start and keep them current. Default: off. */
  warmAgentAnalytics?: boolean;
  /**
   * The model the guided intake reads a goal with. Default: Anthropic's when `ANTHROPIC_API_KEY` is
   * set, else none, and the intake reads with the rules parser alone. A test hands in a replay.
   */
  intakeModel?: IntakeModel | null;
  /** Private, non-executable vault dialogue. Uses the configured intake model and shared quota. */
  vaultAgentModel?: VaultAgentModel | null;
  /** The goal agent behind /goal (gate RELAXED-INTAKE). Default: the relaxed intake when a model key is
   * set and `GOAL_AGENT` does not opt out; null leaves the model-led conversation to answer. */
  relaxedGoalAgent?: RelaxedGoalAgent | null;
  /** The rate limits. Default: `LIMITS`, the ones a server runs with. */
  limits?: Limits;
  /** The daily cap and the keeping time of plans made from a link. Default: `LINKED_PLANS`. */
  linkedPlans?: LinkedPlanLimits;
  /**
   * The test faucet's senders (POST /v1/testnet/fund). Left out: made from the faucet keys in the
   * environment (`FAUCET_KEY_ENV`), for the chains on a test network only, or none. A test hands in
   * its own.
   */
  testFunds?: TestFundsSender[];
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
    // The process's one pool, shared with the routes outside /v1 (packages/db: `sharedDb`). Opens no
    // connection until the first query.
    db = sharedDb().db;
  }
  // Read only when the registry is made here: a test that hands in its chains hands in its senders.
  const solana = deps.chains
    ? undefined
    : (deps.solana ??
      (await solanaFromEnv(env, flags.chainMode.solana, db, deps.solanaRecord ?? null)));
  const robinhood = deps.chains
    ? undefined
    : (deps.robinhood ??
      (await robinhoodFromEnv(env, flags.chainMode.robinhood, db, deps.robinhoodRecord ?? null)));
  const chains =
    deps.chains ??
    createChainRegistry(flags, parseChainConfigs(env, deps.contracts), {
      seed: `${Date.now()}:${randomUUID()}`,
      now: deps.now,
      solana,
      robinhood,
    });
  const orderDeps: OrderDeps = {
    db,
    chains,
    now: deps.now ?? (() => new Date()),
    // The kind of failure only: what was being written is a person's own words, and is not logged.
    onRecordError: (what) => app.log.error(what, 'a plan’s thread could not be written'),
  };
  // The conversations' analytics, read from the start and kept current, so a turn finds them kept.
  const analytics = deps.agentAnalytics;
  if (deps.warmAgentAnalytics && analytics?.warm) {
    const warm = analytics.warm;
    const on = db;
    app.addHook('onReady', async () => {
      for (const entry of chains.active()) {
        if (entry.mock) continue;
        entry.adapter.listAssets().then(
          (assets) => warm({ db: on, chain: entry.chain, assets, provenance: entry.provenance }),
          () =>
            app.log.warn(
              { code: 'analytics_warm_no_catalog', chain: entry.chain },
              'the conversation analytics were not warmed',
            ),
        );
      }
    });
    app.addHook('onClose', async () => analytics.stop?.());
  }
  const modelSettings = intakeSettings(env);
  const quota = createModelQuota({ ...modelSettings, now: deps.now });
  const intakeModel =
    deps.intakeModel === undefined ? intakeModelFromEnv(env, deps.now, quota) : deps.intakeModel;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const vaultAgentModel =
    deps.vaultAgentModel === undefined
      ? apiKey
        ? createAnthropicVaultAgentModel({
            apiKey,
            model: vaultAgentModelId(env, modelSettings.model),
            timeoutMs: vaultAgentTimeoutMs(env),
            effort: vaultAgentEffort(env),
            quota,
            // Token counts only: how much of each prompt the cache wrote and read.
            onUsage: (usage) => app.log.info(usage, 'the conversation model answered'),
          })
        : null
      : deps.vaultAgentModel;
  const relaxedGoalAgent =
    deps.relaxedGoalAgent === undefined
      ? relaxedGoalAgentFromEnv(env, quota)
      : deps.relaxedGoalAgent;

  // The test faucet. Its key-holding file is loaded only here, only when a faucet key is set for a
  // chain on a test network (DESIGN-VAULT section 2, rule 5): otherwise it is never in the process.
  let senders = deps.testFunds ?? [];
  const faucetKeys = deps.testFunds ? null : faucetKeysFrom(env, chains);
  if (faucetKeys) {
    const { createFaucetSenders } = await import('../../faucet/signer');
    senders = await createFaucetSenders(faucetKeys, chains.active(), {
      // The node is held to the genesis of the network the record was deployed on.
      ...(solana
        ? { solana: { rpc: solana.rpc, genesisHash: deps.solanaRecord?.genesisHash ?? null } }
        : {}),
      ...(robinhood ? { robinhood } : {}),
    });
  }
  const testFunds: TestFunds | null = senders.length
    ? createTestFunds({
        senders,
        now: deps.now,
        // The chain and the error's name: never the error, whose message can carry the RPC URL.
        log: (fields) => app.log.error(fields, 'a test faucet send failed'),
      })
    : null;

  // Its own scope: sign-in, the rate limits and the error shape apply to these routes and to no
  // others. Default deny: a route under /v1 that does not say who may call it and which budget it
  // counts against, or that is registered outside this scope, stops the app at start. A request is
  // counted before it is turned away.
  await app.register(async (scope) => {
    inScope(scope);
    identify(scope, issuer);
    registerLimits(scope, { limits: deps.limits, now: deps.now });
    enforceSignIn(scope);
    // No answer of /v1 carries Infinity or NaN: it is refused here, where the route is known.
    refuseNonFinite(scope);
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
      // By what it is called and its code where it has one, and nothing else of it: a database's
      // error repeats the statement's values, which name the person (plugins/loggable.ts).
      req.log.error({ err: loggable(err) }, 'a /v1 route failed');
      // The request id and nothing else: no SQL, no stack.
      return reply.code(500).send({ error: `the server failed on this request (${req.id})` });
    });
    registerConfigRoute(scope, config);
    registerMeRoutes(scope, orderDeps);
    registerFundingRoute(scope, orderDeps, testFunds ?? undefined);
    registerTestnetRoute(scope, orderDeps, testFunds);
    registerOrderRoutes(scope, orderDeps);
    // Bearing's measured exits and the yields a plan is made with. Default: none.
    const planInputs = deps.planInputs ?? (async () => ({}));
    registerBasketRoutes(
      scope,
      orderDeps,
      planInputs,
      { agentSurface: flags.agentSurface },
      deps.linkedPlans,
    );
    registerIntakeRoute(scope, orderDeps, intakeModel, deps.planInputs);
    registerThreadRoutes(scope, orderDeps);
    registerPortfolioRoute(scope, orderDeps);
    // The portfolio section (PORT-2): read from the database alone, the person's own rows only.
    registerPortfolioHistoryRoute(scope, orderDeps);
    registerPortfolioPlansRoute(scope, orderDeps);
    registerPortfolioRebalancesRoute(scope, orderDeps);
    registerPortfolioExposureRoute(scope, orderDeps, planInputs);
    registerSharedRoutes(scope, orderDeps, deps.planInputs);
    registerVaultRoute(scope, orderDeps);
    registerVaultConversationRoutes(scope, orderDeps);
    registerVaultConversationReplyRoute(
      scope,
      orderDeps,
      vaultAgentModel,
      deps.planInputs,
      deps.agentAnalytics,
    );
    registerGoalConversationReplyRoute(
      scope,
      orderDeps,
      vaultAgentModel,
      deps.planInputs,
      deps.agentAnalytics,
      relaxedGoalAgent,
    );
    registerMixRoutes(scope, orderDeps, deps.planInputs);
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
  // What the adapter lists: without a record, the table as it is; with one, held to it, and never a
  // token the deploy retired.
  const listed = record ? holdToRecord(assets, record) : assets;
  // The node is asked what network it is: a test label on a mainnet node does not start.
  const rpc = connect(url);
  await assertNode(rpc, record);
  return { rpc, assets: listed };
}

/**
 * `basket_assets` against the deploy's record, at start: every Solana row is a row the record makes
 * (`deploymentAssets`), with the same mint, decimals, class, session, price entry, ceiling and keeper
 * eligibility, and the cash row is the record's cash. One database serves one network, so a row of
 * another network's deploy, or a hand-edited one (a `priceRef` moved to another entry), stops the API
 * rather than build on it. The table has no token program: the adapter reads it from each mint.
 *
 * Answers the rows the adapter may list. A row of a token the deploy retired does not stop the start,
 * and is left out: a retired token is sold and withdrawn, never bought, and the adapter shows it under
 * its mint (`solana:mint-<hex>`) as it does once the fill script has removed the row.
 */
export function holdToRecord(assets: BasketAsset[], record: SolanaDeploymentRecord): BasketAsset[] {
  return holdTo(assets, {
    network: record.network,
    made: deploymentAssets(record),
    cash: { id: record.cash.id, address: record.cash.mint },
    retired: record.retired.map((r) => r.mint),
  });
}

/** The same for an EVM chain's rows and its record. */
export function holdToEvmRecord(assets: BasketAsset[], record: EvmDeploymentRecord): BasketAsset[] {
  return holdTo(assets, {
    network: record.network,
    made: evmDeploymentAssets(record),
    cash: { id: record.cash.id, address: record.cash.address },
    retired: record.retired.map((r) => r.address),
  });
}

function holdTo(
  assets: BasketAsset[],
  record: {
    network: string;
    made: BasketAsset[];
    cash: { id: string; address: string };
    retired: string[];
  },
): BasketAsset[] {
  const made = new Map(record.made.map((a) => [a.address, a]));
  const fields = [
    'decimals',
    'cls',
    'session',
    'priceKind',
    'priceRef',
    'maxWeightBps',
    'autoFollowEligible',
  ] as const;
  // A token the deploy retired stays listed on chain and may still be in a vault: its row does not stop
  // the start, and is left out of what the adapter lists.
  const retired = new Set(record.retired);
  const wrong = assets.flatMap((a) => {
    if (retired.has(a.address)) return [];
    const want = made.get(a.address);
    if (!want) return [`${a.id} (${a.address}) is not a token of ${record.network}`];
    return fields
      .filter((f) => a[f] !== want[f])
      .map((f) => `${a.id} has ${f} ${a[f]}, and ${record.network} says ${want[f]}`);
  });
  const cash = assets.filter((a) => a.cls === 'cash');
  if (cash.length !== 1 || cash[0]?.address !== record.cash.address)
    wrong.push(
      `the cash row is not ${record.network}'s cash, ${record.cash.id} (${record.cash.address})`,
    );
  if (wrong.length)
    throw new Error(
      `basket_assets does not match the record of ${record.network}: ${wrong.slice(0, 3).join('; ')}`,
    );
  return assets.filter((a) => !retired.has(a.address));
}

/**
 * What Robinhood Chain runs on when it is `live` or `readonly` and nothing was handed in: the RPC at
 * `ROBINHOOD_RPC_URL` and the network's assets as `basket_assets` holds them, held to the deploy's
 * record. The record is required: it is what the node is checked against. Nothing for any other mode.
 */
export async function robinhoodFromEnv(
  env: EnvLike,
  mode: string,
  db: Db,
  record: EvmDeploymentRecord | null,
  connect: (url: string) => EvmRpc = createEvmRpc,
): Promise<EvmInputs | undefined> {
  if (mode !== 'live' && mode !== 'readonly') return undefined;
  if (!record)
    throw new Error(
      `CHAIN_MODE_ROBINHOOD is ${mode}, and there is no deploy record for its network in deployments/`,
    );
  // As written: a URL can carry a key, and keys are case-sensitive (readEnv lower-cases).
  const url = env.ROBINHOOD_RPC_URL?.trim();
  if (!url) throw new Error(`CHAIN_MODE_ROBINHOOD is ${mode}, and ROBINHOOD_RPC_URL is not set`);
  const rows = await db.select().from(basketAssets).where(eq(basketAssets.chainId, 'robinhood'));
  const assets = rows.map(({ updatedAt: _, chainId, ...row }) =>
    BasketAsset.parse({ ...row, chain: chainId }),
  );
  const rpc = connect(url);
  // The node is asked what chain it is: a test label on a mainnet node does not start.
  await assertEvmNode(rpc, record);
  return { rpc, assets: holdToEvmRecord(assets, record) };
}
