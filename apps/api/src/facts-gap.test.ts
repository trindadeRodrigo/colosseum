import { describe, expect, it } from 'vitest';
import { midAgainst } from './facts';

// The pool mid against a lending oracle (the tracking fact of GET /risk/assets/{asset}/facts), from
// the oracle's stored gap to the mid. An oracle that answered zero is stored with a gap of −1, and
// the fact was 1 ÷ 0: Infinity, which the answer's schema refuses for the whole asset.

describe('the pool mid against an oracle', () => {
  it('is the inverse of the stored gap: an oracle 2% under the mid has the mid 2.04% over it', () => {
    expect(midAgainst(0)).toBe(0);
    expect(midAgainst(-0.02)).toBeCloseTo(1 / 0.98 - 1, 12);
    expect(midAgainst(0.25)).toBeCloseTo(-0.2, 12);
  });

  it('is none for an oracle that answered zero or less, and for no gap: never Infinity', () => {
    for (const gap of [-1, -1.5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY])
      expect(midAgainst(gap), String(gap)).toBeNull();
    // the smallest answer above zero is still a number
    expect(Number.isFinite(midAgainst(-1 + 1e-12) as number)).toBe(true);
    expect(midAgainst(-1 + 1e-320)).toBeNull();
  });
});
