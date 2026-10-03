import type { Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  distanceBps,
  fixtureContext,
  fixtureLiquidity,
  launchShelf,
  sheet,
  violations,
} from './testing';
import type { ComposeContext, PersonalProposal, PersonalSheet } from './types';

// When a cap cuts the stocks of a shared portfolio, the cut falls on all of them in proportion to
// their weights, so the portfolio keeps its shape (decided on Oct 3, from the second review). Which
// stocks are held never depends on the order a shelf lists a portfolio's parts in, and a small
// holding does not swap one name for another.

const shelf = launchShelf();
const ctx = fixtureContext();

/** The same shelf with every portfolio's parts, and its recipes, listed the other way round. */
const reversed: Shelf = {
  ...shelf,
  families: shelf.families.map((f) => ({
    ...f,
    recipes: [...f.recipes]
      .reverse()
      .map((r) => ({ ...r, components: [...r.components].reverse() })),
  })),
};

function plan(over: Partial<PersonalSheet>, context: ComposeContext = ctx, onShelf = shelf) {
  const made = compose(sheet(over), onShelf, context);
  expect(violations(made, onShelf, context)).toEqual([]);
  return made;
}
const bpsOf = (made: PersonalProposal, id: string) =>
  made.lines.find((l) => l.assetId === id)?.weightBps ?? 0;
const rulesOn = (made: PersonalProposal, id: string) =>
  made.lines.find((l) => l.assetId === id)?.reasons.map((r) => r.rule) ?? [];
const SEVEN = ['aaplx', 'amznx', 'googlx', 'metax', 'msftx', 'nvdax', 'tslax'].map(
  (s) => `solana:${s}`,
);

describe('the order a shelf lists a portfolio in decides nothing', () => {
  it.each([
    ['The Seven at low risk, $9,999', { themes: ['the-seven'], risk: 'low', amountUsd: 9_999 }],
    ['The Seven at medium risk', { themes: ['the-seven'] }],
    [
      'The Seven with two names and gold ruled out',
      {
        themes: ['the-seven'],
        limits: {
          cannotHold: { underlyings: ['TSLA', 'AAPL'], classes: ['gold', 'commodity'] },
        },
      },
    ],
    ['two portfolios at high risk', { themes: ['the-seven', 'crypto-in-a-suit'], risk: 'high' }],
    ['Home Team, $137.50', { themes: ['home-team'], amountUsd: 137.5 }],
  ] as [string, Partial<PersonalSheet>][])('%s', (_name, over) => {
    const [as, other] = [plan(over), plan(over, ctx, reversed)];
    expect(distanceBps(as, other)).toBe(0);
    expect(other.lines).toEqual(as.lines);
    expect(other.removed).toEqual(as.removed);
    expect(other.recipes).toEqual(as.recipes);
  });

  it('on Robinhood Chain and on Base too', () => {
    for (const over of [
      { chains: ['robinhood' as const], themes: ['sand-to-server'], risk: 'low' as const },
      { chains: ['robinhood' as const], themes: ['the-seven', 'storm-cellar'], amountUsd: 9_999 },
      { chains: ['base' as const], themes: ['chips-and-agents'], amountUsd: 10_001 },
    ])
      expect(plan(over, ctx, reversed).lines).toEqual(plan(over).lines);
  });
});

describe('a cap cuts the stocks of a portfolio in proportion, so it keeps its shape', () => {
  // The Seven is NVDA at 14.32% and six others at 14.28%. On Solana every stock token and the gold
  // token share one issuer, which may hold 70% of a plan at medium risk.
  const made = plan({ themes: ['the-seven'] });
  const held = SEVEN.filter((id) => bpsOf(made, id) > 0);

  it('the issuer is at its limit, and no more: 65% in stocks beside 5% in gold', () => {
    expect(held.reduce((n, id) => n + bpsOf(made, id), 0)).toBe(6500);
    expect(bpsOf(made, 'solana:gldx')).toBe(500);
  });

  it('every stock held is cut by the same share, to the basis point', () => {
    // Eight parts at most: dollar yield, gold and six stocks. The six share 65% as 1432 to 1428.
    expect(held).toHaveLength(6);
    const weight = (id: string) => (id === 'solana:nvdax' ? 1432 : 1428);
    const total = held.reduce((n, id) => n + weight(id), 0);
    for (const id of held)
      expect(Math.abs(bpsOf(made, id) - (6500 * weight(id)) / total), id).toBeLessThan(1);
    // No stock is held whole beside one that is cut to a part.
    const sizes = held.map((id) => bpsOf(made, id));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(4);
  });

  it('each line that was cut says so, and the dollar yield says what it took in and why', () => {
    for (const id of held) expect(rulesOn(made, id), id).toContain('ISSUER_CAP');
    const said = made.lines.find((l) => l.assetId === 'solana:syrupusdc')?.reasons ?? [];
    const cut = said.find((r) => r.rule === 'OVERFLOW_ISSUER');
    expect(cut?.text).toBe(
      '$358 meant for AAPL, AMZN, GOOGL, META, MSFT and NVDA is held in dollar yield or cash instead: no more than 70% of the plan is with one issuer at medium risk, and Backed (xStocks) is at that limit.',
    );
    expect(cut?.params.usd).toBe(357.6);
    expect(said.find((r) => r.rule === 'OVERFLOW_MAX_LINES')?.text).toBe(
      '$1,142 meant for TSLA is held in dollar yield or cash instead: a plan holds at most 8 parts.',
    );
  });

  it('the name with no line left is the last by weight, then by id: TSLA', () => {
    expect(bpsOf(made, 'solana:tslax')).toBe(0);
    expect(made.removed.map((r) => [r.ref, r.reasons.map((x) => x.text)])).toEqual([
      ['TSLA', ['TSLAx is left out: a plan holds at most 8 parts.']],
    ]);
  });

  it('a small holding does not swap one name for another', () => {
    // $100 of NVDA held: the plan buys less NVDA. The same six names are held, and TSLA is still
    // the one with no line left.
    const withHeld = plan(
      { themes: ['the-seven'] },
      fixtureContext({ holdings: [{ underlying: 'NVDA', valueUsd: 100 }] }),
    );
    expect(SEVEN.filter((id) => bpsOf(withHeld, id) > 0)).toEqual(held);
    expect(bpsOf(withHeld, 'solana:nvdax')).toBeLessThan(bpsOf(made, 'solana:nvdax'));
    expect(rulesOn(withHeld, 'solana:nvdax')).toContain('ALREADY_HELD');
    expect(withHeld.removed.map((r) => r.ref)).toEqual(['TSLA']);
    expect(distanceBps(made, withHeld)).toBeLessThan(200);
  });

  it('where the parts differ in weight, the smallest is the one with no line left', () => {
    // Sand to Server on Robinhood Chain at medium risk: seven stocks, dollar yield and gold make
    // nine parts. DELL is 5% of the portfolio and TSM 20%: DELL is left out, whatever its name.
    const sand = plan({ chains: ['robinhood'], themes: ['sand-to-server'] });
    expect(sand.removed.map((r) => r.ref)).toEqual(['DELL']);
    expect(sand.lines.some((l) => l.assetId === 'robinhood:tsm')).toBe(true);
  });

  it('at low risk and $9,999, the case the review found: seven stocks cut alike, none dropped for the order', () => {
    const low = plan({ themes: ['the-seven'], risk: 'low', amountUsd: 9_999 });
    const stocks = SEVEN.filter((id) => bpsOf(low, id) > 0);
    // Half the plan with one issuer at most: 10% in gold, so 40% in stocks.
    expect(stocks.reduce((n, id) => n + bpsOf(low, id), 0)).toBe(4000);
    const sizes = stocks.map((id) => bpsOf(low, id));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(4);
  });
});

describe('where the least a line can be is more than an equal share', () => {
  it('the last names in the order are left out, one at a time, until the rest have a line each', () => {
    // 20% with one issuer at most, 10% of it in gold: 10% for seven stocks, and a line is 4% at
    // least. Five are left out, the last in the order first, and the first two share the room.
    const tight = fixtureContext({
      params: {
        ...PERSONAL_PARAMS,
        capPerIssuerBps: { ...PERSONAL_PARAMS.capPerIssuerBps, low: 2000 },
        minLineBps: 400,
      },
    });
    const made = plan({ themes: ['the-seven'], risk: 'low' }, tight);
    expect(SEVEN.filter((id) => bpsOf(made, id) > 0)).toEqual(['solana:aaplx', 'solana:nvdax']);
    expect(bpsOf(made, 'solana:aaplx') + bpsOf(made, 'solana:nvdax')).toBe(1000);
    expect(made.removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)])).toEqual(
      ['AMZN', 'GOOGL', 'META', 'MSFT', 'TSLA'].map((name) => [name, ['ISSUER_CAP']]),
    );
  });
});

describe('one stock in two portfolios', () => {
  it('a token takes its ceiling in all, counting what a portfolio held whole has of it', () => {
    // NVDA on Robinhood Chain measured at $8,000: a line of it holds $2,000 at most. The Seven is
    // held whole with $680 of it, so Sand to Server, opened, adds $1,320 and no more.
    const context = fixtureContext({
      params: { ...PERSONAL_PARAMS, maxLinesPerChain: 16 },
      liquidity: fixtureLiquidity({ 'robinhood:nvda': 8_000 }),
    });
    const made = plan(
      { chains: ['robinhood'], themes: ['the-seven', 'sand-to-server'], risk: 'high' },
      context,
    );
    const nvda = made.lines.find((l) => l.assetId === 'robinhood:nvda');
    expect(nvda?.amountUsd).toBe(2000);
    expect(nvda?.reasons.map((r) => r.text)).toContain(
      'NVDA is limited to $2,000: beyond that, selling it would cost too much.',
    );
    expect(made.recipes[0]?.components.find((c) => c.kind === 'index')).toMatchObject({
      family: 'the-seven',
    });
    expect(
      made.lines
        .find((l) => l.assetId === 'robinhood:sgov')
        ?.reasons.find((r) => r.rule === 'OVERFLOW_CEILING')?.text,
    ).toBe(
      '$105 meant for NVDA is held in dollar yield or cash instead: NVDA takes at most $2,000.',
    );
  });

  it('what a portfolio held whole has of it counts toward the cap on one stock', () => {
    // NVDA is in The Seven and in Sand to Server. With 15% at most in one stock, The Seven fits
    // whole (6.8% NVDA) and Sand to Server is opened: its NVDA takes what is left under the cap.
    const table = {
      ...PERSONAL_PARAMS,
      capPerStockBps: { ...PERSONAL_PARAMS.capPerStockBps, high: 1500 },
      maxLinesPerChain: 16,
    };
    const context = fixtureContext({ params: table });
    const made = plan(
      { chains: ['robinhood'], themes: ['the-seven', 'sand-to-server'], risk: 'high' },
      context,
    );
    const nvda = made.lines.find((l) => l.assetId === 'robinhood:nvda');
    expect(nvda?.weightBps).toBe(1500);
    expect(nvda?.reasons.map((r) => r.rule)).toEqual(
      expect.arrayContaining(['FOLLOWS', 'OPENED', 'SINGLE_STOCK_CAP']),
    );
    // 680 of it through The Seven, which stays one component, and 820 on its own.
    const components = made.recipes[0]?.components ?? [];
    expect(components.find((c) => c.kind === 'index')).toMatchObject({ family: 'the-seven' });
    expect(components).toContainEqual({ kind: 'asset', asset: 'robinhood:nvda', weightBps: 820 });
    // The line is held partly through the portfolio and partly on its own, so it is not marked as
    // through it; the lines that are wholly The Seven's are.
    expect(nvda?.viaIndex).toBeUndefined();
    expect(made.lines.filter((l) => l.viaIndex === 'the-seven').map((l) => l.assetId)).toEqual(
      ['aapl', 'amzn', 'googl', 'meta', 'msft', 'tsla'].map((s) => `robinhood:${s}`),
    );
  });
});
