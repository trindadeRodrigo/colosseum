import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { familyIdOf, metaHash, view } from '@colosseum/basket';
import {
  createMockAdapter,
  type MockAdapter,
  mockAddress,
  mockRecipeId,
} from '@colosseum/chain-mock';
import {
  type BasketSheet,
  ChainError,
  ConfigResponse,
  chainProvenance,
  DEFAULT_FLAGS,
  DISCLAIMER,
  type OrderDetail,
  parseChainConfigs,
  type Recipe,
  type RecipeVersionView,
  type SharedFamily,
  type Target,
} from '@colosseum/schemas';
import { ApiRefusal, basketIdOfPlan, deploymentsOf, type OrderApi } from '@colosseum/sdk';
import { apiDouble } from '../../packages/sdk/test/api-double';
import { type MockWorld, tampered } from '../../packages/sdk/test/mock';

// The API the end-to-end spec of the web app runs against (apps/web/e2e): a stub over HTTP, on the
// mock chain. It answers the routes the goal, plan, buy and order screens call, in their shared shapes.
// The order routes are the SDK's own double of them (packages/sdk/test/api-double.ts) on a chain of
// packages/chain-mock, so the screen's executor builds, checks with the real guard, signs with the
// throwaway wallet and reports, step by step, as it would against apps/api. It is not apps/api: the
// throwaway wallet has no sign-in, and apps/api answers an order route only to one.
//
//   tsx tests/e2e/stub-api.ts            STUB_API_PORT (3901), WEB_ORIGIN (http://localhost:3100)
//
// Three routes of its own, for the spec: POST /__stub/reset forgets everything, GET /__stub/reports
// lists the steps the web reported as signed, and POST
// /__stub/tamper makes the next swap it builds carry a lower minimum than the order states, as a
// server that lies would. MOCK throughout: every figure says so.

const PORT = Number(process.env.STUB_API_PORT ?? 3901);
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3100';
const CHAIN = 'solana' as const;
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
/** The steps the web reported signed bytes or an id for, in order. */
let reports: string[] = [];

const OBSERVED = {
  source: 'the e2e stub',
  method: 'MOCK: made up for the end-to-end spec',
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

function proposal(sheet: BasketSheet) {
  const cash = world.adapter.mock.cash;
  const lines = [
    ...WEIGHTS.map((t) => ({
      chain: CHAIN,
      assetId: t.asset,
      weightBps: t.weightBps,
      amountUsd: (sheet.amountUsd * t.weightBps) / 10_000,
      reasons: [{ rule: 'stub', inputs: [], params: {}, text: 'MOCK: a reason the stub made up.' }],
    })),
    { chain: CHAIN, assetId: cash, weightBps: 500, amountUsd: sheet.amountUsd / 20, reasons: [] },
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
        components: WEIGHTS.map((t) => ({ kind: 'asset', asset: t.asset, weightBps: t.weightBps })),
      },
    ],
    removed: [],
    card: {
      moneyTodayUsd: sheet.amountUsd,
      termMonths: sheet.horizonMonths,
      cashFlow: 'none',
      expectedReturn: { lowPct: 0, highPct: 0, basis: 'MOCK', lossInFallUsd: 0 },
      exit: { text: 'MOCK: up to the whole amount within a day', costBps: 25 },
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
  adapter.mock.fund(owner, { gasRaw: '1000000000' });
  const made = apiDouble(w, { basketId: basketIdOfPlan(PLAN_ID), targets: WEIGHTS });
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

/** POST /v1/orders for a publish, a buy of a shared portfolio, or a follow. */
async function placeShared(body: Body): Promise<OrderDetail> {
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
    world = freshWorld();
    tamperNext = false;
    reports = [];
    return send(res, 200, { ok: true });
  }
  if (path === '/__stub/reports') return send(res, 200, reports);
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
  if (path === '/v1/baskets/personalize' && method === 'POST') {
    const body = (await read(req)) as { sheet: BasketSheet };
    return send(res, 200, { id: PLAN_ID, proposal: proposal(body.sheet) });
  }
  if (path === '/v1/mock/fund' && method === 'POST') {
    const body = (await read(req)) as { cashUsd: number };
    const owner = world.double?.owner ?? lastWallet;
    for (const who of [owner, lastWallet].filter((x): x is string => Boolean(x)))
      world.adapter.mock.fund(who, {
        gasRaw: '1000000000',
        assets: { [world.adapter.mock.cash]: String(Math.round(body.cashUsd * 1_000_000)) },
      });
    return send(res, 200, { chain: CHAIN, provenance: 'mock', wallets: [] });
  }
  if (path === '/v1/funding') {
    const wallet = url.searchParams.get('wallet') ?? '';
    lastWallet = wallet;
    const usd = Number(url.searchParams.get('amountUsd') ?? 0);
    const need = { cashRaw: String(Math.round(usd * 1_000_000)), legs: 4, newVault: true };
    const f = await world.adapter.funding(wallet, need);
    const missing = (n: string, h: string) =>
      String(BigInt(n) > BigInt(h) ? BigInt(n) - BigInt(h) : 0n);
    const stamp = {
      source: 'the mock chain',
      fetchedAt: new Date().toISOString(),
      provenance: 'mock',
    };
    return send(res, 200, {
      chain: CHAIN,
      name: 'Solana',
      mode: 'mock',
      provenance: 'mock',
      wallet,
      cash: {
        ...stamp,
        method: 'MOCK: the wallet’s balance on the mock chain',
        asset: world.adapter.mock.cash,
        symbol: 'USDC',
        decimals: 6,
        haveRaw: f.cashHaveRaw,
        needRaw: f.cashNeedRaw,
        missingRaw: missing(f.cashNeedRaw, f.cashHaveRaw),
      },
      gas: {
        ...stamp,
        method: 'MOCK: the wallet’s gas on the mock chain',
        symbol: 'SOL',
        decimals: 9,
        haveRaw: f.gasHaveRaw,
        needRaw: f.gasNeedRaw,
        missingRaw: missing(f.gasNeedRaw, f.gasHaveRaw),
      },
      steps: 4,
      newVault: true,
      ok: f.ok,
    });
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
      chains: [{ chain: CHAIN, name: 'Solana', mode: 'mock', provenance: 'mock', vaults, prices }],
      disclaimer: 'MOCK',
    });
  }
  if (path === '/v1/orders' && method === 'POST') {
    const body = (await read(req)) as Body & { owner?: { solana?: string }; amountUsd: number };
    if (body.type !== 'buy' || body.family !== undefined)
      return send(res, 200, await placeShared(body));
    const owner = body.owner?.solana;
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
