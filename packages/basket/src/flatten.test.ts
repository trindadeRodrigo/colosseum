import { Recipe, Shelf, Targets } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FlattenError, flatten } from './flatten';
import { asset, family, recipe, shelf } from './testing';

const ASSETS = ['spy', 'nvda', 'tsla', 'gold', 'yield', 'amd', 'msft'].map((s) =>
  asset(`solana:${s}`),
);
const chips = family('chips', [
  recipe('solana', { 'solana:nvda': 5000, 'solana:tsla': 3000, 'solana:spy': 2000 }),
  recipe('robinhood', { 'robinhood:nvda': 6000, 'robinhood:amd': 4000 }),
]);
const SHELF = shelf(ASSETS, [chips]);
const WIDE = { minLineBps: 50, maxLines: 16 };
const code = (work: () => unknown) => {
  try {
    work();
  } catch (e) {
    return e instanceof FlattenError ? e.code : `not a FlattenError: ${e}`;
  }
  return 'did not throw';
};

describe('flatten', () => {
  it('turns a line that points at a shared portfolio into its assets, weighted through', () => {
    // 30% in "chips" (NVDA 50, TSLA 30, SPY 20), 50% SPY, 20% gold.
    const plan = recipe('solana', { 'index:chips': 3000, 'solana:spy': 5000, 'solana:gold': 2000 });
    expect(Recipe.parse(plan)).toEqual(plan);
    expect(Shelf.parse(SHELF)).toEqual(SHELF);
    const targets = flatten(plan, SHELF, WIDE);
    expect(targets).toEqual([
      // 5000 direct, and 20% of 3000 through the shared portfolio.
      { asset: 'solana:spy', weightBps: 5600 },
      { asset: 'solana:gold', weightBps: 2000 },
      { asset: 'solana:nvda', weightBps: 1500 },
      { asset: 'solana:tsla', weightBps: 900 },
    ]);
    expect(Targets.parse(targets)).toEqual(targets);
  });

  it('leaves a plan of assets as it is, largest first', () => {
    const plan = recipe('solana', { 'solana:gold': 2500, 'solana:spy': 7500 });
    expect(flatten(plan, SHELF, WIDE)).toEqual([
      { asset: 'solana:spy', weightBps: 7500 },
      { asset: 'solana:gold', weightBps: 2500 },
    ]);
  });

  it("takes the shared portfolio's recipe on the plan's own chain", () => {
    const wide = shelf([...ASSETS, asset('robinhood:nvda'), asset('robinhood:amd')], [chips]);
    const plan = recipe('robinhood', { 'index:chips': 10_000 });
    expect(flatten(plan, wide, WIDE)).toEqual([
      { asset: 'robinhood:nvda', weightBps: 6000 },
      { asset: 'robinhood:amd', weightBps: 4000 },
    ]);
    expect(code(() => flatten(recipe('base', { 'index:chips': 10_000 }), wide, WIDE))).toBe(
      'NotOnChain',
    );
  });

  it('shares out the bps that do not divide, so the total is kept exactly', () => {
    const thirds = family('thirds', [
      recipe('solana', { 'solana:nvda': 3334, 'solana:tsla': 3333, 'solana:amd': 3333 }),
    ]);
    const plan = recipe('solana', { 'index:thirds': 3333, 'solana:spy': 6667 });
    const targets = flatten(plan, shelf(ASSETS, [thirds]), WIDE);
    // 3333 × 0.3334 = 1111.2222 and 3333 × 0.3333 = 1110.8889, twice: 3333 in all.
    expect(targets).toEqual([
      { asset: 'solana:spy', weightBps: 6667 },
      { asset: 'solana:amd', weightBps: 1111 },
      { asset: 'solana:nvda', weightBps: 1111 },
      { asset: 'solana:tsla', weightBps: 1111 },
    ]);
  });

  it('drops a line under the minimum and shares what it held over the rest', () => {
    const tail = family('tail', [recipe('solana', { 'solana:nvda': 9800, 'solana:amd': 200 })]);
    // AMD comes to 2% of 20% = 40 bps, under the 50 bps minimum.
    const plan = recipe('solana', { 'index:tail': 2000, 'solana:spy': 8000 });
    const targets = flatten(plan, shelf(ASSETS, [tail]), WIDE);
    // 40 bps over 8000 and 1960: 32.13 and 7.87, so 32 and 8.
    expect(targets).toEqual([
      { asset: 'solana:spy', weightBps: 8032 },
      { asset: 'solana:nvda', weightBps: 1968 },
    ]);
    // With no minimum to speak of, it stays.
    expect(flatten(plan, shelf(ASSETS, [tail]), { minLineBps: 1, maxLines: 16 })).toContainEqual({
      asset: 'solana:amd',
      weightBps: 40,
    });
  });

  it('keeps the largest lines when there are more than the most allowed', () => {
    const plan = recipe('solana', {
      'solana:spy': 4000,
      'solana:nvda': 3000,
      'solana:gold': 2000,
      'solana:tsla': 1000,
    });
    expect(flatten(plan, SHELF, { minLineBps: 50, maxLines: 2 })).toEqual([
      // 4000 and 3000 of 7000, scaled to 10,000: 5714.29 and 4285.71.
      { asset: 'solana:spy', weightBps: 5714 },
      { asset: 'solana:nvda', weightBps: 4286 },
    ]);
  });

  it('refuses what it cannot flatten, by name', () => {
    const plan = recipe('solana', { 'index:chips': 10_000 });
    expect(code(() => flatten(recipe('solana', { 'index:nope': 10_000 }), SHELF, WIDE))).toBe(
      'UnknownFamily',
    );
    const twice = shelf(ASSETS, [family('chips', [...chips.recipes, ...chips.recipes])]);
    expect(code(() => flatten(plan, twice, WIDE))).toBe('AmbiguousRecipe');
    // One level only: a shared portfolio that points at another is not followed.
    const nested = {
      ...chips,
      recipes: [recipe('solana', { 'index:chips': 5000, 'solana:spy': 5000 })],
    };
    expect(code(() => flatten(plan, shelf(ASSETS, [nested]), WIDE))).toBe('BadFamilyRecipe');
    expect(code(() => flatten(plan, SHELF, { minLineBps: 6000, maxLines: 16 }))).toBe(
      'NothingLeft',
    );
    expect(code(() => flatten(plan, SHELF, { minLineBps: 50, maxLines: 0 }))).toBe('NothingLeft');
  });
});

// ---- properties ----

const SLUGS = ['spy', 'nvda', 'tsla', 'gold', 'yield', 'amd', 'msft', 'aapl', 'meta', 'btc'];
const IDS = SLUGS.map((s) => `solana:${s}`);

/** `count` whole weights of at least 1 that add up to `total`. */
const weights = (count: number, total: number): fc.Arbitrary<number[]> =>
  fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: count, maxLength: count }).map((w) => {
    const sum = w.reduce((n, x) => n + x, 0);
    const out = w.map((x) => Math.max(1, Math.floor((x * total) / sum)));
    const first = out[0] ?? 0;
    out[0] = first + total - out.reduce((n, x) => n + x, 0);
    return out;
  });
const components = (keys: string[], min: number): fc.Arbitrary<Record<string, number>> =>
  fc
    .shuffledSubarray(keys, { minLength: min })
    .chain((picked) =>
      weights(picked.length, 10_000).map((w) =>
        Object.fromEntries(picked.map((k, i) => [k, w[i] ?? 0])),
      ),
    )
    .filter((c) => Object.values(c).every((w) => w >= 1));

const world = fc
  .record({
    a: components(IDS, 1),
    b: components(IDS, 1),
    plan: components([...IDS, 'index:fam-a', 'index:fam-b'], 1),
    minLineBps: fc.integer({ min: 0, max: 400 }),
    maxLines: fc.integer({ min: 1, max: 16 }),
  })
  .map((w) => ({
    plan: recipe('solana', w.plan),
    shelf: shelf(
      IDS.map((id) => asset(id)),
      [family('fam-a', [recipe('solana', w.a)]), family('fam-b', [recipe('solana', w.b)])],
    ),
    p: { minLineBps: w.minLineBps, maxLines: w.maxLines },
  }));

const attempt = (plan: Recipe, s: Shelf, p: { minLineBps: number; maxLines: number }) => {
  try {
    return flatten(plan, s, p);
  } catch (e) {
    if (e instanceof FlattenError && e.code === 'NothingLeft') return null;
    throw e;
  }
};

// Generated cases take a second or two alone and several when the machine is busy.
describe('flatten, on generated plans', { timeout: 60_000 }, () => {
  it('preserves the total weight, with each asset once and no line under the minimum', () => {
    let flattened = 0;
    fc.assert(
      fc.property(world, ({ plan, shelf: s, p }) => {
        const targets = attempt(plan, s, p);
        if (targets === null) return;
        flattened += 1;
        expect(targets.reduce((n, t) => n + t.weightBps, 0)).toBe(10_000);
        expect(new Set(targets.map((t) => t.asset)).size).toBe(targets.length);
        expect(targets.length).toBeLessThanOrEqual(p.maxLines);
        for (const t of targets) {
          expect(Number.isInteger(t.weightBps)).toBe(true);
          expect(t.weightBps).toBeGreaterThanOrEqual(Math.max(1, p.minLineBps));
        }
        expect(Targets.parse(targets)).toEqual(targets);
      }),
      { numRuns: 1500 },
    );
    expect(flattened).toBeGreaterThan(1000);
  });

  it('loses nothing when no line is dropped: each asset gets what the plan gives it', () => {
    fc.assert(
      fc.property(world, ({ plan, shelf: s }) => {
        const targets = flatten(plan, s, { minLineBps: 0, maxLines: 1000 });
        // The exact share of each asset, in ten-thousandths of a bp, worked out the long way.
        const exact = new Map<string, number>();
        for (const c of plan.components) {
          if (c.kind === 'asset') {
            exact.set(c.asset, (exact.get(c.asset) ?? 0) + c.weightBps * 10_000);
            continue;
          }
          const inner = s.families.find((f) => f.meta.slug === c.family)?.recipes[0];
          for (const x of inner?.components ?? [])
            if (x.kind === 'asset')
              exact.set(x.asset, (exact.get(x.asset) ?? 0) + c.weightBps * x.weightBps);
        }
        const kept = [...exact].filter(([, fine]) => fine >= 10_000);
        const dropped = 100_000_000 - kept.reduce((n, [, fine]) => n + fine, 0);
        expect(targets.map((t) => t.asset).sort()).toEqual(kept.map(([id]) => id).sort());
        for (const t of targets) {
          const fine = exact.get(t.asset) ?? 0;
          // Never under its exact share; over it by at most a rounding bp and its part of what
          // the lines under 1 bp held.
          expect(t.weightBps * 10_000).toBeGreaterThan(fine - 10_000);
          expect(t.weightBps * 10_000).toBeLessThan(fine + 10_000 + dropped);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('does not depend on the order the lines are written in', () => {
    fc.assert(
      fc.property(world, fc.nat(), ({ plan, shelf: s, p }, seed) => {
        const rotated = plan.components.map(
          (_, i, all) => all[(i + seed) % all.length] ?? all[0],
        ) as Recipe['components'];
        expect(attempt({ ...plan, components: rotated }, s, p)).toEqual(attempt(plan, s, p));
      }),
      { numRuns: 500 },
    );
  });
});
