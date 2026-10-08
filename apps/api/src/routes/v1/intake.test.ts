import { readFileSync } from 'node:fs';
import { mockAssets } from '@colosseum/chain-mock';
import {
  attributeVocabularyOf,
  parseStockAttributes,
  riskForMix,
  riskForSleeves,
} from '@colosseum/engine/personal';
import { ChainError } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { budgetedModel, type IntakeModel, type ReadCall } from '../../llm';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { loadFamilies } from '../../orders/store';
import { bearingPlanInputs } from '../../plan-inputs';
import { loadStockAttributes } from '../../stock-attributes';
import mockStocks from '../../testing/fixtures/mock-stocks.json';
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

// The engine's two rules for the limits a holding takes, watched as the route calls them. The calls
// go through to the engine unchanged; the tests read what it was handed and what it answered.
vi.mock('@colosseum/engine/personal', async (original) => {
  const actual = await original<typeof import('@colosseum/engine/personal')>();
  return {
    ...actual,
    riskForMix: vi.fn(actual.riskForMix),
    riskForSleeves: vi.fn(actual.riskForSleeves),
  };
});

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

// MOCK: the attributes of the mock chain's stand-in stocks (a fixture labelled mock), with one
// keyword that two of the names the chain lists carry; the fixture gives it to one. The mock chain
// lists three stocks and no attribute of the fixture is shared by two of them, and a filter that
// matches one name alone is never used to pick that stock (the second review, Oct 7).
const twoNames = {
  ...mockStocks,
  stocks: mockStocks.stocks.map((row) =>
    row.symbol === 'TSLAx' ? { ...row, keywords: [...row.keywords, 'data centers'] } : row,
  ),
};
// MOCK too: two of the chain's lists handed in as proposed. Every real list is confirmed (gate
// LABELS-CONFIRMED, Oct 7), so the rule for one that is not (it fills nothing, and the filters of
// the word list are read) is held on these.
const PROPOSED = ['ai-infrastructure', 'semiconductors'];
const withMockStocks: PlanInputs = async (q) => {
  const figures = await bearingPlanInputs(q);
  return {
    ...figures,
    ...(q.chain === 'solana' ? { stocks: parseStockAttributes(twoNames, 'mock-stocks.json') } : {}),
    ...(figures.themes
      ? {
          themes: figures.themes.map((list) =>
            PROPOSED.includes(list.slug) ? { ...list, status: 'proposed' as const } : list,
          ),
        }
      : {}),
  };
};

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let off: FastifyInstance;
let mocked: FastifyInstance;
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
  // No model, and the MOCK attributes and the two MOCK proposed lists above as the chain's.
  ({ app: mocked } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    now,
    planInputs: withMockStocks,
  }));
  undo.push(() => mocked.close());
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
      // "Sem ações": no stocks, and none through a fund of stocks either.
      limits: { cannotHold: { classes: ['etf', 'stock'] } },
    });
    expect(second.readBack).toContain('Você deixou de fora ações e fundos de ações.');
    // The time frame is said back as the person wrote it: a year, not 12 months.
    expect(second.readBack?.[0]).toBe(
      'Você definiu um objetivo de proteção com US$ 550 em 1 ano, com risco baixo.',
    );
    // The person confirms. Plans are in US dollars for now (gate USD-ONLY, Thom, Oct 6): a sheet whose
    // goal is in reais is refused with its own code, and the same sheet in dollars goes as it is to
    // the engine.
    const inReais = await post(who, '/v1/baskets/personalize', { sheet: second.sheet });
    expect(inReais.statusCode, inReais.body).toBe(422);
    expect(inReais.json().code).toBe('CURRENCY_UNSUPPORTED');
    const { currency: _currency, ...inDollars } = second.sheet as NonNullable<typeof second.sheet>;
    const plan = await post(who, '/v1/baskets/personalize', { sheet: inDollars });
    expect(plan.statusCode, plan.body).toBe(200);
    const { proposal } = PersonalizeResponse.parse(plan.json());
    const { limits: _, ...sent } = inDollars;
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
      const logged: string[] = [];
      const { app: own } = await testApp({
        issuer: issuer.issuer,
        db: data.db,
        now,
        intakeModel: budgetedModel(call, { id: 'a-model', provenance: 'mock', dailyCalls, now }),
        logTo: { write: (line) => logged.push(line) },
      });
      try {
        const who = await someone('solana');
        const text = goal('en-grow-10y-high').text;
        const res = await post(who, PATH, { text }, own);
        expect(res.statusCode, res.body).toBe(200);
        expect(IntakeResponse.parse(res.json()).reader).toMatchObject({ method: 'rules', why });
        // and the log says so, at warn, with why and the request's id, and no word of the goal
        const fell = logged
          .map((line) => JSON.parse(line))
          .filter((line) => line.msg === 'the intake fell back to the rules parser');
        expect(fell).toHaveLength(1);
        expect(fell[0]).toMatchObject({ level: 40, why, model: 'a-model' });
        expect(fell[0].reqId).toBeTruthy();
        expect(logged.join('\n')).not.toContain(text.slice(0, 20));
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
    // A market only the model names, by a filter. No tracked stock of the person's chain carries the
    // value, so nothing matches: the one sentence is said, on the person's chain, and the model's
    // value is said nowhere.
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
    // The model is handed our own keywords for the person's chain, the ones a filter can select by,
    // and nothing else: no name of the stock classification (DESIGN-VAULT section 17, item 30), no
    // symbol and no company's name.
    const stocks = loadStockAttributes('solana');
    if (!stocks) throw new Error('no stock attributes for solana');
    const keywords = attributeVocabularyOf(stocks).keywords;
    expect(keywords.length).toBeGreaterThan(0);
    const given = replayed.vocabularies();
    expect(given.length).toBeGreaterThan(0);
    for (const vocabulary of given)
      expect(vocabulary).toEqual({ sectors: [], industries: [], subIndustries: [], keywords });
    const names = stocks.stocks.flatMap((row) => [row.symbol, row.underlying, row.company]);
    for (const name of names) expect(keywords, name).not.toContain(name.toLowerCase());
  });

  // Where the intake meets the labels and the attributes (the wiring, on this branch only): the
  // route hands the intake the chain's curated lists, what a filter matches there and the engine's
  // own rule for a mix's limits, as `POST /v1/baskets/personalize` is handed its inputs.
  it('reads a market to a confirmed label, to a filter over the stock attributes, or to nothing, on the chain’s own shelf', async () => {
    const who = await someone('solana');
    const answers = { goal: 'grow', amountUsd: 2000, horizonMonths: 60 };
    const ask = async (text: string, followUps: string[] = []) =>
      IntakeResponse.parse(
        (
          await post(who, PATH, {
            text,
            answers,
            // The form was answered before the messages: a plain yes then answers the one question.
            ...(followUps.length ? { followUps, answersThen: followUps.map(() => answers) } : {}),
          })
        ).json(),
      );
    const WHOLE = { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 };
    // These texts have no recorded reply, so the rules parser reads them. With no model a holding
    // the text states is asked once, with it as the question's start, and never taken (the second
    // review, Oct 7): a plain yes holds what the person wrote.
    // AI: the Solana list is confirmed (gate THEME-AI-SOLANA) and the chain lists names of it.
    const aiText = 'I want to invest $2,000 in AI for 5 years';
    const aiAsked = await ask(aiText);
    expect(aiAsked.reader.method).toBe('rules');
    expect(aiAsked.sheet).toBeNull();
    expect(aiAsked.questions).toEqual([
      {
        field: 'mix',
        template: 'marketShare',
        text: 'How much of the $2,000 for AI?',
        read: WHOLE,
      },
    ]);
    const ai = await ask(aiText, ['yes']);
    expect(ai.flags).toContain('mix_confirmed');
    expect(ai.narratives).toEqual([
      { id: 'ai', words: 'AI', kind: 'label', slug: 'ai', filter: null, name: 'AI' },
    ]);
    expect(ai.questions).toEqual([]);
    expect(ai.sheet?.sleeves).toEqual([{ kind: 'theme', theme: 'ai', shareBps: 10_000 }]);
    expect(ai.readBack?.join(' ')).toContain('100% of the plan for the theme AI.');
    // AI infrastructure and semiconductors: their Solana lists are confirmed too (gate
    // LABELS-CONFIRMED, Oct 7), so each reads to its list, as AI does, and no filter is read for it.
    const centersText = 'I want to invest $2,000 in data centers for 5 years';
    const chipsText = 'I want to invest $2,000 in semiconductors for 5 years';
    const centers = await ask(centersText, ['yes']);
    expect(centers.narratives).toEqual([
      {
        id: 'ai_infrastructure',
        words: 'data centers',
        kind: 'label',
        slug: 'ai-infrastructure',
        filter: null,
        name: 'AI infrastructure',
      },
    ]);
    expect(centers.flags).not.toContain('label_proposed:ai-infrastructure');
    expect(centers.sheet?.sleeves).toEqual([
      { kind: 'theme', theme: 'ai-infrastructure', shareBps: 10_000 },
    ]);
    expect(centers.readBack?.join(' ')).toContain(
      '100% of the plan for the theme AI infrastructure.',
    );
    // Semiconductors: its Solana list names one stock, and the chain lists it. A list a person
    // confirmed is held where a filter that matches one name is not (below): the name up to the most
    // a plan holds in one stock at its risk, and the rest of the sleeve in dollar yield, then cash,
    // each line saying which it is.
    const chips = await ask(chipsText, ['yes']);
    expect(chips.narratives).toEqual([
      {
        id: 'semiconductors',
        words: 'semiconductors',
        kind: 'label',
        slug: 'semiconductors',
        filter: null,
        name: 'Semiconductors',
      },
    ]);
    expect(chips.flags).not.toContain('label_proposed:semiconductors');
    expect(chips.sheet?.sleeves).toEqual([
      { kind: 'theme', theme: 'semiconductors', shareBps: 10_000 },
    ]);
    const oneName = await post(who, '/v1/baskets/personalize', { sheet: chips.sheet });
    expect(oneName.statusCode, oneName.body).toBe(200);
    const held = PersonalizeResponse.parse(oneName.json()).proposal;
    const rulesOf = (line: (typeof held.lines)[number]) => line.reasons.map((r) => r.rule);
    const names = held.lines.filter((l) => rulesOf(l).includes('THEME_MEMBER'));
    expect(names.map(rulesOf)).toEqual([expect.arrayContaining(['SINGLE_STOCK_CAP'])]);
    const rest = held.lines.filter((l) => rulesOf(l).includes('OVERFLOW_STOCK_CAP'));
    expect(rest.length).toBeGreaterThan(0);
    // The one name and the lines that say what was meant for it are the whole plan: no part of the
    // sleeve is held without its reason.
    expect([...names, ...rest].reduce((bps, l) => bps + l.weightBps, 0)).toBe(10_000);
    expect(names[0]?.weightBps).toBeLessThan(10_000);
    // A list that is only proposed fills nothing (gate THEMES), so the filters of the word list are
    // read for its narrative. No real list is proposed any more: the rule is held on the MOCK lists
    // and the MOCK attributes of `mocked`. There the AI infrastructure list is proposed, so the
    // filter is read (keyword data centers), and the chain lists two names that carry it. Said as
    // matched, not curated.
    const onMock = async (text: string, followUps: string[] = []) =>
      IntakeResponse.parse(
        (
          await post(
            who,
            PATH,
            {
              text,
              answers,
              ...(followUps.length ? { followUps, answersThen: followUps.map(() => answers) } : {}),
            },
            mocked,
          )
        ).json(),
      );
    expect((await onMock(centersText)).questions).toMatchObject([
      { field: 'mix', template: 'marketShare', read: WHOLE },
    ]);
    const semis = await onMock(centersText, ['yes']);
    const slug = 'matched-keyword-data-centers';
    expect(semis.narratives).toMatchObject([
      {
        id: 'ai_infrastructure',
        kind: 'matched',
        slug,
        filter: { by: 'keyword', value: 'data centers' },
      },
    ]);
    expect(semis.flags).toContain('label_proposed:ai-infrastructure');
    expect(semis.sheet?.sleeves).toEqual([{ kind: 'theme', theme: slug, shareBps: 10_000 }]);
    expect(semis.assumptions.join(' ')).toContain(
      'the plan holds the names matched by keyword: data centers. Matched from the sourced attributes of each, not a curated theme.',
    );
    // And the sheet it gives is one the plan route builds: the sleeve holds the matched names.
    const built = await post(who, '/v1/baskets/personalize', { sheet: semis.sheet }, mocked);
    expect(built.statusCode, built.body).toBe(200);
    const { proposal } = PersonalizeResponse.parse(built.json());
    expect(
      proposal.lines.some((l) => l.reasons.some((r) => r.rule === 'THEME_MATCHED_MEMBER')),
    ).toBe(true);
    // Semiconductors, on the same MOCK lists: its list is proposed too, and its filter matches one
    // name alone on the chain. A filter is never used to pick one stock (Oct 7): nothing is held, and
    // the line says why.
    const one = await onMock(chipsText);
    expect(one.narratives).toMatchObject([{ id: 'semiconductors', kind: 'none', slug: null }]);
    expect(one.flags).toEqual(
      expect.arrayContaining(['label_proposed:semiconductors', 'filter_one_name:semiconductors']),
    );
    expect(one.assumptions).toEqual([
      'There is only one stock for “semiconductors” on Solana at the moment, and a theme is not made of one. We will be adding more soon. The nearest today is AI, which you can choose.',
    ]);
    expect(one.questions.map((q) => q.field)).toEqual(['risk']);
    // Quantum computing: no label on Solana and no stock that carries it. The founder's sentence,
    // with the nearest list the chain can hold, nothing held for it, and the risk asked as for any
    // goal (gate THEME-NONE-YET).
    const none = await ask('I want to invest $2,000 in quantum computing for 5 years');
    expect(none.narratives).toMatchObject([{ id: 'quantum', kind: 'none', slug: null }]);
    expect(none.assumptions).toEqual([
      'There is no stock for “quantum computing” on Solana at the moment, and we will be adding more soon. The nearest today is AI, which you can choose.',
    ]);
    expect(none.questions.map((q) => q.field)).toEqual(['risk']);
    expect(none.draft.sleeves).toBeNull();
    expect(none.mix).toBeNull();
  });

  // The wiring of the second review (Oct 7): what the route hands the intake beside the labels and
  // the matches. The engine's rule for a mix does not depend on the amount on this branch, so the
  // amount is held by what the engine was handed, not by a risk that differs.
  it('asks the engine the risk of a mix and of theme sleeves at the amount of the person, and at a fixed one until it is known', async () => {
    const who = await someone('solana');
    const ask = async (body: Record<string, unknown>) =>
      IntakeResponse.parse((await post(who, PATH, body)).json());
    const mix = { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 };
    const lastOf = <T extends (...args: never[]) => unknown>(rule: T) => ({
      handed: vi.mocked(rule).mock.calls.at(-1)?.[0],
      answered: vi.mocked(rule).mock.results.at(-1)?.value,
    });
    // A mix, with the amount: the engine is asked at the person's $2,000, and its answer is the
    // sheet's risk and the one the read-back names.
    vi.mocked(riskForMix).mockClear();
    const known = await ask({
      text: 'Grow my savings.',
      answers: { goal: 'grow', amountUsd: 2000, horizonMonths: 60, mix },
    });
    expect(known.sheet).toMatchObject({ amountUsd: 2000, mix });
    expect(lastOf(riskForMix).handed).toMatchObject({ amountUsd: 2000, mix, chains: ['solana'] });
    expect(known.sheet?.risk).toBe(lastOf(riskForMix).answered);
    expect(known.assumptions.join(' ')).toContain(`the limits for ${known.sheet?.risk} risk.`);
    // Before the amount is known a fixed figure stands in, and the amount is still asked.
    vi.mocked(riskForMix).mockClear();
    const unknown = await ask({
      text: 'Grow my savings.',
      answers: { goal: 'grow', horizonMonths: 60, mix },
    });
    expect(unknown.questions.map((q) => q.field)).toEqual(['amountUsd']);
    expect(lastOf(riskForMix).handed).toMatchObject({ amountUsd: 10_000, mix });
    // A sheet held in themes: the engine's own rule, at the person's amount, not the intake's
    // estimate on the issuer caps.
    vi.mocked(riskForSleeves).mockClear();
    const ai = await ask({
      text: 'I want to invest $2,000 in AI for 5 years',
      answers: { goal: 'grow', amountUsd: 2000, horizonMonths: 60 },
      followUps: ['yes'],
      // The form was answered before the yes was sent.
      answersThen: [{ goal: 'grow', amountUsd: 2000, horizonMonths: 60 }],
    });
    const sleeves = [{ kind: 'theme', theme: 'ai', shareBps: 10_000 }];
    expect(ai.sheet?.sleeves).toEqual(sleeves);
    expect(lastOf(riskForSleeves).handed).toMatchObject({
      amountUsd: 2000,
      sleeves,
      chains: ['solana'],
    });
    expect(ai.flags).toContain('risk_from_themes');
    expect(ai.sheet?.risk).toBe(lastOf(riskForSleeves).answered);
    expect(ai.assumptions).toContain(
      `To hold “AI”, the plan uses the limits for ${ai.sheet?.risk} risk.`,
    );
    // And the plan route builds that sheet at that risk.
    const built = await post(who, '/v1/baskets/personalize', { sheet: ai.sheet });
    expect(built.statusCode, built.body).toBe(200);
    expect(PersonalizeResponse.parse(built.json()).proposal.sheet.risk).toBe(ai.sheet?.risk);
  });

  it('where what the chain lists cannot be read, resolves nothing on it, makes no sheet from a goal that names a theme, and says so', async () => {
    // The chain's adapter does not answer: the route cannot read its tokens.
    const dark = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now,
      wrap: (inner) => {
        const unread = (entry: ReturnType<ChainRegistry['get']>) => ({
          ...entry,
          adapter: {
            ...entry.adapter,
            listAssets: async () => {
              throw new ChainError('Unavailable', 'the node did not answer');
            },
          },
        });
        return {
          ...inner,
          get: (chain) => unread(inner.get(chain)),
          active: () => inner.active().map(unread),
        };
      },
    });
    try {
      const who = await someone('solana');
      const answers = { goal: 'grow', amountUsd: 2000, horizonMonths: 60, risk: 'medium' };
      const ask = async (text: string) =>
        IntakeResponse.parse((await post(who, PATH, { text, answers }, dark.app)).json());
      const themed = await ask('I want to invest $2,000 in AI for 5 years');
      expect(themed.sheet).toBeNull();
      expect(themed.readBack).toBeNull();
      expect(themed.narratives).toEqual([]);
      expect(themed.flags).toEqual(
        expect.arrayContaining(['shelf_unread', 'market_unresolved:ai']),
      );
      expect(themed.assumptions).toEqual([
        'What is listed on Solana could not be read just now, so nothing is held for “AI” yet.',
      ]);
      // Nothing is said of what the chain has: nobody looked.
      expect(themed.assumptions.join(' ')).not.toMatch(/no stock|only one stock/);
      // A goal that names nothing only the shelf can settle is read as before.
      const plain = await ask('I want to grow $2,000 over 5 years at medium risk');
      expect(plain.flags).not.toContain('shelf_unread');
      expect(plain.sheet).toMatchObject({ amountUsd: 2000, risk: 'medium', themes: [] });
    } finally {
      await dark.app.close();
    }
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
    // "No stocks" is no stocks through a fund either: both classes are left out.
    const limits = { cannotHold: { classes: ['etf', 'stock'] } };
    // No model configured: the rules reader reads the goal, and code reads the refusal.
    const first = await post(who, PATH, { text: noStocks.text }, off);
    expect(first.statusCode, first.body).toBe(200);
    const asked = IntakeResponse.parse(first.json());
    expect(asked.reader).toMatchObject({ method: 'rules', why: 'model_not_configured' });
    // Read at once, and not asked: the refusal is no question.
    expect(asked.limits).toEqual({ creditTolerance: null, cannotHoldClasses: ['etf', 'stock'] });
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
      'You left out stocks and stock funds.',
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
    expect(byModel.readBack).toContain('You left out stocks and stock funds.');
    // The class that goes with stocks is no disagreement with the model.
    expect(byModel.flags.filter((f) => /cannotHold:etf/.test(f))).toEqual([]);
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
    // "No ETFs" leaves out the stock funds alone: single stocks may still be held.
    const funds = IntakeResponse.parse(
      (
        await post(
          who,
          PATH,
          { text: 'I want to grow $20,000 for 3 years at low risk. No ETFs.', answers },
          off,
        )
      ).json(),
    );
    expect(funds.sheet).toMatchObject({ limits: { cannotHold: { classes: ['etf'] } } });
    expect(funds.readBack).toContain('You left out stock funds.');

    // The confirm takes the sheet with its limits as it is, and the plan made from it holds no stock
    // token and no fund of stocks. At medium risk: there the same goal with nothing refused holds a
    // fund of stocks on this shelf (at low, gold and dollar yield take all the mock's one issuer may
    // hold).
    const medium = IntakeResponse.parse(
      (
        await post(who, PATH, { text: noStocks.text, answers: { ...answers, risk: 'medium' } }, off)
      ).json(),
    );
    expect(medium.sheet).toMatchObject({ goal: 'grow', risk: 'medium', limits });
    expect(medium.readBack).toContain('You left out stocks and stock funds.');
    const cls = new Map(mockAssets('solana').map((a) => [a.id, a.cls]));
    const classesHeld = async (sheet: unknown) => {
      const plan = await post(who, '/v1/baskets/personalize', { sheet });
      expect(plan.statusCode, plan.body).toBe(200);
      const { proposal } = PersonalizeResponse.parse(plan.json());
      expect(proposal.lines.length).toBeGreaterThan(0);
      return proposal.lines.map((line) => cls.get(line.assetId));
    };
    const held = await classesHeld(medium.sheet);
    expect(held).not.toContain('stock');
    expect(held).not.toContain('etf');
    expect(held).not.toContain(undefined);
    // Not idle. With nothing refused the same sheet holds a fund of stocks on this shelf, and with
    // stocks alone left out, which is what the intake read before, the plan still held that fund.
    const { limits: _refused, ...open } = medium.sheet as NonNullable<typeof medium.sheet>;
    expect(await classesHeld(open)).toContain('etf');
    const stocksOnly = await classesHeld({
      ...open,
      limits: { cannotHold: { classes: ['stock'] } },
    });
    expect(stocksOnly).toContain('etf');
    expect(stocksOnly).not.toContain('stock');
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
      { text: 'Grow $5,000', followUps: Array.from({ length: 200 }, () => 'another detail') },
      { text: 'Grow $5,000', answersThen: Array.from({ length: 200 }, () => ({})) },
      { text: 'Grow $5,000', followUps: ['yes'], answersThen: [] },
      { text: 'x'.repeat(2000), followUps: Array.from({ length: 11 }, () => 'x'.repeat(2000)) },
    ]) {
      const res = await post(who, PATH, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(replayed.calls()).toBe(before);
    const nobody = await post(null, PATH, { text: goal('en-grow-10y-high').text });
    expect(nobody.statusCode).toBe(401);
  });
});
