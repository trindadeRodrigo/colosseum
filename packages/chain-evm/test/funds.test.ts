import { describe, expect, it } from 'vitest';
import { firstShort, referenceCostBps } from '../src/vault/funds';

// What a step's trades may sell: what the vault holds, and what the trades before it in the same
// transaction bring in. The vault runs a step's swaps in order, so the cash of a sale is there for
// the purchase after it.

const TSLA = 'robinhood:ttsla';
const GOOGL = 'robinhood:tgoogl';
const CASH = 'robinhood:tusdg';

describe('what the trades of one step may sell', () => {
  it('lets a purchase spend the cash of the sale before it, in a vault that holds no cash', () => {
    const trades = [
      { sell: TSLA, buy: CASH, amountInRaw: '139142021182549089' },
      { sell: CASH, buy: GOOGL, amountInRaw: '97951023' },
    ];
    const held = new Map([
      [TSLA, 139142021182549089n],
      [CASH, 0n],
    ]);
    expect(firstShort(trades, held, [99_900_029n, 277_623_000_000_000_000n])).toBeNull();
  });

  it('refuses a purchase written before the sale that pays for it', () => {
    const trades = [
      { sell: CASH, buy: GOOGL, amountInRaw: '97951023' },
      { sell: TSLA, buy: CASH, amountInRaw: '139142021182549089' },
    ];
    const held = new Map([[TSLA, 139142021182549089n]]);
    expect(firstShort(trades, held, [1n, 99_900_029n])).toEqual({
      index: 0,
      asset: CASH,
      held: 0n,
    });
  });

  it('refuses a sale of more than the vault holds, and a purchase the sale does not cover', () => {
    expect(
      firstShort([{ sell: TSLA, buy: CASH, amountInRaw: '11' }], new Map([[TSLA, 10n]]), [5n]),
    ).toEqual({ index: 0, asset: TSLA, held: 10n });
    const trades = [
      { sell: TSLA, buy: CASH, amountInRaw: '10' },
      { sell: CASH, buy: GOOGL, amountInRaw: '8' },
    ];
    expect(firstShort(trades, new Map([[TSLA, 10n]]), [7n, 1n])).toEqual({
      index: 1,
      asset: CASH,
      held: 7n,
    });
    // with a little cash already there, the same purchase is covered
    expect(
      firstShort(
        trades,
        new Map([
          [TSLA, 10n],
          [CASH, 1n],
        ]),
        [7n, 1n],
      ),
    ).toBeNull();
  });

  it('counts two sales of one token against the one balance', () => {
    const trades = [
      { sell: TSLA, buy: CASH, amountInRaw: '6' },
      { sell: TSLA, buy: GOOGL, amountInRaw: '6' },
    ];
    expect(firstShort(trades, new Map([[TSLA, 10n]]), [1n, 1n])).toEqual({
      index: 1,
      asset: TSLA,
      held: 4n,
    });
  });
});

describe("a quote's cost against the reference prices", () => {
  it('is whole basis points where both sides have a value', () => {
    expect(referenceCostBps(100, 99)).toBe(100);
    expect(referenceCostBps(99.9, 100.2)).toBe(-30);
  });

  it('is none where it cannot be worked out: no value in, or a value that is not a number', () => {
    for (const [inUsd, outUsd] of [
      [0, 5],
      [-1, 5],
      [null, 5],
      [5, null],
      [Number.NaN, 5],
      [5, Number.NaN],
      [5, Number.POSITIVE_INFINITY],
      [Number.POSITIVE_INFINITY, 5],
      // a value in so small the ratio overflows
      [5e-324, 1e300],
    ] as const)
      expect(referenceCostBps(inUsd, outUsd)).toBeNull();
  });
});
