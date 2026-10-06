import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { budgetedModel, type IntakeModel, type ReadCall } from '../../llm';
import type { ChainRegistry } from '../../orders/chains';
import { loadFamilies } from '../../orders/store';
import { orderFlow } from '../../testing/flow';
import {
  type PersonKind,
  person,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import { PersonalizeResponse } from './baskets';
import { IntakeResponse } from './intake';

// POST /v1/baskets/intake, the guided intake (gate GUIDED-INTAKE), through HTTP on the mock chain and
// the real database. The model's replies are MOCK: hand-written in the shape the API asks the model
// for (packages/engine/src/personal/fixtures/intake-replies.json) and replayed by text, labelled
// `mock` in every answer. No test reaches Anthropic.

vi.setConfig({ testTimeout: 60_000 });

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../../packages/engine/src/personal/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const evalSet = fixture('goals-eval.json') as {
  nowMonth: string;
  goals: { id: string; text: string; expect: Record<string, unknown> }[];
};
const recorded = fixture('intake-replies.json') as {
  replies: Record<string, unknown>;
  conversations: Record<string, { messages: string[]; replies: unknown[] }>;
};
const chat = recorded.conversations['first-chat-oct6'] as {
  messages: string[];
  replies: unknown[];
};
// The chat that asked the risk twice and found no big tech list (gate EXPLICIT-MIX, Oct 6).
const bigTech = recorded.conversations['big-tech-chat-oct6'] as {
  messages: string[];
  replies: unknown[];
};
// The conversation's replies, by the text each turn reads: the messages so far, joined as the route joins them.
const replyByText = new Map<string, unknown>([
  ...evalSet.goals.map((g): [string, unknown] => [g.text, recorded.replies[g.id]]),
  ...[chat, bigTech].flatMap((c) =>
    c.replies.map((r, i): [string, unknown] => [c.messages.slice(0, i + 1).join('\n\n'), r]),
  ),
]);
const goal = (id: string) => evalSet.goals.find((g) => g.id === id) as (typeof evalSet.goals)[0];

/** The recorded replies, by text, as a raw call. */
const callOf = (): ReadCall => async (text) => {
  const reply = replyByText.get(text);
  return reply === undefined ? { reply: null, why: 'model_error' } : { reply };
};

/** A replay of the recorded replies, by text; `calls` counts what reached it. */
function replay(): { model: IntakeModel; calls: () => number } {
  let calls = 0;
  const call: ReadCall = async (text) => {
    calls += 1;
    const reply = replyByText.get(text);
    return reply === undefined ? { reply: null, why: 'model_error' } : { reply };
  };
  return {
    model: budgetedModel(call, { id: 'claude-haiku-4-5', provenance: 'mock' }),
    calls: () => calls,
  };
}

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let off: FastifyInstance;
let registry: ChainRegistry;
let replayed: ReturnType<typeof replay>;
const undo: (() => Promise<unknown>)[] = [];
// The month the evaluation set counts from ("by 2031" is 51 months from October 2026).
const now = () => new Date('2026-10-05T12:00:00Z');

beforeAll(async () => {
  issuer = await testIssuer('intake');
  data = await testDb();
  undo.push(() => data.cleanUp());
  replayed = replay();
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    now,
    intakeModel: replayed.model,
  }));
  undo.push(() => app.close());
  // No model configured: the server's own default with no key in the environment.
  ({ app: off } = await testApp({ issuer: issuer.issuer, db: data.db, now }));
  undo.push(() => off.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const someone = async (kind: PersonKind) => data.track(await person(issuer, kind));
const { post } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => ({ solana: '', robinhood: '' }),
});
const PATH = '/v1/baskets/intake';

describe('POST /v1/baskets/intake', () => {
  it('reads each goal of the set through the replayed model, labelled mock, as the set expects', async () => {
    const who = await someone('solana');
    for (const g of evalSet.goals) {
      const res = await post(who, PATH, { text: g.text });
      expect(res.statusCode, `${g.id}: ${res.body}`).toBe(200);
      const body = IntakeResponse.parse(res.json());
      expect(body.reader, g.id).toEqual({
        method: 'model',
        model: 'claude-haiku-4-5',
        provenance: 'mock',
        why: null,
      });
      // Every field but the shared portfolio, which is on the shelf only where the database has it.
      expect({ ...body.draft, themes: null }, g.id).toEqual({ ...g.expect, themes: null });
    }
  });

  it('asks, takes the answers, says back the sheet, and the confirm makes the plan from it', async () => {
    const who = await someone('solana');
    const text = goal('pt-protect-reais-sem-acoes').text;
    const first = IntakeResponse.parse((await post(who, PATH, { text })).json());
    expect(first.sheet).toBeNull();
    expect(first.readBack).toBeNull();
    expect(first.questions.map((q) => q.field)).toEqual(['goal', 'amountUsd', 'risk']);
    expect(first.questions[1]?.text).toBe(
      'Você escreveu 3.000 BRL. Quanto é isso em dólares, a moeda em que o plano é aplicado?',
    );
    expect(first.flags).toContain('other_currency:amountUsd');

    const answers = { goal: 'protect', amountUsd: 550, risk: 'low' };
    const res = await post(who, PATH, { text, answers });
    expect(res.statusCode, res.body).toBe(200);
    const second = IntakeResponse.parse(res.json());
    expect(second.questions).toEqual([]);
    expect(second.sheet).toMatchObject({
      goal: 'protect',
      amountUsd: 550,
      horizonMonths: 12,
      currency: 'BRL',
      chains: ['solana'],
      language: 'pt',
      limits: { cannotHold: { classes: ['stock'] } },
    });
    expect(second.readBack?.[0]).toBe(
      'Você definiu um objetivo de proteção com US$ 550 em 12 meses, com risco baixo.',
    );
    // The person confirms: the sheet goes as it is to the engine.
    const plan = await post(who, '/v1/baskets/personalize', { sheet: second.sheet });
    expect(plan.statusCode, plan.body).toBe(200);
    const { proposal } = PersonalizeResponse.parse(plan.json());
    const { limits: _, ...sent } = second.sheet as NonNullable<typeof second.sheet>;
    expect(proposal.sheet).toEqual(sent);
  });

  it('the same goal sent 10 times gives one sheet, even from a model that answers differently each time', async () => {
    let n = 0;
    const base = recorded.replies['en-grow-10y-high'] as Record<string, unknown>;
    // A model that drifts: every other call it reads the risk as unclear and the goal as income.
    const drifting: ReadCall = async () => {
      n += 1;
      return { reply: n % 2 === 0 ? { ...base, goal: 'income', unclear: ['risk'] } : base };
    };
    const { app: own } = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now,
      intakeModel: budgetedModel(drifting, { provenance: 'mock' }),
    });
    try {
      const who = await someone('solana');
      const text = goal('en-grow-10y-high').text;
      const bodies = new Set<string>();
      for (let i = 0; i < 10; i += 1) {
        const res = await post(who, PATH, { text }, own);
        expect(res.statusCode, res.body).toBe(200);
        bodies.add(res.body);
      }
      expect(bodies.size).toBe(1);
      expect(n).toBe(1);
      const body = IntakeResponse.parse(JSON.parse([...bodies][0] as string));
      expect(body.sheet).toMatchObject({ goal: 'grow', amountUsd: 20_000, horizonMonths: 120 });
    } finally {
      await own.close();
    }
  });

  it('with no model configured, the rules parser fills the draft and the same questions are asked', async () => {
    const who = await someone('solana');
    const res = await post(who, PATH, { text: goal('en-grow-10y-high').text }, off);
    expect(res.statusCode, res.body).toBe(200);
    const body = IntakeResponse.parse(res.json());
    expect(body.reader).toEqual({
      method: 'rules',
      model: null,
      provenance: null,
      why: 'model_not_configured',
    });
    // What the rules parser read (the goal and the risk) is put to the person once, with its reading.
    expect(body.questions.map((q) => q.field)).toEqual([
      'goal',
      'amountUsd',
      'horizonMonths',
      'risk',
    ]);
    expect(body.questions.find((q) => q.field === 'risk')?.read).toBe('high');
    const done = await post(
      who,
      PATH,
      {
        text: goal('en-grow-10y-high').text,
        answers: {
          goal: 'grow',
          amountUsd: 20_000,
          horizonMonths: 120,
          risk: 'high',
        },
      },
      off,
    );
    expect(IntakeResponse.parse(done.json()).sheet).toMatchObject({ goal: 'grow', risk: 'high' });
  });

  it('a model that times out, or is out of its budget, falls back to the rules parser and says why', async () => {
    const slow: ReadCall = async () => ({ reply: null, why: 'model_timeout' });
    const budget: ReadCall = async () => ({ reply: recorded.replies['en-grow-10y-high'] });
    for (const [call, why, dailyCalls] of [
      [slow, 'model_timeout', 10],
      [budget, 'model_budget_spent', 0],
    ] as const) {
      const { app: own } = await testApp({
        issuer: issuer.issuer,
        db: data.db,
        now,
        intakeModel: budgetedModel(call, { provenance: 'mock', dailyCalls, now }),
      });
      try {
        const who = await someone('solana');
        const res = await post(who, PATH, { text: goal('en-grow-10y-high').text }, own);
        expect(res.statusCode, res.body).toBe(200);
        expect(IntakeResponse.parse(res.json()).reader).toMatchObject({ method: 'rules', why });
      } finally {
        await own.close();
      }
    }
  });

  it('one person cannot spend the day for everyone: past their own budget they get the rules parser', async () => {
    const { app: own } = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now,
      intakeModel: budgetedModel(callOf(), {
        provenance: 'mock',
        dailyCalls: 100,
        dailyCallsPerPerson: 1,
        now,
      }),
    });
    try {
      const [a, b] = [await someone('solana'), await someone('solana')];
      const first = goal('en-grow-10y-high').text;
      const second = goal('en-protect-18m-low').text;
      const readerOf = async (who: typeof a, text: string) =>
        IntakeResponse.parse((await post(who, PATH, { text }, own)).json()).reader;
      expect(await readerOf(a, first)).toMatchObject({ method: 'model' });
      expect(await readerOf(a, second)).toMatchObject({
        method: 'rules',
        why: 'model_person_budget_spent',
      });
      // A reply already read costs nothing; another person still has their own budget.
      expect(await readerOf(a, first)).toMatchObject({ method: 'model' });
      expect(await readerOf(b, second)).toMatchObject({ method: 'model' });
    } finally {
      await own.close();
    }
  });

  it("reads the follow-ups of the first chat of Oct 6 in the person's words, asking nothing twice", async () => {
    const who = await someone('solana');
    const [text = '', ...later] = chat.messages;
    const turn = async (n: number) => {
      const res = await post(who, PATH, { text, followUps: later.slice(0, n - 1) });
      expect(res.statusCode, res.body).toBe(200);
      return IntakeResponse.parse(res.json());
    };
    const first = await turn(1);
    expect(first.reader.provenance).toBe('mock');
    expect(first.questions.map((q) => q.field)).toEqual(['goal', 'sleeves', 'horizonMonths']);
    expect(first.flags).toContain('split_mismatch');
    // The second message answers all three in words; no country is asked (gate COUNTRY-REMOVED).
    const second = await turn(2);
    expect(second.questions).toEqual([]);
    expect(second.sheet).toMatchObject({
      goal: 'grow',
      amountUsd: 2000,
      risk: 'high',
      horizonOpen: true,
      rules: { useHoldings: true, glide: false },
      sleeves: [
        { kind: 'safe_yield', shareBps: 7000 },
        { kind: 'goal', shareBps: 3000 },
      ],
    });
    expect(second.readBack?.[0]).toBe(
      'You set a goal to grow with $2,000, with no date set, at high risk.',
    );
    expect(second.assumptions).toContain(
      'I took “go crazy” as high risk for the 30% that seeks the goal.',
    );
    // The confirm makes the plan from it.
    const plan = await post(who, '/v1/baskets/personalize', { sheet: second.sheet });
    expect(plan.statusCode, plan.body).toBe(200);
  });

  it('holds what the person says to hold: big tech, all in stocks, no risk question (EXPLICIT-MIX)', async () => {
    const who = await someone('solana');
    const [text = '', ...later] = bigTech.messages;
    // The Seven is on the shelf only where the database has it; where it has none, that is said.
    const onShelf = (await loadFamilies(data.db, 'solana')).some(
      (f) => f.meta.slug === 'the-seven',
    );
    const themes = onShelf ? ['the-seven'] : [];
    const turn = async (n: number) => {
      const res = await post(who, PATH, { text, followUps: later.slice(0, n - 1) });
      expect(res.statusCode, res.body).toBe(200);
      return IntakeResponse.parse(res.json());
    };
    // The first message says no mix and no risk: the risk is asked, once.
    const first = await turn(1);
    expect(first.reader.provenance).toBe('mock');
    expect(first.questions.map((q) => q.field)).toEqual(['risk']);
    expect(first.draft.themes).toEqual(onShelf ? themes : null);
    expect(first.mix).toBeNull();
    // "I want all of it in stocks": the plan holds it, and the risk is not asked again.
    const second = await turn(2);
    expect(second.questions).toEqual([]);
    expect(second.mix).toEqual({ growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 });
    expect(second.sheet).toMatchObject({
      goal: 'grow',
      amountUsd: 2000,
      horizonMonths: 60,
      risk: 'high',
      themes,
      rules: { useHoldings: true, glide: false },
      mix: { growthBps: 10_000 },
    });
    expect(second.sheet?.horizonOpen).toBeUndefined();
    expect(
      second.assumptions.filter(
        (s) => s === 'To hold “all of it in stocks”, the plan uses the limits for high risk.',
      ),
    ).toHaveLength(1);
    if (onShelf) expect(second.readBack).toContain('The plan starts from The Seven.');
    else
      expect(second.assumptions).toContain(
        'No shared portfolio on your chain holds “big tech” yet, so the plan does not start from one.',
      );
  });

  it('a person with no chain yet is asked to pick one, and no sheet is made', async () => {
    const who = await someone('passkey');
    const res = await post(who, PATH, {
      text: goal('en-grow-10y-high').text,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = IntakeResponse.parse(res.json());
    expect(body.questions.map((q) => q.field)).toEqual(['chains']);
    expect(body.sheet).toBeNull();
  });

  it('refuses a body it cannot read before any model is asked, and nobody signed in', async () => {
    const who = await someone('solana');
    const before = replayed.calls();
    for (const bad of [
      {},
      { text: 'hi' },
      { text: 'x'.repeat(2001) },
      { text: 'Grow $5,000', answers: { risk: 'extreme' } },
      { text: 'Grow $5,000', answers: { amountUsd: 5 } },
      { text: 'Grow $5,000', answers: { weights: { nvda: 5000 } } },
      { text: 'Grow $5,000', language: 'fr' },
    ]) {
      const res = await post(who, PATH, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(replayed.calls()).toBe(before);
    const nobody = await post(null, PATH, { text: goal('en-grow-10y-high').text });
    expect(nobody.statusCode).toBe(401);
  });
});
