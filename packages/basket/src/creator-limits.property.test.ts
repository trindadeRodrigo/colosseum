import type { LimitContext, Target } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkCreatorLimits, movedBps, type RecipeHeader, turnoverBps } from './creator-limits';
import { referenceBreaks, referenceMovedBps } from './creator-limits.reference';

// Generated versions, held to the slow reference and to each bound written out in plain terms.

const LISTED: LimitContext['assets'] = [
  ...[
    ...'abcdefghijklmn'.split('').map((x) => ({ id: `solana:${x}`, maxWeightBps: 5000 })),
    { id: 'solana:wide', maxWeightBps: 10_000 },
    { id: 'solana:quarter', maxWeightBps: 2500 },
    { id: 'solana:odd', maxWeightBps: 2520 },
    { id: 'solana:tiny', maxWeightBps: 150 },
    { id: 'solana:shut', maxWeightBps: 0 },
  ].map((a) => ({ ...a, cls: 'stock' as const })),
  // The chain's cash token, with a ceiling that would let it in if it were an asset like the others.
  { id: 'solana:usdc', maxWeightBps: 5000, cls: 'cash' },
];
const PLAIN = LISTED.slice(0, 14).map((a) => a.id);
const ANY = [...LISTED.map((a) => a.id), 'solana:unlisted', 'solana:other'];

/** `count` whole steps of 50 bps, each from 4 (2%) to 100 (50%), adding up to `total` steps. */
function partition(count: number, total: number): fc.Arbitrary<number[]> {
  return fc.array(fc.nat(), { minLength: count, maxLength: count }).map((seeds) => {
    const steps = Array.from({ length: count }, () => 4);
    let left = total - 4 * count;
    let i = 0;
    while (left > 0) {
      const at = i % count;
      const room = 100 - (steps[at] ?? 0);
      const give = Math.min(left, room, 1 + ((seeds[at] ?? 0) % 24));
      steps[at] = (steps[at] ?? 0) + give;
      left -= give;
      i += 1;
    }
    return steps.map((s) => s * 50);
  });
}
const validWeights = (count: number) => partition(count, 200);

/** A version inside every shape limit, on plain assets. */
const validVersion: fc.Arbitrary<Target[]> = fc
  .integer({ min: 3, max: 12 })
  .chain((count) =>
    fc.tuple(
      fc.shuffledSubarray(PLAIN, { minLength: count, maxLength: count }),
      validWeights(count),
    ),
  )
  .map(([assets, weights]) => assets.map((asset, i) => ({ asset, weightBps: weights[i] ?? 0 })));

/**
 * A version that is in order but for one line: an asset with a ceiling of its own, at a weight from
 * 2% to 55%. The other lines are plain and make up the rest.
 */
const ceilingVersion: fc.Arbitrary<Target[]> = fc
  .tuple(
    fc.constantFrom(
      'solana:wide',
      'solana:quarter',
      'solana:odd',
      'solana:tiny',
      'solana:shut',
      'solana:usdc',
    ),
    fc.integer({ min: 4, max: 110 }),
  )
  .chain(([asset, steps]) => {
    const rest = 200 - steps;
    return fc
      .integer({ min: Math.max(2, Math.ceil(rest / 100)), max: Math.min(11, Math.floor(rest / 4)) })
      .chain((count) =>
        fc.tuple(
          fc.shuffledSubarray(PLAIN, { minLength: count, maxLength: count }),
          partition(count, rest),
        ),
      )
      .map(([assets, weights]) => [
        { asset, weightBps: steps * 50 },
        ...assets.map((a, i) => ({ asset: a, weightBps: weights[i] ?? 0 })),
      ]);
  });

/** Moves whole steps from one line to another: the small edits an author makes. */
const shift = (version: Target[], moves: [number, number, number][]): Target[] => {
  const next = version.map((t) => ({ ...t }));
  for (const [from, to, steps] of moves) {
    const a = next[from % next.length];
    const b = next[to % next.length];
    if (a && b && a !== b) {
      a.weightBps -= steps * 50;
      b.weightBps += steps * 50;
    }
  }
  return next;
};
const moves = fc.array(fc.tuple(fc.nat(11), fc.nat(11), fc.integer({ min: 0, max: 45 })), {
  maxLength: 4,
});

/** Anything at all: wrong counts, repeats, unlisted assets, weights off the step. */
const wildVersion: fc.Arbitrary<Target[]> = fc.array(
  fc.record({
    asset: fc.constantFrom(...ANY),
    weightBps: fc.oneof(
      fc.integer({ min: 0, max: 110 }).map((s) => s * 50),
      fc.integer({ min: -100, max: 10_100 }),
    ),
  }),
  { maxLength: 14 },
);

/** One line of a good version changed for something that may or may not be allowed. */
const nearVersion: fc.Arbitrary<Target[]> = fc
  .tuple(validVersion, fc.nat(11), fc.constantFrom(...ANY), fc.integer({ min: -3, max: 3 }))
  .map(([version, at, asset, steps]) =>
    version.map((t, i) =>
      i === at % version.length ? { asset, weightBps: t.weightBps + steps * 50 } : t,
    ),
  );

const scenario = fc
  .record({
    prev: fc.option(validVersion, { nil: null, freq: 4 }),
    fresh: fc.oneof(validVersion, nearVersion, ceilingVersion, wildVersion),
    edit: fc.option(moves, { nil: null }),
    publishDelay: fc.constantFrom(60, 300, 172_800),
    last: fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
    wait: fc.oneof(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -200_000, max: 400_000 })),
    hasPending: fc.boolean().map((b) => b),
    pendingBias: fc.nat(9),
    flags: fc.oneof(
      { weight: 9, arbitrary: fc.constant(0) },
      { weight: 1, arbitrary: fc.nat(255) },
    ),
    maxFeeBps: fc.oneof(
      { weight: 9, arbitrary: fc.constant(0) },
      { weight: 1, arbitrary: fc.nat(500) },
    ),
  })
  .map((s) => {
    // A later version is most often an edit of the one in effect.
    const next = s.prev && s.edit ? shift(s.prev, s.edit) : s.fresh;
    const ctx: LimitContext = {
      assets: LISTED,
      publishDelay: s.publishDelay,
      // A first version sometimes comes with a context that names a last publish or a pending
      // version. No registry can be in that state; the check must not be thrown by it.
      lastPublishAt: s.prev || s.pendingBias === 9 ? s.last : null,
      now: s.last + s.publishDelay + s.wait,
      hasPending: s.hasPending && (s.prev !== null ? s.pendingBias < 2 : s.pendingBias === 8),
    };
    const header: RecipeHeader = { flags: s.flags, maxFeeBps: s.maxFeeBps };
    return { prev: s.prev, next, ctx, header };
  });

// Generated cases take a second or two alone and several when the machine is busy.
describe('checkCreatorLimits, on generated versions', { timeout: 60_000 }, () => {
  it('accepts exactly what the slow reference accepts, and names the same first rule', () => {
    fc.assert(
      fc.property(scenario, ({ prev, next, ctx, header }) => {
        const result = checkCreatorLimits(prev, next, ctx, header);
        const broken = referenceBreaks(prev, next, ctx, header);
        expect(result.ok).toBe(broken.length === 0);
        if (!result.ok) expect(result.code).toBe(broken[0]);
      }),
      { numRuns: 4000 },
    );
  });

  it('never accepts a version that breaks a stated bound', () => {
    fc.assert(
      fc.property(scenario, ({ prev, next, ctx, header }) => {
        const result = checkCreatorLimits(prev, next, ctx, header);
        if (!result.ok) return;
        // 3 to 12 assets from the platform list, each once.
        expect(next.length).toBeGreaterThanOrEqual(3);
        expect(next.length).toBeLessThanOrEqual(12);
        expect(new Set(next.map((t) => t.asset)).size).toBe(next.length);
        let sum = 0;
        for (const t of next) {
          const listed = LISTED.find((a) => a.id === t.asset);
          expect(listed, `${t.asset} is listed`).toBeDefined();
          // Each from 2% up to its ceiling, min(5000, maxWeightBps), in 50 bps steps.
          expect(t.weightBps).toBeGreaterThanOrEqual(200);
          expect(t.weightBps).toBeLessThanOrEqual(5000);
          expect(t.weightBps).toBeLessThanOrEqual(listed?.maxWeightBps ?? -1);
          expect(t.weightBps % 50).toBe(0);
          sum += t.weightBps;
        }
        expect(sum).toBe(10_000);
        // Both header values zero.
        expect([header.flags, header.maxFeeBps]).toEqual([0, 0]);
        // Never the cash token.
        expect(next.some((t) => t.asset === 'solana:usdc')).toBe(false);
        // The first version is exempt from what follows.
        if (prev === null) {
          expect(result.turnoverBps).toBe(0);
          return;
        }
        // One version per publish delay, and none while one is pending.
        expect(ctx.hasPending).toBe(false);
        if (ctx.lastPublishAt !== null)
          expect(ctx.now).toBeGreaterThanOrEqual(ctx.lastPublishAt + ctx.publishDelay);
        // The absolute changes add up to at most 4,000: 20% of the portfolio moved.
        expect(referenceMovedBps(prev, next)).toBeLessThanOrEqual(4000);
        expect(result.turnoverBps * 2).toBe(referenceMovedBps(prev, next));
      }),
      { numRuns: 4000 },
    );
  });

  it('is not a property that holds because nothing is ever accepted, or ever refused', () => {
    const sample = fc.sample(scenario, { numRuns: 3000, seed: 20261002 });
    const outcomes = sample.map(({ prev, next, ctx, header }) =>
      checkCreatorLimits(prev, next, ctx, header),
    );
    const accepted = outcomes.filter((r) => r.ok);
    expect(accepted.length).toBeGreaterThan(300);
    expect(accepted.filter((r) => r.ok && r.turnoverBps > 0).length).toBeGreaterThan(50);
    const reasons = new Set(outcomes.flatMap((r) => (r.ok ? [] : [r.code])));
    expect(reasons.size).toBeGreaterThanOrEqual(12);
    expect(reasons).toContain('CashNotAllowed');
  });

  it('refuses to judge without the delay or the time, where a comparison would pass by accident', () => {
    const version = [
      { asset: 'solana:a', weightBps: 5000 },
      { asset: 'solana:b', weightBps: 3000 },
      { asset: 'solana:c', weightBps: 2000 },
    ];
    const ctx = { assets: LISTED, now: 1000, lastPublishAt: 990, hasPending: false };
    // A caller that got past the type with no delay: plain JavaScript, or a cast.
    const noDelay = ctx as unknown as LimitContext;
    expect(() => checkCreatorLimits(version, version, noDelay)).toThrow(RangeError);
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => checkCreatorLimits(version, version, { ...ctx, publishDelay: bad })).toThrow(
        RangeError,
      );
      expect(() =>
        checkCreatorLimits(version, version, { ...ctx, publishDelay: 60, now: bad }),
      ).toThrow(RangeError);
    }
    expect(checkCreatorLimits(version, version, { ...ctx, publishDelay: 60 })).toMatchObject({
      ok: false,
      code: 'VersionTooSoon',
    });
    expect(checkCreatorLimits(version, version, { ...ctx, publishDelay: 10 })).toEqual({
      ok: true,
      turnoverBps: 0,
    });
  });

  it('exempts a first version from the delay and from turnover, whatever the context says', () => {
    const version = [
      { asset: 'solana:a', weightBps: 5000 },
      { asset: 'solana:b', weightBps: 3000 },
      { asset: 'solana:c', weightBps: 2000 },
    ];
    const ctx = {
      assets: LISTED,
      now: 1000,
      lastPublishAt: null,
      hasPending: false,
      publishDelay: 300,
    };
    const accepted = { ok: true, turnoverBps: 0 };
    expect(checkCreatorLimits(null, version, ctx)).toEqual(accepted);
    // The review of BAS-1: these two were refused as pending and as too soon.
    expect(checkCreatorLimits(null, version, { ...ctx, hasPending: true })).toEqual(accepted);
    expect(checkCreatorLimits(null, version, { ...ctx, lastPublishAt: 900 })).toEqual(accepted);
    // A later version in the same context is held to both.
    expect(checkCreatorLimits(version, version, { ...ctx, hasPending: true })).toMatchObject({
      code: 'VersionPending',
    });
    expect(checkCreatorLimits(version, version, { ...ctx, lastPublishAt: 900 })).toMatchObject({
      code: 'VersionTooSoon',
    });
  });

  it('refuses the cash token as a component, even where its ceiling would let it in', () => {
    const withCash = [
      { asset: 'solana:usdc', weightBps: 5000 },
      { asset: 'solana:b', weightBps: 3000 },
      { asset: 'solana:c', weightBps: 2000 },
    ];
    const ctx = {
      assets: LISTED,
      now: 1000,
      lastPublishAt: null,
      hasPending: false,
      publishDelay: 300,
    };
    expect(checkCreatorLimits(null, withCash, ctx)).toMatchObject({
      ok: false,
      code: 'CashNotAllowed',
    });
    // The same list with no asset marked as cash has nothing to refuse it by. The type asks for a class
    // on every asset, so the token is marked as an asset like the others.
    const unmarked = LISTED.map((a) => ({ ...a, cls: 'stock' as const }));
    expect(checkCreatorLimits(null, withCash, { ...ctx, assets: unmarked })).toEqual({
      ok: true,
      turnoverBps: 0,
    });
  });

  it('compares turnover without dividing: 4,000 of absolute change passes, 4,001 does not', () => {
    const prev = [
      { asset: 'solana:a', weightBps: 5000 },
      { asset: 'solana:b', weightBps: 3000 },
      { asset: 'solana:c', weightBps: 2000 },
    ];
    const next = [
      { asset: 'solana:a', weightBps: 3000 },
      { asset: 'solana:b', weightBps: 5000 },
      { asset: 'solana:c', weightBps: 2000 },
    ];
    expect(movedBps(prev, next)).toBe(4000);
    expect(turnoverBps(prev, next)).toBe(2000);
    // An odd sum, which two versions that each add up to 10,000 never give: over is over.
    const odd = [
      { asset: 'solana:a', weightBps: 5001 },
      { asset: 'solana:b', weightBps: 4999 },
    ];
    const far = [
      { asset: 'solana:a', weightBps: 3001 },
      { asset: 'solana:b', weightBps: 7000 },
    ];
    expect(movedBps(odd, far)).toBe(4001);
    expect(turnoverBps(odd, far)).toBe(2001);
  });

  it('counts turnover the same whichever version is called the old one', () => {
    fc.assert(
      fc.property(validVersion, validVersion, (a, b) => {
        expect(turnoverBps(a, b)).toBe(turnoverBps(b, a));
        expect(turnoverBps(a, b) * 2).toBe(referenceMovedBps(a, b));
        expect(turnoverBps(a, a)).toBe(0);
      }),
    );
  });
});
