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
  narratives: { cases: Record<string, { text: string; reply: unknown }> };
  refusals: { cases: Record<string, { text: string; reply: unknown }> };
};
// A goal that writes a refusal, with a reply that reads the goal and misses the refusal. MOCK.
const noStocks = recorded.refusals.cases['no-stocks-missed'] as { text: string; reply: unknown };
// A goal that names a market the fixed lists have no word for, with the filter the model names for it
// (gate THEME-MATCHED). MOCK, like every reply here.
const obesityDrugs = recorded.narratives.cases['obesity-drugs'] as { text: string; reply: unknown };
const chat = recorded.conversations['first-chat-oct6'] as {
  messages: string[];
  replies: unknown[];
};
// The chat that asked the risk twice and found no big tech list (gate EXPLICIT-MIX, Oct 6).
const bigTech = recorded.conversations['big-tech-chat-oct6'] as {
  messages: string[];
  replies: unknown[];
};
// A share of the money said in words on a later turn ("70-30", "half", "all of it in stocks"), in
// answer to "How much of the $2,000 for big tech?" (the review of Oct 6). MOCK, like every reply here.
const inWords = (['pair', 'half', 'mix'] as const).map(
  (name) =>
    recorded.conversations[`share-in-words-${name}`] as { messages: string[]; replies: unknown[] },
);
// The conversation's replies, by the text each turn reads: the messages so far, joined as the route joins them.
const replyByText = new Map<string, unknown>([
  ...evalSet.goals.map((g): [string, unknown] => [g.text, recorded.replies[g.id]]),
  [obesityDrugs.text, obesityDrugs.reply],
  [noStocks.text, noStocks.reply],
  ...[chat, bigTech, ...inWords].flatMap((c) =>
    c.replies.map((r, i): [string, unknown] => [c.messages.slice(0, i + 1).join('\n\n'), r]),
  ),
]);
const goal = (id: string) => evalSet.goals.find((g) => g.id === id) as (typeof evalSet.goals)[0];

/** The recorded replies, by text, as a raw call. */
const callOf = (): ReadCall => async (text) => {
  const reply = replyByText.get(text);
  return reply === undefined ? { reply: null, why: 'model_error' } : { reply };
};

/**
 * A replay of the recorded replies, by text; `calls` counts what reached it, and `vocabularies` keeps
 * the attribute values each call was handed.
 */
function replay(): { model: IntakeModel; calls: () => number; vocabularies: () => unknown[] } {
  let calls = 0;
  const vocabularies: unknown[] = [];
  const call: ReadCall = async (text, _month, _language, vocabulary) => {
    calls += 1;
    vocabularies.push(vocabulary);
    const reply = replyByText.get(text);
    return reply === undefined ? { reply: null, why: 'model_error' } : { reply };
  };
  return {
    model: budgetedModel(call, { id: 'claude-haiku-4-5', provenance: 'mock' }),
    calls: () => calls,
    vocabularies: () => vocabularies,
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
    // The time frame is said back as the person wrote it: a year, not 12 months.
    expect(second.readBack?.[0]).toBe(
      'Você definiu um objetivo de proteção com US$ 550 em 1 ano, com risco baixo.',
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
    // The Seven on the person's shelf, as on the launch shelf; put there for this test where the
    // database has none, and deleted at the end.
    const onShelf = (await loadFamilies(data.db, 'solana')).some(
      (f) => f.meta.slug === 'the-seven',
    );
    if (!onShelf)
      await data.storeFamily(
        'solana',
        [
          { kind: 'asset', asset: 'solana:nvda', weightBps: 5000 },
          { kind: 'asset', asset: 'solana:spy', weightBps: 5000 },
        ],
        { slug: 'the-seven', name: 'The Seven' },
      );
    const turn = async (n: number) => {
      const res = await post(who, PATH, { text, followUps: later.slice(0, n - 1) });
      expect(res.statusCode, res.body).toBe(200);
      return IntakeResponse.parse(res.json());
    };
    const expected = {
      goal: 'grow',
      amountUsd: 2000,
      horizonMonths: 60,
      risk: 'high',
      themes: ['the-seven'],
      rules: { useHoldings: true, glide: false },
      mix: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
    };
    // Turn 1: "invest in the big tech industry" is the whole 2k, held: nothing is asked, the risk least.
    const first = await turn(1);
    expect(first.reader.provenance).toBe('mock');
    expect(first.questions.map((q) => q.field)).not.toContain('risk');
    expect(first.questions).toEqual([]);
    expect(first.flags).toContain('mix_from_market');
    expect(first.sheet).toMatchObject(expected);
    // Turn 2: "I want all of it in stocks" confirms it; the risk is still not asked.
    const second = await turn(2);
    expect(second.questions).toEqual([]);
    expect(second.mix).toEqual(expected.mix);
    expect(second.sheet).toMatchObject(expected);
    expect(second.sheet?.horizonOpen).toBeUndefined();
    expect(second.assumptions.filter((s) => /the limits for/.test(s))).toEqual([
      'To hold “all of it in stocks”, the plan uses the limits for high risk.',
    ]);
    expect(second.readBack).toContain('The plan starts from The Seven.');
  });

  it('says what each market the text names reads to on the person chain (THEMES, THEME-MATCHED)', async () => {
    const who = await someone('solana');
    // Big tech with The Seven on the person's shelf (put there as in the test above where the
    // database has none, and deleted at the end): a shared portfolio.
    if (!(await loadFamilies(data.db, 'solana')).some((f) => f.meta.slug === 'the-seven'))
      await data.storeFamily(
        'solana',
        [
          { kind: 'asset', asset: 'solana:nvda', weightBps: 5000 },
          { kind: 'asset', asset: 'solana:spy', weightBps: 5000 },
        ],
        { slug: 'the-seven', name: 'The Seven' },
      );
    const big = IntakeResponse.parse((await post(who, PATH, { text: bigTech.messages[0] })).json());
    expect(big.narratives).toEqual([
      {
        id: 'big_tech',
        words: 'big tech',
        kind: 'portfolio',
        slug: 'the-seven',
        filter: null,
        name: 'The Seven',
      },
    ]);
    // A market only the model names, by a filter. This server hands the intake no labels and no
    // attributes yet, so nothing matches: the one sentence is said, on the person's chain, and the
    // model's value is said nowhere.
    const res = await post(who, PATH, { text: obesityDrugs.text });
    expect(res.statusCode, res.body).toBe(200);
    const none = IntakeResponse.parse(res.json());
    expect(none.reader.provenance).toBe('mock');
    expect(none.narratives).toEqual([
      { id: null, words: 'obesity drugs', kind: 'none', slug: null, filter: null, name: null },
    ]);
    expect(none.flags).toEqual(
      expect.arrayContaining(['filter_no_match:marketFilter', 'market_not_on_shelf:marketFilter']),
    );
    expect(none.assumptions).toEqual([
      'There is no stock for “obesity drugs” on Solana at the moment. We will be adding more soon.',
    ]);
    expect(res.body).not.toMatch(/GLP-1/);
    // Nothing is held for it (gate THEME-NONE-YET): no mix, no theme sleeve, no share asked. The rest
    // goes on as if it had not been named, so the risk is asked as for any goal.
    expect(none.questions.map((q) => q.field)).toEqual(['risk']);
    expect(none.mix).toBeNull();
    expect(none.draft.sleeves).toBeNull();
    const answered = IntakeResponse.parse(
      (await post(who, PATH, { text: obesityDrugs.text, answers: { risk: 'medium' } })).json(),
    );
    expect(answered.questions).toEqual([]);
    expect(answered.sheet).toMatchObject({ risk: 'medium', themes: [] });
    expect(answered.sheet?.sleeves).toBeUndefined();
    expect(answered.sheet?.mix).toBeUndefined();
    expect(answered.readBack).toEqual([
      'You set a goal to grow with $2,000 over 5 years, at medium risk.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      'There is no stock for “obesity drugs” on Solana at the moment. We will be adding more soon.',
      'Nothing moves toward cash as the date nears unless you ask for it.',
      'If this is right, confirm it and the plan is made from it.',
    ]);
    // The route has no attribute values to hand the model: no call was given any.
    expect(replayed.vocabularies().length).toBeGreaterThan(0);
    expect(replayed.vocabularies().filter((v) => v !== undefined)).toEqual([]);
  });

  it('reads a share or a mix said in words on a later turn as the answer to "how much" (EXPLICIT-MIX, the review of Oct 6)', async () => {
    const who = await someone('solana');
    // The Seven on the person's shelf, as in the tests above.
    if (!(await loadFamilies(data.db, 'solana')).some((f) => f.meta.slug === 'the-seven'))
      await data.storeFamily(
        'solana',
        [
          { kind: 'asset', asset: 'solana:nvda', weightBps: 5000 },
          { kind: 'asset', asset: 'solana:spy', weightBps: 5000 },
        ],
        { slug: 'the-seven', name: 'The Seven' },
      );
    const mixOf = (growthBps: number) => ({
      growthBps,
      dollarYieldBps: 0,
      goldBps: 0,
      cashBps: 10_000 - growthBps,
    });
    for (const [conversation, growthBps, risk] of [
      [inWords[0], 7000, 'medium'],
      [inWords[1], 5000, 'low'],
      [inWords[2], 10_000, 'high'],
    ] as const) {
      const [text = '', ...later] = conversation?.messages ?? [];
      const said = later[0] ?? '';
      // Turn 1: a market with no share said asks how much of the money, once, and never the risk.
      const first = IntakeResponse.parse((await post(who, PATH, { text })).json());
      expect(first.reader.provenance, said).toBe('mock');
      expect(first.questions, said).toEqual([
        { field: 'mix', template: 'marketShare', text: 'How much of the $2,000 for big tech?' },
      ]);
      expect(first.sheet, said).toBeNull();
      // Turn 2: the person answers in their own words, as a follow-up and not as a form field.
      const res = await post(who, PATH, { text, followUps: later });
      expect(res.statusCode, res.body).toBe(200);
      const second = IntakeResponse.parse(res.json());
      expect(second.reader, said).toMatchObject({ method: 'model', provenance: 'mock' });
      expect(second.flags, said).toContain('mix_from_words');
      expect(second.questions, said).toEqual([]);
      expect(second.mix, said).toEqual(mixOf(growthBps));
      expect(second.sheet, said).toMatchObject({
        goal: 'grow',
        amountUsd: 2000,
        horizonMonths: 60,
        risk,
        themes: ['the-seven'],
        mix: mixOf(growthBps),
      });
      expect(second.sheet?.sleeves, said).toBeUndefined();
      expect(second.readBack?.[0], said).toBe('You set a goal to grow with $2,000 over 5 years.');
      // The same answer on the form gives the same sheet: the words are read as the field is.
      const byForm = IntakeResponse.parse(
        (await post(who, PATH, { text, answers: { mix: mixOf(growthBps) } })).json(),
      );
      expect(byForm.sheet, said).toEqual(second.sheet);
      // The confirm makes the plan from it.
      const plan = await post(who, '/v1/baskets/personalize', { sheet: second.sheet });
      expect(plan.statusCode, plan.body).toBe(200);
    }
    // With no model configured the words are read the same way, once what the rules parser read is
    // answered.
    const [text = ''] = inWords[0]?.messages ?? [];
    const rules = await post(
      who,
      PATH,
      {
        text,
        followUps: ['70-30'],
        answers: { goal: 'grow', amountUsd: 2000, horizonMonths: 60 },
      },
      off,
    );
    expect(rules.statusCode, rules.body).toBe(200);
    const byRules = IntakeResponse.parse(rules.json());
    expect(byRules.reader.method).toBe('rules');
    expect(byRules.flags).toContain('mix_from_words');
    expect(byRules.sheet).toMatchObject({
      themes: ['the-seven'],
      mix: mixOf(7000),
      risk: 'medium',
    });
  });

  it('asks a mix the person only wonders about, with the reading as the question start, and builds nothing from what the text rules out', async () => {
    const who = await someone('solana');
    const ask = async (text: string) => {
      const res = await post(
        who,
        PATH,
        { text, answers: { goal: 'grow', amountUsd: 5000, horizonMonths: 60, risk: 'medium' } },
        off,
      );
      expect(res.statusCode, res.body).toBe(200);
      return IntakeResponse.parse(res.json());
    };
    const wondered = await ask(
      'I want to grow $5,000 over 5 years. Should I put all of it in stocks?',
    );
    expect(wondered.mix).toBeNull();
    expect(wondered.sheet).toBeNull();
    // The question carries the mix it asks about: a mix is a value `read` may hold.
    expect(wondered.questions).toEqual([
      {
        field: 'mix',
        template: 'mix',
        text: 'How do you want the money held: how much in stocks and crypto, and how much in cash?',
        read: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
      },
    ]);
    // The review's sentences, through HTTP: no mix, no market, no question about either.
    for (const sentence of [
      'I am retired so no stocks please.',
      "I wouldn't put all of it in stocks.",
      "I don't want to invest in big tech.",
      'I already invest in the S&P 500 through my pension.',
    ]) {
      const body = await ask(`I want to grow $5,000 over 5 years. ${sentence}`);
      expect(body.mix, sentence).toBeNull();
      expect(body.narratives, sentence).toEqual([]);
      expect(body.questions, sentence).toEqual([]);
      expect(body.sheet, sentence).toMatchObject({ risk: 'medium', themes: [] });
      expect(body.sheet?.mix, sentence).toBeUndefined();
    }
  });

  it('a refusal the text writes is carried to the sheet and said back, with no model and where the model misses it', async () => {
    const who = await someone('solana');
    const limits = { cannotHold: { classes: ['stock'] } };
    // No model configured: the rules reader reads the goal, and code reads the refusal.
    const first = await post(who, PATH, { text: noStocks.text }, off);
    expect(first.statusCode, first.body).toBe(200);
    const asked = IntakeResponse.parse(first.json());
    expect(asked.reader).toMatchObject({ method: 'rules', why: 'model_not_configured' });
    // Read at once, and not asked: the refusal is no question.
    expect(asked.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['stock'] });
    expect(asked.questions.map((q) => q.field)).toEqual([
      'goal',
      'amountUsd',
      'horizonMonths',
      'risk',
    ]);
    const answers = { goal: 'grow', amountUsd: 20_000, horizonMonths: 36, risk: 'low' };
    const res = await post(who, PATH, { text: noStocks.text, answers }, off);
    expect(res.statusCode, res.body).toBe(200);
    const byRules = IntakeResponse.parse(res.json());
    expect(byRules.questions).toEqual([]);
    expect(byRules.mix).toBeNull();
    expect(byRules.sheet).toMatchObject({ goal: 'grow', amountUsd: 20_000, risk: 'low', limits });
    expect(byRules.sheet?.mix).toBeUndefined();
    expect(byRules.readBack).toEqual([
      'You set a goal to grow with $20,000 over 3 years, at low risk.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      'You left out stocks.',
      'Nothing moves toward cash as the date nears unless you ask for it.',
      'If this is right, confirm it and the plan is made from it.',
    ]);
    // With a model whose reply misses the refusal: the text's is taken, and the disagreement flagged.
    const read = await post(who, PATH, { text: noStocks.text, answers: { risk: 'low' } });
    expect(read.statusCode, read.body).toBe(200);
    const byModel = IntakeResponse.parse(read.json());
    expect(byModel.reader).toMatchObject({ method: 'model', provenance: 'mock' });
    expect(byModel.flags).toContain('disagrees_with_rules:cannotHold:stock');
    expect(byModel.sheet).toMatchObject({ limits });
    expect(byModel.readBack).toContain('You left out stocks.');
    expect(byModel.sheet).toEqual(byRules.sheet);
    // "Sem crédito", with no model.
    const pt = IntakeResponse.parse(
      (
        await post(
          who,
          PATH,
          {
            text: 'Quero fazer US$ 20.000 crescer por 3 anos, sem crédito.',
            language: 'pt',
            answers,
          },
          off,
        )
      ).json(),
    );
    expect(pt.sheet).toMatchObject({ limits: { creditTolerance: 'none' } });
    expect(pt.readBack).toContain('Nenhum token que empresta a tomadores ou opera um spread.');
    // A refusal the person is not sure of is not taken, and that is said.
    const unsure = IntakeResponse.parse(
      (
        await post(
          who,
          PATH,
          { text: 'I want to grow $20,000 for 3 years at low risk. No stocks? Not sure.', answers },
          off,
        )
      ).json(),
    );
    expect(unsure.limits).toEqual({ creditTolerance: null, cannotHoldClasses: null });
    expect(unsure.flags).toContain('refusal_wondered:stock');
    expect(unsure.sheet?.limits).toBeUndefined();
    expect(unsure.readBack).toContain(
      'I did not read “No stocks” as something to leave out. Say so if you want it left out.',
    );
    // The confirm takes the sheet with its limits as it is.
    const plan = await post(who, '/v1/baskets/personalize', { sheet: byRules.sheet });
    expect(plan.statusCode, plan.body).toBe(200);
  });

  it('with no chain yet, a market the text names is not resolved, and nothing is said of it', async () => {
    const who = await someone('passkey');
    const res = await post(who, PATH, { text: obesityDrugs.text });
    expect(res.statusCode, res.body).toBe(200);
    const body = IntakeResponse.parse(res.json());
    expect(body.narratives).toEqual([]);
    expect(body.flags).toContain('market_unresolved:marketFilter');
    expect(body.questions.map((q) => q.field)).toEqual(['chains']);
    expect(body.assumptions.join(' ')).not.toMatch(/no stock/);
    expect(body.sheet).toBeNull();
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
