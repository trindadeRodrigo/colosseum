import type { BasketSheet } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { dictionary } from '../../i18n';
import { READ_IN_DOLLARS } from '../goal/test/plan';
import { json } from '../wallet/test/fake-port';
import { readerConversation, type Sheet } from './conversation';
import { INTAKE_PATH } from './intake';
import { intakeConversation, NO_DATE } from './intake-conversation';
import { answer, DRAFT, SHEET } from './test/intake';

// The guided intake behind `Conversation`: what each turn posts (the first message, the later ones,
// the answers given by a tap), and what comes back to the screen. The route is a double of
// POST /v1/baskets/intake as `staging` answers it.

const en = dictionary('en');
type Body = Record<string, unknown>;

/** A server that answers each intake call in turn, and has no other route but the rules reader. */
function server(...answers: (unknown | (() => Response))[]) {
  const posted: Body[] = [];
  const other: string[] = [];
  let at = 0;
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== INTAKE_PATH) {
      other.push(path);
      return path === '/goals' ? json(READ_IN_DOLLARS) : json({ error: 'not found' }, 404);
    }
    posted.push(JSON.parse(String(init?.body)) as Body);
    const next = answers[Math.min(at++, answers.length - 1)];
    return typeof next === 'function' ? (next as () => Response)() : json(next);
  });
  return { api, posted, other };
}
const talk = (api: ReturnType<typeof server>['api'], chain: 'solana' | 'robinhood' = 'solana') =>
  intakeConversation(api, {
    lang: 'en',
    chain,
    fallback: readerConversation(api, { lang: 'en', chain, examples: en.goal.examples.list }),
  });
const GOAL = 'I want to grow some savings';
const ASK_AMOUNT = {
  field: 'amountUsd',
  template: 'amount',
  text: 'How much are you putting in, in dollars?',
};
const ASK_RISK = {
  field: 'risk',
  template: 'risk',
  text: 'How much can it swing on the way?',
  options: ['low', 'medium', 'high'],
};

describe('a turn of the guided intake', () => {
  it('posts the goal, and asks our server’s first question in its words, with replies one press gives', async () => {
    const s = server(answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT, ASK_RISK] }));
    const reply = await talk(s.api).turn({ kind: 'text', text: `  ${GOAL} ` }, null);
    expect(s.posted).toEqual([{ text: GOAL, language: 'en' }]);
    expect(reply.question?.text).toBe(ASK_AMOUNT.text);
    expect(reply.ask).toBe('amount');
    expect(reply.open).toEqual(['amount', 'risk']);
    expect(reply.question?.replies.map((r) => r.posts)).toEqual([
      { kind: 'answer', fact: 'amount', value: '1000' },
      { kind: 'answer', fact: 'amount', value: '10000' },
      { kind: 'answer', fact: 'amount', value: '50000' },
    ]);
    // what was read is the server's draft; nothing is whole, so there is no sheet to build from
    expect(reply.sheet.fields).toMatchObject({ goal: 'grow', amount: '', risk: '' });
    // what was understood is said before the question
    expect(reply.say).toEqual([{ key: 'understood' }, { key: 'first' }]);
    expect(reply.valid).toBeNull();
    expect(reply.sheet.words).toEqual([GOAL]);
  });

  it('sends an answer given by a tap by its field, and the choices our server names as replies', async () => {
    const s = server(
      answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT, ASK_RISK] }),
      answer({ draft: { goal: 'grow', amountUsd: 10_000 }, questions: [ASK_RISK] }),
    );
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    const second = await talk(s.api).turn(
      { kind: 'answer', fact: 'amount', value: '10000' },
      first.sheet,
    );
    expect(s.posted[1]).toEqual({ text: GOAL, language: 'en', answers: { amountUsd: 10_000 } });
    expect(second.sheet.fields.amount).toBe('10000');
    expect(second.question?.text).toBe(ASK_RISK.text);
    expect(second.question?.replies.map((r) => r.label)).toEqual([
      { kind: 'fact', fact: 'risk', value: 'low' },
      { kind: 'fact', fact: 'risk', value: 'medium' },
      { kind: 'fact', fact: 'risk', value: 'high' },
    ]);
  });

  it('sends later messages in the person’s own words, with the answers as they stood at each', async () => {
    const open = answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] });
    const s = server(open, open, open, open);
    const t = talk(s.api);
    const a = await t.turn({ kind: 'text', text: GOAL }, null);
    const b = await t.turn({ kind: 'text', text: 'put 30% in AI' }, a.sheet);
    const c = await t.turn({ kind: 'answer', fact: 'risk', value: 'high' }, b.sheet);
    await t.turn({ kind: 'text', text: 'and it is for my daughter' }, c.sheet);
    expect(s.posted[1]).toEqual({
      text: GOAL,
      language: 'en',
      followUps: ['put 30% in AI'],
      answersThen: [{}],
    });
    expect(s.posted[3]).toEqual({
      text: GOAL,
      language: 'en',
      followUps: ['put 30% in AI', 'and it is for my daughter'],
      // the first was said before the risk was answered, the second after
      answersThen: [{}, { risk: 'high' }],
      answers: { risk: 'high' },
    });
  });

  it('offers what our server read and asks to be sure of as the first reply', async () => {
    const s = server(
      answer({
        questions: [{ ...ASK_AMOUNT, read: 40 }],
      }),
      answer({ questions: [{ ...ASK_RISK, read: 'medium' }] }),
      // what it read is not a value the fact takes: it is not offered
      answer({ questions: [{ ...ASK_AMOUNT, read: 5 }] }),
    );
    const values = async () =>
      (await talk(s.api).turn({ kind: 'text', text: GOAL }, null)).question?.replies.map((r) =>
        r.posts.kind === 'answer' ? r.posts.value : null,
      );
    expect(await values()).toEqual(['40', '1000', '10000', '50000']);
    expect(await values()).toEqual(['medium', 'low', 'high']);
    expect(await values()).toEqual(['1000', '10000', '50000']);
  });

  it('takes a bare figure typed to the open question as its answer, not as a message', async () => {
    const s = server(
      answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }),
      answer({ draft: { goal: 'grow', amountUsd: 2000 }, questions: [] }),
    );
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    await talk(s.api).turn({ kind: 'text', text: '$2,000', asked: 'amount' }, first.sheet);
    expect(s.posted[1]).toEqual({ text: GOAL, language: 'en', answers: { amountUsd: 2000 } });
  });

  it('says back what our server understood, sentence by sentence as given, and hands its sheet on unchanged', async () => {
    const sheet = {
      ...SHEET,
      // what only the server's sheet carries: sent back as it came
      limits: { cannotHold: { classes: ['stock', 'etf'] } },
      mix: { growthBps: 0, dollarYieldBps: 7000, goldBps: 0, cashBps: 3000 },
    };
    const readBack = [
      'You want to grow $2,000 over 5 years.',
      'You left out stocks.',
      'Is that right?',
    ];
    const s = server(answer({ sheet, readBack, mix: sheet.mix }));
    const reply = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    expect(reply.say).toEqual([{ key: 'said', lines: readBack }]);
    expect(reply.question).toBeNull();
    expect(reply.ask).toBeNull();
    expect(reply.valid).toEqual(sheet);
    expect(JSON.stringify(reply.valid)).toBe(JSON.stringify(sheet));
    expect(reply.sheet.fields).toMatchObject({
      goal: 'grow',
      amount: '2000',
      horizon: '60',
      risk: 'high',
    });
    expect(reply.sheet.intake?.mix).toEqual(sheet.mix);
    // a sheet sent while something is still asked, or with no read-back, is not one to build from
    for (const early of [answer({ sheet, readBack, questions: [ASK_RISK] }), answer({ sheet })]) {
      const open = await talk(server(early).api).turn({ kind: 'text', text: GOAL }, null);
      expect(open.valid).toBeNull();
      expect(open.sheet.intake?.sheet).toBeNull();
    }
    // a plan lives on the person's chain: a sheet for another is not one to build from here
    const other = await talk(s.api, 'robinhood').turn({ kind: 'text', text: GOAL }, null);
    expect(other.valid).toBeNull();
  });

  it('shows no months for a goal with no date, and says "no date" by a reply', async () => {
    const ASK_DATE = { field: 'horizonMonths', template: 'horizon', text: 'By when?' };
    const s = server(
      answer({ draft: { goal: 'grow' }, questions: [ASK_DATE] }),
      answer({
        sheet: { ...SHEET, horizonMonths: 120, horizonOpen: true },
        readBack: ['No date.'],
      }),
    );
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    const last = first.question?.replies.at(-1);
    expect(last?.label).toEqual({ kind: 'word', word: 'noDate' });
    const open = await talk(s.api).turn(
      { kind: 'answer', fact: 'horizon', value: NO_DATE },
      first.sheet,
    );
    expect(s.posted[1]?.answers).toEqual({ horizonOpen: true });
    expect(open.sheet.fields.horizon).toBe('');
    expect(open.sheet.intake?.horizonOpen).toBe(true);
    expect(JSON.stringify(open.sheet.fields)).not.toContain('120');
  });

  it('reads the themes and the mix the plan holds from our server’s reading, a theme’s share from the sheet', async () => {
    const sheet = {
      ...SHEET,
      sleeves: [
        { kind: 'theme', theme: 'ai', shareBps: 3000 },
        { kind: 'safe_yield', shareBps: 7000 },
      ],
    };
    const s = server(
      answer({
        sheet,
        readBack: ['ok'],
        narratives: [
          { id: 'ai', words: 'AI', kind: 'label', slug: 'ai', filter: null, name: 'AI' },
          { id: null, words: 'space', kind: 'none', slug: null, filter: null, name: null },
        ],
      }),
    );
    const reply = await talk(s.api).turn({ kind: 'text', text: 'put 30% in AI and space' }, null);
    // what nothing on the chain fits is not a theme of the plan
    expect(reply.sheet.intake?.themes).toEqual([{ name: 'AI', shareBps: 3000 }]);
  });

  it('offers yes and no where our server asks to leave something out, said in the person’s words', async () => {
    const ASK_LIMITS = {
      field: 'limits',
      template: 'leaveOut',
      text: 'Do you want to leave out stocks and stock funds?',
    };
    const s = server(answer({ draft: { goal: 'grow' }, questions: [ASK_LIMITS] }));
    const reply = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    expect(reply.ask).toBeNull();
    expect(reply.question?.text).toBe(ASK_LIMITS.text);
    expect(reply.question?.replies).toEqual([
      { posts: { kind: 'text', text: 'yes' }, label: { kind: 'word', word: 'yes' } },
      { posts: { kind: 'text', text: 'no' }, label: { kind: 'word', word: 'no' } },
    ]);
    // a question with nothing to press: the person says it
    const ASK_CHAIN = { field: 'chains', template: 'chain', text: 'Which chain?' };
    const none = await talk(server(answer({ questions: [ASK_CHAIN] })).api).turn(
      { kind: 'text', text: GOAL },
      null,
    );
    expect(none.question).toEqual({ text: ASK_CHAIN.text, replies: [] });
  });

  it('says what is held, not the read-back again, when a message changes nothing', async () => {
    const whole = answer({ sheet: SHEET, readBack: ['You want to grow $2,000.'] });
    const s = server(whole, whole);
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    const again = await talk(s.api).turn({ kind: 'text', text: 'hmm' }, first.sheet);
    expect(again.say).toEqual([{ key: 'held' }]);
    expect(again.valid).toEqual(SHEET);
  });

  it('asks a reopened fact in the screen’s own words, and sends its answer over what the text says', async () => {
    const whole = answer({ sheet: SHEET, readBack: ['ok'] });
    const s = server(whole, answer({ sheet: { ...SHEET, risk: 'low' }, readBack: ['ok, low'] }));
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    const reopened = await talk(s.api).turn({ kind: 'reopen', fact: 'risk' }, first.sheet);
    expect(s.posted).toHaveLength(1);
    expect(reopened.ask).toBe('risk');
    expect(reopened.question).toBeNull();
    expect(reopened.valid).toBeNull();
    const set = await talk(s.api).turn(
      { kind: 'answer', fact: 'risk', value: 'low' },
      reopened.sheet,
    );
    expect(s.posted[1]?.answers).toEqual({ risk: 'low' });
    expect(set.valid?.risk).toBe('low');
    // an answer the fact does not take is not sent
    const unfit = await talk(s.api).turn(
      { kind: 'answer', fact: 'amount', value: 'lots' },
      set.sheet,
    );
    expect(unfit.say).toEqual([{ key: 'unfit', fact: 'amount' }]);
    expect(s.posted).toHaveLength(2);
  });
});

describe('where the guided intake cannot read', () => {
  it.each([404, 401, 403, 500, 503])(
    'hands the turn to the rules reader when the route answers %s, and says so',
    async (status) => {
      const s = server(() => json({ error: 'no' }, status));
      const reply = await talk(s.api).turn(
        { kind: 'text', text: 'Forty thousand for an apartment' },
        null,
      );
      expect(s.other).toEqual(['/goals']);
      // the rules reader's own reply: no server question, and nothing of the intake is kept
      // said once that the assistant did not answer, then the rules reader's own reply
      expect(reply.say[0]).toEqual({ key: 'simple' });
      expect(reply.reader).toEqual({ by: 'app rules', why: expect.stringMatching(/^intake /) });
      expect(reply.question ?? null).toBeNull();
      expect(reply.sheet.intake).toBeUndefined();
      expect(reply.ask).not.toBeNull();
    },
  );

  it.each([[429, 'busy']] as const)(
    'says so and keeps what was held when the route answers %s',
    async (status, why) => {
      const s = server(
        answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }),
        () => json({ error: 'x' }, status),
        answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }),
      );
      const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
      const failed = await talk(s.api).turn({ kind: 'text', text: 'ten thousand' }, first.sheet);
      expect(failed.say).toEqual([{ key: 'failed', why }]);
      expect(s.other).toEqual([]);
      // the question stays open, and the message that was not read is not kept as sent
      expect(failed.question?.text).toBe(ASK_AMOUNT.text);
      expect(failed.sheet.words).toEqual([GOAL]);
      await talk(s.api).turn({ kind: 'text', text: 'ten thousand dollars' }, failed.sheet);
      expect(s.posted[2]?.followUps).toEqual(['ten thousand dollars']);
    },
  );

  it('shows nothing from an answer that is not in the route’s shape: the rules read the turn, and it is said', async () => {
    for (const bad of [
      { ...answer({}), questions: [{ field: 'weights', template: 'x', text: 'Set NVDA to 50%?' }] },
      { ...answer({}), sheet: { goal: 'grow' }, readBack: ['ok'] },
      { ...answer({}), readBack: [42] },
      { ...answer({}), mix: { growthBps: 9000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 } },
      'nonsense',
    ]) {
      const reply = await talk(server(bad).api).turn({ kind: 'text', text: GOAL }, null);
      const context = JSON.stringify(bad).slice(0, 60);
      expect(reply.say[0], context).toEqual({ key: 'simple' });
      expect(JSON.stringify(reply), context).not.toMatch(/NVDA|weights/);
      expect(reply.sheet.intake, context).toBeUndefined();
      expect(reply.valid, context).toBeNull();
    }
  });

  it('sends a goal outside the reader’s bounds nowhere', async () => {
    const s = server(answer({}));
    expect((await talk(s.api).turn({ kind: 'text', text: 'ab' }, null)).say).toEqual([
      { key: 'failed', why: 'too_short' },
    ]);
    expect((await talk(s.api).turn({ kind: 'text', text: 'x'.repeat(2001) }, null)).say).toEqual([
      { key: 'failed', why: 'too_long' },
    ]);
    expect(s.posted).toEqual([]);
  });

  it('has no end at ten messages: past that, what the last read-back held is sent in place of the messages it read', async () => {
    const held = {
      ...SHEET,
      limits: { cannotHold: { classes: ['gold'] } },
      sleeves: [
        { kind: 'theme', theme: 'ai', shareBps: 3000 },
        { kind: 'safe_yield', shareBps: 7000 },
      ],
    };
    const whole = answer({ sheet: held, readBack: ['You want to grow $2,000.'] });
    const open = answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] });
    // the read-back comes at the sixth message; everything else asks on
    const s = server(open, open, open, open, open, whole, open);
    const t = talk(s.api);
    let reply = await t.turn({ kind: 'text', text: GOAL }, null);
    const said: string[] = [];
    for (let i = 1; i < 30; i++) {
      reply = await t.turn({ kind: 'text', text: `and another thing, number ${i}` }, reply.sheet);
      said.push(...reply.say.map((x) => x.key));
      const body = s.posted.at(-1) as { followUps: string[]; answersThen: unknown[] };
      // never more than the route takes, and one set of answers for each message sent
      expect(body.followUps.length, String(i)).toBeLessThanOrEqual(10);
      expect(body.answersThen, String(i)).toHaveLength(body.followUps.length);
      expect(body.followUps.at(-1)).toBe(`and another thing, number ${i}`);
    }
    // thirty turns, every one read, and never a word about a limit
    expect(s.posted).toHaveLength(30);
    expect(said).not.toContain('full');
    expect(JSON.stringify(dictionary('en').talk.say)).not.toMatch(/as long as I can read/);
    // the sixth message had the read-back: once the conversation is past ten, the request starts
    // after it, with what its sheet held as answers
    const last = s.posted.at(-1) as { text: string; followUps: string[]; answers: unknown };
    expect(last.text).toBe(GOAL);
    expect(last.followUps[0]).toBe('and another thing, number 20');
    expect(s.posted[11]).toMatchObject({
      followUps: [6, 7, 8, 9, 10, 11].map((i) => `and another thing, number ${i}`),
      answers: {
        goal: 'grow',
        amountUsd: 2000,
        horizonMonths: 60,
        risk: 'high',
        limits: held.limits,
        sleeves: held.sleeves,
      },
    });
    // every message is still kept with the sheet, and stays on the screen
    expect(reply.sheet.words).toHaveLength(30);
  });

  it('keeps the last ten of a stretch with no read-back in it, and says nothing of it', async () => {
    const open = answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] });
    const s = server(open);
    const t = talk(s.api);
    let reply = await t.turn({ kind: 'text', text: GOAL }, null);
    for (let i = 1; i <= 14; i++)
      reply = await t.turn({ kind: 'text', text: `message ${i}` }, reply.sheet);
    const last = s.posted.at(-1) as { followUps: string[]; answers?: unknown };
    expect(last.followUps).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => `message ${i}`));
    expect(last.answers).toBeUndefined();
    expect(reply.say.map((x) => x.key)).not.toContain('full');
  });

  it('lets the words decide a fact they speak of, over an answer pressed earlier for it', async () => {
    const open = answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] });
    const s = server(open);
    const t = talk(s.api);
    const a = await t.turn({ kind: 'text', text: GOAL }, null);
    const b = await t.turn({ kind: 'answer', fact: 'risk', value: 'high' }, a.sheet);
    const c = await t.turn({ kind: 'answer', fact: 'amount', value: '1000' }, b.sheet);
    await t.turn({ kind: 'text', text: 'make it low risk' }, c.sheet);
    // the amount pressed still stands; the risk is the message's to say
    expect(s.posted.at(-1)).toMatchObject({
      followUps: ['make it low risk'],
      answers: { amountUsd: 1000 },
    });
    expect((s.posted.at(-1) as { answers: object }).answers).not.toHaveProperty('risk');
    // and a share pressed for what is held gives way to words that name what to hold
    const d = await t.turn({ kind: 'hold', shareBps: 5000 }, c.sheet);
    await t.turn({ kind: 'text', text: 'all in stocks' }, d.sheet);
    expect((s.posted.at(-1) as { answers: object }).answers).not.toHaveProperty('mix');
  });
});

describe('a conversation begun before the person signed in', () => {
  it('is read again by the intake from the person’s own messages, with the facts they had as answers', async () => {
    const rules: Sheet = {
      fields: {
        goal: 'grow',
        amount: '2000',
        income: '',
        horizon: '',
        risk: '',
        country: '',
        holdings: 'yes',
        glide: 'no',
        language: 'en',
      },
      skipped: [],
      words: ['Grow $2,000', 'I like AI'],
    };
    const s = server(answer({ draft: DRAFT, questions: [ASK_RISK] }));
    const reply = await talk(s.api).turn({ kind: 'text', text: 'five years' }, rules);
    expect(s.posted[0]).toEqual({
      text: 'Grow $2,000',
      language: 'en',
      followUps: ['I like AI', 'five years'],
      answersThen: [{}, { goal: 'grow', amountUsd: 2000 }],
      answers: { goal: 'grow', amountUsd: 2000 },
    });
    expect(reply.question?.text).toBe(ASK_RISK.text);
  });

  it('reads the conversation again, with nothing new, when asked to replay it', async () => {
    const whole = answer({ sheet: SHEET, readBack: ['You want to grow $2,000.'] });
    const s = server(whole);
    const kept: Sheet = {
      fields: { ...(await talk(s.api).turn({ kind: 'text', text: GOAL }, null)).sheet.fields },
      skipped: [],
      words: [GOAL],
      intake: {
        answers: { risk: 'high' },
        answersThen: [],
        sheet: null,
        question: null,
        mix: null,
        themes: [],
        horizonOpen: false,
      },
    };
    const reply = await talk(s.api).turn({ kind: 'replay' }, kept);
    expect(s.posted[1]).toEqual({ text: GOAL, language: 'en', answers: { risk: 'high' } });
    expect(reply.valid).toEqual(SHEET as BasketSheet);
    expect(reply.say).toEqual([{ key: 'said', lines: ['You want to grow $2,000.'] }]);
  });
});

describe('what Thom’s conversation of Oct 7 showed', () => {
  const ASK_MIX = {
    field: 'mix',
    template: 'mixShare',
    text: 'How do you want the money held: how much in stocks and crypto, and how much in cash?',
  };

  it('asks the intake again on the turn after it did not answer, with every message and every fact held', async () => {
    const s = server(
      () => json({ error: 'too many connections' }, 500),
      answer({ draft: { goal: 'grow' }, questions: [ASK_RISK] }),
    );
    const t = talk(s.api);
    const first = await t.turn({ kind: 'text', text: 'Grow $40,000 over ten years' }, null);
    expect(first.say[0]).toEqual({ key: 'simple' });
    // the screen keeps the person's messages with the sheet the rules reader answered
    const kept: Sheet = { ...first.sheet, words: ['Grow $40,000 over ten years'] };
    expect(kept.fields.amount).toBe('40000');
    const second = await t.turn({ kind: 'text', text: 'i like elon musk' }, kept);
    expect(s.posted[1]).toMatchObject({
      text: 'Grow $40,000 over ten years',
      followUps: ['i like elon musk'],
      answers: { goal: 'grow', amountUsd: 40_000, horizonMonths: 120 },
    });
    expect(second.question?.text).toBe(ASK_RISK.text);
    // and it is not said a second time that the assistant did not answer
    const again = await talk(server(() => json({}, 500)).api).turn(
      { kind: 'text', text: 'hello?' },
      { ...second.sheet, simple: true },
    );
    expect(again.say.map((x) => x.key)).not.toContain('simple');
  });

  it('never loses a fact the person gave by a press, whatever our server’s draft of the text says', async () => {
    // the draft is of the text alone: it does not carry the answers
    const s = server(answer({ questions: [ASK_AMOUNT] }), answer({ questions: [ASK_RISK] }), () =>
      json({ error: 'down' }, 503),
    );
    const t = talk(s.api);
    const a = await t.turn({ kind: 'text', text: 'help me save' }, null);
    const b = await t.turn({ kind: 'answer', fact: 'amount', value: '40000' }, a.sheet);
    expect(b.sheet.fields.amount).toBe('40000');
    const c = await t.turn({ kind: 'answer', fact: 'goal', value: 'protect' }, b.sheet);
    // the intake is down for this turn: the rules reader holds the same facts, and resets nothing
    expect(c.sheet.fields).toMatchObject({ goal: 'protect', amount: '40000' });
    expect(c.say.map((x) => x.key)).not.toContain('notUnderstood');
    expect(c.ask).not.toBe('goal');
    expect(c.ask).not.toBe('amount');
  });

  it('never answers with nothing: a reading with no sheet and no question says what is held', async () => {
    const nothing = answer({});
    const first = await talk(server(nothing).api).turn({ kind: 'text', text: 'so?' }, null);
    expect(first.say).toEqual([{ key: 'notUnderstood' }]);
    const s = server(answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }), {
      ...answer({ draft: { goal: 'grow' } }),
    });
    const held = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    const next = await talk(s.api).turn({ kind: 'text', text: 'i like nvidea' }, held.sheet);
    // what is held is said: never nothing
    expect(next.say).toEqual([{ key: 'understood' }]);
  });

  it('sends a share pressed for "how do you want the money held" as the answer to that question', async () => {
    const s = server(
      answer({ draft: { goal: 'grow' }, questions: [ASK_MIX] }),
      answer({ sheet: SHEET, readBack: ['All of it in stocks.'] }),
      answer({ sheet: SHEET, readBack: ['None of it in stocks.'] }),
    );
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    expect(first.question?.replies.map((r) => r.posts)).toEqual([
      { kind: 'hold', shareBps: 10_000 },
      { kind: 'hold', shareBps: 7000 },
      { kind: 'hold', shareBps: 5000 },
      { kind: 'hold', shareBps: 3000 },
      { kind: 'hold', shareBps: null },
    ]);
    const all = await talk(s.api).turn({ kind: 'hold', shareBps: 10_000 }, first.sheet);
    expect(s.posted[1]).toEqual({
      text: GOAL,
      language: 'en',
      answers: { mix: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 } },
    });
    // not sent as words, which could ask the same question again
    expect(s.posted[1]).not.toHaveProperty('followUps');
    await talk(s.api).turn({ kind: 'hold', shareBps: null }, all.sheet);
    expect(s.posted[2]?.answers).toEqual({ mix: null });
  });

  it('says so when words meant as an answer bring the same question back', async () => {
    const open = answer({ draft: { goal: 'grow' }, questions: [ASK_MIX] });
    const s = server(open, open);
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    const again = await talk(s.api).turn(
      { kind: 'text', text: '100% in stocks. 100% in nvidea!' },
      first.sheet,
    );
    expect(again.say).toEqual([{ key: 'notAnswer' }]);
    expect(again.question?.text).toBe(ASK_MIX.text);
    expect(s.posted[1]?.followUps).toEqual(['100% in stocks. 100% in nvidea!']);
  });

  it('says only what is new of a read-back when the sheet is the same: our server’s line that no stock fits', async () => {
    const lines = ['You want to grow $2,000 over 5 years.', 'If this is right, confirm it.'];
    const none =
      'There is no stock for “nvidea” on Solana at the moment. We will be adding more soon.';
    const s = server(
      answer({ sheet: SHEET, readBack: lines }),
      answer({ sheet: SHEET, readBack: [lines[0], none, lines[1]] }),
    );
    const first = await talk(s.api).turn({ kind: 'text', text: GOAL }, null);
    const next = await talk(s.api).turn({ kind: 'text', text: 'add nvidea to it' }, first.sheet);
    expect(next.say).toEqual([{ key: 'said', lines: [none] }]);
  });

  it('says who read the turn, for the people building this', async () => {
    const model = await talk(server(answer({ questions: [ASK_AMOUNT] })).api).turn(
      { kind: 'text', text: GOAL },
      null,
    );
    expect(model.reader).toEqual({ by: 'model', why: null });
    const rules = await talk(server(answer({ questions: [ASK_AMOUNT], method: 'rules' })).api).turn(
      { kind: 'text', text: GOAL },
      null,
    );
    expect(rules.reader).toEqual({ by: 'server rules', why: 'model_not_configured' });
  });

  it('says before the question what our server read the person wants held, from its fields and never from the typed words', async () => {
    const ASK_GOAL = {
      field: 'goal',
      template: 'goal',
      text: 'What is this money for: to grow it, to earn an income from it, or to protect it?',
      options: ['grow', 'income', 'protect'],
    };
    const typed = 'i want to invest on the 5 biggest stoks on solana by liquidity';
    // a theme the server read to a label, and a mix
    const read = await talk(
      server(
        answer({
          questions: [ASK_GOAL],
          narratives: [
            { id: 'ai', words: 'AI', kind: 'label', slug: 'ai', filter: null, name: 'AI' },
          ],
          mix: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
        }),
      ).api,
    ).turn({ kind: 'text', text: typed }, null);
    expect(read.say).toEqual([
      {
        key: 'heard',
        themes: ['AI'],
        mix: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
      },
      { key: 'first' },
    ]);
    expect(JSON.stringify(read.say)).not.toMatch(/biggest|stoks|liquidity/);
    // nothing on the chain fits what was named: said only because the server says so
    const none = await talk(
      server(
        answer({
          questions: [ASK_GOAL],
          narratives: [
            { id: null, words: 'x', kind: 'none', slug: null, filter: null, name: null },
          ],
        }),
      ).api,
    ).turn({ kind: 'text', text: typed }, null);
    expect(none.say).toEqual([{ key: 'noneYet' }, { key: 'first' }]);
    // the server read nothing of it: the question alone, and no claim about what cannot be done
    const bare = await talk(server(answer({ questions: [ASK_GOAL] })).api).turn(
      { kind: 'text', text: typed },
      null,
    );
    expect(bare.say).toEqual([{ key: 'first' }]);
    expect(bare.question?.text).toBe(ASK_GOAL.text);
  });

  it('offers the change of goal that would hold what was asked for, only where our server’s code says the goal is why', async () => {
    const income = { ...SHEET, goal: 'income', incomeTargetUsdMonthly: 300 };
    const lines = [
      'A plan for a goal of income holds no stocks or crypto, so “100% stocks and crypto” is not held.',
    ];
    const dropped = {
      ...answer({ sheet: income, readBack: lines }),
      flags: ['mix_dropped_for_goal'],
    };
    const s = server(dropped, answer({ sheet: SHEET, readBack: ['You want to grow $2,000.'] }));
    const reply = await talk(s.api).turn({ kind: 'text', text: 'income, all in stocks' }, null);
    expect(reply.offers).toEqual([
      {
        posts: { kind: 'answer', fact: 'goal', value: 'grow' },
        label: { kind: 'word', word: 'growGoal' },
      },
    ]);
    // pressed: the goal is answered as growth, and the monthly income goes with the old goal
    const pressed = { ...reply.sheet };
    await talk(s.api).turn({ kind: 'answer', fact: 'income', value: '300' }, pressed);
    const grown = await talk(s.api).turn(
      { kind: 'answer', fact: 'goal', value: 'grow' },
      {
        ...pressed,
        intake: {
          ...(pressed.intake as NonNullable<Sheet['intake']>),
          answers: { incomeTargetUsdMonthly: 300 },
        },
      },
    );
    expect(s.posted.at(-1)?.answers).toEqual({ goal: 'grow' });
    expect(grown.offers).toBeUndefined();
    // the same sentence with no code, a code about something else, or a goal that is already growth:
    // nothing is offered that the server did not imply
    for (const other of [
      answer({ sheet: income, readBack: lines }),
      { ...answer({ sheet: income, readBack: lines }), flags: ['share_too_small'] },
      { ...answer({ sheet: SHEET, readBack: lines }), flags: ['mix_dropped_for_goal'] },
    ]) {
      const none = await talk(server(other).api).turn({ kind: 'text', text: 'x y z' }, null);
      expect(none.offers).toBeUndefined();
    }
  });
});
