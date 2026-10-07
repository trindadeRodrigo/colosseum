import type {
  BasketAsset,
  ExitCapacity,
  LiquidityProvider,
  YieldObservation,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { figuresOf, YIELD_METHOD } from './figures';

// What a shared portfolio's card and page say of its holdings: the readings a plan is made from, a
// holding at a time, null where there is none, and the whole's yield added up from them.

const NOW = '2026-10-07T12:00:00.000Z';
const asset = (id: string, cls: BasketAsset['cls']) => ({ id, cls }) as BasketAsset;
const assets = [
  asset('solana:spyx', 'etf'),
  asset('solana:jlusdc', 'dollar_yield'),
  asset('solana:syrupusdc', 'dollar_yield'),
];
const reading = (
  assetId: string,
  quoted: number,
  haircut: number,
  over = {},
): YieldObservation => ({
  assetId,
  quotedYield: quoted,
  haircutYield: haircut,
  haircutRule: 'a fifth off',
  source: `feed of ${assetId}`,
  method: 'the rate the pool paid over 30 days',
  fetchedAt: '2026-10-07T10:00:00.000Z',
  provenance: 'live',
  ...over,
});
const capacity = (usd: number, over: Partial<ExitCapacity> = {}): ExitCapacity => ({
  capacityUsd: usd,
  lowerBound: false,
  regime: 'weekend',
  samples: 40,
  dataFrom: '2026-10-01T00:00:00.000Z',
  dataTo: '2026-10-07T09:00:00.000Z',
  ...over,
});
const provider = (
  measured: Record<string, ExitCapacity | null>,
  provenance: LiquidityProvider['provenance'] = 'live',
) =>
  ({
    provenance,
    covers: (id: string) => id in measured,
    exitCapacity: (id: string, tau: number, days: number) => {
      expect([tau, days]).toEqual([0.01, 7]);
      return measured[id] ?? null;
    },
  }) as unknown as LiquidityProvider;

const components = [
  { asset: 'solana:spyx', weightBps: 5000 },
  { asset: 'solana:jlusdc', weightBps: 3000 },
  { asset: 'solana:syrupusdc', weightBps: 2000 },
];

describe('the figures of a shared portfolio’s holdings', () => {
  it('gives each holding its own reading, and null where there is none: never a zero', () => {
    const figures = figuresOf(
      components,
      assets,
      {
        yields: [reading('solana:jlusdc', 0.05, 0.04), reading('solana:syrupusdc', 0.08, 0.06)],
        liquidity: {
          provider: provider({ 'solana:spyx': capacity(250_000, { lowerBound: true }) }),
          source: 'Bearing',
        },
      },
      NOW,
    );
    expect(figures.holdings.map((h) => h.asset)).toEqual(components.map((c) => c.asset));
    expect(figures.holdings.map((h) => h.cls)).toEqual(['etf', 'dollar_yield', 'dollar_yield']);
    const [stock, lending] = figures.holdings;
    expect(stock?.yield).toBeNull();
    expect(stock?.exit).toMatchObject({
      capacityUsd: 250_000,
      lowerBound: true,
      windowDays: 7,
      maxCostBps: 100,
      source: 'Bearing',
      fetchedAt: '2026-10-07T09:00:00.000Z',
      provenance: 'live',
    });
    expect(stock?.exit?.method).toContain('within 7 days at a cost of at most 1%');
    expect(lending?.yield).toMatchObject({
      quoted: 0.05,
      afterHaircut: 0.04,
      haircutRule: 'a fifth off',
      source: 'feed of solana:jlusdc',
    });
    // covered by nobody: no exit figure, not a capacity of nothing
    expect(lending?.exit).toBeNull();
  });

  it('adds the whole’s yield from the readings times their shares, a holding without one as nothing', () => {
    const figures = figuresOf(
      components,
      assets,
      {
        yields: [
          reading('solana:jlusdc', 0.05, 0.04, { fetchedAt: '2026-10-06T00:00:00.000Z' }),
          reading('solana:syrupusdc', 0.08, 0.06, { provenance: 'sandbox' }),
        ],
      },
      NOW,
    );
    // 30% at 4% and 20% at 6% after the haircut; at 5% and 8% as quoted; the stock half adds nothing
    expect(figures.yield?.low).toBeCloseTo(0.3 * 0.04 + 0.2 * 0.06, 12);
    expect(figures.yield?.high).toBeCloseTo(0.3 * 0.05 + 0.2 * 0.08, 12);
    expect(figures.yield).toMatchObject({
      source: 'feed of solana:jlusdc + feed of solana:syrupusdc',
      method: YIELD_METHOD,
      // the oldest reading it stands on, and the label that is not live
      fetchedAt: '2026-10-06T00:00:00.000Z',
      provenance: 'sandbox',
    });
  });

  it('says no yield for the whole when no holding has a reading, and labels a fixture as not live', () => {
    const figures = figuresOf(
      [{ asset: 'solana:spyx', weightBps: 10_000 }],
      assets,
      {
        liquidity: {
          provider: provider({ 'solana:spyx': capacity(1_000, { dataTo: null }) }, 'fixture'),
          source: 'a fixture',
        },
      },
      NOW,
    );
    expect(figures.yield).toBeNull();
    expect(figures.holdings[0]?.exit).toMatchObject({ provenance: 'mock', fetchedAt: NOW });
    // nothing read at all: every figure is absent
    expect(figuresOf(components, assets, {}, NOW)).toEqual({
      holdings: components.map((c, i) => ({
        asset: c.asset,
        cls: assets[i]?.cls,
        yield: null,
        exit: null,
      })),
      yield: null,
    });
  });

  it('reads no exit for a token the chain does not list, whatever the provider covers', () => {
    const figures = figuresOf(
      [{ asset: 'solana:other', weightBps: 10_000 }],
      assets,
      { liquidity: { provider: provider({ 'solana:other': capacity(9) }), source: 'Bearing' } },
      NOW,
    );
    expect(figures.holdings[0]?.exit).toBeNull();
    expect(figures.holdings[0]?.cls).toBeNull();
  });
});
