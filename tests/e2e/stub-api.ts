import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { familyIdOf, metaHash, rebalancePlan, sha256Hex, view } from '@colosseum/basket';
import {
  createMockAdapter,
  type MockAdapter,
  mockAddress,
  mockRecipeId,
} from '@colosseum/chain-mock';
import {
  AcceptGoalMixRequest,
  AcceptGoalMixResponse,
  ApplyVaultMixRequest,
  ApplyVaultMixResponse,
  type BasketSheet,
  ChainError,
  ChainId,
  ConfigResponse,
  chainProvenance,
  DEFAULT_FLAGS,
  DISCLAIMER,
  MixReview,
  type OrderDetail,
  PortfolioExposureResponse,
  PortfolioHistoryResponse,
  PortfolioPlansResponse,
  PortfolioRebalancesQuery,
  PortfolioRebalancesResponse,
  parseChainConfigs,
  type Recipe,
  type RecipeVersionView,
  type SharedFamily,
  Target,
  VaultAgentReplyShape,
  warningsBelong,
} from '@colosseum/schemas';
import {
  ApiRefusal,
  basketIdOfLinkedPlan,
  basketIdOfPlan,
  deploymentsOf,
  type OrderApi,
} from '@colosseum/sdk';
import { z } from 'zod';
import {
  EXPOSURE,
  HISTORY,
  PLANS,
  REBALANCES,
} from '../../apps/web/features/portfolio-section/fixtures/answers';
import {
  narrowExposure,
  narrowHistory,
  narrowPlans,
  narrowRebalances,
} from '../../apps/web/features/portfolio-section/fixtures/narrow';
import { apiDouble } from '../../packages/sdk/test/api-double';
import { type MockWorld, tampered } from '../../packages/sdk/test/mock';
import { riskAnswer } from './stub-risk';

// The API the end-to-end spec of the web app runs against (apps/web/e2e): a stub over HTTP, on the
// mock chain. It answers the routes the goal, plan, buy and order screens call, in their shared shapes.
// The order routes are the SDK's own double of them (packages/sdk/test/api-double.ts) on a chain of
// packages/chain-mock, so the screen's executor builds, checks with the real guard, signs with the
// throwaway wallet and reports, step by step, as it would against apps/api. It is not apps/api: the
// throwaway wallet has no sign-in, and apps/api answers an order route only to one.
//
//   tsx tests/e2e/stub-api.ts            STUB_API_PORT (3901), WEB_ORIGIN (http://localhost:3100)
//
// Plans an agent proposes from a link are made and read back as the API does (AGT-2). Four routes of
// its own, for the spec: POST /__stub/reset forgets everything, GET /__stub/reports
// lists the steps the web reported as signed, POST
// /__stub/tamper makes the next swap it builds carry a lower minimum than the order states, as a
// server that lies would, and POST /__stub/test-network has the funding answer as a test network's
// with test funds offered (POST /v1/testnet/fund), as a server with a faucet key does. MOCK throughout: every figure says so. The /risk routes are the one
// exception: they answer from Rodrigo's recording of the risk API (stub-risk.ts), measured and old.
//
// The portfolio section's four routes (GET /v1/portfolio/plans, /history, /rebalances, /exposure,
// PORT-3) answer whoever asks with the section's own sample answers
// (apps/web/features/portfolio-section/fixtures/answers.ts): seven vaults on two chains, one labelled a
// test network and one the mock, and Base switched off, so the spec sees every kind of card. They are
// samples and say so on every figure; they are not this stub's mock chain, and a buy made here does
// not change them. Each is narrowed by `chain`, `address` and `limit` as the API narrows its own, and
// is parsed with the contract's schema before it is sent.

const PORT = Number(process.env.STUB_API_PORT ?? 3901);
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3100';
/**
 * The chain the stub's mock runs: Solana by default, Robinhood Chain with STUB_CHAIN=robinhood, where
 * a buy is an approval of the deposit and a create that trades (the EVM mock's capabilities).
 */
const CHAIN = (process.env.STUB_CHAIN === 'robinhood' ? 'robinhood' : 'solana') as
  | 'solana'
  | 'robinhood';
const CHAIN_NAME = CHAIN === 'robinhood' ? 'Robinhood Chain' : 'Solana';
/** The mock's dollar, by the name of the chain it stands in for (packages/chain-mock, shelf.ts). */
const CASH_SYMBOL = CHAIN === 'robinhood' ? 'tUSDG' : 'USDC';
const GAS =
  CHAIN === 'robinhood' ? { symbol: 'ETH', decimals: 18 } : { symbol: 'SOL', decimals: 9 };
/** What the stub's faucet gives a wallet in gas: a little of the chain's own coin. */
const GAS_FAUCET = CHAIN === 'robinhood' ? '1000000000000000000' : '1000000000';
/** The owner a request names on this chain's family. */
const ownerIn = (o: unknown): string =>
  ((o ?? {}) as { solana?: string; evm?: string })[CHAIN === 'robinhood' ? 'evm' : 'solana'] ?? '';
const PLAN_ID = '3c1f9a7e-5b2d-4c8e-9f0a-1b2c3d4e5f60';
/** The plan's weights on the mock shelf; the rest is cash. */
const WEIGHTS: Target[] = [
  { asset: `${CHAIN}:spy`, weightBps: 5000 },
  { asset: `${CHAIN}:nvda`, weightBps: 3000 },
  { asset: `${CHAIN}:gold`, weightBps: 1500 },
];

type Published = { familyId: string; slug: string; name: string; copy: string; creator: string };

type World = {
  adapter: MockAdapter;
  double?: {
    owner: string;
    api: OrderApi;
    buy: (usd: number) => Promise<OrderDetail>;
    place: ReturnType<typeof apiDouble>['place'];
  };
  /** The shared portfolios publish orders were made for, by slug: shown once the chain holds them. */
  published: Map<string, Published>;
  /** Every version seen of each recipe, by its id. */
  versions: Map<string, Map<number, RecipeVersionView>>;
};
const freshWorld = (): World => ({
  adapter: createMockAdapter({ chain: CHAIN }),
  published: new Map(),
  versions: new Map(),
});
let world: World = freshWorld();
let tamperNext = false;
/** The funding answers as a test network's, and the test faucet sends (POST /__stub/test-network). */
let testNetwork = false;
/** The plan an agent proposed from a link (`POST /v1/baskets/propose`), read back by its id. */
let linked: ReturnType<typeof proposal> | null = null;
/** The plan a person built (`POST /v1/baskets/personalize`), read back by its id as their own. */
let built: ReturnType<typeof proposal> | null = null;
/** The weights of a mix confirmed for a new goal (POST /v1/conversations/{chain}/goal/accept): the buy's. */
let mixTargets: Target[] | null = null;
/** The risk roll-up of a plan an agent proposed: MOCK, nothing measured, as on the mock chain. */
const ROLL_UP = {
  byIssuer: [{ key: 'mock', bps: 10_000 }],
  byChain: [{ key: CHAIN, bps: 10_000 }],
  byClass: [{ key: 'stock', bps: 10_000 }],
  flags: ['exit_not_measured', 'exit_quote_missing'],
  exit: { quotedBps: null, quotedAt: null, measuredWorstBps: null, measuredShareBps: 0 },
};
/** The steps the web reported signed bytes or an id for, in order. */
let reports: string[] = [];

const OBSERVED = {
  source: 'the e2e stub',
  method: 'sample: made up for the end-to-end spec',
  fetchedAt: '2026-10-05T12:00:00.000Z',
  provenance: 'mock' as const,
};

function config(): ConfigResponse {
  const configs = parseChainConfigs({});
  return ConfigResponse.parse({
    flags: DEFAULT_FLAGS,
    chains: (['solana', 'robinhood', 'base'] as const).map((id) => ({
      ...configs[id],
      mode: DEFAULT_FLAGS.chainMode[id],
      provenance: chainProvenance(configs[id].network, DEFAULT_FLAGS.chainMode[id]),
    })),
  });
}

function proposal(sheet: BasketSheet, weights: Target[] = WEIGHTS) {
  const cash = world.adapter.mock.cash;
  const cashBps = 10_000 - weights.reduce((n, t) => n + t.weightBps, 0);
  const lines = [
    ...weights.map((t) => ({
      chain: CHAIN,
      assetId: t.asset,
      weightBps: t.weightBps,
      amountUsd: (sheet.amountUsd * t.weightBps) / 10_000,
      reasons: [
        { rule: 'stub', inputs: [], params: {}, text: 'Sample: a reason the stub made up.' },
      ],
    })),
    ...(cashBps > 0
      ? [
          {
            chain: CHAIN,
            assetId: cash,
            weightBps: cashBps,
            amountUsd: (sheet.amountUsd * cashBps) / 10_000,
            reasons: [],
          },
        ]
      : []),
  ];
  return {
    sheet,
    engineVersion: 'stub',
    paramsHash: 'stub',
    shelfVersion: 'stub',
    inputsHash: 'stub',
    lines,
    recipes: [
      {
        chain: CHAIN,
        amountUsd: sheet.amountUsd,
        components: weights.map((t) => ({ kind: 'asset', asset: t.asset, weightBps: t.weightBps })),
      },
    ],
    removed: [],
    card: {
      moneyTodayUsd: sheet.amountUsd,
      termMonths: sheet.horizonMonths,
      cashFlow: 'none',
      expectedReturn: { lowPct: 0, highPct: 0, basis: 'sample', lossInFallUsd: 0 },
      exit: { text: 'Sample: up to the whole amount within a day', costBps: 25 },
    },
    flags: [],
    observations: [
      { id: 'stub-yield', kind: 'yield', ...OBSERVED },
      { id: 'stub-exit', kind: 'liquidity', ...OBSERVED },
    ],
    disclaimer: 'MOCK',
  };
}

/** The order routes for this owner: the SDK's double, on this chain, for the plan's vault. */
function doubleFor(owner: string) {
  if (world.double?.owner === owner) return world.double;
  const { adapter } = world;
  const w: MockWorld = {
    chain: CHAIN,
    adapter,
    deployment: deploymentsOf('mock')[CHAIN] as MockWorld['deployment'],
    owner,
    stranger: mockAddress(CHAIN, 'e2e stranger'),
    send: async (tx) => {
      await adapter.mock.send(tx);
    },
  };
  // A wallet first seen here gets mock gas, as from a faucet: a publish or a follow deposits nothing,
  // and its one step still pays the network fee.
  adapter.mock.fund(owner, { gasRaw: GAS_FAUCET });
  // A plan made from a link numbers the buyer's vault from the plan and the person (gate AGENT-LINK):
  // the throwaway wallet's user id is `test:` and the first 8 letters of its Solana address.
  const basketId = linked
    ? basketIdOfLinkedPlan(PLAN_ID, `test:${owner.slice(0, 8)}`)
    : basketIdOfPlan(PLAN_ID);
  const made = apiDouble(w, { basketId, targets: mixTargets ?? WEIGHTS });
  world.double = { owner, api: made.api, buy: made.buy, place: made.place };
  return world.double;
}

// ---- Shared portfolios (WEB-4), as apps/api serves them, on the stub's mock chain. ----

/** On this stub gold has no price oracle, as on Solana's test network before PAXG (GOLD-ONE-TAP). */
const NO_ORACLE = new Set([`${CHAIN}:gold`]);

const targetsOf = (r: Recipe): Target[] =>
  r.components.flatMap((c) =>
    c.kind === 'asset' ? [{ asset: c.asset, weightBps: c.weightBps }] : [],
  );

async function recipeAt(p: Published) {
  try {
    return await world.adapter.getRecipe(mockRecipeId(CHAIN, p.creator, p.familyId));
  } catch (e) {
    if (e instanceof ChainError) return null;
    throw e;
  }
}

/** A shared portfolio as GET /v1/indexes/{slug} answers it, or null before its publish landed. */
async function familyOf(p: Published): Promise<SharedFamily | null> {
  const read = await recipeAt(p);
  if (!read) return null;
  const hash = metaHash({ ...p, kind: 'index' });
  const seen = world.versions.get(read.active.onchainId ?? '') ?? new Map();
  for (const v of world.versions.get(read.active.onchainId ?? '')?.values() ?? [])
    if (v.status === 'active' || v.status === 'pending') v.status = 'superseded';
  const versionOf = (r: Recipe, status: 'active' | 'pending'): RecipeVersionView => ({
    version: r.version,
    effectiveAt: r.effectiveAt,
    components: targetsOf(r),
    metaHash: r.metaHash,
    status,
  });
  const active = versionOf(read.active, 'active');
  const pending = read.pending ? versionOf(read.pending, 'pending') : null;
  seen.set(active.version, active);
  if (pending) seen.set(pending.version, pending);
  world.versions.set(read.active.onchainId ?? '', seen);
  const held = [...targetsOf(read.active), ...(read.pending ? targetsOf(read.pending) : [])];
  const without = [...new Set(held.map((t) => t.asset))].filter((a) => NO_ORACLE.has(a));
  return {
    familyId: p.familyId,
    slug: p.slug,
    name: p.name,
    copy: p.copy,
    kind: 'index',
    platform: false,
    creatorKind: 'community',
    chains: [CHAIN],
    recipes: [
      {
        chain: CHAIN,
        name: 'Solana',
        onchainId: read.active.onchainId ?? '',
        creator: p.creator,
        active,
        pending,
        autoFollow: without.length
          ? { offered: false, reason: 'no_oracle', assets: without }
          : { offered: true },
        textMatches:
          active.metaHash === hash ? 'active' : pending?.metaHash === hash ? 'pending' : null,
        source: 'chain',
        observedAt: new Date().toISOString(),
        provenance: 'mock',
      },
    ],
  };
}

const cashOf = (usd: number) => BigInt(Math.round(usd * 100)) * 10_000n;

/** The trades of a deposit, as apps/api plans them (`tradesFor`). */
function tradesFor(targets: Target[], cashRaw: bigint) {
  const sum = targets.reduce((n, t) => n + t.weightBps, 0);
  const invested = (cashRaw * BigInt(sum)) / 10_000n;
  const shares = targets.map((t) => (invested * BigInt(t.weightBps)) / BigInt(sum));
  const largest = targets.findIndex(
    (t) => t.weightBps === Math.max(...targets.map((x) => x.weightBps)),
  );
  shares[largest] = (shares[largest] ?? 0n) + invested - shares.reduce((n, x) => n + x, 0n);
  return targets.map((t, i) => ({
    sell: world.adapter.mock.cash,
    buy: t.asset,
    amountInRaw: String(shares[i] ?? 0n),
  }));
}

type Body = Record<string, unknown> & { type: string };

/**
 * POST /v1/orders for a withdrawal, as apps/api plans one (orders/withdraw.ts): the vault's tokens, all
 * of them or the ones named, each in full or by amount, a step per token on Solana and one for all on
 * an EVM chain. Built for the vault's owner, from the vault as it is when the step is built.
 */
async function placeWithdraw(body: Body): Promise<OrderDetail> {
  const { adapter } = world;
  const [address] = body.vaults as string[];
  const state = await adapter.getVault(String(address));
  if (!state || body.sellToCash)
    throw new ApiRefusal(state ? 422 : 404, {
      error: state
        ? 'Selling to cash before withdrawing isn’t offered yet; you can withdraw the tokens themselves'
        : 'no vault of yours at that address',
    });
  const held = new Map(
    [state.cash, ...state.positions]
      .filter((h) => BigInt(h.raw) > 0n)
      .map((h) => [h.asset, h.raw] as const),
  );
  const asked = body.withdrawals as { asset: string; amountRaw?: string | null }[] | undefined;
  const all = (asked ?? [...held.keys()].map((asset) => ({ asset, amountRaw: null }))).map((x) => {
    const heldRaw = held.get(x.asset);
    if (heldRaw === undefined || (x.amountRaw != null && BigInt(x.amountRaw) > BigInt(heldRaw)))
      throw new ApiRefusal(409, { error: `the vault holds less ${x.asset} than asked for` });
    return { asset: x.asset, amountRaw: x.amountRaw ?? null, heldRaw };
  });
  if (!all.length) throw new ApiRefusal(409, { error: 'the vault holds nothing to withdraw' });
  const groups = CHAIN === 'solana' ? all.map((x) => [x]) : [all];
  return doubleFor(state.owner).place({
    type: 'withdraw',
    summary: `Withdraw from your vault on ${CHAIN_NAME} to your own wallet`,
    needsConsent: [],
    steps: [
      // A vault with auto-follow on has it switched off first, as apps/api plans it.
      ...(state.autoFollow
        ? [{ kind: 'set_auto_follow' as const, description: 'Switch auto-follow off', trades: [] }]
        : []),
      ...groups.map((withdrawals) => ({
        kind: 'withdraw' as const,
        description: 'Withdraw to your own wallet',
        trades: [],
        withdrawals,
      })),
    ],
    build: async (leg, nonce) => {
      if (leg.kind === 'set_auto_follow')
        return adapter.buildSetAutoFollow({
          vault: state.address,
          on: false,
          ...(nonce === undefined ? {} : { nonce }),
        });
      const named = leg.withdrawals ?? [];
      const amounts = named.flatMap((x) =>
        x.amountRaw === null ? [] : [[x.asset, x.amountRaw] as const],
      );
      const [tx] = await adapter.buildWithdrawInKind({
        vault: state.address,
        ...(asked || CHAIN === 'solana' ? { assets: named.map((x) => x.asset) } : {}),
        ...(amounts.length ? { amounts: Object.fromEntries(amounts) } : {}),
        ...(nonce === undefined ? {} : { nonce }),
      });
      if (!tx) throw new ApiRefusal(409, { error: 'the vault holds none of it any more' });
      return tx;
    },
  });
}

/** POST /v1/orders for a publish, a buy of a shared portfolio, or a follow. */
async function placeShared(body: Body): Promise<OrderDetail> {
  if (body.type === 'withdraw') return placeWithdraw(body);
  const { adapter } = world;
  if (body.type === 'publish') {
    const creator = (body.creator as { solana?: string }).solana ?? '';
    const slug = String(body.family);
    const p: Published = {
      familyId: familyIdOf(slug),
      slug,
      name: String(body.name),
      copy: String(body.copy),
      creator,
    };
    if (body.familyId !== undefined && body.familyId !== p.familyId)
      throw new ApiRefusal(409, { error: 'the family id is not the one of this shared portfolio' });
    const [draft] = body.recipes as { chain: string; components: Recipe['components'] }[];
    const exists = await recipeAt(p);
    world.published.set(slug, p);
    return doubleFor(creator).place({
      type: 'publish',
      summary: 'Publish your shared portfolio on Solana',
      needsConsent: ['publish'],
      steps: [
        {
          kind: 'publish',
          description: exists ? 'Publish the next version' : 'Publish version 1',
          trades: [],
        },
      ],
      build: () =>
        adapter.buildPublishRecipe({
          creator,
          recipe: {
            schemaVersion: 1,
            familyId: p.familyId,
            chain: CHAIN,
            onchainId: null,
            creator,
            kind: 'community',
            version: 1,
            effectiveAt: 0,
            components: draft?.components ?? [],
            metaHash: metaHash({ ...p, kind: 'index' }),
            maxFeeBps: 0,
            flags: 0,
          },
        }),
    });
  }
  const p = world.published.get(String(body.family));
  const read = p && (await recipeAt(p));
  if (!p || !read) throw new ApiRefusal(404, { error: 'no shared portfolio with that slug' });
  const { active } = read;
  if (body.version !== undefined && body.version !== active.version)
    throw new ApiRefusal(409, { error: 'another version is in effect', code: 'VERSION_CHANGED' });
  if (body.type === 'buy') {
    const owner = (body.owner as { solana?: string }).solana ?? '';
    const basketId = basketIdOfPlan(p.familyId);
    const deposit = cashOf(Number(body.amountUsd));
    const trades = tradesFor(targetsOf(active), deposit);
    const vaultOf = async () =>
      (await adapter.getVaults(owner)).find((v) => v.basketId === basketId)?.address ?? '';
    const existing = await vaultOf();
    return doubleFor(owner).place({
      type: 'buy',
      summary: 'Buy a shared portfolio on Solana, following it',
      depositRaw: String(deposit),
      needsConsent: [],
      steps: [
        {
          kind: existing ? 'deposit' : 'create_vault',
          description: 'Open the vault that follows it',
          cashRaw: String(deposit),
          trades: [],
        },
        ...trades.map((t) => ({ kind: 'swap' as const, description: 'Buy', trades: [t] })),
      ],
      build: async (leg) =>
        leg.kind === 'create_vault'
          ? adapter.buildCreateVault({
              owner,
              basketId,
              targets: [],
              recipeOnchainId: active.onchainId ?? '',
              expectedVersion: active.version,
              autoFollow: false,
              depositRaw: String(deposit),
              slippageBps: 100,
            })
          : leg.kind === 'deposit'
            ? adapter.buildDeposit({
                vault: await vaultOf(),
                amountRaw: String(deposit),
                slippageBps: 100,
              })
            : adapter.buildOwnerSwap({
                vault: await vaultOf(),
                trades: leg.trades,
                slippageBps: 100,
              }),
    });
  }
  // a follow by a vault the person has
  const state = await adapter.getVault(String(body.vault));
  if (!state) throw new ApiRefusal(404, { error: 'no vault of yours at that address' });
  const steps: { kind: 'accept_version' | 'set_auto_follow'; description: string; trades: [] }[] =
    [];
  if (state.recipeOnchainId !== active.onchainId || state.acceptedVersion !== active.version)
    steps.push({ kind: 'accept_version', description: 'Follow the version in effect', trades: [] });
  if (body.autoFollow !== state.autoFollow)
    steps.push({ kind: 'set_auto_follow', description: 'Switch auto-follow', trades: [] });
  return doubleFor(state.owner).place({
    type: 'follow',
    summary: 'Follow a shared portfolio with your vault on Solana',
    needsConsent: [
      ...(steps.some((x) => x.kind === 'accept_version') ? (['new_asset'] as const) : []),
      ...(body.autoFollow && steps.some((x) => x.kind === 'set_auto_follow')
        ? (['auto_follow_on'] as const)
        : []),
    ],
    steps,
    build: (leg) =>
      leg.kind === 'accept_version'
        ? adapter.buildAcceptVersion({
            vault: state.address,
            recipeOnchainId: active.onchainId ?? '',
            expectedVersion: active.version,
          })
        : adapter.buildSetAutoFollow({ vault: state.address, on: Boolean(body.autoFollow) }),
  });
}

// A mix from the conversation or the person's own hand (gate ANY-COMPOSITION, #191), as apps/api reads
// it, in its shapes: the review with its figures and warnings, its hash, and on a confirm with every
// warning ticked, the stored plan or the order. Each body is read with the route's own schema and each
// answer written through it, so a shape apps/api would refuse is refused here. MOCK throughout: the
// exit ceiling of every line is a made-up 40% of the amount, so a larger line carries a warning to tick.

type MixBody = Pick<
  ApplyVaultMixRequest,
  'origin' | 'allocations' | 'confirm' | 'acceptedWarnings' | 'reviewHash'
>;
/** A body as the route's schema reads it, or the 400 apps/api answers a body it cannot read. */
function bodyOf<T>(schema: z.ZodType<T>, value: unknown): T {
  const read = schema.safeParse(value);
  if (!read.success) throw new ApiRefusal(400, { error: z.prettifyError(read.error) });
  return read.data;
}
/** The new-goal conversation's answer, as apps/api declares it (routes/v1/goal-conversation-reply.ts). */
const GoalReply = VaultAgentReplyShape.extend({ chain: ChainId }).superRefine(warningsBelong);
const cents = (n: number) => Math.round(n * 100) / 100;

async function mixReview(body: MixBody, amountUsd: number, goal: MixReview['goal']) {
  const { adapter } = world;
  const cash = adapter.mock.cash;
  const listed = new Map((await adapter.listAssets()).map((a) => [a.id, a]));
  const sent = body.allocations;
  const issues = [
    ...sent.filter((l) => !listed.has(l.assetId)).map((l) => `NOT_LISTED:${l.assetId}`),
    ...(sent.reduce((n, l) => n + l.weightBps, 0) !== 10_000 ? ['SUM_NOT_10000'] : []),
    ...(sent.filter((l) => l.assetId !== cash).length > 16 ? ['TOO_MANY_LINES'] : []),
  ];
  if (issues.length)
    throw new ApiRefusal(422, {
      error: 'this mix cannot be bought as it is',
      code: 'MIX_NOT_VALID',
      details: { issues },
    });
  const ordered = [
    ...sent.filter((l) => l.assetId === cash),
    ...sent.filter((l) => l.assetId !== cash),
  ];
  const prices = await adapter.getPrices(ordered.map((l) => l.assetId).filter((id) => id !== cash));
  const warnings: MixReview['warnings'] = [];
  const lines = ordered.map((l) => {
    const asset = listed.get(l.assetId);
    const amount = cents((amountUsd * l.weightBps) / 10_000);
    if (l.assetId === cash)
      return {
        assetId: l.assetId,
        symbol: CASH_SYMBOL,
        cls: 'cash' as const,
        weightBps: l.weightBps,
        amountUsd: amount,
        price: null,
        exitCeiling: null,
      };
    const price = prices.find((p) => p.asset === l.assetId);
    const ceiling = cents(amountUsd * 0.4);
    if (amount > ceiling)
      warnings.push({
        id: `EXIT_OVER_TIER_CEILING:${l.assetId}`,
        code: 'EXIT_OVER_TIER_CEILING',
        assetId: l.assetId,
        text: `Sample: ${asset?.symbol ?? l.assetId} is larger than its tier’s ceiling, and its selling cost isn’t measured.`,
        figures: [{ label: 'Tier ceiling', value: ceiling, unit: 'USD', ...OBSERVED }],
      });
    return {
      assetId: l.assetId,
      symbol: asset?.symbol ?? l.assetId,
      cls: asset?.cls ?? 'stock',
      weightBps: l.weightBps,
      amountUsd: amount,
      price: price ? { usdPerToken: price.usdPerToken, ...OBSERVED } : null,
      exitCeiling: { usd: ceiling, measured: false, ...OBSERVED },
    };
  });
  const targets = sent
    .filter((l) => l.assetId !== cash)
    .map((l) => ({ asset: l.assetId, weightBps: l.weightBps }));
  const cashBps = 10_000 - targets.reduce((n, t) => n + t.weightBps, 0);
  const reviewHash = sha256Hex(
    new TextEncoder().encode(JSON.stringify({ lines, amountUsd, warnings })),
  );
  const accepted = new Set(body.acceptedWarnings ?? []);
  return MixReview.parse({
    chain: CHAIN,
    origin: body.origin,
    goal,
    amountUsd,
    lines,
    targets,
    cashBps,
    warnings,
    unconfirmed: warnings.map((w) => w.id).filter((id) => !accepted.has(id)),
    reviewHash,
    provenance: 'mock',
    disclaimer: DISCLAIMER.en,
  });
}
const confirmed = (body: MixBody, review: MixReview) =>
  body.confirm && body.reviewHash === review.reviewHash && review.unconfirmed.length === 0;

/** The goal conversation's preview: two picks, equal, and what the server did with the weights. */
function goalReply(body: { messageId?: string }) {
  const picks = [`${CHAIN}:spy`, `${CHAIN}:gold`];
  return GoalReply.parse({
    version: 1,
    chain: CHAIN,
    messageId: body.messageId,
    message: 'Sample: a broad fund and gold, split equally. Nothing is bought until you confirm.',
    question: null,
    proposal: {
      objective: 'Sample: grow with a hedge',
      summary: 'Sample: a broad fund and gold.',
      allocations: picks.map((assetId) => ({
        assetId,
        weightBps: 5000,
        why: 'Sample: a reason the stub made up.',
        evidenceIds: [`catalog:${assetId}`],
        symbol: assetId === `${CHAIN}:spy` ? 'SPY' : 'Gold',
      })),
      tradeoffs: ['Sample: a fund and gold can both fall.'],
      unknowns: ['Sample: nothing here is measured.'],
      sources: picks.map((assetId) => ({
        id: `catalog:${assetId}`,
        assetId,
        label: 'Listed on this chain',
        ...OBSERVED,
      })),
    },
    warnings: [],
    weightNotes: [{ code: 'equal_split', assetIds: picks }],
  });
}

async function placeRetarget(address: string, body: MixBody): Promise<ApplyVaultMixResponse> {
  const { adapter } = world;
  const state = await adapter.getVault(address);
  if (!state) throw new ApiRefusal(404, { error: 'no vault of yours at that address' });
  const listed = await adapter.listAssets();
  const prices = await adapter.getPrices([
    ...new Set([...state.positions.map((p) => p.asset), ...body.allocations.map((l) => l.assetId)]),
  ]);
  const value = Number(view(state, prices, listed).valueUsd);
  const review = await mixReview(body, cents(value), null);
  if (!confirmed(body, review)) return { status: 'review', review };
  const plan = rebalancePlan(
    state,
    review.targets,
    prices,
    { bandBps: 0, minTradeUsd: 1, costBps: 100 },
    listed,
  );
  // The sales first, so the purchases find their cash.
  const trades = [...plan.trades].sort(
    (a, b) => Number(b.buy === adapter.mock.cash) - Number(a.buy === adapter.mock.cash),
  );
  const order = await doubleFor(state.owner).place({
    type: 'rebalance',
    summary: 'Sample: give your vault its own targets, then trade to them',
    needsConsent: [],
    steps: [
      { kind: 'set_targets', description: 'Set your vault’s targets', trades: [] },
      ...trades.map((t) => ({
        kind: 'swap' as const,
        description: t.buy === adapter.mock.cash ? 'Sell for cash' : 'Buy',
        trades: [t],
      })),
    ],
    build: (leg) =>
      leg.kind === 'set_targets'
        ? adapter.buildSetTargets({ vault: address, targets: review.targets })
        : adapter.buildOwnerSwap({ vault: address, trades: leg.trades, slippageBps: 100 }),
  });
  return ApplyVaultMixResponse.parse({ status: 'ordered', review, order });
}

/**
 * A route of the portfolio section, answered from the section's sample answers and held to the
 * contract: its status and its body. Null for a path that is none of the four. A limit the contract
 * refuses is answered 400, as the API answers it.
 */
function sectionAnswer(
  path: string,
  query: URLSearchParams,
): { status: number; body: unknown } | null {
  const q = {
    chain: query.get('chain') ?? undefined,
    address: query.get('address') ?? undefined,
  };
  switch (path) {
    case '/v1/portfolio/plans':
      return { status: 200, body: PortfolioPlansResponse.parse(narrowPlans(PLANS, q)) };
    case '/v1/portfolio/exposure':
      return { status: 200, body: PortfolioExposureResponse.parse(narrowExposure(EXPOSURE, q)) };
    case '/v1/portfolio/rebalances': {
      const asked = PortfolioRebalancesQuery.safeParse({ limit: query.get('limit') ?? undefined });
      if (!asked.success)
        return { status: 400, body: { error: 'limit is a whole number from 1 to 200' } };
      const { limit } = asked.data;
      return {
        status: 200,
        body: PortfolioRebalancesResponse.parse(narrowRebalances(REBALANCES, { ...q, limit })),
      };
    }
    case '/v1/portfolio/history':
      return { status: 200, body: PortfolioHistoryResponse.parse(narrowHistory(HISTORY, q)) };
    default:
      return null;
  }
}

/** A vault as the public page reads it: what GET /v1/vaults/{chain}/{address} answers. */
async function vaultView(address: string) {
  const state = await world.adapter.getVault(address);
  if (!state) return null;
  const listed = await world.adapter.listAssets();
  const ids = [state.cash.asset, ...state.positions.map((p) => p.asset)];
  const prices = await world.adapter.getPrices([...new Set(ids)]);
  return { vault: { ...view(state, prices, listed), provenance: 'mock' as const }, prices };
}

const read = (req: IncomingMessage) =>
  new Promise<unknown>((done) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      try {
        done(text ? JSON.parse(text) : undefined);
      } catch {
        done(undefined);
      }
    });
  });

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors() });
  res.end(JSON.stringify(body));
}
const cors = () => ({
  'access-control-allow-origin': ORIGIN,
  'access-control-allow-headers': 'content-type, authorization, privy-id-token',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
});

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (method === 'OPTIONS') {
    res.writeHead(204, cors());
    res.end();
    return;
  }
  if (path === '/__stub/reset' && method === 'POST') {
    mixTargets = null;
    world = freshWorld();
    tamperNext = false;
    testNetwork = false;
    reports = [];
    linked = null;
    built = null;
    return send(res, 200, { ok: true });
  }
  if (path === '/__stub/reports') return send(res, 200, reports);
  if (path === '/__stub/source-vault' && method === 'POST') {
    // An already-owned private vault fixture, not an order or production endpoint. Publication and
    // follower buys below still build, guard and sign every step through the browser executor.
    const body = (await read(req)) as { owner: string; targets: unknown };
    const targets = Target.array().parse(body.targets);
    const owner = body.owner;
    const { adapter } = world;
    const listed = new Set((await adapter.listAssets()).map((a) => a.id));
    if (
      !owner ||
      targets.length === 0 ||
      new Set(targets.map((t) => t.asset)).size !== targets.length ||
      targets.some((t) => !listed.has(t.asset)) ||
      targets.reduce((n, t) => n + t.weightBps, 0) !== 10_000
    )
      return send(res, 422, { error: 'an owned source needs exact listed targets' });
    lastWallet = owner;
    const basketId = '700';
    const depositRaw = '100000000';
    adapter.mock.fund(owner, { gasRaw: GAS_FAUCET, assets: { [adapter.mock.cash]: depositRaw } });
    const trades = targets.map((t) => ({
      sell: adapter.mock.cash,
      buy: t.asset,
      amountInRaw: String(t.weightBps * 10_000),
    }));
    if (adapter.capabilities.needsApprove)
      await adapter.mock.send(
        await adapter.buildApprove({ owner, basketId, amountRaw: depositRaw }),
      );
    await adapter.mock.send(
      await adapter.buildCreateVault({
        owner,
        basketId,
        targets,
        autoFollow: false,
        depositRaw,
        slippageBps: 50,
        ...(adapter.capabilities.tradesInCreate ? { trades } : {}),
      }),
    );
    const source = (await adapter.getVaults(owner)).find((v) => v.basketId === basketId);
    if (!source) return send(res, 500, { error: 'source fixture was not created' });
    if (!adapter.capabilities.tradesInCreate)
      for (const trade of trades)
        await adapter.mock.send(
          await adapter.buildOwnerSwap({
            vault: source.address,
            trades: [trade],
            slippageBps: 50,
          }),
        );
    return send(res, 200, { address: source.address });
  }
  if (path.startsWith('/risk/') && method === 'GET') {
    const answer = riskAnswer(`${path}${url.search}`);
    return send(res, answer.status, answer.body);
  }
  if (path === '/__stub/test-network' && method === 'POST') {
    testNetwork = true;
    return send(res, 200, { ok: true });
  }
  if (path === '/__stub/tamper' && method === 'POST') {
    tamperNext = true;
    return send(res, 200, { ok: true });
  }
  if (path === '/v1/config') return send(res, 200, config());
  if (path === '/goals' && method === 'POST')
    return send(res, 200, {
      goalId: '0b9a8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
      sheet: null,
      candidate: {
        language: 'en',
        currency: 'BRL',
        target: { kind: 'balance', amountBrl: null, byMonth: '2029-10' },
        profile: 'accumulation',
        horizonMonths: 36,
        liquidityWindowDays: 90,
        riskBudget: 'medium',
        creditTolerance: 'limited',
        fxStance: 'hedge_near_term',
      },
      validationErrors: [],
      parser: { method: 'rules' },
      disclaimer: 'MOCK',
    });
  // A plan an agent proposes for a person (AGT-2): no sign-in, the same plan, read back by its id.
  if (path === '/v1/baskets/propose' && method === 'POST') {
    const body = (await read(req)) as { sheet: BasketSheet };
    linked = proposal(body.sheet);
    return send(res, 200, { id: PLAN_ID, proposal: linked, rollUp: ROLL_UP });
  }
  if (path.startsWith('/v1/baskets/') && method === 'GET') {
    if (path !== `/v1/baskets/${PLAN_ID}` || !(linked || built))
      return send(res, 404, { error: 'no plan with that id that you can read' });
    return linked
      ? send(res, 200, { id: PLAN_ID, proposal: linked, fromLink: true })
      : send(res, 200, { id: PLAN_ID, proposal: built, fromLink: false });
  }
  if (path === '/v1/baskets/personalize' && method === 'POST') {
    const body = (await read(req)) as { sheet: BasketSheet };
    built = proposal(body.sheet);
    return send(res, 200, { id: PLAN_ID, proposal: built });
  }
  if (path === `/v1/conversations/${CHAIN}/goal/reply` && method === 'POST')
    return send(res, 200, goalReply((await read(req)) as { messageId?: string }));
  if (path === `/v1/conversations/${CHAIN}/goal/accept` && method === 'POST') {
    const body = bodyOf(AcceptGoalMixRequest, await read(req));
    const review = await mixReview(body, body.amountUsd, body.goal);
    if (!confirmed(body, review)) return send(res, 200, { status: 'review', review });
    const sheet: BasketSheet = {
      basketType: 'standard',
      goal: body.goal,
      amountUsd: body.amountUsd,
      horizonMonths: body.horizonMonths ?? 120,
      ...(body.horizonMonths ? {} : { horizonOpen: true }),
      risk: body.risk,
      themes: [],
      chains: [CHAIN],
      rules: { useHoldings: false, glide: false },
      language: body.language,
    } as BasketSheet;
    mixTargets = review.targets;
    built = proposal(sheet, review.targets);
    linked = null;
    // The buy's double holds the order to the plan's weights: made again for this plan's.
    world.double = undefined;
    return send(
      res,
      200,
      AcceptGoalMixResponse.parse({
        status: 'stored',
        review,
        proposalId: PLAN_ID,
        proposal: built,
      }),
    );
  }
  const targets = /^\/v1\/vaults\/([^/]+)\/([^/]+)\/targets$/.exec(path);
  if (targets && method === 'POST') {
    if (targets[1] !== CHAIN) return send(res, 404, { error: 'no vault of yours at that address' });
    return send(
      res,
      200,
      await placeRetarget(
        decodeURIComponent(targets[2] ?? ''),
        bodyOf(ApplyVaultMixRequest, await read(req)),
      ),
    );
  }
  if (path === '/v1/mock/fund' && method === 'POST') {
    const body = (await read(req)) as { cashUsd: number };
    const owner = world.double?.owner ?? lastWallet;
    for (const who of [owner, lastWallet].filter((x): x is string => Boolean(x)))
      world.adapter.mock.fund(who, {
        gasRaw: GAS_FAUCET,
        assets: { [world.adapter.mock.cash]: String(Math.round(body.cashUsd * 1_000_000)) },
      });
    return send(res, 200, { chain: CHAIN, provenance: 'mock', wallets: [] });
  }
  if (path === '/v1/testnet/fund' && method === 'POST') {
    if (!testNetwork) return send(res, 404, { error: 'this server sends no test funds' });
    const body = (await read(req)) as { amountUsd: number; wallet: string };
    const need = {
      cashRaw: String(Math.round(body.amountUsd * 1_000_000)),
      legs: 4,
      newVault: true,
    };
    const f = await world.adapter.funding(body.wallet, need);
    // What is missing, with the API's margins: 1% of cash, 25% of gas.
    const short = (n: string, h: string) => (BigInt(n) > BigInt(h) ? BigInt(n) - BigInt(h) : 0n);
    const cash = short(f.cashNeedRaw, f.cashHaveRaw);
    const gas = short(f.gasNeedRaw, f.gasHaveRaw);
    const cashRaw = cash + (cash + 99n) / 100n;
    const gasRaw = gas + (gas + 3n) / 4n;
    world.adapter.mock.fund(body.wallet, {
      gasRaw: gasRaw.toString(),
      assets: { [world.adapter.mock.cash]: cashRaw.toString() },
    });
    return send(res, 200, {
      chain: CHAIN,
      provenance: 'sandbox',
      wallet: body.wallet,
      cash: { symbol: 'USDC', decimals: 6, raw: cashRaw.toString() },
      gas: { ...GAS, raw: gasRaw.toString() },
      txIds: ['stub-test-network-tx'],
      left: 2,
    });
  }
  if (path === '/v1/funding') {
    const wallet = url.searchParams.get('wallet') ?? '';
    lastWallet = wallet;
    const usd = Number(url.searchParams.get('amountUsd') ?? 0);
    const need = { cashRaw: String(Math.round(usd * 1_000_000)), legs: 4, newVault: true };
    const f = await world.adapter.funding(wallet, need);
    const missing = (n: string, h: string) =>
      String(BigInt(n) > BigInt(h) ? BigInt(n) - BigInt(h) : 0n);
    const provenance = testNetwork ? 'sandbox' : 'mock';
    const stamp = {
      source: testNetwork ? 'the stub, as a test network' : 'the mock chain',
      fetchedAt: new Date().toISOString(),
      provenance,
    };
    return send(res, 200, {
      chain: CHAIN,
      name: CHAIN_NAME,
      mode: testNetwork ? 'live' : 'mock',
      provenance,
      ...(testNetwork ? { testFunds: true } : {}),
      wallet,
      cash: {
        ...stamp,
        method: testNetwork
          ? 'the wallet’s balance, read by the stub as a test network'
          : 'sample: the wallet’s balance on the mock chain',
        asset: world.adapter.mock.cash,
        symbol: CASH_SYMBOL,
        decimals: 6,
        haveRaw: f.cashHaveRaw,
        needRaw: f.cashNeedRaw,
        missingRaw: missing(f.cashNeedRaw, f.cashHaveRaw),
      },
      gas: {
        ...stamp,
        method: testNetwork
          ? 'the wallet’s gas, read by the stub as a test network'
          : 'sample: the wallet’s gas on the mock chain',
        ...GAS,
        haveRaw: f.gasHaveRaw,
        needRaw: f.gasNeedRaw,
        missingRaw: missing(f.gasNeedRaw, f.gasHaveRaw),
      },
      steps: 4,
      newVault: true,
      ok: f.ok,
    });
  }
  if (path.startsWith('/v1/portfolio/') && method === 'GET') {
    const answer = sectionAnswer(path, url.searchParams);
    if (answer) return send(res, answer.status, answer.body);
  }
  if (path === '/v1/portfolio') {
    // The vaults of the wallet that bought here, valued where apps/api values them (packages/basket),
    // in the shape of its route.
    const owner = world.double?.owner ?? lastWallet;
    const { adapter } = world;
    const states = owner ? await adapter.getVaults(owner) : [];
    const listed = states.length ? await adapter.listAssets() : [];
    const known = new Set(listed.map((a) => a.id));
    const held = states.flatMap((v) => [v.cash.asset, ...v.positions.map((p) => p.asset)]);
    const ids = [...new Set(held)].filter((id) => known.has(id));
    const prices = ids.length ? await adapter.getPrices(ids) : [];
    const vaults = states.map((v) => ({ ...view(v, prices, listed), provenance: 'mock' }));
    return send(res, 200, {
      chains: [
        { chain: CHAIN, name: CHAIN_NAME, mode: 'mock', provenance: 'mock', vaults, prices },
      ],
      disclaimer: 'MOCK',
    });
  }
  if (path === '/v1/orders' && method === 'POST') {
    const body = (await read(req)) as Body & { owner?: unknown; amountUsd: number };
    if (body.type !== 'buy' || body.family !== undefined)
      return send(res, 200, await placeShared(body));
    const owner = ownerIn(body.owner);
    if (!owner) return send(res, 422, { error: 'a buy names its owner' });
    return send(res, 200, await doubleFor(owner).buy(body.amountUsd));
  }
  if (path === '/v1/shelf') {
    const families = [];
    for (const p of world.published.values()) {
      const family = await familyOf(p);
      if (family)
        families.push({
          ...family,
          recipes: family.recipes.map((r) => ({ ...r, source: 'cache' })),
        });
    }
    return send(res, 200, { families, disclaimer: DISCLAIMER.en });
  }
  const shared = /^\/v1\/indexes\/([^/]+)(\/versions)?$/.exec(path);
  if (shared) {
    const p = world.published.get(decodeURIComponent(shared[1] ?? ''));
    const family = p ? await familyOf(p) : null;
    if (!family) return send(res, 404, { error: 'no shared portfolio with that slug' });
    if (!shared[2]) return send(res, 200, { family, disclaimer: DISCLAIMER.en });
    const [recipe] = family.recipes;
    const seen = world.versions.get(recipe?.onchainId ?? '');
    return send(res, 200, {
      familyId: family.familyId,
      slug: family.slug,
      chains: recipe
        ? [
            {
              chain: CHAIN,
              onchainId: recipe.onchainId,
              source: 'chain',
              observedAt: recipe.observedAt,
              provenance: 'mock',
              versions: [...(seen?.values() ?? [])].sort((a, b) => b.version - a.version),
            },
          ]
        : [],
    });
  }
  const vault = /^\/v1\/vaults\/([^/]+)\/([^/]+)$/.exec(path);
  if (vault) {
    const read = vault[1] === CHAIN ? await vaultView(decodeURIComponent(vault[2] ?? '')) : null;
    if (!read) return send(res, 404, { error: 'no vault at that address' });
    return send(res, 200, {
      chain: CHAIN,
      name: 'Solana',
      mode: 'mock',
      provenance: 'mock',
      ...read,
      disclaimer: DISCLAIMER.en,
    });
  }
  const order = /^\/v1\/orders\/([^/]+)$/.exec(path);
  const leg = /^\/v1\/orders\/([^/]+)\/legs\/([^/]+)\/(build|report|cancel)$/.exec(path);
  const api = world.double?.api;
  if ((order || leg) && !api) return send(res, 404, { error: 'no order with that id' });
  if (order && api) return send(res, 200, await api.getOrder(order[1] as string));
  if (leg && api) {
    const [, id, legId, step] = leg as unknown as [string, string, string, string];
    if (step === 'build') {
      const built = await api.buildLeg(id, legId);
      const swapping = built.tx.preview.minimums.length > 0;
      if (tamperNext && swapping) {
        tamperNext = false;
        // The bytes and the attempt agree with each other: only the minimum is not the order's.
        built.tx = tampered(built.tx, (m) => {
          m.mins = m.mins.map(() => '1');
        });
        built.attempt = { ...built.attempt, messageHash: built.tx.messageHash };
      }
      return send(res, 200, built);
    }
    if (step === 'report') {
      reports.push(legId);
      return send(res, 200, await api.reportLeg(id, legId, (await read(req)) as never));
    }
    return send(res, 200, await api.cancelLeg(id, legId));
  }
  return send(res, 404, { error: 'Route not found' });
}
let lastWallet: string | null = null;

createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    if (e instanceof ApiRefusal) return send(res, e.status, e.body);
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
}).listen(PORT, () => {
  console.log(`e2e stub API on http://localhost:${PORT}, for ${ORIGIN}`);
});
