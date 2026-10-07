import type {
  BasketAsset,
  ExitCapacity,
  LiquidityProvider,
  YieldObservation,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { figuresOf } from './figures';

// What a shared portfolio's card and page say of its holdings: the readings a plan is made from, a
// holding at a time, null where there is none, and nothing added up across them.

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

  it('hands each reading on as it is stored, the one a plan is made from, and adds nothing up', () => {
    const stored = [
      reading('solana:jlusdc', 0.05, 0.04, { fetchedAt: '2026-10-06T00:00:00.000Z' }),
      reading('solana:syrupusdc', 0.08, 0.06, { provenance: 'sandbox' }),
    ];
    const figures = figuresOf(components, assets, { yields: stored }, NOW);
    // The engine's card multiplies these same two numbers by a plan's dollars (cardOf): a holding of a
    // shared portfolio and the same holding in a plan stand on one observation, field for field.
    for (const o of stored)
      expect(figures.holdings.find((h) => h.asset === o.assetId)?.yield).toEqual({
        quoted: o.quotedYield,
        afterHaircut: o.haircutYield,
        haircutRule: o.haircutRule,
        source: o.source,
        method: o.method,
        fetchedAt: o.fetchedAt,
        provenance: o.provenance,
      });
    // no figure of the whole: that is the engine's to work out, and it takes no recipe
    expect(Object.keys(figures)).toEqual(['holdings']);
  });

  it('labels a fixture’s exit as not live, and has no figure at all where nothing was read', () => {
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
    expect(figures.holdings[0]?.exit).toMatchObject({ provenance: 'mock', fetchedAt: NOW });
    // nothing read at all: every figure is absent
    expect(figuresOf(components, assets, {}, NOW)).toEqual({
      holdings: components.map((c, i) => ({
        asset: c.asset,
        cls: assets[i]?.cls,
        yield: null,
        exit: null,
      })),
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
