import { LimitResult } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { checkCreatorLimits } from './creator-limits';

// A refusal says from when the same version would be accepted, where waiting is all it takes.

const LISTED = [
  ...'abcdef'
    .split('')
    .map((x) => ({ id: `solana:${x}`, maxWeightBps: 5000, cls: 'stock' as const })),
  { id: 'solana:usdc', maxWeightBps: 5000, cls: 'cash' as const },
];
const weights = (list: Record<string, number>) =>
  Object.entries(list).map(([x, weightBps]) => ({ asset: `solana:${x}`, weightBps }));
const prev = weights({ a: 5000, b: 3000, c: 2000 });
const DELAY = 172_800;
const LAST = 1_791_212_400;
const ctx = {
  assets: LISTED,
  now: LAST + 60,
  lastPublishAt: LAST,
  hasPending: false,
  publishDelay: DELAY,
};

describe('the author limits: when a refused version may be published', () => {
  it('says when a version that is only too soon will pass, and it does pass then', () => {
    const next = weights({ a: 4000, b: 4000, c: 2000 });
    const refused = checkCreatorLimits(prev, next, ctx);
    expect(refused).toMatchObject({ ok: false, code: 'VersionTooSoon', allowedAt: LAST + DELAY });
    expect(LimitResult.parse(refused)).toEqual(refused);
    // One second before it is still refused, with the same time; at the time it passes.
    expect(checkCreatorLimits(prev, next, { ...ctx, now: LAST + DELAY - 1 })).toMatchObject({
      code: 'VersionTooSoon',
      allowedAt: LAST + DELAY,
    });
    expect(checkCreatorLimits(prev, next, { ...ctx, now: LAST + DELAY })).toEqual({
      ok: true,
      turnoverBps: 1000,
    });
  });

  it('names no time when waiting would not be enough', () => {
    // Too soon, and it moves 30% of the portfolio: at the time, it is refused for the turnover.
    const far = weights({ a: 2000, b: 5000, c: 3000 });
    const soon = checkCreatorLimits(prev, far, ctx);
    expect(soon).toMatchObject({ ok: false, code: 'VersionTooSoon' });
    expect(soon).not.toHaveProperty('allowedAt');
    expect(checkCreatorLimits(prev, far, { ...ctx, now: LAST + DELAY })).toMatchObject({
      code: 'TurnoverTooHigh',
    });
    // Too soon, and it holds the cash token.
    const cash = weights({ a: 5000, b: 3000, usdc: 2000 });
    const withCash = checkCreatorLimits(prev, cash, ctx);
    expect(withCash).toMatchObject({ ok: false, code: 'VersionTooSoon' });
    expect(withCash).not.toHaveProperty('allowedAt');
  });

  it('names no time for a refusal that time does not cure', () => {
    const next = weights({ a: 4000, b: 4000, c: 2000 });
    // While a version waits, the one in effect will change under this one: nothing can be promised.
    const pending = checkCreatorLimits(prev, next, { ...ctx, hasPending: true });
    expect(pending).toMatchObject({ ok: false, code: 'VersionPending' });
    expect(pending).not.toHaveProperty('allowedAt');
    const late = { ...ctx, now: LAST + DELAY };
    for (const refused of [
      checkCreatorLimits(prev, weights({ a: 5000, b: 5000 }), late),
      checkCreatorLimits(prev, weights({ a: 2000, b: 5000, c: 3000 }), late),
      checkCreatorLimits(null, weights({ a: 5000, b: 3000, usdc: 2000 }), late),
    ]) {
      expect(refused.ok).toBe(false);
      expect(refused).not.toHaveProperty('allowedAt');
    }
  });
});
