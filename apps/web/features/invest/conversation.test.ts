import { describe, expect, it, vi } from 'vitest';
import { dictionary } from '../../i18n';
import { READ_IN_DOLLARS } from '../goal/test/plan';
import { json } from '../wallet/test/fake-port';
import {
  FACTS,
  fitAnswer,
  isGoAhead,
  openFacts,
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

  it('knows the few words that are a go-ahead, alone, in both languages', () => {
    for (const word of [
      'yes',
      'Yes.',
      'ok',
      'OK!',
      'go',
      'so?',
      'build',
      'build it',
      'sim',
      'pode',
      'bora',
    ])
      expect(isGoAhead(word), word).toBe(true);
    for (const words of ['yes but make it five years', 'no', 'grow', 'ok $50,000', ''])
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
