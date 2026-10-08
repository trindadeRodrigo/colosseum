import { randomUUID } from 'node:crypto';
import { type Db, planTurns, proposals } from '@colosseum/db';
import {
  type BasketSheet,
  OrderDetail,
  OrderError,
  PortfolioResponse,
  THREAD_LIMITS,
  ThreadResponse,
  ThreadStart,
  ThreadTurnRequest,
  ThreadTurnResponse,
  YieldObservation,
} from '@colosseum/schemas';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { appendTurn, attachThread } from '../../orders/thread';
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
/**
 * The database, with every write of a person's or the app's turn made to fail as the database itself
 * fails it: the row is sent with a thread that does not exist, so the driver throws its own error,
 * with the statement's values in it. Events are written as they are.
 */
function breaking(db: Db): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'insert')
        return (table: unknown) => {
          const builder = target.insert(table as typeof planTurns);
          if (table !== planTurns) return builder;
          return {
            values: (rows: (typeof planTurns.$inferInsert)[]) =>
              builder.values(
                rows.map((row) => (row.who === 'event' ? row : { ...row, threadId: randomUUID() })),
              ),
          };
        };
      if (prop === 'transaction')
        return (work: (tx: Db) => Promise<unknown>) =>
          target.transaction((tx) => work(breaking(tx as unknown as Db)));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
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
const legacyIds = new Set<string>();
const buildIds = new Map<string, string[]>();
const idsOf = (id: string) => {
  const ids = buildIds.get(id);
  if (!ids) throw new Error('missing test build identities');
  return ids;
};
const legacyTurns = (t: ThreadResponse) =>
  t.turns.filter(
    (turn) => turn.who !== 'event' || !('planId' in turn.event) || legacyIds.has(turn.event.planId),
  );
// Existing single-plan lifecycle checks follow the legacy plan. Group tests below assert every
// sibling build event, exact IDs, shared history and selected-candidate order attribution separately.
const make = async (who: Person, amountUsd: number, more: object = {}, on?: FastifyInstance) => {
  const res = await post(
    who,
    '/v1/baskets/personalize',
    { sheet: sheet({ amountUsd }), ...more },
    on,
  );
  expect(res.statusCode, res.body).toBe(200);
  const result = PersonalizeResponse.parse(res.json());
  legacyIds.add(result.id);
  buildIds.set(result.id, [...new Set([result.id, ...result.candidates.map((c) => c.id)])]);
  return result;
};
const reply = (over: object = {}) => ({
  say: [{ key: 'understood' }, { key: 'set', fact: 'amount' }],
  ask: 'horizon',
  open: ['horizon', 'risk'],
  // every sheet of this file is a goal to grow: a reply's facts are its plan's own
  facts: { goal: 'grow' },
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
  legacyTurns(t).map((turn) =>
    turn.who === 'person' ? `person: ${turn.text}` : turn.who === 'app' ? 'app' : turn.event.type,
  );

describe('a plan’s thread', () => {
  it('groups every distinct candidate with one initial attachment and exact server build identities', async () => {
    const who = await someone();
    const started = [{ text: 'My private complete build', reply: reply() }];
    const [a, b] = await Promise.all([
      make(who, 6_151, { thread: started }),
      make(who, 6_151, { thread: started }),
    ]);
    expect(b.candidates.map((c) => c.id)).toEqual(a.candidates.map((c) => c.id));
    const ids = [...new Set([a.id, ...a.candidates.map((c) => c.id)])];
    const main = await thread(who, a.id);
    expect(main.turns.filter((t) => t.who === 'person').map((t) => t.text)).toEqual([
      'My private complete build',
    ]);
    expect(main.turns.filter((t) => t.who === 'app')).toHaveLength(1);
    expect(main.turns.flatMap((t) => (t.who === 'event' ? [t.event] : []))).toEqual(
      ids.map((planId) => ({ type: 'plan_built', planId })),
    );
    const other = await someone();
    for (const id of ids) {
      expect((await thread(who, id)).turns).toEqual(main.turns);
      expect((await get(other, `/v1/baskets/${id}/thread`)).statusCode).toBe(404);
    }
    const selected = a.candidates[0];
    if (!selected) throw new Error('expected an offered candidate');
    const rebuilt = await make(who, 6_152, { previousPlanId: selected.id });
    const current = await thread(who, rebuilt.id);
    expect(current.turns.slice(0, main.turns.length)).toEqual(main.turns);
    expect(
      current.turns.slice(main.turns.length).flatMap((t) => (t.who === 'event' ? [t.event] : [])),
    ).toEqual(
      [...new Set([rebuilt.id, ...rebuilt.candidates.map((c) => c.id)])].map((planId) => ({
        type: 'plan_rebuilt',
        planId,
        previousPlanId: selected.id,
        changed: ['amountUsd'],
      })),
    );
  });

  it('attributes a buy of every offered candidate to its actual proposal and shared private history', async () => {
    const who = await someone();
    const made = await make(who, 6_153, {
      thread: [{ text: 'Keep my chosen candidate conversation', reply: reply() }],
    });
    await fund(who, undefined, 20_000);
    for (const candidate of made.candidates) {
      const placed = await order(who, { proposalId: candidate.id, amountUsd: 900 });
      await settleAll(who, placed);
      const main = await thread(who, made.id);
      expect((await thread(who, candidate.id)).turns).toEqual(main.turns);
      expect(
        main.turns.some(
          (t) => t.who === 'person' && t.text === 'Keep my chosen candidate conversation',
        ),
      ).toBe(true);
      const rows = await data.db
        .select()
        .from(planTurns)
        .where(eq(planTurns.eventKey, `buy_done:${placed.id}`));
      expect(rows.map((row) => row.proposalId)).toEqual([candidate.id]);
    }
  });

  it('starts with the plan having been built, and takes the person’s turns with the app’s replies', async () => {
    const who = await someone();
    const { id } = await make(who, 6_101);
    const first = await thread(who, id);
    expect(first).toMatchObject({ planId: id, before: null });
    expect(first.turns.map((t) => (t.who === 'event' ? t.event : null))).toEqual(
      idsOf(id).map((planId) => ({ type: 'plan_built', planId })),
    );

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
    expect(after.turns.slice(idsOf(id).length)).toEqual(stored.turns);
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

  it('refuses reply facts when the owned stored sheet is unreadable', async () => {
    const who = await someone();
    const { id } = await make(who, 6_154);
    await data.db
      .update(proposals)
      .set({ proposal: sql`jsonb_set(${proposals.proposal}, '{sheet}', 'null'::jsonb)` })
      .where(eq(proposals.id, id));
    const before = await thread(who, id);
    for (const facts of [{ goal: 'grow' }, {}]) {
      const res = await say(who, id, { text: 'Do not trust this reply', reply: reply({ facts }) });
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain('Do not trust');
    }
    expect((await thread(who, id)).turns).toEqual(before.turns);
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
      ['a direction override', { text: 'pay \u202eevil', reply: reply() }],
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
    // a figure or a value that is not the plan's own: refused by the fact's name, with no value
    for (const facts of [
      { amountUsd: 999_999 },
      { goal: 'income' },
      { incomeTargetUsdMonthly: 777 },
    ]) {
      const res = await say(who, id, { text: 'hi', reply: reply({ facts }) });
      expect(res.statusCode, res.body).toBe(422);
      expect(OrderError.parse(res.json()).error).toContain(Object.keys(facts)[0]);
      expect(res.body).not.toMatch(/999|777/);
    }
    // larger than a turn can be: refused before it is read
    const huge = await say(who, id, { text: 'hi', reply: reply({ pad: 'x'.repeat(20_000) }) });
    expect(huge.statusCode).toBe(413);
    expect(lines(await thread(who, id))).toEqual(['plan_built']);
    // the plan's own facts are taken, and a line break from Windows is stored as the one character
    const ok = await say(who, id, {
      text: 'two lines\r\nfrom Windows',
      reply: reply({ facts: { goal: 'grow', amountUsd: 6_105, horizonMonths: 60, risk: 'high' } }),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(lines(await thread(who, id))).toEqual([
      'plan_built',
      'person: two lines\nfrom Windows',
      'app',
    ]);
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
    expect((await thread(who, id)).turns).toHaveLength(8 + idsOf(id).length);
    for (const bad of ['?limit=0', '?limit=51', '?before=yesterday', '?before=-1'])
      expect((await get(who, `/v1/baskets/${id}/thread${bad}`)).statusCode, bad).toBe(400);
  });
});

describe('a thread begun before the plan was the person’s own', () => {
  const started = [
    { text: 'I want to grow 6,107 dollars', reply: reply({ ask: 'horizon' }) },
    { text: 'five years', reply: reply({ ask: null, open: [], say: [{ key: 'ready' }] }) },
  ];

  it('stores all 200 accepted chronological messages without slicing the attachment', async () => {
    const who = await someone();
    const turns = Array.from({ length: 200 }, (_, i) => ({
      text: `chronological person message ${i}`,
      reply: reply(),
    }));
    const made = await make(who, 6_154, { thread: turns });
    const pages: ThreadResponse['turns'] = [];
    let before: string | null = null;
    do {
      const page = await thread(who, made.id, before ? `?before=${before}` : '');
      pages.unshift(...page.turns);
      before = page.before;
    } while (before !== null);
    expect(pages.filter((turn) => turn.who === 'person').map((turn) => turn.text)).toEqual(
      turns.map((turn) => turn.text),
    );
    expect(pages.filter((turn) => turn.who === 'app')).toHaveLength(200);
  });

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

  it('is stored once: sent again for a thread that has a person’s turn, it is not written', async () => {
    const who = await someone();
    const first = await make(who, 6_108, { thread: started });
    const before = lines(await thread(who, first.id));
    const [row] = await data.db
      .select({ threadId: proposals.threadId })
      .from(proposals)
      .where(eq(proposals.id, first.id));
    if (!row?.threadId) throw new Error('the plan is in no thread');
    await attachThread(
      data.db,
      { threadId: row.threadId, planId: first.id },
      ThreadStart.parse(started),
    );
    expect(lines(await thread(who, first.id))).toEqual(before);
  });

  it('serializes attachment with an append and never repeats the initial conversation', async () => {
    const who = await someone();
    const { id } = await make(who, 6_155);
    const [row] = await data.db
      .select({ threadId: proposals.threadId })
      .from(proposals)
      .where(eq(proposals.id, id));
    if (!row?.threadId) throw new Error('the plan is in no thread');
    const at = { threadId: row.threadId, planId: id };
    const initial = ThreadStart.parse([{ text: 'Initial local conversation', reply: reply() }]);
    await Promise.all([
      attachThread(data.db, at, initial),
      appendTurn(
        data.db,
        at,
        ThreadTurnRequest.parse({ text: 'Later owner turn', reply: reply() }),
      ),
    ]);
    const before = await thread(who, id);
    const words = before.turns.flatMap((turn) => (turn.who === 'person' ? [turn.text] : []));
    // If the append wins the lock, it already makes attachment ineligible; otherwise initial precedes it.
    expect([
      ['Later owner turn'],
      ['Initial local conversation', 'Later owner turn'],
    ]).toContainEqual(words);
    expect(before.turns.filter((turn) => turn.who === 'app')).toHaveLength(words.length);
    await attachThread(data.db, at, initial);
    expect((await thread(who, id)).turns).toEqual(before.turns);
  });

  it('is refused whole when a turn of it is not one, and a plan from a link takes none', async () => {
    const who = await someone();
    const bad = await post(who, '/v1/baskets/personalize', {
      sheet: sheet({ amountUsd: 6_109 }),
      thread: [
        { text: 'fine', reply: reply() },
        { text: 'bad \u202e', reply: reply() },
      ],
    });
    expect(bad.statusCode).toBe(400);
    const many = await post(who, '/v1/baskets/personalize', {
      sheet: sheet({ amountUsd: 6_109 }),
      thread: Array.from({ length: THREAD_LIMITS.attachMax + 1 }, () => started[0]),
    });
    expect(many.statusCode).toBe(400);
    // the conversation ends at the plan: its last reply's facts are the sheet's, or nothing is made
    const off = await post(who, '/v1/baskets/personalize', {
      sheet: sheet({ amountUsd: 6_109 }),
      thread: [{ text: 'fine', reply: reply({ facts: { amountUsd: 123_456 } }) }],
    });
    expect(off.statusCode, off.body).toBe(422);
    expect(off.body).toContain('amountUsd');
    expect(off.body).not.toContain('123');
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

describe('a plan built again in the same conversation', () => {
  const started = [{ text: 'grow what I have, five years', reply: reply() }];
  const led = ['person: grow what I have, five years', 'app', 'plan_built'];
  const events = (t: ThreadResponse) =>
    legacyTurns(t).flatMap((x) => (x.who === 'event' ? [x.event] : []));

  it('is in the thread of the plan before it: one thread, read whole by either plan’s id', async () => {
    const who = await someone();
    const first = await make(who, 6_120, { thread: started });
    await say(who, first.id, { text: 'make it 6,121 over six years', reply: reply() });
    // the conversation so far is sent again, as the tab has it: the thread has it, and takes none
    const second = await make(who, 6_121, {
      previousPlanId: first.id,
      thread: [...started, { text: 'make it 6,121 over six years', reply: reply() }],
      sheet: sheet({ amountUsd: 6_121, horizonMonths: 72 }),
    });
    expect(second.id).not.toBe(first.id);
    const whole = [...led, 'person: make it 6,121 over six years', 'app', 'plan_rebuilt'];
    const [byFirst, bySecond] = [await thread(who, first.id), await thread(who, second.id)];
    expect(lines(byFirst)).toEqual(whole);
    expect(bySecond.turns).toEqual(byFirst.turns);
    expect([byFirst.planId, bySecond.planId]).toEqual([first.id, second.id]);
    // what changed is the names of the sheet's fields, never a value
    expect(events(bySecond).at(-1)).toEqual({
      type: 'plan_rebuilt',
      planId: second.id,
      previousPlanId: first.id,
      changed: ['amountUsd', 'horizonMonths'],
    });

    // a turn under either plan is a turn of the one thread, and a third plan follows the second
    await say(who, second.id, { text: 'and seven years', reply: reply() });
    await say(who, first.id, { text: 'said from the old tab', reply: reply() });
    const third = await make(who, 6_121, {
      previousPlanId: second.id,
      sheet: sheet({ amountUsd: 6_121, horizonMonths: 84 }),
    });
    const end = [
      ...whole,
      'person: and seven years',
      'app',
      'person: said from the old tab',
      'app',
      'plan_rebuilt',
    ];
    for (const id of [first.id, second.id, third.id])
      expect(lines(await thread(who, id)), id).toEqual(end);
    expect(events(await thread(who, third.id)).at(-1)).toMatchObject({
      previousPlanId: second.id,
      changed: ['horizonMonths'],
    });
  });

  it('carries on to the buy and the vault: the orders of the plan that was bought are in the one thread', async () => {
    const who = await someone();
    const first = await make(who, 6_122);
    const second = await make(who, 6_123, { previousPlanId: first.id });
    await fund(who, undefined, 20_000);
    const placed = await order(who, { proposalId: second.id, amountUsd: 900 });
    await settleAll(who, placed);
    const told = events(await thread(who, first.id));
    expect(told.map((e) => e.type)).toEqual([
      'plan_built',
      'plan_rebuilt',
      'order_made',
      'deposit_landed',
      'buy_done',
    ]);
    expect(told.slice(2).every((e) => 'orderId' in e && e.orderId === placed.id)).toBe(true);
  });

  it('joins only a plan of the caller’s own: another person’s, a link’s or an unknown id starts a thread', async () => {
    const [who, other] = [await someone(), await someone()];
    const theirs = await make(other, 6_124, {
      thread: [{ text: 'the other person’s own words 9917', reply: reply() }],
    });
    const linked = PersonalizeResponse.parse(
      (await post(null, '/v1/baskets/propose', { sheet: sheet({ amountUsd: 6_125 }) })).json(),
    );
    let amountUsd = 6_126;
    for (const previousPlanId of [theirs.id, linked.id, crypto.randomUUID()]) {
      const mine = await make(who, amountUsd++, { previousPlanId });
      const read = await get(who, `/v1/baskets/${mine.id}/thread`);
      expect(read.body).not.toContain('9917');
      // a thread of its own, started as any plan's is
      expect(events(ThreadResponse.parse(read.json()))).toEqual([
        { type: 'plan_built', planId: mine.id },
      ]);
    }
    // and nothing was written to the thread that was named
    expect(lines(await thread(other, theirs.id))).toEqual([
      'person: the other person’s own words 9917',
      'app',
      'plan_built',
    ]);
    expect(
      await data.db.select().from(planTurns).where(eq(planTurns.proposalId, linked.id)),
    ).toEqual([]);
    // a plan from a link is in no thread, whatever it names
    const agent = await post(null, '/v1/baskets/propose', {
      sheet: sheet({ amountUsd: 6_129 }),
      previousPlanId: theirs.id,
    });
    expect(agent.statusCode, agent.body).toBe(200);
    const [row] = await data.db
      .select({ threadId: proposals.threadId })
      .from(proposals)
      .where(eq(proposals.id, PersonalizeResponse.parse(agent.json()).id));
    expect(row?.threadId).toBeNull();
  });

  it('is apart from a plan made with no plan named: two conversations, two threads', async () => {
    const who = await someone();
    const first = await make(who, 6_130, { thread: started });
    const second = await make(who, 6_131);
    expect(lines(await thread(who, first.id))).toEqual(led);
    expect(lines(await thread(who, second.id))).toEqual(['plan_built']);
  });
});

describe('what happened to the plan, written by the server', () => {
  it('tells a buy from the order to the end, each thing once, in the order it happened', async () => {
    const who = await someone();
    const { id } = await make(who, 6_111);
    await fund(who, undefined, 20_000);
    // Orders a screen makes to show their steps, with nothing pressed: the thread says none of them.
    for (let i = 0; i < 3; i++) await order(who, { proposalId: id, amountUsd: 900 });
    const placed = await order(who, { proposalId: id, amountUsd: 900 });
    expect(lines(await thread(who, id))).toEqual(['plan_built']);
    // the first step is built, which is the person's press: the order was made
    const firstLeg = placed.legs[0];
    if (!firstLeg) throw new Error('the buy has no step');
    await build(who, placed, firstLeg.id);
    expect(lines(await thread(who, id))).toEqual(['plan_built', 'order_made']);
    const made = (await thread(who, id)).turns.find(
      (turn) => turn.who === 'event' && turn.event.type === 'order_made',
    );
    expect(made).toMatchObject({
      who: 'event',
      event: { type: 'order_made', orderId: placed.id, kind: 'buy', amountUsd: 900 },
    });

    // the vault is opened and the deposit lands; no swap is signed yet
    await report(who, placed, firstLeg.id, { txId: await land(who, placed, firstLeg.id) });
    for (const leg of placed.legs.slice(1).filter((l) => l.kind !== 'swap')) {
      await build(who, placed, leg.id);
      await report(who, placed, leg.id, { txId: await land(who, placed, leg.id) });
    }
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
    for (const turn of (await thread(who, id)).turns.slice(idsOf(id).length))
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

    const events = legacyTurns(await thread(who, id)).flatMap((t) =>
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

  it('lets nothing of a person’s words into a log when the database refuses a write', async () => {
    const secret = 'what I earn is my own 5521';
    // the driver's own error repeats what it was sent: this is what must never be logged
    const raw = await breaking(data.db)
      .insert(planTurns)
      .values([{ threadId: randomUUID(), proposalId: randomUUID(), who: 'person', text: secret }])
      .then(
        () => null,
        (e: unknown) => e as Error & { params?: unknown },
      );
    expect(`${raw?.message} ${JSON.stringify(raw?.params)}`).toContain('5521');

    const logged: string[] = [];
    const broken = await testApp({
      issuer: issuer.issuer,
      db: breaking(data.db),
      planInputs: withMockYield,
      logTo: { write: (line) => logged.push(line) },
    });
    try {
      const who = await someone();
      // the conversation sent with the plan is not stored, and the plan is made all the same
      const plan = await make(
        who,
        6_140,
        { thread: [{ text: `${secret}, said first`, reply: reply() }] },
        broken.app,
      );
      const res = await say(
        who,
        plan.id,
        { text: secret, reply: reply({ say: [{ key: 'cantPick', pick: 'tesla' }] }) },
        broken.app,
      );
      expect(res.statusCode, res.body).toBe(503);
      expect(OrderError.parse(res.json())).toEqual({
        error: 'the turn could not be stored: send it again in a moment',
        details: { retryable: true },
      });
      // both failures are in the log, by their name and the database's code
      const failures = logged.filter((line) => line.includes('ThreadWriteError'));
      expect(failures).toHaveLength(2);
      for (const line of failures) expect(JSON.parse(line)).toMatchObject({ code: '23503' });
      // and no line of the log, of any request, has a word of either turn or of the reply
      const all = logged.join('\n');
      expect(logged.length).toBeGreaterThan(2);
      for (const word of ['5521', 'what I earn', 'said first', 'tesla', 'cantPick'])
        expect(all, word).not.toContain(word);
      expect(lines(await thread(who, plan.id))).toEqual(['plan_built']);
    } finally {
      await broken.app.close();
    }
  });

  it('goes with its plan when the plan is deleted: the turns written under it', async () => {
    const who = await someone();
    const { id } = await make(who, 6_116);
    await say(who, id, { text: 'gone with the plan', reply: reply() });
    // a plan built after it, in the same thread, keeps what was written under it
    const next = await make(who, 6_117, { previousPlanId: id });
    await data.db.delete(proposals).where(eq(proposals.id, id));
    expect(await data.db.select().from(planTurns).where(eq(planTurns.proposalId, id))).toEqual([]);
    expect(lines(await thread(who, next.id))).toEqual(['plan_rebuilt']);
  });
});
