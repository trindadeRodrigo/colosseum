import { describe, expect, it } from 'vitest';
import { statedAmountUsd } from './stated-amount';

// The deposit step starts from this amount and the person confirms it on the review (gate
// DEPOSIT-DERIVE), so the reader keeps only a sum in dollars it can tell apart from everything else.

const person = (text: string) => ({ who: 'person' as const, text });
const app = (text: string) => ({ who: 'app' as const, text });
const read = (...texts: string[]) => statedAmountUsd(texts.map(person));

describe('the amount a person wrote, read from their own words', () => {
  it.each([
    [
      'I want to invest in 2k 70%  in the hieghets liquid safe income and another 30% in ai stocks',
      2000,
    ],
    ['Grow $5,000 for ten years, high risk', 5000],
    ['I am 35 and want to grow $5,000', 5000],
    ['put 2000 in tech stocks', 2000],
    ['US$ 1.500,50 em ouro', 1500.5],
    ['10k, half in gold', 10_000],
    ['I want to put about $500 into AI stocks', 500],
    ['Start with $1,000, mostly yield', 1000],
    ['Invest $2,000 to reach $100,000', 2000],
    ['quero investir 3 mil dólares em ouro', 3000],
  ])('reads %j as %d', (text, amount) => {
    expect(read(text)).toBe(amount);
  });

  it.each([
    ['70% income and 30% AI stocks'],
    ['$300 a month of income'],
    ['for five years'],
    ['R$ 3.000 em renda fixa'],
    ['3,000 in euros'],
    ['by 2031'],
    ['$2,000 or maybe $3,000'],
    // a target, a price, a loss, an income or a rate other than a month is not the money put in
    ['I want to reach $100,000 in ten years'],
    ['Grow my money to $50k'],
    ['retire with $1M'],
    ['Tesla at $250 is cheap, 30% Tesla'],
    ['I lost $2,000 last year, now 70% in yield'],
    ['withdraw $300 every year'],
    ['$200 weekly'],
    ['I want an income of $500'],
  ])('reads no amount in %j', (text) => {
    expect(read(text)).toBeNull();
  });

  it('keeps the newest sum, and lets a message with none leave it standing', () => {
    expect(read('2k, 70% income and 30% AI stocks', 'in five years', 'yes, $100 a month')).toBe(
      2000,
    );
    expect(read('2k, 70% income and 30% AI stocks', 'make it $3,000')).toBe(3000);
  });

  it('reads only the person: an amount the app wrote is not theirs', () => {
    expect(
      statedAmountUsd([
        person('70% income and 30% AI stocks'),
        app('Over five years, $2,000 placed today would earn about $271.'),
      ]),
    ).toBeNull();
  });
});
