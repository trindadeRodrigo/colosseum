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

  it('lets the latest statement stand, and reads a correction', () => {
    expect(
      read('I want it to grow, high risk is fine.', 'Actually no. Keep it safe, low risk.'),
    ).toEqual({ goal: 'protect', risk: 'low' });
    expect(read('Quero crescer, risco alto.', 'Na verdade quero renda, risco baixo.')).toEqual({
      goal: 'income',
      risk: 'low',
    });
    // a later message about something else changes nothing
    expect(read('I want income, low risk.', 'Add some Tesla.')).toEqual({
      goal: 'income',
      risk: 'low',
    });
    // one kind corrected, the other kept
    expect(read('I want growth, high risk is fine.', 'Medium risk')).toEqual({
      goal: 'grow',
      risk: 'medium',
    });
  });

  it('takes a value back when a later message refuses or questions it and states no other', () => {
    expect(read('I want growth.', 'Actually, not growth.')).toEqual(NOTHING);
    expect(read('I want growth, high risk is fine.', 'I do not want high risk')).toEqual({
      goal: 'grow',
      risk: null,
    });
    expect(read('Keep it safe.', 'Is safe the right choice?')).toEqual(NOTHING);
    expect(read('I want growth, low risk.', 'Actually no.')).toEqual(NOTHING);
    expect(read('Quero renda.', 'Não quero mais renda.')).toEqual(NOTHING);
    expect(read('I want income.', 'Growth or income, I cannot decide')).toEqual(NOTHING);
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
