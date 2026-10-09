import { Price } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { pinSourceOfPrice } from './price-source';
import { pinLabel, pinState, staleWords } from './provenance';

// Where the pin's `staleAgeSec` comes from for a price: the price's own age against the chain's
// limit, both stated by the API (DESIGN-VAULT 3.1, `isStalePrice`).

const price = (over: Partial<Price> = {}): Price =>
  Price.parse({
    source: 'sample feed',
    method: 'reference price',
    fetchedAt: '2026-10-01T14:02:11Z',
    provenance: 'live',
    asset: 'solana:spyx',
    usdPerToken: '100.00',
    ageSeconds: 30,
    maxAgeSeconds: 120,
    market: 'open',
    ...over,
  });

describe('what the pin is handed for a price', () => {
  it('is live while the price is no older than the chain accepts', () => {
    expect(pinSourceOfPrice(price())).toEqual({
      source: 'sample feed',
      method: 'reference price',
      fetchedAt: '2026-10-01T14:02:11Z',
      provenance: 'live',
      staleAgeSec: null,
      // the chain's own limit, which the popover names beside a stale reading
      staleLimitSec: 120,
    });
    expect(pinState(pinSourceOfPrice(price()))).toBe('live');
    // at the limit is not past it
    expect(pinState(pinSourceOfPrice(price({ ageSeconds: 120 })))).toBe('live');
  });

  it('is stale, with the price’s own age, once the price is older than that', () => {
    const stale = pinSourceOfPrice(price({ ageSeconds: 3 * 3600 }));
    expect(stale.staleAgeSec).toBe(3 * 3600);
    expect(pinState(stale)).toBe('stale');
    expect(staleWords(stale)).toBe('stale · 3 h');
    expect(pinLabel('$100.00', stale)).toBe('Source for $100.00, stale, 3 hours old');
    // a chain that accepts no age at all: any age is stale
    expect(pinState(pinSourceOfPrice(price({ ageSeconds: 1, maxAgeSeconds: 0 })))).toBe('stale');
  });

  it('does not read the time it was fetched: an old fetch of a fresh price is live', () => {
    expect(pinState(pinSourceOfPrice(price({ fetchedAt: '2001-01-01T00:00:00Z' })))).toBe('live');
  });

  it('is never live for a test network or a mock, fresh or stale', () => {
    for (const provenance of ['sandbox', 'mock', 'fixture', 'prior_dataset'] as const)
      for (const ageSeconds of [1, 9000])
        expect(pinState(pinSourceOfPrice(price({ provenance, ageSeconds })))).toBe('mock');
  });
});
