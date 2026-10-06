import {
  BasketSheet,
  BasketSheetDraft,
  currencyOf,
  Obligation,
  PlanSleeves,
  sleevesOf,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// ENG-3 slice 2 (docs/vault/PROMPT-BUILD-SOLVER.md): the goal's currency, dated withdrawals, sleeves
// and the restore choice on the sheet (gates SLEEVES, Oct 5; change C19 of the research note).

const sheet: BasketSheet = {
  basketType: 'standard',
  goal: 'income',
  amountUsd: 10_000,
  horizonMonths: 24,
  risk: 'medium',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: true, glide: true },
  language: 'en',
};

describe('the sheet without the new fields', () => {
  it('is a goal in dollars, one goal sleeve at the whole plan, nothing restored', () => {
    expect(BasketSheet.parse(sheet)).toEqual(sheet);
    expect(currencyOf(sheet)).toBe('USD');
    expect(sleevesOf(sheet)).toEqual([{ kind: 'goal', shareBps: 10_000 }]);
    expect(sheet.restoreSplit).toBeUndefined();
  });

  it('a draft written before them still parses, and says nothing of them', () => {
    const empty = Object.fromEntries(
      [
        'basketType',
        'goal',
        'amountUsd',
        'horizonMonths',
        'risk',
        'themes',
        'country',
        'chains',
        'incomeTargetUsdMonthly',
        'rules',
        'language',
      ].map((k) => [k, null]),
    );
    expect(BasketSheetDraft.parse(empty)).toMatchObject({
      currency: null,
      obligations: null,
      sleeves: null,
      restoreSplit: null,
    });
  });
});

describe('sleeve shares are validated', () => {
  const ok = [
    { kind: 'theme' as const, shareBps: 5000, theme: 'ai' },
    { kind: 'safe_yield' as const, shareBps: 5000 },
  ];

  it('accepts a split that adds up to the whole plan: "$2k, half in AI, half safe"', () => {
    expect(BasketSheet.safeParse({ ...sheet, sleeves: ok, restoreSplit: true }).success).toBe(true);
  });

  it.each([
    ['under the whole', [{ kind: 'goal', shareBps: 9999 }]],
    ['over the whole', [...ok, { kind: 'goal', shareBps: 1 }]],
    ['empty', []],
    [
      'a zero share',
      [
        { kind: 'goal', shareBps: 10_000 },
        { kind: 'safe_yield', shareBps: 0 },
      ],
    ],
    [
      'two goal sleeves',
      [
        { kind: 'goal', shareBps: 5000 },
        { kind: 'goal', shareBps: 5000 },
      ],
    ],
    [
      'two safe-yield sleeves',
      [
        { kind: 'safe_yield', shareBps: 5000 },
        { kind: 'safe_yield', shareBps: 5000 },
      ],
    ],
    [
      'one theme twice',
      [
        { kind: 'theme', shareBps: 5000, theme: 'ai' },
        { kind: 'theme', shareBps: 5000, theme: 'ai' },
      ],
    ],
    ['a theme with no list', [{ kind: 'theme', shareBps: 10_000, theme: '' }]],
    ['an unknown kind', [{ kind: 'lottery', shareBps: 10_000 }]],
    [
      'a fractional share',
      [
        { kind: 'goal', shareBps: 9999.5 },
        { kind: 'safe_yield', shareBps: 0.5 },
      ],
    ],
  ])('refuses %s', (_name, sleeves) => {
    expect(PlanSleeves.safeParse(sleeves).success).toBe(false);
    expect(BasketSheet.safeParse({ ...sheet, sleeves }).success).toBe(false);
  });

  it('two different themes are two sleeves', () => {
    const two = [
      { kind: 'theme', shareBps: 5000, theme: 'ai' },
      { kind: 'theme', shareBps: 5000, theme: 'energy' },
    ];
    expect(PlanSleeves.safeParse(two).success).toBe(true);
  });
});

describe('the goal currency and dated withdrawals', () => {
  it('takes a goal in reais with withdrawals in reais', () => {
    const brl = {
      ...sheet,
      currency: 'BRL',
      obligations: [
        { month: '2027-01', amount: 3000, currency: 'BRL' },
        { month: '2027-02', amount: 3000, currency: 'BRL' },
      ],
    };
    expect(BasketSheet.safeParse(brl).success).toBe(true);
    expect(currencyOf(brl)).toBe('BRL');
  });

  it.each([
    ['a month that is not one', { month: '2027-13', amount: 1, currency: 'USD' }],
    ['a day, not a month', { month: '2027-01-05', amount: 1, currency: 'USD' }],
    ['no amount', { month: '2027-01', amount: 0, currency: 'USD' }],
    ['a currency that is not a code', { month: '2027-01', amount: 1, currency: 'reais' }],
  ])('refuses a withdrawal with %s', (_name, o) => {
    expect(Obligation.safeParse(o).success).toBe(false);
  });

  it('refuses a goal currency that is not a code', () => {
    expect(BasketSheet.safeParse({ ...sheet, currency: 'usd' }).success).toBe(false);
  });
});
