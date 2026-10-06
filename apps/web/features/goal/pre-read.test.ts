import type { BasketSheetDraft } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { EXAMPLE_FIELDS, exampleDraft } from './examples';
import { browserCountry, fillFromWords, preRead, type Words } from './pre-read';

// The words of a goal this app reads for itself, before POST /goals, and how they fill the blanks the
// first structurer's reader leaves. Every example chip, in both languages, and ten goals typed freely
// in each, read back field by field.

const NOW = new Date('2026-10-06T12:00:00Z');

describe('the words of a goal', () => {
  it.each(['en', 'pt'] as const)('read every example chip back in full, in %s', (lang) => {
    for (const [i, text] of dictionary(lang).goal.examples.list.entries()) {
      const fields = EXAMPLE_FIELDS[i];
      const words = preRead(text, NOW);
      for (const [key, value] of Object.entries(fields ?? {}))
        expect(words[key as keyof Words] ?? null, `${text}: ${key}`).toBe(value);
    }
  });

  it.each<[string, Words]>([
    [
      'Protect $50,000 for 18 months, low risk',
      { goal: 'protect', amountUsd: 50_000, horizonMonths: 18, risk: 'low' },
    ],
    [
      'Grow 50k over 2 years, medium risk',
      { goal: 'grow', amountUsd: 50_000, horizonMonths: 24, risk: 'medium' },
    ],
    [
      'I want to turn $5k into a down payment by 2031, high-risk',
      { goal: 'grow', amountUsd: 5_000, horizonMonths: 51, risk: 'high' },
    ],
    ['Keep $12,500 safe for six months', { goal: 'protect', amountUsd: 12_500, horizonMonths: 6 }],
    [
      'Preserve 20,000 dollars for 3 years, conservative',
      { goal: 'protect', amountUsd: 20_000, horizonMonths: 36, risk: 'low' },
    ],
    [
      'Pay me $500 a month from $150,000',
      { goal: 'income', amountUsd: 150_000, incomeTargetUsdMonthly: 500 },
    ],
    [
      'I have $90k and want a monthly income of $400',
      { goal: 'income', amountUsd: 90_000, incomeTargetUsdMonthly: 400 },
    ],
    [
      'Build $0.25 million for retirement in 20 years, risk: high',
      { goal: 'grow', amountUsd: 250_000, horizonMonths: 240, risk: 'high' },
    ],
    ['Grow USD 3,000 for ten years', { goal: 'grow', amountUsd: 3_000, horizonMonths: 120 }],
    ['$800 for 12 months, moderate', { amountUsd: 800, horizonMonths: 12, risk: 'medium' }],
  ])('read a goal typed in English: %s', (text, expected) => {
    expect(preRead(text, NOW)).toEqual(expected);
  });

  it.each<[string, Words]>([
    [
      'Proteger US$ 50.000 por 18 meses, risco baixo',
      { goal: 'protect', amountUsd: 50_000, horizonMonths: 18, risk: 'low' },
    ],
    [
      'Fazer US$ 10.000 crescer em 5 anos, risco médio',
      { goal: 'grow', amountUsd: 10_000, horizonMonths: 60, risk: 'medium' },
    ],
    [
      'Quero guardar 30 mil dólares até 2031, baixo risco',
      { goal: 'protect', amountUsd: 30_000, horizonMonths: 51, risk: 'low' },
    ],
    ['Preservar US$ 7.500 por dois anos', { goal: 'protect', amountUsd: 7_500, horizonMonths: 24 }],
    [
      'Multiplicar $20k em dez anos, risco alto',
      { goal: 'grow', amountUsd: 20_000, horizonMonths: 120, risk: 'high' },
    ],
    [
      'Uma renda de US$ 250 por mês com US$ 60.000',
      { goal: 'income', amountUsd: 60_000, incomeTargetUsdMonthly: 250 },
    ],
    [
      'Me pague US$ 400 por mês a partir de US$ 100 mil',
      { goal: 'income', amountUsd: 100_000, incomeTargetUsdMonthly: 400 },
    ],
    [
      'Aumentar US$ 1.200 por 6 meses, agressivo',
      { goal: 'grow', amountUsd: 1_200, horizonMonths: 6, risk: 'high' },
    ],
    [
      'Construir uma reserva com 15 mil dólares em 3 anos, moderado',
      { goal: 'grow', amountUsd: 15_000, horizonMonths: 36, risk: 'medium' },
    ],
    [
      'Manter US$ 40.000 em segurança por 12 meses',
      { goal: 'protect', amountUsd: 40_000, horizonMonths: 12 },
    ],
  ])('read a goal typed in Portuguese: %s', (text, expected) => {
    expect(preRead(text, NOW)).toEqual(expected);
  });

  it('leaves an amount in reais for the person: plans are in dollars for now', () => {
    expect(preRead('Juntar R$ 50.000 em 3 anos', NOW)).toEqual({ horizonMonths: 36 });
    expect(preRead('Juntar R$50k em 3 anos', NOW).amountUsd).toBeUndefined();
    expect(preRead('Proteger 50 mil reais', NOW)).toEqual({ goal: 'protect' });
    expect(preRead('Proteger 50k reais', NOW)).toEqual({ goal: 'protect' });
  });

  it('takes "a month" for how often, never for how long', () => {
    expect(preRead('$300 a month of income', NOW).horizonMonths).toBeUndefined();
    expect(preRead('US$ 300 por mês de renda', NOW).horizonMonths).toBeUndefined();
  });

  it('reads no amount outside what a plan takes, and nothing from words it does not know', () => {
    expect(preRead('Grow $5 for a year', NOW)).toEqual({ goal: 'grow', horizonMonths: 12 });
    expect(preRead('something for later', NOW)).toEqual({});
  });
});

const draft = (over: Partial<BasketSheetDraft> = {}): BasketSheetDraft => ({
  basketType: 'standard',
  goal: null,
  amountUsd: null,
  horizonMonths: null,
  risk: null,
  incomeTargetUsdMonthly: null,
  themes: null,
  country: null,
  chains: null,
  rules: null,
  language: 'en',
  currency: null,
  obligations: null,
  sleeves: null,
  restoreSplit: null,
  ...over,
});

describe('the reader’s draft, filled from the words', () => {
  it('fills only what the reader left empty or guessed, and says it filled something', () => {
    const read = draft({ goal: 'grow', risk: 'medium', horizonMonths: 36 });
    const words = preRead('Protect $50,000 for 18 months, low risk', NOW);
    // the reader's "grow" and "medium" are its own defaults; its 36 months a reading of the text
    const out = fillFromWords(read, new Set(['goal', 'risk']), words);
    expect(out.filled).toBe(true);
    expect(out.draft).toMatchObject({
      goal: 'protect',
      amountUsd: 50_000,
      risk: 'low',
      horizonMonths: 36,
    });
  });

  it('keeps what the reader found, and fills nothing when the words add nothing', () => {
    const read = draft({ goal: 'income', risk: 'high' });
    expect(fillFromWords(read, new Set(), { goal: 'grow', risk: 'low' })).toEqual({
      draft: read,
      filled: false,
    });
    const guessed = draft({ goal: 'grow' });
    expect(fillFromWords(guessed, new Set(['goal']), {})).toEqual({
      draft: guessed,
      filled: false,
    });
  });

  it('carries a monthly figure only into a plan for income', () => {
    const words: Words = { goal: 'grow', incomeTargetUsdMonthly: 300 };
    expect(fillFromWords(draft(), new Set(), words).draft.incomeTargetUsdMonthly).toBeNull();
    expect(
      fillFromWords(draft({ goal: 'income' }), new Set(), { incomeTargetUsdMonthly: 300 }).draft
        .incomeTargetUsdMonthly,
    ).toBe(300);
  });

  it('gives an example chip in full without the reader', () => {
    for (const lang of ['en', 'pt'] as const)
      for (const text of dictionary(lang).goal.examples.list)
        expect(exampleDraft(text, dictionary(lang).goal.examples.list, lang)).not.toBeNull();
  });
});

describe('the country of the browser', () => {
  it('is the region of its language, when it names one the list has', () => {
    expect(browserCountry(['pt-BR', 'en'])).toBe('BR');
    expect(browserCountry(['en', 'en-GB'])).toBe('GB');
    expect(browserCountry(['en', 'pt'])).toBeNull();
    expect(browserCountry(['xx-ZZ'])).toBeNull();
  });
});
