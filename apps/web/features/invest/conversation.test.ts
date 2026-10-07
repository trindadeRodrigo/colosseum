import { describe, expect, it, vi } from 'vitest';
import { dictionary } from '../../i18n';
import { READ_IN_DOLLARS } from '../goal/test/plan';
import { json } from '../wallet/test/fake-port';
import {
  affirmed,
  FACTS,
  fitAnswer,
  isGoAhead,
  openFacts,
  PICKS,
  pickOf,
  QUICK,
  readerConversation,
  type Sheet,
  silentCountry,
  validOf,
} from './conversation';
import { wayChange } from './ways';

// The conversation behind its interface: what is sent, the sheet so far, what is still open and what
// to say. The reader is a double of POST /goals as `staging` answers it.

const en = dictionary('en');
const reader = (answer: unknown = READ_IN_DOLLARS, status = 200) =>
  vi.fn(async (_path: string) => json(answer, status));
const talk = (apiFetch = reader(), chain: 'solana' | null = 'solana') =>
  readerConversation(apiFetch, {
    lang: 'en',
    chain,
    examples: en.goal.examples.list,
    country: 'BR',
  });
const facts = (sheet: Sheet) => Object.fromEntries(FACTS.map((f) => [f, sheet.fields[f]]));

describe('a first sentence', () => {
  it('reads an example of the page without asking a reader: every fact known, and ready', async () => {
    const api = reader();
    const reply = await talk(api).turn(
      { kind: 'text', text: en.goal.examples.list[1] as string },
      null,
    );
    expect(api).not.toHaveBeenCalled();
    expect(facts(reply.sheet)).toEqual({
      goal: 'protect',
      amount: '50000',
      income: '',
      horizon: '18',
      risk: 'low',
    });
    expect(reply.open).toEqual([]);
    expect(reply.ask).toBeNull();
    expect(reply.say.map((s) => s.key)).toEqual(['understood', 'ready']);
    expect(reply.valid).toMatchObject({ goal: 'protect', amountUsd: 50000, chains: ['solana'] });
  });

  it('asks what the words did not say, one question at a time, and assumes nothing the reader guessed', async () => {
    // the reader answers "accumulation" and "medium" for any goal that names neither
    const api = reader();
    const reply = await talk(api).turn(
      { kind: 'text', text: 'Forty thousand for an apartment' },
      null,
    );
    expect(api).toHaveBeenCalledTimes(1);
    // nothing it only assumed is in the sheet
    expect(facts(reply.sheet)).toEqual({ goal: '', amount: '', income: '', horizon: '', risk: '' });
    expect(reply.open).toEqual(['goal', 'amount', 'horizon', 'risk']);
    expect(reply.ask).toBe('goal');
    expect(reply.valid).toBeNull();
  });

  it('takes what the words themselves say over the reader', async () => {
    const reply = await talk().turn(
      { kind: 'text', text: 'Protect $50,000 for 18 months, low risk, please' },
      null,
    );
    expect(facts(reply.sheet)).toMatchObject({
      goal: 'protect',
      amount: '50000',
      horizon: '18',
      risk: 'low',
    });
    expect(reply.open).toEqual([]);
  });

  it('says so when the reader cannot be reached, and keeps nothing', async () => {
    const reply = await talk(reader({}, 503)).turn({ kind: 'text', text: 'Grow my savings' }, null);
    expect(reply.say).toEqual([{ key: 'failed', why: 'unreachable' }]);
    expect(reply.valid).toBeNull();
  });
});

describe('the turns after', () => {
  const start = async () => (await talk().turn({ kind: 'text', text: 'Grow $40,000' }, null)).sheet;

  it('takes an answer to the open question, then asks the next', async () => {
    const sheet = await start();
    expect(openFacts(sheet)).toEqual(['horizon', 'risk']);
    const next = await talk().turn({ kind: 'answer', fact: 'horizon', value: '36' }, sheet);
    expect(next.say).toEqual([{ key: 'set', fact: 'horizon' }]);
    expect(next.ask).toBe('risk');
    const done = await talk().turn({ kind: 'answer', fact: 'risk', value: 'medium' }, next.sheet);
    expect(done.ask).toBeNull();
    expect(done.say.at(-1)).toEqual({ key: 'ready' });
    expect(done.valid).toMatchObject({ amountUsd: 40000, horizonMonths: 36, risk: 'medium' });
  });

  it('reads a typed answer: a bare number of years, or facts said in passing, without the reader', async () => {
    const api = reader();
    const sheet = await start();
    const years = await talk(api).turn({ kind: 'text', text: '5' }, sheet);
    expect(years.sheet.fields.horizon).toBe('60');
    const more = await talk(api).turn({ kind: 'text', text: 'low risk' }, years.sheet);
    expect(more.sheet.fields.risk).toBe('low');
    expect(api).not.toHaveBeenCalled();
  });

  it('asks again when an answer is not one the fact takes, and changes nothing', async () => {
    const sheet = await start();
    for (const [fact, value] of [
      ['horizon', '0'],
      ['amount', '5'],
      ['amount', 'abc'],
      ['risk', 'reckless'],
    ] as const) {
      const reply = await talk().turn({ kind: 'answer', fact, value }, sheet);
      expect(reply.say, value).toEqual([{ key: 'unfit', fact }]);
      expect(reply.ask).toBe(fact);
      expect(reply.sheet).toEqual(sheet);
    }
    const lost = await talk().turn({ kind: 'text', text: 'hmm' }, sheet);
    expect(lost.say).toEqual([{ key: 'unfit', fact: 'horizon' }]);
  });

  it('asks an income goal how much a month, and lets the person leave it out', async () => {
    const sheet = (
      await talk().turn({ kind: 'text', text: 'Income from $80,000 for 5 years, low risk' }, null)
    ).sheet;
    expect(openFacts(sheet)).toEqual(['income']);
    const skipped = await talk().turn({ kind: 'answer', fact: 'income', value: '' }, sheet);
    expect(skipped.open).toEqual([]);
    expect(skipped.sheet.skipped).toEqual(['income']);
    expect(skipped.valid?.incomeTargetUsdMonthly).toBeUndefined();
    const asked = await talk().turn({ kind: 'answer', fact: 'income', value: '300' }, sheet);
    expect(asked.valid?.incomeTargetUsdMonthly).toBe(300);
    // a monthly figure is an income's: another goal drops it
    const grow = await talk().turn({ kind: 'answer', fact: 'goal', value: 'grow' }, asked.sheet);
    expect(grow.sheet.fields.income).toBe('');
  });

  it('opens a fact again when the person taps it: it is asked, and no plan is built meanwhile', async () => {
    const whole = (
      await talk().turn({ kind: 'text', text: en.goal.examples.list[0] as string }, null)
    ).sheet;
    const reply = await talk().turn({ kind: 'reopen', fact: 'amount' }, whole);
    expect(reply.ask).toBe('amount');
    expect(reply.valid).toBeNull();
    expect(reply.sheet.fields.amount).toBe('2000');
  });

  it('is not valid while the chain is not known', async () => {
    const whole = (
      await talk().turn({ kind: 'text', text: en.goal.examples.list[0] as string }, null)
    ).sheet;
    expect(validOf(whole, null)).toBeNull();
    expect(validOf(whole, 'solana')).not.toBeNull();
  });
});

describe('words that change nothing', () => {
  it('are answered as held once a goal is known, and as not understood only before one is', async () => {
    const whole = (
      await talk().turn({ kind: 'text', text: en.goal.examples.list[0] as string }, null)
    ).sheet;
    const api = reader();
    const reply = await talk(api).turn({ kind: 'text', text: 'what is the weather like' }, whole);
    expect(reply.say.map((s) => s.key)).toEqual(['held', 'ready']);
    expect(reply.sheet).toEqual(whole);
    expect(api).not.toHaveBeenCalled();
    const first = await talk().turn({ kind: 'text', text: 'hello there' }, null);
    expect(first.say.map((s) => s.key)).toEqual(['notUnderstood']);
  });

  /** Every fact known, at the risk named. */
  const at = async (risk: 'low' | 'medium' | 'high') =>
    (
      await talk().turn(
        { kind: 'answer', fact: 'risk', value: risk },
        (
          await talk().turn({ kind: 'text', text: en.goal.examples.list[0] as string }, null)
        ).sheet,
      )
    ).sheet;

  it('says what it cannot take: a single stock is named back by our own name, and more risk at the highest says so (Thom, Oct 7)', async () => {
    const high = await at('high');
    const api = reader();
    const text = 'more risk. what else could I use to do more stuff. I like nvidia';
    const reply = await talk(api).turn({ kind: 'text', text }, high);
    expect(reply.say).toEqual([
      { key: 'cantPick', pick: 'nvidia' },
      { key: 'riskTop' },
      { key: 'held' },
      { key: 'ready' },
    ]);
    // nothing was taken, and nothing typed is carried in the reply
    expect(reply.sheet).toEqual(high);
    expect(JSON.stringify(reply.say)).not.toMatch(/stuff|I like/);
    expect(api).not.toHaveBeenCalled();
    // the sentences, from the dictionary
    expect(en.talk.say.cantPick[PICKS.nvidia.kind](PICKS.nvidia.name)).toBe(
      'I can’t pick single stocks like Nvidia yet. I can change the risk, the amount, the time or what it’s for.',
    );
    expect(en.talk.say.riskTop).toBe('The risk is already high, the highest I can do.');
  });

  it('takes "more risk" and "less risk" as a step from the risk that is held, and stops at the ends', async () => {
    const up = await talk().turn({ kind: 'text', text: 'more risk please' }, await at('medium'));
    expect(up.sheet.fields.risk).toBe('high');
    expect(up.say.map((s) => s.key)).toEqual(['understood', 'ready']);
    const down = await talk().turn({ kind: 'text', text: 'something safer' }, await at('medium'));
    expect(down.sheet.fields.risk).toBe('low');
    const low = await at('low');
    const floor = await talk().turn({ kind: 'text', text: 'menos risco' }, low);
    expect(floor.say.map((s) => s.key)).toEqual(['riskBottom', 'held', 'ready']);
    expect(floor.sheet).toEqual(low);
    // a risk said outright is taken as said
    const said = await talk().turn({ kind: 'text', text: 'more risk: high risk' }, low);
    expect(said.sheet.fields.risk).toBe('high');
  });

  it('takes what it can from a message and says what it could not', async () => {
    const reply = await talk().turn(
      { kind: 'text', text: 'make it 7 years and buy Tesla' },
      await at('medium'),
    );
    expect(reply.sheet.fields.horizon).toBe('84');
    expect(reply.say).toEqual([
      { key: 'understood' },
      { key: 'cantPick', pick: 'tesla' },
      { key: 'ready' },
    ]);
    // on a first sentence too
    const first = await talk().turn({ kind: 'text', text: 'Forty thousand in bitcoin' }, null);
    expect(first.say).toContainEqual({ key: 'cantPick', pick: 'bitcoin' });
    expect(pickOf('a plan for my daughter', 'en')).toBeNull();
    expect(pickOf('something meaningful', 'en')).toBeNull();
  });

  it('holds, and says so, when the words say only what is already held', async () => {
    const high = await at('high');
    const reply = await talk().turn({ kind: 'text', text: 'high risk' }, high);
    expect(reply.say.map((s) => s.key)).toEqual(['held', 'ready']);
    expect(reply.sheet).toEqual(high);
  });

  it.each([
    ['en', 'I don’t want more risk'],
    ['en', "I don't want more risk"],
    ['en', 'no more risk please'],
    ['en', 'not riskier'],
    ['en', 'never less risk'],
    ['en', 'I do not want something safer'],
    ['pt', 'não quero mais risco'],
    ['pt', 'nao quero mais risco'],
    ['pt', 'sem mais risco'],
    ['pt', 'nunca menos risco'],
  ] as const)('takes no step from a risk that is refused (%s: "%s")', async (lang, text) => {
    const medium = await at('medium');
    const reply = await readerConversation(reader(), {
      lang,
      chain: 'solana',
      examples: en.goal.examples.list,
      country: 'BR',
    }).turn({ kind: 'text', text }, medium);
    expect(reply.sheet).toEqual(medium);
    // answered in context: what is held, and nothing built again
    expect(reply.say.map((s) => s.key)).toEqual(['held', 'ready']);
  });

  it.each([
    ['en', 'not $5,000', 'amount'],
    ['en', 'I don’t want ten years', 'horizon'],
    ['en', "I don't want 10 years", 'horizon'],
    ['en', 'not high risk', 'risk'],
    ['en', 'no income', 'goal'],
    ['pt', 'não quero 10 anos', 'horizon'],
    ['pt', 'não R$ 5.000', 'amount'],
    ['pt', 'sem risco alto', 'risk'],
  ] as const)(
    'takes no amount, time, risk or goal from words that refuse it (%s: "%s")',
    async (lang, text, fact) => {
      const medium = await at('medium');
      const reply = await readerConversation(reader(), {
        lang,
        chain: 'solana',
        examples: en.goal.examples.list,
        country: 'BR',
      }).turn({ kind: 'text', text }, medium);
      expect(reply.sheet.fields[fact], text).toBe(medium.fields[fact]);
      expect(reply.sheet).toEqual(medium);
      expect(reply.say.map((s) => s.key)).toContain('held');
    },
  );

  it('still takes what the same message asks for beside what it refuses', async () => {
    const medium = await at('medium');
    const reply = await talk().turn(
      { kind: 'text', text: 'not $5,000, make it $8,000. I don’t want more risk' },
      medium,
    );
    expect(reply.sheet.fields.amount).toBe('8000');
    expect(reply.sheet.fields.risk).toBe('medium');
    // an answer to the question that is open is refused the same way
    const open = { ...medium, fields: { ...medium.fields, horizon: '' } };
    const no = await talk().turn({ kind: 'text', text: 'not 10 years' }, open);
    expect(no.sheet.fields.horizon).toBe('');
    expect(no.say).toEqual([{ key: 'unfit', fact: 'horizon' }]);
    // words that refuse nothing are read exactly as typed, figures and all
    expect(affirmed('Grow $40,000.50 over 3 years, medium risk', 'en')).toBe(
      'Grow $40,000.50 over 3 years, medium risk',
    );
    // "no" is "in the" in Portuguese
    expect(affirmed('R$ 40.000 no longo prazo', 'pt')).toBe('R$ 40.000 no longo prazo');
    expect(affirmed('no more risk', 'en')).toBe('');
  });

  it('does not take a refused fact from a first sentence either: it is left open and asked', async () => {
    // a reader that took the risk from the words it was refused in
    const api = reader({
      ...READ_IN_DOLLARS,
      candidate: { ...READ_IN_DOLLARS.candidate, riskBudget: 'high' },
    });
    const reply = await talk(api).turn(
      { kind: 'text', text: 'Grow $40,000 over 3 years. Not high risk' },
      null,
    );
    expect(reply.sheet.fields.amount).toBe('40000');
    expect(reply.sheet.fields.risk).toBe('');
    expect(reply.ask).toBe('risk');
  });

  it('does not read the Portuguese word for a goal as the company', async () => {
    const pt = readerConversation(reader(), {
      lang: 'pt',
      chain: 'solana',
      examples: en.goal.examples.list,
      country: 'BR',
    });
    const first = await pt.turn(
      { kind: 'text', text: 'Minha meta é fazer R$ 40.000 crescer' },
      null,
    );
    expect(first.say.map((s) => s.key)).not.toContain('cantPick');
    expect(pickOf('Minha meta é crescer', 'pt')).toBeNull();
    expect(pickOf('buy Meta', 'en')).toBe('meta');
    expect(pickOf('ações do Facebook', 'pt')).toBe('meta');
  });

  it('keeps a first sentence’s monthly figure while the goal is still open, and drops it for a goal that is not income', async () => {
    // the reader guesses the goal: it is left open, and "$300 a month" is not thrown away
    const first = await talk().turn({ kind: 'text', text: '$80,000 and $300 each month' }, null);
    expect(first.sheet.fields.goal).toBe('');
    expect(first.sheet.fields.income).toBe('300');
    expect(first.ask).toBe('goal');
    const income = await talk().turn(
      { kind: 'answer', fact: 'goal', value: 'income' },
      first.sheet,
    );
    expect(income.sheet.fields.income).toBe('300');
    expect(income.open).not.toContain('income');
    const grow = await talk().turn({ kind: 'answer', fact: 'goal', value: 'grow' }, first.sheet);
    expect(grow.sheet.fields.income).toBe('');
  });

  it('knows the few words that are a go-ahead, alone, in both languages', () => {
    for (const word of [
      'yes',
      'Yes.',
      'ok',
      'OK!',
      'go',
      'build',
      'build it',
      'sim',
      'pode',
      'bora',
    ])
      expect(isGoAhead(word), word).toBe(true);
    for (const words of [
      'yes but make it five years',
      'no',
      'grow',
      'ok $50,000',
      '',
      // a filler is not a yes
      'so?',
      'so',
      'and',
      'then',
      'next',
      'please',
      'e aí',
      'então',
    ])
      expect(isGoAhead(words), words).toBe(false);
  });
});

describe('what is never asked, and what the quick replies send', () => {
  it('has no country among its facts, and sends one silently', () => {
    expect(FACTS).not.toContain('country');
    expect(silentCountry(['pt-BR'])).toBe('BR');
    expect(silentCountry(['en-US'])).toBe('US');
    expect(silentCountry(['en'])).toBe('BR');
  });

  it('offers only replies the fact takes', () => {
    for (const fact of FACTS)
      for (const value of QUICK[fact])
        if (value !== '') expect(fitAnswer(fact, value, 'en'), `${fact} ${value}`).toBe(value);
  });
});

describe('a way to close a gap, as the engine wrote it', () => {
  const sheet = { amountUsd: 80_000, incomeTargetUsdMonthly: 300, language: 'en' as const };
  it('is a larger amount, read from its own figure', () => {
    expect(wayChange('You can add $83,100, for $163,100 in all.', sheet)).toEqual({
      fact: 'amount',
      value: '163100',
    });
  });
  it('is a smaller income, read from its own figure', () => {
    expect(wayChange('You can aim for $147 a month instead of $300.', sheet)).toEqual({
      fact: 'income',
      value: '147',
    });
  });
  it('reads Portuguese figures as Portuguese writes them', () => {
    expect(
      wayChange('Você pode aplicar mais US$ 83.100, US$ 163.100 no total.', {
        ...sheet,
        language: 'pt',
      }),
    ).toEqual({ fact: 'amount', value: '163100' });
  });
  it('changes nothing for a sentence that names neither', () => {
    expect(wayChange('No larger amount closes the gap.', sheet)).toBeNull();
  });
});
