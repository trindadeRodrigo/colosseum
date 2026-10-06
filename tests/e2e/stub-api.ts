import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { view } from '@colosseum/basket';
import { createMockAdapter, type MockAdapter, mockAddress } from '@colosseum/chain-mock';
import {
  type BasketSheet,
  ConfigResponse,
  chainProvenance,
  DEFAULT_FLAGS,
  type OrderDetail,
  parseChainConfigs,
  type Target,
} from '@colosseum/schemas';
import { ApiRefusal, basketIdOfPlan, deploymentsOf, type OrderApi } from '@colosseum/sdk';
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
// Three routes of its own, for the spec: POST /__stub/reset forgets everything, GET /__stub/reports
// lists the steps the web reported as signed, and POST
// /__stub/tamper makes the next swap it builds carry a lower minimum than the order states, as a
// server that lies would. MOCK throughout: every figure says so. The /risk routes are the one
// exception: they answer from Rodrigo's recording of the risk API (stub-risk.ts), measured and old.

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

type World = {
  adapter: MockAdapter;
  double?: { owner: string; api: OrderApi; buy: (usd: number) => Promise<OrderDetail> };
};
let world: World = { adapter: createMockAdapter({ chain: CHAIN }) };
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
  const made = apiDouble(w, { basketId: basketIdOfPlan(PLAN_ID), targets: WEIGHTS });
  world.double = { owner, api: made.api, buy: made.buy };
  return world.double;
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
    world = { adapter: createMockAdapter({ chain: CHAIN }) };
    tamperNext = false;
    reports = [];
    return send(res, 200, { ok: true });
  }
  if (path === '/__stub/reports') return send(res, 200, reports);
  if (path.startsWith('/risk/') && method === 'GET') {
    const answer = riskAnswer(`${path}${url.search}`);
    return send(res, answer.status, answer.body);
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
  if (path === '/v1/baskets/personalize' && method === 'POST') {
    const body = (await read(req)) as { sheet: BasketSheet };
    return send(res, 200, { id: PLAN_ID, proposal: proposal(body.sheet) });
  }
  if (path === '/v1/mock/fund' && method === 'POST') {
    const body = (await read(req)) as { cashUsd: number };
    const owner = world.double?.owner ?? url.searchParams.get('wallet');
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
    const body = (await read(req)) as { owner: { solana?: string }; amountUsd: number };
    const owner = body.owner.solana;
    if (!owner) return send(res, 422, { error: 'a buy names its owner' });
    return send(res, 200, await doubleFor(owner).buy(body.amountUsd));
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
