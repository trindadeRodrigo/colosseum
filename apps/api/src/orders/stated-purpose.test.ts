import { describe, expect, it } from 'vitest';
import { statedPurpose } from './stated-purpose';

// The goal decides which assets a plan may hold, so what the server reads of it errs towards nothing
// (gate DEPOSIT-STEP): every row under "states nothing" once served a wrong goal or risk.

const person = (...texts: string[]) => texts.map((text) => ({ who: 'person' as const, text }));
const read = (...texts: string[]) => statedPurpose(person(...texts));
const NOTHING = { goal: null, risk: null };

describe('the goal and risk a person stated, read from their own words', () => {
  it.each([
    ['I want it to grow.', 'grow'],
    ['This is for growth', 'grow'],
    ['Growth, please.', 'grow'],
    ['I need monthly income', 'income'],
    ['Looking for passive income.', 'income'],
    ['Keep it safe', 'protect'],
    ['I want to protect my savings', 'protect'],
    ['My goal is to preserve capital', 'protect'],
    ['Quero que cresça.', 'grow'],
    ['Para crescer', 'grow'],
    ['Preciso de renda mensal', 'income'],
    ['Quero renda', 'income'],
    ['Quero manter seguro', 'protect'],
    ['Meu objetivo é proteger o patrimônio', 'protect'],
  ] as const)('reads the goal of "%s"', (text, goal) => {
    expect(read(text)).toEqual({ goal, risk: null });
  });

  it.each([
    ['Only low risk please.', 'low'],
    ['I am conservative', 'low'],
    ['My risk tolerance is low', 'low'],
    ['Medium risk', 'medium'],
    ['I want moderate risk', 'medium'],
    ['I can take high risk', 'high'],
    ['High risk is fine', 'high'],
    ['Risk: high', 'high'],
    ['Risco baixo, por favor', 'low'],
    ['Quero pouco risco', 'low'],
    ['Sou conservador', 'low'],
    ['Risco médio', 'medium'],
    ['Aceito risco alto', 'high'],
    ['Quero alto risco', 'high'],
    ['Meu perfil de risco é moderado', 'medium'],
  ] as const)('reads the risk of "%s"', (text, risk) => {
    expect(read(text)).toEqual({ goal: null, risk });
  });

  it('reads both from one sentence, in either language', () => {
    expect(read('I want it to grow, high risk is fine.')).toEqual({ goal: 'grow', risk: 'high' });
    expect(read('For income, at low risk')).toEqual({ goal: 'income', risk: 'low' });
    expect(read('Para crescer, com risco alto')).toEqual({ goal: 'grow', risk: 'high' });
    expect(read('Quero renda mensal com risco baixo.')).toEqual({ goal: 'income', risk: 'low' });
  });

  it.each([
    ['I do not want growth, I am retired.'],
    ['Is protect better than grow for me?'],
    ['This is for my retirement in Tesla and Nvidia.'],
    ['Tell me about Tesla.'],
    ['Go slow, I am incoming to this.'],
    ['yes'],
    ['ok'],
    ['sim'],
    ['Não quero risco alto nem crescer rápido.'],
    // a level or the word alone, a remark, another person's wish, a figure, a comparison, a hedge
    ['I understand the risk'],
    ['low'],
    ['The risk is high'],
    ['This is high risk'],
    ['My income is good'],
    ['I like growth stocks'],
    ['My wife wants growth'],
    ['I want 10% growth'],
    ['Growth or income'],
    ['I want lower risk'],
    ['Quero menos risco'],
    ['Maybe growth'],
    ['Acho que renda'],
    ['I want growth and income'],
    ['Low risk? High risk?'],
    ['What is low risk?'],
    ['I want growth if it is safe'],
    ['I don’t want income'],
    ['Sem renda'],
    ['Never high risk'],
    ['No growth'],
    ['Evite risco alto'],
    ['Lowlands and highlands, growthy incomes'],
    ['The risk level is high here'],
    ['The plan is conservative'],
    ['I want to keep my income'],
    ['I am fine with this, it is high risk'],
    ['I am safe'],
    ['That profile is high risk'],
  ])('reads nothing in "%s"', (text) => {
    expect(read(text)).toEqual(NOTHING);
  });

  it('does not read "only low risk" as anything but low, whatever else is said about risk', () => {
    expect(read('Only low risk please.').risk).toBe('low');
  });

  it('lets the latest statement stand, through messages that have nothing to do with it', () => {
    // a later message about something else changes nothing
    expect(read('I want income, low risk.', 'Add some Tesla.')).toEqual({
      goal: 'income',
      risk: 'low',
    });
    // one kind stated again, the other kept
    expect(read('I want growth, high risk is fine.', 'Medium risk')).toEqual({
      goal: 'grow',
      risk: 'medium',
    });
    expect(read('Quero crescer, risco alto.', 'Quero renda, risco baixo.')).toEqual({
      goal: 'income',
      risk: 'low',
    });
    expect(read('High risk is fine', 'ok, low risk')).toEqual({ goal: null, risk: 'low' });
  });

  // Until the reader read a message whole, each of these two read protect and low, and income and
  // low: a correction word anywhere now withdraws, and the person is asked by a tap.
  it('reads a correction as a withdrawal, never as the value before it', () => {
    expect(
      read('I want it to grow, high risk is fine.', 'Actually no. Keep it safe, low risk.'),
    ).toEqual(NOTHING);
    expect(read('Quero crescer, risco alto.', 'Na verdade quero renda, risco baixo.')).toEqual(
      NOTHING,
    );
  });

  it.each([
    // a refusal that stood in another piece of the sentence
    [['For anything but income.']],
    [['I want it safe but growing']],
    [['I want everything but income']],
    [['High risk. No thanks.']],
    [['Growth. Not for me.']],
    [["I don't want\nhigh risk"]],
    [['I want growth but low risk']],
    [['Quero tudo menos renda']],
    [['Quero crescer, exceto com risco alto']],
    // the latest statement, when it does not parse, still replaces the one before it
    [['I want it to grow.', 'Actually, income']],
    [['grow. sorry, protect']],
    [['high risk is fine', 'Honestly low risk suits me']],
    [['I can take high risk but prefer low']],
    [['I want it to grow.', 'income would be better']],
    [['Quero crescer.', 'Pensando bem, renda']],
    [['I want low risk', 'the risk here worries me']],
    // the same letters typed another way, and a sign that is not a letter
    [['Na\u0303o quero crescer']],
    [['na\u0303o quero risco alto']],
    [['growth 👎']],
    [['high risk ❌']],
    [['I want growth :(  *']],
    // a goal word in another sense
    [['quero um seguro']],
    [['quero fazer um seguro']],
    [['com segurança']],
    [['It is safe to take high risk']],
    [['para de crescer']],
    [['I want fixed income']],
    [['Quero renda fixa']],
    // held before, and still
    [['I want to stop growth']],
    [['keep me away from high risk']],
    [['I need out of safe']],
    [['quero sair de renda']],
    [['I want my income safe']],
    [['I want to grow my business']],
    [['my wife says high risk']],
    [['my tolerance for high risk is low']],
    [['medium to high risk']],
    [['Growth, right?']],
    [['wow, high risk']],
    [['hmm high risk']],
    [['ok high risk then']],
  ] as [string[]][])('reads nothing in %j', (texts) => {
    expect(read(...texts)).toEqual(NOTHING);
  });

  it('withdraws both on a message that only refuses, and on any refusal after a statement', () => {
    expect(read('I want growth, low risk.', 'Actually no.')).toEqual(NOTHING);
    expect(read('I want growth, low risk.', 'No thanks.')).toEqual(NOTHING);
    expect(read('I want growth, low risk.', 'Not for me.')).toEqual(NOTHING);
    expect(read('Quero renda, risco baixo.', 'Não.')).toEqual(NOTHING);
    // a refusal of something else withdraws too: the reader cannot tell what was refused
    expect(read('I want growth, low risk.', 'No Tesla please')).toEqual(NOTHING);
  });

  it('takes a value back when a later message refuses or questions it and states no other', () => {
    expect(read('I want growth.', 'Actually, not growth.')).toEqual(NOTHING);
    // "not" withdraws the goal with the risk: before the whole-message read the goal stood
    expect(read('I want growth, high risk is fine.', 'I do not want high risk')).toEqual(NOTHING);
    expect(read('Keep it safe.', 'Is safe the right choice?')).toEqual(NOTHING);
    expect(read('Quero renda.', 'Não quero mais renda.')).toEqual(NOTHING);
    expect(read('I want income.', 'Growth or income, I cannot decide')).toEqual(NOTHING);
    // a question or a hedge about one kind leaves the other
    expect(read('I want growth, high risk is fine.', 'What is high risk?')).toEqual({
      goal: 'grow',
      risk: null,
    });
    expect(read('I want growth, high risk is fine.', 'maybe income')).toEqual({
      goal: null,
      risk: 'high',
    });
    // a question about something else is passed over
    expect(read('I want growth, high risk is fine.', 'What is Tesla?')).toEqual({
      goal: 'grow',
      risk: 'high',
    });
  });

  it('keeps reading the plain answers the conversation asks for', () => {
    expect(read('ok, high risk')).toEqual({ goal: null, risk: 'high' });
    expect(read('Goal: growth')).toEqual({ goal: 'grow', risk: null });
    expect(read('I am moderate')).toEqual({ goal: null, risk: 'medium' });
    expect(read('to grow\nmedium risk')).toEqual({ goal: 'grow', risk: 'medium' });
  });

  it('reads only the person: the app’s words, and a yes to them, state nothing', () => {
    expect(
      statedPurpose([
        { who: 'app', text: 'Should this be kept safe, at low risk?' },
        { who: 'person', text: 'yes' },
      ]),
    ).toEqual(NOTHING);
    expect(
      statedPurpose([
        { who: 'person', text: 'Some stocks' },
        { who: 'app', text: 'I want it to grow, high risk is fine.' },
      ]),
    ).toEqual(NOTHING);
  });
});
