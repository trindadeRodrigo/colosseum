import { describe, expect, it } from 'vitest';
import { type Aged, verdict } from '../scripts/testnet/health';

// The test networks' health line (scripts/testnet/health.ts): what it says and when it calls a price old.

const price = (symbol: string, ageS: number, limitS = 120): Aged => ({
  symbol,
  what: 'price',
  ageS,
  limitS,
});

describe('the health line', () => {
  it('names the oldest price and the oldest average against their limits', () => {
    const { lines, old } = verdict(
      'solana',
      [
        price('tSPYx', 40),
        price('tQQQx', 62),
        { symbol: 'tSPYx', what: 'average', ageS: 1_500, limitS: 3_600 },
      ],
      0.75,
    );
    expect(old).toBe(false);
    expect(lines).toEqual([
      'solana: oldest price tQQQx, 62 s of 120 s (52%)  ok',
      'solana: oldest average tSPYx, 25 min of 60 min (42%)  ok',
    ]);
  });

  it('calls a value old at 75% of its limit, and names every one that is', () => {
    expect(verdict('solana', [price('a', 89)], 0.75).old).toBe(false);
    const { lines, old } = verdict(
      'robinhood',
      [price('tSPY', 70_200, 93_600), price('tGLD', 90_000, 93_600), price('tQQQ', 100, 93_600)],
      0.75,
    );
    expect(old).toBe(true);
    expect(lines).toEqual([
      'robinhood: oldest price tGLD, 25.0 h of 26.0 h (96%)  OLD: tSPY, tGLD',
    ]);
  });

  it('judges each value by its own limit', () => {
    // 100 s is old for a 120 s limit and young for an hour's.
    const { old, lines } = verdict('solana', [price('a', 100), price('b', 100, 3_600)], 0.75);
    expect(old).toBe(true);
    expect(lines[0]).toContain('OLD: a');
  });
});
