import { describe, expect, it } from 'vitest';
import { candidates } from './candidates';
import { compose } from './compose';
import { PERSONAL_PARAMS } from './params';
import { sleeveOfClass } from './registry';
import { extendedContext, extendedShelf, sheet, violations } from './testing';
import type { PersonalProposal, PersonalSheet } from './types';

// The limit on lines counts each set of a plan that has two (gate LINES-PER-SET, Rodrigo, Oct 7):
// "8k safe and liquid, 20% in big tech" held The Seven in seven of the plan's eight lines, so the
// 80% had one line, and what its one token could not take sat in cash. Where the person's plan is
// two sets, a stated mix or a split, stocks and crypto have their eight lines and the rest of the
// plan has its own eight. Every figure is MOCK, from the engine's fixtures.

const shelf = extendedShelf();
const ctx = extendedContext();
const MAX = PERSONAL_PARAMS.maxLinesPerChain;
const cls = new Map(shelf.assets.map((a) => [a.id, a.cls]));
const inSet = (plan: PersonalProposal, growth: boolean) =>
  plan.lines.filter((l) => {
    const c = cls.get(l.assetId);
    return c !== undefined && c !== 'cash' && (sleeveOfClass(c) === 'growth') === growth;
  });
const cashBps = (plan: PersonalProposal) =>
  plan.lines.filter((l) => cls.get(l.assetId) === 'cash').reduce((n, l) => n + l.weightBps, 0);
const asked = (over: Partial<PersonalSheet>) =>
  sheet({
    goal: 'grow',
    amountUsd: 10_000,
    horizonOpen: true,
    themes: ['the-seven'],
    rules: { useHoldings: true, glide: false },
    ...over,
  });

describe('the limit on lines, for a plan of two sets', () => {
  it('a stated mix: the seven stocks leave the dollar yield its own lines, and no cash is left over', () => {
    const s = asked({ mix: { growthBps: 2000, dollarYieldBps: 8000, goldBps: 0, cashBps: 0 } });
    const made = candidates(s, shelf, ctx);
    expect(made.shown.length).toBeGreaterThan(0);
    for (const c of made.shown) {
      expect(violations(c.plan, shelf, ctx), c.id).toEqual([]);
      expect(inSet(c.plan, true), c.id).toHaveLength(7);
      expect(inSet(c.plan, false).length, c.id).toBeGreaterThan(1);
      expect(inSet(c.plan, false).length, c.id).toBeLessThanOrEqual(MAX);
      expect(cashBps(c.plan), c.id).toBe(0);
    }
  });

  it('a split: the part kept safe holds more than one rate token beside the seven stocks', () => {
    const s = asked({
      risk: 'high',
      sleeves: [
        { kind: 'safe_yield', shareBps: 8000 },
        { kind: 'goal', shareBps: 2000 },
      ],
    });
    const plan = compose(s, shelf, ctx);
    expect(violations(plan, shelf, ctx)).toEqual([]);
    expect(inSet(plan, true)).toHaveLength(7);
    expect(inSet(plan, false).length).toBeGreaterThan(1);
  });

  it('each set keeps its own limit: neither holds more than the limit', () => {
    const s = asked({ mix: { growthBps: 5000, dollarYieldBps: 5000, goldBps: 0, cashBps: 0 } });
    for (const c of candidates(s, shelf, ctx).shown) {
      expect(inSet(c.plan, true).length, c.id).toBeLessThanOrEqual(MAX);
      expect(inSet(c.plan, false).length, c.id).toBeLessThanOrEqual(MAX);
    }
  });

  it('a plan from the table, with no mix and no split, keeps the one limit', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      const plan = compose(asked({ risk }), shelf, ctx);
      expect(violations(plan, shelf, ctx), risk).toEqual([]);
      expect(inSet(plan, true).length + inSet(plan, false).length, risk).toBeLessThanOrEqual(MAX);
    }
  });
});
