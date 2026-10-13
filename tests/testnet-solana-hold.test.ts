import { describe, expect, it } from 'vitest';
import {
  decide,
  HOLD_AVERAGE_AFTER_S,
  HOLD_PRICE_AFTER_S,
  HOLD_SOURCE_MAX_AGE_S,
  type Stamped,
  written,
} from '../programs/tests/src/testnet/hold';

// What the Solana price copier does with one entry (TNET-5), with and without `--hold-last`. The
// round around it is tested on LiteSVM in programs/tests/testnet-prices.test.ts.

const NOW = 1_800_000_000n;
const at = (value: bigint, unixTimestamp: bigint): Stamped => ({
  value,
  exponent: 8n,
  unixTimestamp,
});

describe('the Solana price copier, one entry', () => {
  it('copies a source that is newer, holding or not', () => {
    const held = at(100n, NOW - 90n);
    const source = at(101n, NOW - 40n);
    expect(decide(source, held, NOW, null)).toBe('copy');
    expect(decide(source, held, NOW, HOLD_PRICE_AFTER_S)).toBe('copy');
  });

  it('copies a source stamped before a held entry when its value differs', () => {
    // The entry was held ten seconds ago; the source's next real price is stamped 40 s back.
    const held = at(100n, NOW - 10n);
    const source = at(101n, NOW - 40n);
    expect(decide(source, held, NOW, HOLD_PRICE_AFTER_S)).toBe('copy');
    expect(decide({ ...source, value: 100n, exponent: 9n }, held, NOW, HOLD_PRICE_AFTER_S)).toBe(
      'copy',
    );
    // Without the flag the time alone decides, as before.
    expect(decide(source, held, NOW, null)).toBe('unchanged');
  });

  it("holds the source's own value once the entry is older than the limit, and not before", () => {
    const source = at(100n, NOW - 86_400n);
    expect(decide(source, at(100n, NOW - 46n), NOW, HOLD_PRICE_AFTER_S)).toBe('hold');
    expect(decide(source, at(100n, NOW - 45n), NOW, HOLD_PRICE_AFTER_S)).toBe('unchanged');
    expect(decide(source, at(100n, NOW - 1_801n), NOW, HOLD_AVERAGE_AFTER_S)).toBe('hold');
    expect(decide(source, at(100n, NOW - 1_800n), NOW, HOLD_AVERAGE_AFTER_S)).toBe('unchanged');
  });

  it('stops holding a source that has posted nothing for four days', () => {
    const held = at(100n, NOW - 100n);
    expect(decide(at(100n, NOW - HOLD_SOURCE_MAX_AGE_S), held, NOW, HOLD_PRICE_AFTER_S)).toBe(
      'hold',
    );
    expect(decide(at(100n, NOW - HOLD_SOURCE_MAX_AGE_S - 1n), held, NOW, HOLD_PRICE_AFTER_S)).toBe(
      'unchanged',
    );
    // A long weekend, Friday 20:00 to Tuesday 13:30 UTC, is inside it.
    expect(HOLD_SOURCE_MAX_AGE_S).toBeGreaterThan(322_200n);
  });

  it("writes a copy with the source's time, unless that time is already past the hold limit", () => {
    const standing = at(100n, NOW - 10n);
    const fresh = at(101n, NOW - 40n);
    expect(written('copy', fresh, standing, NOW, HOLD_PRICE_AFTER_S)).toEqual({
      entry: fresh,
      held: false,
    });
    // A value that arrives 70 s old would be held next round anyway: it takes the cluster's time now.
    const late = at(101n, NOW - 70n);
    expect(written('copy', late, standing, NOW, HOLD_PRICE_AFTER_S)).toEqual({
      entry: at(101n, NOW),
      held: true,
    });
    // Without the flag a time is never made up, and nor for a source silent for four days.
    expect(written('copy', late, standing, NOW, null)).toEqual({ entry: late, held: false });
    const dead = at(101n, NOW - HOLD_SOURCE_MAX_AGE_S - 1n);
    expect(written('copy', dead, standing, NOW, HOLD_PRICE_AFTER_S).entry).toEqual(dead);
    expect(written('hold', fresh, standing, NOW, HOLD_PRICE_AFTER_S)).toEqual({
      entry: at(100n, NOW),
      held: true,
    });
    expect(written('unchanged', fresh, standing, NOW, HOLD_PRICE_AFTER_S).entry).toEqual(standing);
  });

  it('leaves a stale entry alone without the flag', () => {
    const source = at(100n, NOW - 86_400n);
    expect(decide(source, at(100n, NOW - 86_400n), NOW, null)).toBe('unchanged');
    expect(decide(source, at(100n, NOW - 3_600n), NOW, null)).toBe('unchanged');
  });

  it('stays inside what the program takes: 120 s for a price, an hour for the average', () => {
    // Held every second round of 30 s, a price is at most 60 s old; with one round lost, 90 s.
    expect(HOLD_PRICE_AFTER_S).toBeGreaterThan(30n);
    expect(HOLD_PRICE_AFTER_S).toBeLessThanOrEqual(60n);
    expect(HOLD_AVERAGE_AFTER_S).toBeLessThanOrEqual(1_800n);
  });
});
