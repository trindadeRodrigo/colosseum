import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { personWeights, type StatedShare, scaleToWholeBps, splitBps } from './weights';

const sum = (weights: readonly number[]) => weights.reduce((n, w) => n + w, 0);

describe('the weights of a person’s picks: equal unless they stated shares', () => {
  it.each([
    [1, [10000]],
    [3, [3334, 3333, 3333]],
    [7, [1429, 1429, 1429, 1429, 1428, 1428, 1428]],
    [16, Array(16).fill(625)],
  ])('splits %i picks equally, the remainder to the first, summing to 10,000', (n, expected) => {
    const { weights, unmet, scaled } = personWeights(n, []);
    expect(weights).toEqual(expected);
    expect(sum(weights)).toBe(10000);
    expect(unmet).toEqual([]);
    expect(scaled).toBe(false);
  });

  it('gives every count from 1 to 64 a whole split', () => {
    for (let n = 1; n <= 64; n += 1) {
      const weights = splitBps(n);
      expect(sum(weights)).toBe(10000);
      expect(Math.max(...weights) - Math.min(...weights)).toBeLessThanOrEqual(1);
    }
  });

  it('follows "70% Tesla, the rest Nvidia": 7000 and 3000', () => {
    expect(personWeights(2, [{ members: [0], min: 7000, max: 7000 }])).toEqual({
      weights: [7000, 3000],
      unmet: [],
      scaled: false,
    });
    // The rest shared equally when more than one pick takes it.
    expect(personWeights(3, [{ members: [0], min: 7000, max: 7000 }]).weights).toEqual([
      7000, 1500, 1500,
    ]);
  });

  it('honours a stated minimum and maximum, moving only what it must', () => {
    // "At least 40% stocks" over two of three picks already equal: met, nothing moves.
    expect(personWeights(3, [{ members: [0, 1], min: 4000, max: 10000 }]).weights).toEqual([
      3334, 3333, 3333,
    ]);
    // Over one of three: raised to 40%, the rest equal.
    expect(personWeights(3, [{ members: [0], min: 4000, max: 10000 }]).weights).toEqual([
      4000, 3000, 3000,
    ]);
    // "At most 5%": lowered, the rest equal.
    expect(personWeights(3, [{ members: [0], min: 0, max: 500 }]).weights).toEqual([
      500, 4750, 4750,
    ]);
  });

  it('scales shares the person gave for every pick to the whole, and says so', () => {
    expect(
      personWeights(2, [
        { members: [0], min: 6000, max: 6000 },
        { members: [1], min: 6000, max: 6000 },
      ]),
    ).toEqual({ weights: [5000, 5000], unmet: [], scaled: true });
    expect(
      personWeights(3, [
        { members: [0], min: 5000, max: 5000 },
        { members: [1, 2], min: 5000, max: 5000 },
      ]),
    ).toEqual({ weights: [5000, 2500, 2500], unmet: [], scaled: false });
    expect(scaleToWholeBps([2, 1])).toEqual([6667, 3333]);
    expect(scaleToWholeBps([0.7, 0.3])).toEqual([7000, 3000]);
    expect(scaleToWholeBps([0, 0, 0])).toEqual([3334, 3333, 3333]);
  });

  it('reports a share the picks cannot meet instead of bending it', () => {
    // A minimum over picks that are not there.
    expect(personWeights(2, [{ members: [], min: 4000, max: 10000 }])).toMatchObject({
      unmet: [0],
      weights: [5000, 5000],
    });
    // "70% Tesla" with Tesla the only pick: nothing else to hold the rest.
    expect(personWeights(1, [{ members: [0], min: 7000, max: 7000 }])).toMatchObject({
      unmet: [0],
      weights: [10000],
    });
    // A maximum over every pick.
    expect(personWeights(2, [{ members: [0, 1], min: 0, max: 1000 }]).unmet).toEqual([0]);
  });

  it('refuses a share that is not whole basis points over picks that exist', () => {
    for (const bad of [
      { members: [2], min: 0, max: 100 },
      { members: [0], min: 5000, max: 4000 },
      { members: [0], min: 0, max: 10001 },
      { members: [0], min: 0.5, max: 100 },
    ])
      expect(() => personWeights(2, [bad])).toThrow(RangeError);
  });

  it('does not depend on the order the shares were stated: "at least 20% AAPL and 60% NVDA"', () => {
    const atLeast = { members: [0], min: 2000, max: 10000 };
    const sixty = { members: [1], min: 6000, max: 6000 };
    for (const order of [
      [atLeast, sixty],
      [sixty, atLeast],
    ])
      expect(personWeights(4, order)).toEqual({
        weights: [2000, 6000, 1000, 1000],
        unmet: [],
        scaled: false,
      });
  });
});

describe('the weights do not depend on the order of the shares (property)', () => {
  const share = (count: number) =>
    fc
      .record({
        members: fc.uniqueArray(fc.integer({ min: 0, max: count - 1 }), {
          minLength: 0,
          maxLength: count,
        }),
        kind: fc.constantFrom('exact', 'min', 'max', 'both'),
        a: fc.integer({ min: 0, max: 10000 }),
        b: fc.integer({ min: 0, max: 10000 }),
      })
      .map(({ members, kind, a, b }): StatedShare => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        if (kind === 'exact') return { members, min: a, max: a };
        if (kind === 'min') return { members, min: a, max: 10000 };
        if (kind === 'max') return { members, min: 0, max: a };
        return { members, min: low, max: high };
      });
  const input = fc
    .integer({ min: 1, max: 17 })
    .chain((count) =>
      fc.tuple(
        fc.constant(count),
        fc.array(share(count), { maxLength: 4 }),
        fc.infiniteStream(fc.nat()),
      ),
    );

  it('gives the same weights and the same unmet shares in any order, always summing to 10,000', () => {
    fc.assert(
      fc.property(input, ([count, stated, stream]) => {
        const base = personWeights(count, stated);
        expect(sum(base.weights)).toBe(10000);
        expect(base.weights.every((w) => Number.isInteger(w) && w >= 0)).toBe(true);
        // A shuffle (from the stream) and the reverse.
        const random = stated.map((_, i) => i);
        for (let i = random.length - 1; i > 0; i -= 1) {
          const j = (stream.next().value as number) % (i + 1);
          [random[i], random[j]] = [random[j] as number, random[i] as number];
        }
        for (const order of [stated.map((_, i) => stated.length - 1 - i), random]) {
          const moved = personWeights(
            count,
            order.map((i) => stated[i] as StatedShare),
          );
          expect(moved.weights).toEqual(base.weights);
          expect(moved.scaled).toBe(base.scaled);
          expect(moved.unmet.map((i) => order[i]).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
            base.unmet,
          );
        }
      }),
      { numRuns: 3000 },
    );
  });
});
