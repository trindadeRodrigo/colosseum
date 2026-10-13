import type { BasketAsset } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { type ChainRead, exitsOf, type Held, totalOf } from './exposure';

// A figure goes out with where it came from (CLAUDE.md: source, fetched_at, method), or not at all.

const asset = (id: string, cls: BasketAsset['cls']) =>
  ({
    id: `solana:${id}`,
    symbol: id.toUpperCase(),
    underlying: id.toUpperCase(),
    issuer: 'issuer',
    tier: 2,
    cls,
    chain: 'solana',
  }) as unknown as BasketAsset;
const held: Held[] = [
  { asset: asset('spy', 'etf'), usd: 1000n * 10n ** 18n },
  { asset: asset('usdc', 'cash'), usd: 500n * 10n ** 18n },
];

type Liquidity = Parameters<typeof exitsOf>[1];
const liquidity = (source: string, dataTo: string | undefined): Liquidity =>
  ({
    source,
    provider: {
      covers: () => true,
      exitCapacity: () => ({ capacityUsd: 50_000, samples: 30, dataTo }),
      exitCost: () => 0.0042,
      methodVersion: 'exit-v1',
      provenance: 'live',
    },
  }) as unknown as Liquidity;

describe('exitsOf', () => {
  it('states a measured cost with its source, method and time', () => {
    const [exit, ...rest] = exitsOf(held, liquidity('bearing', '2026-10-07T20:00:00.000Z'));
    expect(rest).toEqual([]);
    expect(exit).toEqual({
      asset: 'solana:spy',
      usd: '1000',
      measured: true,
      costBps: 42,
      source: 'bearing',
      method: 'exit-v1',
      fetchedAt: '2026-10-07T20:00:00.000Z',
      provenance: 'live',
    });
  });

  it('states no cost where the measurement names no source', () => {
    const [exit] = exitsOf(held, liquidity('  ', '2026-10-07T20:00:00.000Z'));
    expect(exit?.costBps).toBeNull();
    expect(exit?.source).toBeUndefined();
  });

  it('states no cost where the measurement names no time', () => {
    const [exit] = exitsOf(held, liquidity('bearing', undefined));
    expect(exit?.costBps).toBeNull();
    expect(exit?.fetchedAt).toBeUndefined();
  });

  it('names the tier as a fallback and no cost where nothing is measured', () => {
    expect(exitsOf(held, undefined as unknown as Liquidity)).toEqual([
      { asset: 'solana:spy', usd: '1000', measured: false, costBps: null, fallbackTier: 2 },
    ]);
  });
});

describe('totalOf', () => {
  it('carries the sources, the method and the oldest time of the chains it adds', () => {
    const chain = (source: string, observedAt: string, rows: Held[]): ChainRead =>
      ({
        answer: { source, observedAt, provenance: 'sandbox', method: 'sums' },
        held: rows,
      }) as unknown as ChainRead;
    const total = totalOf([
      chain('snapshots b', '2026-10-08T00:00:00.000Z', held),
      chain('snapshots a', '2026-10-07T00:00:00.000Z', held.slice(0, 1)),
      chain('nothing here', '2026-10-01T00:00:00.000Z', []),
    ]);
    expect(total).toMatchObject({
      valueUsd: '2500',
      provenance: 'sandbox',
      source: 'snapshots a; snapshots b',
      observedAt: '2026-10-07T00:00:00.000Z',
    });
    expect(total?.method).toMatch(/added together/);
  });
});
