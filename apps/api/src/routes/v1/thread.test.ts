import { planTurns, proposals } from '@colosseum/db';
import {
  type BasketSheet,
  OrderDetail,
  OrderError,
  PortfolioResponse,
  THREAD_LIMITS,
  ThreadResponse,
  ThreadStart,
  ThreadTurnResponse,
  YieldObservation,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { attachThread } from '../../orders/thread';
import { bearingPlanInputs } from '../../plan-inputs';
import { LIMITS } from '../../plugins/limits';
import mockYields from '../../testing/fixtures/mock-yields.json';
import { orderFlow } from '../../testing/flow';
import { person, type TestIssuer, testApp, testDb, testIssuer } from '../../testing/harness';
import { PersonalizeResponse } from './baskets';

// A plan's thread (gate PLAN-THREAD): the person's own, read and added to by them alone; the app's
// replies as keys and facts; and what happened to the plan, written by the server as orders change
// state. On the mock chain and the real database, over HTTP.

vi.setConfig({ testTimeout: 90_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
const undo: (() => Promise<unknown>)[] = [];
const withMockYield: PlanInputs = async (q) => ({
  ...(await bearingPlanInputs(q)),
  yields: YieldObservation.array()
    .parse(mockYields)
    .filter((y) => q.assets.some((a) => a.id === y.assetId)),
});

beforeAll(async () => {
  issuer = await testIssuer('thread');
  data = await testDb();
  undo.push(() => data.cleanUp());
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    env: { AGENT_SURFACE: 'on' },
    planInputs: withMockYield,
  }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { post, get, fund, order, settleAll, build, land, report } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => ({ solana: '', robinhood: '' }),
});

const sheet = (over: Partial<BasketSheet> = {}): BasketSheet => ({
  basketType: 'standard',
  goal: 'grow',
  amountUsd: 6_100,
  horizonMonths: 60,
  risk: 'high',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
  ...over,
});
const someone = async () => data.track(await person(issuer, 'solana'));
type Person = Awaited<ReturnType<typeof someone>>;
const make = async (who: Person, amountUsd: number, more: object = {}, on?: FastifyInstance) => {
  const res = await post(
    who,
    '/v1/baskets/personalize',
    { sheet: sheet({ amountUsd }), ...more },
    on,
  );
  expect(res.statusCode, res.body).toBe(200);
  return PersonalizeResponse.parse(res.json());
};
const reply = (over: object = {}) => ({
  say: [{ key: 'understood' }, { key: 'set', fact: 'amount' }],
  ask: 'horizon',
  open: ['horizon', 'risk'],
  facts: { goal: 'grow', amountUsd: 6100 },
  ...over,
});
const thread = async (who: Person, id: string, query = '') => {
  const res = await get(who, `/v1/baskets/${id}/thread${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return ThreadResponse.parse(res.json());
};
const say = (who: Person | null, id: string, body: unknown, on?: FastifyInstance) =>
  post(who as Person, `/v1/baskets/${id}/thread`, body, on);
/** Every turn as a short line, to read a thread's order at a glance. */
const lines = (t: ThreadResponse) =>
  t.turns.map((turn) =>
    turn.who === 'person' ? `person: ${turn.text}` : turn.who === 'app' ? 'app' : turn.event.type,
  );

describe('a plan’s thread', () => {
  it('starts with the plan having been built, and takes the person’s turns with the app’s replies', async () => {
    const who = await someone();
    const { id } = await make(who, 6_101);
    const first = await thread(who, id);
    expect(first).toMatchObject({ planId: id, before: null });
    expect(first.turns.map((t) => (t.who === 'event' ? t.event : null))).toEqual([
      { type: 'plan_built', planId: id },
    ]);

    const res = await say(who, id, {
      text: 'Can it take more risk?\nSay five years.',
      reply: reply(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const stored = ThreadTurnResponse.parse(res.json());
    expect(stored.planId).toBe(id);
    expect(stored.turns.map((t) => t.who)).toEqual(['person', 'app']);
    // the words as typed, and the reply as keys and facts, exactly as sent
    expect(stored.turns[0]).toMatchObject({
      who: 'person',
      text: 'Can it take more risk?\nSay five years.',
    });
    expect(stored.turns[1]).toMatchObject({ who: 'app', reply: reply() });

    const after = await thread(who, id);
    expect(lines(after)).toEqual([
      'plan_built',
      'person: Can it take more risk?\nSay five years.',
      'app',
    ]);
    expect(after.turns.slice(1)).toEqual(stored.turns);
  });

  it('is the person’s own: another person, nobody, a plan from a link and an unknown id are one 404', async () => {
    const [who, other] = [await someone(), await someone()];
    const { id } = await make(who, 6_102);
    await say(who, id, { text: 'my own words', reply: reply() });
    const linked = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 6_103 }) })).json(),
    );
    const reads = [
      await get(other, `/v1/baskets/${id}/thread`),
      await get(who, `/v1/baskets/${crypto.randomUUID()}/thread`),
      // a plan from a link has no thread, for its buyer as for anybody
      await get(who, `/v1/baskets/${linked.id}/thread`),
    ];
    const writes = [
      await say(other, id, { text: 'not mine to write', reply: reply() }),
      await say(who, crypto.randomUUID(), { text: 'nowhere', reply: reply() }),
      await say(who, linked.id, { text: 'no thread here', reply: reply() }),
    ];
    for (const res of [...reads, ...writes]) {
      expect(res.statusCode).toBe(404);
      expect(OrderError.parse(res.json()).error).toBe('no plan with that id that you can read');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body).not.toContain('my own words');
    }
    // with no sign-in there is no thread to ask for at all
    expect((await get(null, `/v1/baskets/${id}/thread`)).statusCode).toBe(401);
    expect((await say(null, id, { text: 'x', reply: reply() })).statusCode).toBe(401);
    // nothing was written by the three that were refused
    expect(lines(await thread(who, id))).toEqual(['plan_built', 'person: my own words', 'app']);
    // and no row at all hangs off the plan from a link
    const none = await data.db.select().from(planTurns).where(eq(planTurns.proposalId, linked.id));
    expect(none).toEqual([]);
  });

  it('shows nothing of itself on any other route: the plan by its id, the list of plans, the portfolio', async () => {
    const who = await someone();
    const { id } = await make(who, 6_104);
    const secret = 'my salary is my own business 7731';
    await say(who, id, { text: secret, reply: reply() });
    for (const path of [`/v1/baskets/${id}`, '/v1/me/plans', '/v1/portfolio', '/v1/me']) {
      const res = await get(who, path);
      expect(res.body, path).not.toContain('7731');
      expect(res.body, path).not.toContain('thread');
    }
  });

  it('takes plain text and a reply of keys and facts, and stores nothing of a turn it refuses', async () => {
    const who = await someone();
    const { id } = await make(who, 6_105);
    const bad: [string, unknown][] = [
      ['no words', { text: '   ', reply: reply() }],
      ['too many words', { text: 'x'.repeat(THREAD_LIMITS.textMax + 1), reply: reply() }],
      ['a control character', { text: 'bell\u0007', reply: reply() }],
      ['a direction override', { text: 'pay ‮evil', reply: reply() }],
      [
        'a sentence for a key',
        { text: 'hi', reply: reply({ say: [{ key: 'You will earn 8% a year' }] }) },
      ],
      ['free text beside the keys', { text: 'hi', reply: { ...reply(), text: 'buy NVDA now' } }],
      ['a fact the sheet does not have', { text: 'hi', reply: reply({ facts: { advice: 'x' } }) }],
      ['a figure as words', { text: 'hi', reply: reply({ facts: { amountUsd: '$5,000' } }) }],
      [
        'an event of its own',
        { text: 'hi', reply: reply(), event: { type: 'buy_done', orderId: id } },
      ],
      ['no reply', { text: 'hi' }],
    ];
    for (const [what, body] of bad) {
      const res = await say(who, id, body);
      expect(res.statusCode, what).toBe(400);
      // the answer names what is wrong and repeats none of what was sent
      expect(res.body, what).not.toMatch(/evil|NVDA|earn 8%/);
    }
    // larger than a turn can be: refused before it is read
    const huge = await say(who, id, { text: 'hi', reply: reply({ pad: 'x'.repeat(20_000) }) });
    expect(huge.statusCode).toBe(413);
    expect(lines(await thread(who, id))).toEqual(['plan_built']);
  });

  it('pages from the newest back, oldest first on each page, and ends', async () => {
    const who = await someone();
    const { id } = await make(who, 6_106);
    for (let i = 1; i <= 4; i++) await say(who, id, { text: `turn ${i}`, reply: reply() });
    // nine turns: the plan built, then four of the person's with the app's
    const newest = await thread(who, id, '?limit=4');
    expect(lines(newest)).toEqual(['person: turn 3', 'app', 'person: turn 4', 'app']);
    expect(newest.before).not.toBeNull();
    const older = await thread(who, id, `?limit=4&before=${newest.before}`);
    expect(lines(older)).toEqual(['person: turn 1', 'app', 'person: turn 2', 'app']);
    const oldest = await thread(who, id, `?limit=4&before=${older.before}`);
    expect(lines(oldest)).toEqual(['plan_built']);
    expect(oldest.before).toBeNull();
    expect((await thread(who, id)).turns).toHaveLength(9);
    for (const bad of ['?limit=0', '?limit=51', '?before=yesterday', '?before=-1'])
      expect((await get(who, `/v1/baskets/${id}/thread${bad}`)).statusCode, bad).toBe(400);
  });
});

describe('a thread begun before the plan was the person’s own', () => {
  const started = [
    { text: 'I want to grow 6,107 dollars', reply: reply({ ask: 'horizon' }) },
    { text: 'five years', reply: reply({ ask: null, open: [], say: [{ key: 'ready' }] }) },
  ];

  it('is stored with the plan, in order, before the plan having been built', async () => {
    const who = await someone();
    const { id } = await make(who, 6_107, { thread: started });
    expect(lines(await thread(who, id))).toEqual([
      'person: I want to grow 6,107 dollars',
      'app',
      'person: five years',
      'app',
      'plan_built',
    ]);
  });

  it('is stored once: the same plan made again keeps the thread it has', async () => {
    const who = await someone();
    const first = await make(who, 6_108, { thread: started });
    await say(who, first.id, { text: 'and later, this', reply: reply() });
    const kept = [
      'person: I want to grow 6,107 dollars',
      'app',
      'person: five years',
      'app',
      'plan_built',
      'person: and later, this',
      'app',
    ];
    // the same sheet is the same plan; the conversation sent again adds nothing to it
    const again = await make(who, 6_108, {
      thread: [...started, { text: 'a third', reply: reply() }],
    });
    expect(again.id).toBe(first.id);
    expect(lines(await thread(who, first.id))).toEqual(kept);
    // and the store itself writes a thread that has a person's turn no second time
    await attachThread(data.db, first.id, ThreadStart.parse(started));
    expect(lines(await thread(who, first.id))).toEqual(kept);
  });

  it('is refused whole when a turn of it is not one, and a plan from a link takes none', async () => {
    const who = await someone();
    const bad = await post(who, '/v1/baskets/personalize', {
      sheet: sheet({ amountUsd: 6_109 }),
      thread: [
        { text: 'fine', reply: reply() },
        { text: 'bad ‮', reply: reply() },
      ],
    });
    expect(bad.statusCode).toBe(400);
    const many = await post(who, '/v1/baskets/personalize', {
      sheet: sheet({ amountUsd: 6_109 }),
      thread: Array.from({ length: THREAD_LIMITS.attachMax + 1 }, () => started[0]),
    });
    expect(many.statusCode).toBe(400);
    // an agent's plan is nobody's conversation: the field is not one of that route's, and no row is written
    const linked = await post(null, '/v1/baskets/propose', {
      sheet: sheet({ amountUsd: 6_110 }),
      thread: started,
    });
    expect(linked.statusCode, linked.body).toBe(200);
    const rows = await data.db
      .select()
      .from(planTurns)
      .where(eq(planTurns.proposalId, PersonalizeResponse.parse(linked.json()).id));
    expect(rows).toEqual([]);
  });
});

describe('what happened to the plan, written by the server', () => {
  it('tells a buy from the order to the end, each thing once, in the order it happened', async () => {
    const who = await someone();
    const { id } = await make(who, 6_111);
    await fund(who, undefined, 20_000);
    const placed = await order(who, { proposalId: id, amountUsd: 900 });
    expect(lines(await thread(who, id))).toEqual(['plan_built', 'order_made']);
    const made = (await thread(who, id)).turns[1];
    expect(made).toMatchObject({
      who: 'event',
      event: { type: 'order_made', orderId: placed.id, kind: 'buy', amountUsd: 900 },
    });

    // the vault is opened and the deposit lands; no swap is signed yet
    await settleAll(who, placed, undefined, (leg) => leg.kind === 'swap');
    expect(lines(await thread(who, id))).toEqual(['plan_built', 'order_made', 'deposit_landed']);
    // reading the order again, however often, writes nothing twice
    for (let i = 0; i < 3; i++) await get(who, `/v1/orders/${placed.id}`);
    expect(lines(await thread(who, id))).toEqual(['plan_built', 'order_made', 'deposit_landed']);

    for (const leg of placed.legs.filter((l) => l.kind === 'swap')) {
      await build(who, placed, leg.id);
      await report(who, placed, leg.id, { txId: await land(who, placed, leg.id) });
    }
    const done = OrderDetail.parse((await get(who, `/v1/orders/${placed.id}`)).json());
    expect(done.status).toBe('done');
    expect(lines(await thread(who, id))).toEqual([
      'plan_built',
      'order_made',
      'deposit_landed',
      'buy_done',
    ]);
    // every event names the order by its id, and nothing else of it
    for (const turn of (await thread(who, id)).turns.slice(1))
      expect(turn).toMatchObject({ who: 'event', event: { orderId: placed.id } });
  });

  it('tells an add and a finished buy in the thread of the vault’s plan', async () => {
    const who = await someone();
    const { id } = await make(who, 6_112);
    await fund(who, undefined, 20_000);
    await settleAll(who, await order(who, { proposalId: id, amountUsd: 900 }));
    const vault = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json())
      .chains.flatMap((c) => c.vaults)
      .find((v) => v.planId === id);
    if (!vault) throw new Error('the plan has no vault');
    // more money into the vault: an order that names the vault, and no plan
    const res = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 300,
      vault: { chain: vault.chain, address: vault.address },
    });
    expect(res.statusCode, res.body).toBe(200);
    const add = OrderDetail.parse(res.json());
    // its deposit lands and its swaps are left: the buy is finished by another order
    await settleAll(who, add, undefined, (leg) => leg.kind === 'swap');
    const finished = await post(who, `/v1/orders/${add.id}/continue`);
    expect(finished.statusCode, finished.body).toBe(200);
    const next = OrderDetail.parse(finished.json());
    await settleAll(who, next);

    const events = (await thread(who, id)).turns.flatMap((t) =>
      t.who === 'event' ? [t.event] : [],
    );
    expect(events.slice(4)).toEqual([
      { type: 'order_made', orderId: add.id, kind: 'add', amountUsd: 300 },
      { type: 'deposit_landed', orderId: add.id },
      // the add stopped with its cash in the vault, and another order finishes it
      { type: 'buy_stopped', orderId: add.id },
      { type: 'order_made', orderId: next.id, kind: 'finish', amountUsd: null },
      { type: 'buy_done', orderId: next.id },
    ]);
  });

  it('writes nothing for another person’s order, and none of it into another plan’s thread', async () => {
    const [who, other] = [await someone(), await someone()];
    const mine = await make(who, 6_113);
    const theirs = await make(other, 6_114);
    await fund(other, undefined, 20_000);
    await settleAll(other, await order(other, { proposalId: theirs.id, amountUsd: 900 }));
    expect(lines(await thread(who, mine.id))).toEqual(['plan_built']);
    expect(lines(await thread(other, theirs.id))).toEqual([
      'plan_built',
      'order_made',
      'deposit_landed',
      'buy_done',
    ]);
  });
});

describe('a thread’s place in the limits and the database', () => {
  it('counts a turn against the budget of the routes that read a person’s words', async () => {
    const strict = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      planInputs: withMockYield,
      limits: LIMITS,
    });
    try {
      const who = await someone();
      const { id } = await make(who, 6_115, {}, strict.app);
      const codes: number[] = [];
      for (let i = 0; i < LIMITS.class.parse + 1; i++)
        codes.push(
          (await say(who, id, { text: `turn ${i}`, reply: reply() }, strict.app)).statusCode,
        );
      expect(codes.slice(0, LIMITS.class.parse).every((code) => code === 200)).toBe(true);
      expect(codes.at(-1)).toBe(429);
    } finally {
      await strict.app.close();
    }
  });

  it('goes with its plan when the plan is deleted', async () => {
    const who = await someone();
    const { id } = await make(who, 6_116);
    await say(who, id, { text: 'gone with the plan', reply: reply() });
    await data.db.delete(proposals).where(eq(proposals.id, id));
    expect(await data.db.select().from(planTurns).where(eq(planTurns.proposalId, id))).toEqual([]);
  });
});
