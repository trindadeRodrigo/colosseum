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
    expect(reply.say).toEqual([{ key: 'understood' }]);
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
    await t.turn({ kind: 'text', text: 'make it safer' }, c.sheet);
    expect(s.posted[1]).toEqual({
      text: GOAL,
      language: 'en',
      followUps: ['put 30% in AI'],
      answersThen: [{}],
    });
    expect(s.posted[3]).toEqual({
      text: GOAL,
      language: 'en',
      followUps: ['put 30% in AI', 'make it safer'],
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
    const ASK_MIX = { field: 'mix', template: 'share', text: 'How much of the $2,000 for AI?' };
    const mix = await talk(server(answer({ questions: [ASK_MIX] })).api).turn(
      { kind: 'text', text: GOAL },
      null,
    );
    expect(mix.question).toEqual({ text: ASK_MIX.text, replies: [] });
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
  it.each([404, 401, 403])(
    'hands the turn to the rules reader when the route answers %s',
    async (status) => {
      const s = server(() => json({ error: 'no' }, status));
      const reply = await talk(s.api).turn(
        { kind: 'text', text: 'Forty thousand for an apartment' },
        null,
      );
      expect(s.other).toEqual(['/goals']);
      // the rules reader's own reply: no server question, and nothing of the intake is kept
      expect(reply.question ?? null).toBeNull();
      expect(reply.sheet.intake).toBeUndefined();
      expect(reply.ask).not.toBeNull();
    },
  );

  it.each([
    [429, 'busy'],
    [503, 'unreachable'],
  ] as const)('says so and keeps what was held when the route answers %s', async (status, why) => {
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
  });

  it('shows nothing from an answer that is not in the route’s shape', async () => {
    for (const bad of [
      { ...answer({}), questions: [{ field: 'weights', template: 'x', text: 'Set NVDA to 50%?' }] },
      { ...answer({}), sheet: { goal: 'grow' }, readBack: ['ok'] },
      { ...answer({}), readBack: [42] },
      { ...answer({}), mix: { growthBps: 9000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 } },
      'nonsense',
    ]) {
      const reply = await talk(server(bad).api).turn({ kind: 'text', text: GOAL }, null);
      expect(reply.say, JSON.stringify(bad).slice(0, 60)).toEqual([
        { key: 'failed', why: 'unreadable' },
      ]);
      expect(reply.valid).toBeNull();
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

  it('stops at the number of messages the route takes, and says a tap is the way on', async () => {
    const open = answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] });
    const s = server(open);
    const t = talk(s.api);
    let sheet: Sheet = (await t.turn({ kind: 'text', text: GOAL }, null)).sheet;
    for (let i = 0; i < 10; i++)
      sheet = (await t.turn({ kind: 'text', text: `more ${i}` }, sheet)).sheet;
    expect(s.posted).toHaveLength(11);
    expect(s.posted.at(-1)?.followUps).toHaveLength(10);
    const full = await t.turn({ kind: 'text', text: 'one more' }, sheet);
    expect(full.say).toEqual([{ key: 'full' }]);
    expect(s.posted).toHaveLength(11);
    // an answer by a tap still goes through
    await t.turn({ kind: 'answer', fact: 'amount', value: '1000' }, full.sheet);
    expect(s.posted).toHaveLength(12);
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
