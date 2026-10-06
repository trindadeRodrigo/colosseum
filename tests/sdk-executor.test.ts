import type { BasketTx, ChainId, OrderDetail, Target } from '@colosseum/schemas';
import {
  type ApiFetch,
  basketIdOfLinkedPlan,
  basketIdOfPlan,
  createOrderApi,
  deploymentsOf,
  type ExecutorDeps,
  execute,
  type OrderApi,
  type PlanTerms,
} from '@colosseum/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../apps/api/src/orders/chains';
import { basketIdOf, basketIdOfLinked } from '../apps/api/src/orders/prepare';
import { orderFlow } from '../apps/api/src/testing/flow';
import {
  type HomeChain,
  type Person,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../apps/api/src/testing/harness';
import { tampered } from '../packages/sdk/test/mock';

// AGT-1: the order executor of packages/sdk against the real route handlers of apps/api, over HTTP, on
// the mock chain and the real database. The executor's own tests (packages/sdk/src/executor) run it
// against a double of these routes; this is the same machine on the routes themselves, so the two
// cannot drift apart unseen.

vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];
/** A plan that keeps a twentieth in cash, so the trades spend less than the deposit. */
const WEIGHTS = { spy: 5000, nvda: 3000, gold: 1500 };

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: Awaited<ReturnType<typeof testApp>>['app'];
let registry: ChainRegistry;
let plans: Record<HomeChain, string>;
/** The clock of the server and of its mock chains. Time passes when the executor waits. */
let clock = Date.now();
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('sdk');
  data = await testDb();
  undo.push(() => data.cleanUp());
  plans = {
    solana: await data.storePlan(planFixture('solana', WEIGHTS)),
    robinhood: await data.storePlan(planFixture('robinhood', WEIGHTS)),
  };
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    now: () => new Date(clock),
  }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { fund, order } = orderFlow({ app: () => app, registry: () => registry, plans: () => plans });

/** The API over HTTP as a signed-in person reaches it: the SDK's own client on the app's routes. */
const fetchAs =
  (who: Person): ApiFetch =>
  async (path, init) => {
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: path,
      headers: { ...who.headers, ...init?.headers },
      ...(init?.body === undefined ? {} : { payload: init.body }),
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => res.json(),
    };
  };

const targetsOf = (chain: ChainId): Target[] =>
  Object.entries(WEIGHTS).map(([slug, weightBps]) => ({ asset: `${chain}:${slug}`, weightBps }));

type Scene = {
  who: Person;
  chain: HomeChain;
  owner: string;
  api: OrderApi;
  asked: BasketTx[];
  deps: ExecutorDeps;
};

/** A person with a funded wallet on their chain, and everything the executor is handed for them. */
async function scene(chain: HomeChain): Promise<Scene> {
  const who = data.track(await person(issuer, chain));
  await fund(who);
  const mock = registry.get(chain).mock;
  if (!mock) throw new Error('not on the mock');
  const api = createOrderApi(fetchAs(who));
  const asked: BasketTx[] = [];
  const plan: PlanTerms = {
    basketId: basketIdOfPlan(plans[chain]),
    targets: targetsOf(chain),
    autoFollow: false,
  };
  return {
    who,
    chain,
    owner: chain === 'solana' ? who.solana : who.evm,
    api,
    asked,
    deps: {
      api,
      // A wallet made in the app: it signs what it is handed and gives the bytes back.
      signer: {
        active: () => ({ address: chain === 'solana' ? who.solana : who.evm }),
        caps: () => ({ signOnly: true }),
        sign: async (_chain, txs) => {
          asked.push(...txs);
          return txs.map((tx) => mock.sign(tx));
        },
        send: async () => {
          throw new Error('this wallet signs and hands the bytes back');
        },
      },
      deployments: deploymentsOf('mock'),
      plan,
      signed: new Map(),
      sleep: async (ms) => {
        clock += ms;
      },
    },
  };
}

const vaultOf = async (s: Scene) =>
  (await registry.get(s.chain).adapter.getVaults(s.owner)).find(
    (v) => v.basketId === s.deps.plan.basketId,
  );

describe("the SDK's rule for a plan's number", () => {
  it("is the API's own", () => {
    for (const id of [...Object.values(plans), 'A1B2C3D4-0000-4000-8000-000000000000'])
      expect(basketIdOfPlan(id)).toBe(basketIdOf(id));
  });

  it("is the API's own for a plan made from a link, and differs for each buyer and from the plan's", () => {
    const id = 'A1B2C3D4-0000-4000-8000-000000000000';
    for (const user of ['did:privy:alice', 'did:privy:bob', 'test:5Hx9a1b2'])
      expect(basketIdOfLinkedPlan(id, user)).toBe(basketIdOfLinked(id, user));
    const numbers = new Set([
      basketIdOfPlan(id),
      basketIdOfLinkedPlan(id, 'did:privy:alice'),
      basketIdOfLinkedPlan(id, 'did:privy:bob'),
    ]);
    expect(numbers.size).toBe(3);
  });
});

describe('the executor on the real order routes: a buy walked to its end', () => {
  for (const chain of CHAINS)
    it(`on ${chain}: every step is built, checked, signed and reported, and the vault holds the plan`, async () => {
      const s = await scene(chain);
      const placed = await order(s.who);
      expect(placed.depositRaw).toBe('1000000000');

      const result = await execute(placed, s.deps);
      expect(result.status).toBe('done');
      expect(result.order.status).toBe('done');
      expect(result.order.legs.every((l) => l.status === 'confirmed')).toBe(true);
      // One signature per step, each for that step.
      expect(s.asked.map((tx) => tx.legId)).toEqual(placed.legs.map((l) => l.id));
      const vault = await vaultOf(s);
      expect(vault?.owner).toBe(s.owner);
      // The plan keeps 5% of the 1,000 deposited in cash.
      expect(vault?.cash.raw).toBe('50000000');
      expect(vault?.positions.map((p) => p.asset).sort()).toEqual(
        Object.keys(WEIGHTS)
          .map((slug) => `${chain}:${slug}`)
          .sort(),
      );

      // A second buy of the plan deposits into the vault that is there.
      const again = await order(s.who, { amountUsd: 200 });
      expect(again.legs.map((l) => l.kind)).toContain('deposit');
      expect((await execute(again, s.deps)).status).toBe('done');
      expect((await vaultOf(s))?.cash.raw).toBe('60000000');
    });
});

describe('the executor on the real order routes: a server that lies at one step', () => {
  /** The real API, except that one step's transaction is another than the one it built. */
  const lying = (s: Scene, legId: string, change: Parameters<typeof tampered>[1]): OrderApi => ({
    ...s.api,
    async buildLeg(orderId, id) {
      const built = await s.api.buildLeg(orderId, id);
      if (id !== legId) return built;
      const tx = tampered(built.tx, change);
      return { tx, attempt: { ...built.attempt, messageHash: tx.messageHash } };
    },
  });

  const lies: [string, HomeChain, number, string, Parameters<typeof tampered>[1]][] = [
    [
      'an approval of another spender',
      'robinhood',
      0,
      'spender',
      (m) => {
        m.op.a.spender = `0x${'66'.repeat(20)}`;
      },
    ],
    [
      'a create that deposits more',
      'robinhood',
      1,
      'amount',
      (m) => {
        m.op.a.depositRaw = '2000000000';
      },
    ],
    [
      'a create with a lower minimum on its trades',
      'robinhood',
      1,
      'minimum',
      (m) => {
        m.mins = m.mins.map(() => '1');
      },
    ],
    [
      'a create with other targets',
      'solana',
      0,
      'targets',
      (m) => {
        m.op.a.targets = [{ asset: 'solana:tsla', weightBps: 10_000 }];
      },
    ],
    [
      'a trade that buys another token',
      'solana',
      1,
      'asset',
      (m) => {
        (m.op.a.trades as [{ buy: string }])[0].buy = 'solana:tsla';
      },
    ],
    [
      'a trade with a lower minimum',
      'solana',
      3,
      'minimum',
      (m) => {
        m.mins = ['1'];
      },
    ],
  ];
  for (const [name, chain, at, code, change] of lies)
    it(`${chain}, step ${at + 1}: ${name} is refused, and nothing is signed for it`, async () => {
      const s = await scene(chain);
      const placed = await order(s.who);
      const leg = placed.legs[at];
      if (!leg) throw new Error('no such step');
      const result = await execute(placed, { ...s.deps, api: lying(s, leg.id, change) });
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') return;
      expect(result.refusal.code, result.refusal.message).toBe(code);
      expect(result.legId).toBe(leg.id);
      // The steps before it are done; this one never reached the wallet, and none after was built.
      expect(s.asked.map((tx) => tx.legId)).toEqual(placed.legs.slice(0, at).map((l) => l.id));
      const stands = await s.api.getOrder(placed.id);
      expect(stands.legs.map((l) => l.status === 'confirmed')).toEqual(
        placed.legs.map((_, i) => i < at),
      );
      expect(stands.legs.slice(at + 1).every((l) => l.status === 'planned')).toBe(true);
    });
});

describe('the executor on the real order routes: picking an order up again', () => {
  for (const chain of CHAINS)
    it(`on ${chain}: a step built and never signed is closed and built again`, async () => {
      const s = await scene(chain);
      const placed = await order(s.who);
      const first = placed.legs[0]?.id as string;
      // The page built the step and was closed before the wallet was asked.
      const lost = await s.api.buildLeg(placed.id, first);
      const result = await execute(placed, s.deps);
      expect(result.status).toBe('done');
      expect(s.asked.some((tx) => tx.attemptId === lost.tx.attemptId)).toBe(false);
      const attempts = result.order.attempts.filter((a) => a.legId === first);
      expect(attempts.map((a) => a.status)).toEqual(['expired', 'confirmed']);
    });

  it('a second order of the same wallet on an EVM chain waits for the first one: blocked', async () => {
    const s = await scene('robinhood');
    // The vault is open, so both orders are an approval and a deposit.
    expect((await execute(await order(s.who, { amountUsd: 100 }), s.deps)).status).toBe('done');
    s.asked.length = 0;
    const one = await order(s.who, { amountUsd: 100 });
    const two = await order(s.who, { amountUsd: 100 });
    const open = one.legs[0]?.id as string;
    await s.api.buildLeg(one.id, open);
    const result = await execute(two, s.deps);
    expect(result).toMatchObject({
      status: 'blocked',
      legId: two.legs[0]?.id,
      blocking: { orderId: one.id, legId: open },
    });
    expect(s.asked).toEqual([]);
    // The first order is run to its end, and then the second goes through.
    expect((await execute(one, s.deps)).status).toBe('done');
    expect((await execute(two, s.deps)).status).toBe('done');
  });

  it('an order nobody signed in time is expired, and nothing is signed for it', async () => {
    const s = await scene('solana');
    const placed: OrderDetail = await order(s.who);
    clock += 16 * 60 * 1000;
    const result = await execute(placed, s.deps);
    expect(result.status).toBe('expired');
    expect(s.asked).toEqual([]);
  });
});
