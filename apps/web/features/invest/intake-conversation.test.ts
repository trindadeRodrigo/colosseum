import type { BasketSheet } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { dictionary } from '../../i18n';
import { READ_IN_DOLLARS } from '../goal/test/plan';
import { json } from '../wallet/test/fake-port';
import {
  allocationConversation,
  allocationIntent,
  readerConversation,
  type Sheet,
} from './conversation';
import { INTAKE_PATH } from './intake';
import { intakeConversation, NO_DATE } from './intake-conversation';
import { answer, DRAFT, SHEET } from './test/intake';

// The guided intake behind `Conversation`: what each turn posts (the first message, the later ones,
// the answers given by a tap), and what comes back to the screen. The route is a double of
// POST /v1/baskets/intake as `staging` answers it.

const en = dictionary('en');
/** Exact expected wire, including the additive capability and chronological question origins. */
function wire(body: Record<string, unknown> | Record<string, unknown>[]): unknown {
  if (Array.isArray(body)) return body.map((entry) => wire(entry));
  const later = (body.followUps ?? []) as string[];
  return { dialogueVersion: 1, questionThen: later.map(() => null), ...body };
}

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

describe('interest origin and conservative pause', () => {
  const words = 'i like elon';
  const marker = { quote: words, sourceTurn: 1 };
  const question = {
    field: 'themes',
    template: 'interestClarification',
    text: 'Which business do you want this plan to reflect?',
  };

  it.each([500, 404, 401])(
    'keeps pending interest and exact reply origins through intake %s and replay',
    async (status) => {
      const s = server(
        answer({ sheet: SHEET, readBack: ['Grow $2000 for five years.'] }),
        { ...answer({ draft: SHEET, questions: [question] }), pendingInterest: marker },
        () => json({}, status),
        {
          ...answer({ sheet: SHEET, readBack: ['The old goal is complete.'] }),
          pendingInterest: marker,
        },
        { ...answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }), pendingInterest: null },
        () => json({}, status),
        {
          ...answer({ sheet: SHEET, readBack: ['Grow $2000 for five years.'] }),
          pendingInterest: null,
        },
      );
      const t = talk(s.api);
      const first = await t.turn(
        { kind: 'text', text: 'Grow $2000 for five years at high risk' },
        null,
      );
      const interest = await t.turn({ kind: 'text', text: words }, first.sheet);
      expect(interest.valid).toBeNull();
      expect(interest.sheet.intake?.pendingInterest).toEqual(marker);
      const failed = await t.turn({ kind: 'text', text: 'thanks' }, interest.sheet);
      expect(failed.valid).toBeNull();
      expect(failed.sheet.intake?.sheet).toBeNull();
      expect(failed.sheet.intake?.pendingInterest).toEqual(marker);
      expect(failed.sheet.words).toEqual([
        'Grow $2000 for five years at high risk',
        words,
        'thanks',
      ]);
      expect(failed.sheet.intake?.questionThen).toEqual([null, 'interestClarification']);
      expect(s.other).toEqual([]); // no executable local reader fallback
      const replayed = await t.turn({ kind: 'replay' }, failed.sheet);
      expect(replayed.valid).toBeNull();
      expect(replayed.sheet.intake?.sheet).toBeNull();
      expect(s.posted[3]).toMatchObject({
        dialogueVersion: 1,
        pendingInterest: marker,
        followUps: [words, 'thanks'],
        questionThen: [null, 'interestClarification'],
        answersThen: [{}, {}],
      });
      const clarified = await t.turn(
        { kind: 'text', text: 'I want this plan to reflect electric vehicle businesses' },
        replayed.sheet,
      );
      expect(clarified.sheet.intake?.pendingInterest).toBeNull();
      expect(clarified.question?.text).toBe(ASK_AMOUNT.text);
      expect(clarified.valid).toBeNull(); // resolving interest never resolves remaining facts
      const nextFailure = await t.turn({ kind: 'text', text: 'thanks again' }, clarified.sheet);
      expect(nextFailure.valid).toBeNull();
      expect(nextFailure.sheet.intake?.interestReview).toBe(true);
      expect(nextFailure.sheet.intake?.pendingInterest).toBeNull();
      expect(s.other).toEqual([]);
      const resolved = await t.turn({ kind: 'replay' }, nextFailure.sheet);
      expect(s.posted.at(-1)?.pendingInterest).toBeNull();
      expect(resolved.valid).toEqual(SHEET);
      expect(resolved.sheet.intake?.interestReview).toBe(true);
    },
  );

  it('sends yes as the person wrote it with interest origin and keeps pending on a legacy response', async () => {
    const s = server(
      { ...answer({ questions: [question] }), pendingInterest: { quote: words, sourceTurn: 0 } },
      answer({ sheet: SHEET, readBack: ['Historic complete goal.'] }),
    );
    const t = talk(s.api);
    const first = await t.turn({ kind: 'text', text: words }, null);
    const next = await t.turn({ kind: 'text', text: 'yes' }, first.sheet);
    expect(s.posted[1]).toMatchObject({
      dialogueVersion: 1,
      followUps: ['yes'],
      questionThen: ['interestClarification'],
      answersThen: [{}],
      pendingInterest: { quote: words, sourceTurn: 0 },
    });
    expect(next.sheet.words).toEqual([words, 'yes']);
    expect(next.valid).toBeNull();
    expect(next.sheet.intake?.sheet).toBeNull();
    expect(next.sheet.intake?.pendingInterest).toEqual({ quote: words, sourceTurn: 0 });
  });

  it('rejects a response marker not grounded in its stated original person turn', async () => {
    const s = server({
      ...answer({ sheet: SHEET, readBack: ['Old complete goal.'] }),
      pendingInterest: { quote: 'Tesla', sourceTurn: 0 },
    });
    const reply = await talk(s.api).turn({ kind: 'text', text: words }, null);
    expect(reply.reader?.why).toBe('intake unreadable');
  });
});

describe('unapplied allocation requests', () => {
  it('drops against the current null mix without reviving an older pressed stock mix', async () => {
    const income: BasketSheet = { ...SHEET, goal: 'income', incomeTargetUsdMonthly: 300 };
    const s = server(
      answer({ sheet: income, readBack: ['Current income goal, no stocks.'], mix: null }),
    );
    const t = allocationConversation(talk(s.api), 'en', 'solana');
    const first = await t.turn(
      { kind: 'text', text: 'Income from $2000, five years, high risk' },
      null,
    );
    const pressed = await t.turn({ kind: 'hold', shareBps: 5000 }, first.sheet);
    expect(pressed.sheet.intake?.held?.growthBps).toBe(5000);
    expect(pressed.sheet.intake?.mix).toBeNull();
    const pending = await t.turn({ kind: 'text', text: 'I want more stocks' }, pressed.sheet);
    const dropped = await t.turn({ kind: 'dropAllocation' }, pending.sheet);
    expect(dropped.sheet.intake?.held).toBeNull();
    await t.turn({ kind: 'answer', fact: 'goal', value: 'grow' }, dropped.sheet);
    expect(s.posted.at(-1)).toMatchObject({ answers: { goal: 'grow', mix: null } });
  });

  it('repeats a server rejection rather than calling the requested allocation held', async () => {
    const income: BasketSheet = { ...SHEET, goal: 'income', incomeTargetUsdMonthly: 300 };
    const rejection = 'Stocks are not held for an income goal.';
    const s = server(answer({ sheet: income, readBack: ['The income goal.'] }), {
      ...answer({ sheet: income, readBack: ['The income goal.'], assumptions: [rejection] }),
      flags: ['mix_dropped_for_goal'],
    });
    const t = allocationConversation(talk(s.api), 'en', 'solana');
    const first = await t.turn(
      { kind: 'text', text: 'Income from $2000, five years, high risk' },
      null,
    );
    const pending = await t.turn({ kind: 'text', text: 'I want more stocks' }, first.sheet);
    expect(pending.valid).toBeNull();
    expect(pending.say).toContainEqual({ key: 'said', lines: [rejection] });
    expect(pending.say).not.toContainEqual({ key: 'held' });
  });
  it.each([404, 403, 500])(
    'keeps funding paused and preserves answer snapshots when intake fails (%i)',
    async (status) => {
      const s = server(
        answer({ sheet: SHEET, readBack: ['The current growth goal.'] }),
        answer({ sheet: SHEET, readBack: ['The current growth goal.'] }),
        () => json({}, status),
        answer({ sheet: SHEET, readBack: ['The current growth goal.'] }),
      );
      const t = allocationConversation(talk(s.api), 'en', 'solana');
      const first = await t.turn(
        { kind: 'text', text: 'Grow $2000 for five years at high risk' },
        null,
      );
      const pressed = await t.turn({ kind: 'answer', fact: 'risk', value: 'high' }, first.sheet);
      const pending = await t.turn(
        { kind: 'text', text: 'Increase stocks to at least40%' },
        pressed.sheet,
      );
      expect(pending.valid).toBeNull();
      expect(pending.sheet.intake?.sheet).toEqual(SHEET);
      expect(pending.sheet.intake?.answersThen).toEqual([{ risk: 'high' }]);
      const next = await t.turn({ kind: 'answer', fact: 'risk', value: 'low' }, pending.sheet);
      expect(next.valid).toBeNull();
      expect(s.posted.at(-1)).toMatchObject({
        followUps: ['Increase stocks to at least40%'],
        answersThen: [{ risk: 'high' }],
        answers: { risk: 'low' },
      });
      const replayed = await t.turn({ kind: 'replay' }, next.sheet);
      expect(replayed.valid).toBeNull();
      expect(replayed.sheet.allocation?.minimum).toBe(true);
    },
  );

  it('does not accept a changed but wrong allocation or lose the original minimum through a vague amendment', async () => {
    const wrong = {
      ...SHEET,
      sleeves: [
        { kind: 'theme' as const, theme: 'ai', shareBps: 2000 },
        { kind: 'safe_yield' as const, shareBps: 8000 },
      ],
    };
    const s = server(
      answer({ sheet: SHEET, readBack: ['The original allocation.'] }),
      answer({ sheet: wrong, readBack: ['Only 20% is in this theme.'] }),
    );
    const t = allocationConversation(talk(s.api), 'en', 'solana');
    const first = await t.turn(
      { kind: 'text', text: 'Grow $2000 for five years at high risk' },
      null,
    );
    const exact = await t.turn({ kind: 'text', text: 'Increase stocks to60%' }, first.sheet);
    expect(exact.valid).toBeNull();
    expect(exact.sheet.allocation?.text).toBe('Increase stocks to60%');
    const bounded = await t.turn({ kind: 'text', text: 'I want at least40% stocks' }, first.sheet);
    const vague = await t.turn({ kind: 'text', text: 'I still want more stocks' }, bounded.sheet);
    expect(vague.valid).toBeNull();
    expect(vague.sheet.allocation).toEqual(bounded.sheet.allocation);
  });

  it('does not offer growth for an income cash amendment', async () => {
    const income: BasketSheet = { ...SHEET, goal: 'income', incomeTargetUsdMonthly: 300 };
    const s = server(answer({ sheet: income }));
    const t = allocationConversation(talk(s.api), 'en', 'solana');
    const first = await t.turn(
      { kind: 'text', text: 'Income $300 monthly from $2000, high risk, five years' },
      null,
    );
    const pending = await t.turn({ kind: 'text', text: 'I want more cash' }, first.sheet);
    expect(pending.say).toContainEqual(
      expect.objectContaining({ key: 'allocation', conflict: false }),
    );
    expect(pending.offers?.map((r) => r.posts)).not.toContainEqual({
      kind: 'answer',
      fact: 'goal',
      value: 'grow',
    });
  });

  it.each([
    'i think i want way more stocks on them. like at least40%',
    'acho que quero bem mais ações nesses planos, pelo menos40%',
  ])('keeps the unchanged income reading paused: %s', async (text) => {
    const income: BasketSheet = {
      ...SHEET,
      goal: 'income',
      amountUsd: 1000,
      incomeTargetUsdMonthly: 300,
      horizonOpen: true,
    };
    const s = server(answer({ sheet: income, readBack: ['Income goal as read.'] }));
    const t = allocationConversation(talk(s.api), 'en', 'solana');
    const first = await t.turn(
      { kind: 'text', text: 'Income $300 monthly from $1000, high risk, no date' },
      null,
    );
    const pending = await t.turn({ kind: 'text', text }, first.sheet);
    expect(pending.valid).toBeNull();
    expect(pending.sheet.allocation).toMatchObject({ text, minimum: true });
    expect(pending.say).toContainEqual(
      expect.objectContaining({ key: 'allocation', text, conflict: true }),
    );
    expect(pending.say).not.toContainEqual({ key: 'held' });
    expect(pending.offers?.map((r) => r.posts)).toContainEqual({
      kind: 'answer',
      fact: 'goal',
      value: 'grow',
    });
    const chatter = await t.turn({ kind: 'text', text: 'thanks' }, pending.sheet);
    expect(chatter.valid).toBeNull();
    expect(chatter.sheet.allocation?.text).toBe(text);
    const before = s.posted.length;
    const dropped = await t.turn({ kind: 'dropAllocation' }, chatter.sheet);
    expect(s.posted).toHaveLength(before);
    expect(dropped.valid).toEqual(income);
    expect(dropped.sheet.allocation).toBeUndefined();
    expect(dropped.sheet.words).toEqual([first.sheet.words?.[0], text, 'thanks']);
  });

  it('does not resolve the minimum through growth, and retains pressed-answer chronology', async () => {
    const income: BasketSheet = {
      ...SHEET,
      goal: 'income',
      amountUsd: 1000,
      incomeTargetUsdMonthly: 300,
    };
    const growth = { ...SHEET, amountUsd: 1000 };
    const s = server(
      answer({ sheet: income, readBack: ['Income read back.'] }),
      answer({ sheet: income }),
      answer({ sheet: growth, readBack: ['Growth read back, without a monthly income target.'] }),
    );
    const t = allocationConversation(talk(s.api), 'en', 'solana');
    const first = await t.turn(
      { kind: 'text', text: 'Income $300 monthly from $1000, high risk, five years' },
      null,
    );
    const pending = await t.turn({ kind: 'text', text: 'I want at least40% stocks' }, first.sheet);
    const changed = await t.turn({ kind: 'answer', fact: 'goal', value: 'grow' }, pending.sheet);
    expect(changed.valid).toBeNull();
    expect(changed.sheet.allocation?.minimum).toBe(true);
    expect(changed.sheet.fields.goal).toBe('grow');
    expect(changed.sheet.fields.income).toBe('');
    expect(s.posted[2]).toMatchObject({
      followUps: ['I want at least40% stocks'],
      answersThen: [{}],
      answers: { goal: 'grow' },
    });
    const dropped = await t.turn({ kind: 'dropAllocation' }, changed.sheet);
    expect(dropped.valid).toEqual(growth);
    expect(dropped.sheet.intake?.held).toBeNull();
    expect(dropped.say).toContainEqual({
      key: 'said',
      lines: ['Growth read back, without a monthly income target.'],
    });
    await t.turn({ kind: 'text', text: 'thanks' }, dropped.sheet);
    expect(s.posted.at(-1)).toMatchObject({
      followUps: ['I want at least40% stocks', 'thanks'],
      answers: { goal: 'grow', mix: null },
    });
  });

  it.each([
    'what are stocks?',
    'Why does this plan have more stocks?',
    'should I increase stocks?',
    'would40% stocks be sensible?',
    'I do not want to increase stocks',
    'stocks fell40%',
    'Stocks rose more than40% last year',
    'My adviser says I should add more stocks',
    '40% of my friends buy stocks',
    'I already hold40% stocks at my broker',
    'eu já tenho40% em ações fora daqui',
    'increase my monthly income target40%',
  ])('does not interpret an inquiry or unrelated fact as an amendment: %s', (text) => {
    expect(allocationIntent(text, 'en')).toBe(false);
  });
  it.each([
    'can you increase stocks to40%?',
    'I want no stocks',
    "I don't want gold",
    "I don't want stocks",
    'não quero ações',
    'do not add stocks; replace them with cash',
    'not40%, make it50% stocks',
    'my adviser says40% stocks, do that',
    'pode aumentar ações para40%',
    'tira ações e põe em caixa',
    'Não quero mais de40% em ações',
  ])('recognizes a current instruction: %s', (text) => {
    expect(allocationIntent(text, 'en')).toBe(true);
  });
});

describe('a turn of the guided intake', () => {
  it.each([
    [
      'en',
      'i like elon',
      'When you say “i like elon”, is there a business or industry you want this plan to reflect? Tell me which one.',
      'I want to invest in businesses related to electric vehicles.',
    ],
    [
      'pt',
      'eu gosto do elon',
      'Quando você diz “eu gosto do elon”, há um negócio ou setor que você quer refletir neste plano? Diga qual.',
      'Quero investir em negócios ligados a veículos elétricos.',
    ],
  ] as const)(
    'renders contextual interest without generic goal chips or a fabricated asset (%s)',
    async (lang, text, question, business) => {
      const s = server(
        {
          ...answer({
            questions: [
              {
                field: 'themes',
                template: 'interestClarification',
                text: question,
                options: [lang === 'en' ? 'Ignore that interest.' : 'Ignore esse interesse.'],
              },
            ],
          }),
          language: lang,
        },
        answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }),
      );
      const t = intakeConversation(s.api, {
        lang,
        chain: 'solana',
        fallback: readerConversation(s.api, {
          lang,
          chain: 'solana',
          examples: dictionary(lang).goal.examples.list,
        }),
      });
      const pending = await t.turn({ kind: 'text', text }, null);
      expect(pending.question?.text).toBe(question);
      expect(pending.question?.replies.map((reply) => reply.posts)).toEqual([
        { kind: 'text', text: lang === 'en' ? 'Ignore that interest.' : 'Ignore esse interesse.' },
      ]);
      expect(pending.valid).toBeNull();
      expect(pending.sheet.intake?.sheet).toBeNull();
      expect(pending.sheet.fields.goal).toBe('');
      expect(pending.sheet.intake?.themes).toEqual([]);
      expect(s.posted).toEqual(wire([{ text, language: lang }]));
      const next = await t.turn({ kind: 'text', text: business }, pending.sheet);
      expect(s.posted[1]).toEqual(
        wire({
          text,
          language: lang,
          followUps: [business],
          questionThen: ['interestClarification'],
          answersThen: [{}],
        }),
      );
      expect(s.posted[1]).not.toHaveProperty('answers');
      expect(next.question?.text).toBe(ASK_AMOUNT.text);
      expect(next.valid).toBeNull();
    },
  );

  it('posts a grounded natural-language interest option as person words, never a theme slug answer', async () => {
    const text = 'I like electric vehicles';
    const option = 'I want to invest in businesses related to electric vehicles.';
    const s = server(
      answer({
        questions: [
          {
            field: 'themes',
            template: 'interestClarification',
            text: 'Do you want this plan to reflect electric vehicles?',
            options: [option],
          },
        ],
      }),
      answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }),
    );
    const t = talk(s.api);
    const pending = await t.turn({ kind: 'text', text }, null);
    const choice = pending.question?.replies[0];
    expect(choice).toEqual({
      posts: { kind: 'text', text: option },
      label: { kind: 'option', text: option },
    });
    if (!choice) throw new Error('the grounded interest option is missing');
    const next = await t.turn(choice.posts, pending.sheet);
    expect(s.posted[1]).toEqual(
      wire({
        text,
        language: 'en',
        followUps: [option],
        questionThen: ['interestClarification'],
        answersThen: [{}],
      }),
    );
    expect(s.posted[1]).not.toHaveProperty('answers');
    expect(next.sheet.intake?.answers).not.toHaveProperty('themes');
    expect(next.valid).toBeNull();
  });
  it('posts the goal, and asks our server’s first question in its words, with replies one press gives', async () => {
    const s = server(answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT, ASK_RISK] }));
    const reply = await talk(s.api).turn({ kind: 'text', text: `  ${GOAL} ` }, null);
    expect(s.posted).toEqual(wire([{ text: GOAL, language: 'en' }]));
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
    expect(s.posted[1]).toEqual(
      wire({ text: GOAL, language: 'en', answers: { amountUsd: 10_000 } }),
    );
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
    expect(s.posted[1]).toEqual(
      wire({
        text: GOAL,
        language: 'en',
        followUps: ['put 30% in AI'],
        answersThen: [{}],
      }),
    );
    expect(s.posted[3]).toEqual(
      wire({
        text: GOAL,
        language: 'en',
        followUps: ['put 30% in AI', 'and it is for my daughter'],
        // the first was said before the risk was answered, the second after
        answersThen: [{}, { risk: 'high' }],
        answers: { risk: 'high' },
      }),
    );
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
    expect(s.posted[1]).toEqual(wire({ text: GOAL, language: 'en', answers: { amountUsd: 2000 } }));
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
    expect(s.posted).toEqual(wire([]));
  });

  it('keeps every message and answers snapshot past ten turns, without turning a read-back into form answers', async () => {
    const held = {
      ...SHEET,
      limits: { cannotHold: { classes: ['gold'] } },
      sleeves: [{ kind: 'safe_yield', shareBps: 10000 }],
    };
    const s = server(answer({ sheet: held, readBack: ['You left out gold.'] }));
    const t = talk(s.api);
    let reply = await t.turn({ kind: 'text', text: GOAL }, null);
    reply = await t.turn({ kind: 'answer', fact: 'amount', value: '2000' }, reply.sheet);
    for (let i = 1; i < 30; i++) {
      reply = await t.turn({ kind: 'text', text: `and another thing, number ${i}` }, reply.sheet);
      const body = s.posted.at(-1) as {
        followUps: string[];
        answersThen: unknown[];
        answers: unknown;
      };
      expect(body.followUps).toEqual(
        Array.from({ length: i }, (_, at) => `and another thing, number ${at + 1}`),
      );
      expect(body.answersThen).toEqual(Array.from({ length: i }, () => ({ amountUsd: 2000 })));
      expect(body.answers).toEqual({ amountUsd: 2000 });
    }
    expect(reply.sheet.words).toHaveLength(30);
    expect(s.posted).toHaveLength(31);
  });

  it('retains the complete stretch without a read-back too', async () => {
    const s = server(answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }));
    const t = talk(s.api);
    let reply = await t.turn({ kind: 'text', text: GOAL }, null);
    for (let i = 1; i <= 14; i++)
      reply = await t.turn({ kind: 'text', text: `message ${i}` }, reply.sheet);
    expect(s.posted.at(-1)).toMatchObject({
      followUps: Array.from({ length: 14 }, (_, i) => `message ${i + 1}`),
    });
    expect(s.posted.at(-1)).not.toHaveProperty('answers');
  });

  it('stops at the count bound without accepting the new text, and still lets a pressed fact be edited', async () => {
    const s = server(answer({ sheet: SHEET, readBack: ['Your goal'] }));
    const t = talk(s.api);
    let reply = await t.turn({ kind: 'text', text: GOAL }, null);
    for (let i = 1; i < 200; i++)
      reply = await t.turn({ kind: 'text', text: `message ${i}` }, reply.sheet);
    const before = reply.sheet;
    const blocked = await t.turn({ kind: 'text', text: 'do not lose my earlier limits' }, before);
    expect(s.posted).toHaveLength(200);
    expect(blocked.sheet).toEqual(before);
    expect(blocked.say).toEqual([{ key: 'failure', text: en.talk.capacity }]);
    const edited = await t.turn({ kind: 'answer', fact: 'amount', value: '3000' }, blocked.sheet);
    expect(s.posted).toHaveLength(201);
    expect(s.posted.at(-1)).toMatchObject({
      answers: { amountUsd: 3000 },
      followUps: before.words?.slice(1),
    });
    expect(edited.sheet.words).toEqual(before.words);
  });

  it('keeps prior accepted state when the joined text exceeds the budget, in both languages', async () => {
    for (const lang of ['en', 'pt'] as const) {
      const s = server(answer({ sheet: SHEET, readBack: ['Your goal'] }));
      const t = intakeConversation(s.api, {
        lang,
        chain: 'solana',
        fallback: {
          turn: async () => {
            throw Error('No fallback on capacity');
          },
        },
      });
      let reply = await t.turn({ kind: 'text', text: 'x'.repeat(2000) }, null);
      for (let i = 0; i < 9; i++)
        reply = await t.turn({ kind: 'text', text: 'y'.repeat(2000) }, reply.sheet);
      reply = await t.turn({ kind: 'text', text: 'z'.repeat(1980) }, reply.sheet);
      expect(s.posted).toHaveLength(11); // joined text is exactly22,000 including20 separators
      const before = reply.sheet;
      const blocked = await t.turn({ kind: 'text', text: 'one more' }, before);
      expect(s.posted).toHaveLength(11);
      expect(blocked.sheet).toEqual(before);
      expect(blocked.say).toEqual([{ key: 'failure', text: dictionary(lang).talk.capacity }]);
    }
  });

  it('keeps prior state if an API deployed with the old ten-follow-up bound refuses the next turn', async () => {
    const posted: Body[] = [];
    const api = async (_path: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      posted.push(body);
      return Array.isArray(body.followUps) && body.followUps.length > 10
        ? json({ error: 'old route bound' }, 400)
        : json(answer({ sheet: SHEET, readBack: ['Your goal'] }));
    };
    const t = intakeConversation(api, {
      lang: 'en',
      chain: 'solana',
      fallback: {
        turn: async () => {
          throw Error('No fallback for a refusal');
        },
      },
    });
    let r = await t.turn({ kind: 'text', text: GOAL }, null);
    for (let i = 0; i < 10; i++)
      r = await t.turn({ kind: 'text', text: `Accepted detail ${i}` }, r.sheet);
    const before = r.sheet;
    const refused = await t.turn({ kind: 'text', text: 'New exclusion' }, before);
    expect(posted.at(-1)?.followUps).toHaveLength(11);
    expect(refused.sheet).toEqual(before);
    expect(refused.say).toEqual([{ key: 'failed', why: 'unreadable' }]);
    expect(refused.valid).toEqual(before.intake?.sheet);
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
    expect(s.posted[0]).toEqual(
      wire({
        text: 'Grow $2,000',
        language: 'en',
        followUps: ['I like AI', 'five years'],
        answersThen: [{}, { goal: 'grow', amountUsd: 2000 }],
        answers: { goal: 'grow', amountUsd: 2000 },
      }),
    );
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
    expect(s.posted[1]).toEqual(wire({ text: GOAL, language: 'en', answers: { risk: 'high' } }));
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
    expect(s.posted[1]).toEqual(
      wire({
        text: GOAL,
        language: 'en',
        answers: { mix: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 } },
      }),
    );
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
