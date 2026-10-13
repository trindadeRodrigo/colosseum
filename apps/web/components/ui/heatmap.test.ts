import { describe, expect, it } from 'vitest';
import { heatLevels, heatName, heatWhen } from './heatmap';

// The arithmetic of bearing-heatmap-tile.md: five lightness steps, bins at the quintiles of the hours
// shown, more depth always the fifth step; and the words a cell is named by.

describe('the heatmap ramp', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('bins at the quintiles as Rodrigo’s view does, the deepest on step 5, for a depth in dollars', () => {
    const level = heatLevels(values, 'high');
    // cuts at the 20th, 40th, 60th and 80th values (3, 5, 7, 9); a value on a cut stays below it
    expect(values.map(level)).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
  });

  it('turns over for a cost, where less is deeper', () => {
    const level = heatLevels(values, 'low');
    expect(values.map(level)).toEqual([5, 5, 5, 4, 4, 3, 3, 2, 2, 1]);
  });

  it('puts every value of a flat week on one step', () => {
    const level = heatLevels([3, 3, 3], 'high');
    expect([3, 3, 3].map(level)).toEqual([1, 1, 1]);
  });
});

describe('the name of a cell', () => {
  const fmt = (v: number) => `$${v}`;
  it('says the hour, the figure, what it is and the sample size', () => {
    expect(
      heatName(6, 3, 'UTC', { day: 6, hour: 3, value: 1200, samples: 18 }, fmt, 'at ≤ 2%'),
    ).toBe('Sun 03:00 UTC · $1200 at ≤ 2% · n=18');
  });
  it('says "no sample" for an hour with none', () => {
    expect(heatName(0, 4, 'ET', undefined, fmt, 'at ≤ 2%')).toBe('Mon 04:00 ET · no sample');
    expect(heatWhen(24 * 2 + 15, 'ET')).toBe('Wed 15:00 ET');
  });
});
