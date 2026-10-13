import { referenceCostBps } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// A quote's cost against the reference prices, as both chain adapters state it (`Quote.costBps`). It
// goes out in an order's answer, whose schema takes no number that is not finite: a price that does
// not read as a number, or a value that overflows, gives no cost, never NaN or Infinity.

describe("a quote's cost against the reference prices", () => {
  it('is whole basis points where both sides have a value', () => {
    expect(referenceCostBps(100, 99)).toBe(100);
    expect(referenceCostBps(99.9, 100.2)).toBe(-30);
    expect(referenceCostBps(5, 0)).toBe(10_000);
  });

  it('is none where it cannot be worked out: no value in, or a value that is not a number', () => {
    for (const [inUsd, outUsd] of [
      [0, 5],
      [-1, 5],
      [null, 5],
      [5, null],
      [Number.NaN, 5],
      // the Solana quote's case: the bought token's price does not read as a number
      [5, Number('not a price')],
      [5, Number.POSITIVE_INFINITY],
      [Number.POSITIVE_INFINITY, 5],
      // a value in so small the ratio overflows
      [5e-324, 1e300],
    ] as const)
      expect(referenceCostBps(inUsd, outUsd)).toBeNull();
  });
});
