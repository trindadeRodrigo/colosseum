import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { tradeLine } from './trade-line';
import type { ChainUnits } from './units';

// What one trade of a step reads as on the card a person signs from. A step may sell what the vault
// holds as well as spend its cash (a change of targets does both, in one transaction on an EVM chain):
// each line names the asset that goes in with its own decimals, and the least that comes out, which
// are the figures the guard holds the bytes to (`sell`, `inRaw`, `buy`, `minOutRaw`).

const en = dictionary('en');
const pt = dictionary('pt');
const CASH = 'robinhood:tusdg';
const TSLA = 'robinhood:ttsla';
const GOOGL = 'robinhood:tgoogl';
const units: ChainUnits = {
  cash: CASH,
  tokens: {
    [CASH]: { symbol: 'tUSDG', decimals: 6 },
    [TSLA]: { symbol: 'TSLA', decimals: 18 },
    [GOOGL]: { symbol: 'GOOGL', decimals: 18 },
  },
};
const money = (value: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(value);
const line = (
  trade: { sell: string; buy: string; amountInRaw: string },
  expected: { outRaw: string; minOutRaw: string } | undefined,
  over: { units?: ChainUnits | null; t?: typeof en } = {},
) =>
  tradeLine({
    trade,
    expected: expected ? { inRaw: trade.amountInRaw, costBps: 0, ...expected } : undefined,
    units: over.units === undefined ? units : over.units,
    t: over.t ?? en,
    locale: 'en',
    money,
  });

// The step the product owner saw on Oct 9: all of a vault's TSLA sold, and GOOGL taken with the cash.
const sale = { sell: TSLA, buy: CASH, amountInRaw: '139142021182549089' };
const saleExpected = { outRaw: '99900029', minOutRaw: '98901029' };
const purchase = { sell: CASH, buy: GOOGL, amountInRaw: '97951023' };
const purchaseExpected = { outRaw: '277623232323232323', minOutRaw: '274847000000000000' };

describe('a trade of a step, as a person reads it', () => {
  it('writes a sale as a sale: the stock sold in its own units, and the least cash it brings', () => {
    const said = line(sale, saleExpected);
    expect(said).toBe(
      'Sell 0.139142 TSLA · receive at least 98.901029 tUSDG (at least $710.79 each) · 1% under the quote',
    );
    // never the cash token's decimals or name on what is sold
    expect(said).not.toContain('139,142,021,182');
    expect(said).not.toMatch(/tUSDG on tUSDG|Spend/);
  });

  it('keeps a purchase with cash as it was', () => {
    expect(line(purchase, purchaseExpected)).toBe(
      'Spend 97.951023 tUSDG on GOOGL · receive at least 0.274847 GOOGL (at most $356.38 each) · 1% under the quote',
    );
  });

  it('names both assets where neither side is cash, and gives no price each', () => {
    expect(
      line(
        { sell: TSLA, buy: GOOGL, amountInRaw: '139142021182549089' },
        { outRaw: '277623232323232323', minOutRaw: '274847000000000000' },
      ),
    ).toBe('Sell 0.139142 TSLA · receive at least 0.274847 GOOGL · 1% under the quote');
  });

  it('gives no price each where one cannot be worked out: nothing sold, nothing received, a dust amount', () => {
    for (const [trade, expected] of [
      [{ ...sale, amountInRaw: '0' }, saleExpected],
      [sale, { outRaw: '0', minOutRaw: '0' }],
      [{ ...sale, amountInRaw: '1' }, saleExpected],
      [purchase, { outRaw: '0', minOutRaw: '0' }],
      [purchase, { outRaw: '2', minOutRaw: '1' }],
    ] as const) {
      const said = line(trade, expected);
      expect(said).not.toMatch(/each|Infinity|NaN|∞/);
    }
  });

  it('shows no raw count of a token it has no units for, sold or received', () => {
    const odd = 'robinhood:somethingnew';
    const sold = line({ ...sale, sell: odd }, saleExpected);
    expect(sold).toContain(en.order.review.sellUnnamed('SOMETHINGNEW'));
    expect(sold).toContain(en.order.review.atLeastWhole('98.901029 tUSDG'));
    expect(sold).not.toMatch(/139142021182549089|139,142/);
    const got = line({ ...purchase, buy: odd }, purchaseExpected);
    expect(got).toBe(
      `${en.order.review.spend('97.951023 tUSDG', 'SOMETHINGNEW')} · ${en.order.review.atMostUnder('1%')}`,
    );
  });

  it('says the sale and nothing else where the step was not quoted', () => {
    expect(line(sale, undefined)).toBe('Sell 0.139142 TSLA');
  });

  it('says a sale in Portuguese', () => {
    expect(line(sale, saleExpected, { t: pt })).toContain('Vender 0.139142 TSLA');
  });
});
