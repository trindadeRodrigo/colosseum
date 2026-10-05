/// <reference path="../types/javascript-lp-solver.d.ts" />
import solver from 'javascript-lp-solver';
import { describe, expect, it } from 'vitest';
import { bandedFill, type FillItem } from './fill';

// Change C1 and C2 of docs/vault/research/portfolio-method.md, section 4.2: the banded fill against
// the old linear program, its order independence, and what the band does.

/** A small seeded generator, so a failing case can be run again. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const objective = (items: FillItem[], take: Map<string, number>) =>
  items.reduce((s, i) => s + (i.yield ?? 0) * (take.get(i.id) ?? 0), 0);

describe('bandedFill against the old linear program (C1)', () => {
  it('with the band at zero, reaches the linear program’s optimum on 5,000 random cases', () => {
    const next = rng(20261005);
    const UNIT = 1_000_000; // a plan of a million units, so whole units stand in for fractions
    let feasible = 0;
    for (let n = 0; n < 5000; n += 1) {
      const count = 2 + Math.floor(next() * 19);
      const tied = next() < 0.3;
      const items: FillItem[] = Array.from({ length: count }, (_, k) => {
        const y = tied ? [0.03, 0.04, 0.05][Math.floor(next() * 3)] : 0.01 + next() * 0.09;
        const credit = next() < 0.3;
        return {
          id: `a${String(k).padStart(2, '0')}`,
          yield: Math.round((y as number) * 1e6) / 1e6,
          room: Math.round((0.05 + next() * 0.55) * UNIT),
          groups: credit ? ['credit'] : [],
        };
      });
      const creditMax = [0, 0.25, 0.5][Math.floor(next() * 3)] as number;
      const remainder = Math.round((0.5 + next() * 0.5) * UNIT);

      const constraints: Record<string, { max?: number; equal?: number }> = {
        total: { max: remainder },
        credit: { max: creditMax * UNIT },
      };
      const variables: Record<string, Record<string, number>> = {};
      for (const i of items) {
        constraints[`cap_${i.id}`] = { max: i.room };
        variables[i.id] = {
          y: i.yield as number,
          total: 1,
          [`cap_${i.id}`]: 1,
          credit: i.groups.includes('credit') ? 1 : 0,
        };
      }
      const lp = solver.Solve({ optimize: 'y', opType: 'max', constraints, variables });
      expect(lp.feasible).toBe(true);
      const fill = bandedFill({
        amount: remainder,
        items,
        groupRoom: { credit: Math.round(creditMax * UNIT) },
        band: 0,
      });
      const lpValue = Number(lp.result);
      const fillValue = objective(items, fill.take);
      // Whole units against a continuous optimum: within one unit per asset at the top yield.
      expect(Math.abs(fillValue - lpValue)).toBeLessThanOrEqual(count * 0.1 + 1e-6);
      // Distinct yields have one optimum: the weights themselves agree, to a unit.
      if (!tied && new Set(items.map((i) => i.yield)).size === items.length)
        for (const i of items)
          expect(Math.abs((fill.take.get(i.id) ?? 0) - Number(lp[i.id] ?? 0))).toBeLessThanOrEqual(
            1,
          );
      if (lpValue > 0) feasible += 1;
    }
    expect(feasible).toBeGreaterThan(4000);
  });
});

describe('bandedFill does not depend on the order of its inputs (C1)', () => {
  it('gives the same plan when the assets are shuffled 100 times', () => {
    const next = rng(7);
    const items: FillItem[] = Array.from({ length: 12 }, (_, k) => ({
      id: `t${k}`,
      yield: [0.041, 0.043, 0.045, 0.05, null][k % 5] as number | null,
      room: 50_000 + 10_000 * (k % 4),
      groups: k % 3 === 0 ? ['issuer:x', 'credit'] : [`issuer:${k}`],
    }));
    const run = (xs: FillItem[]) =>
      bandedFill({
        amount: 400_000,
        items: xs,
        groupRoom: { 'issuer:x': 90_000, credit: 120_000 },
        band: 0.005,
      });
    const first = run(items);
    const key = (r: ReturnType<typeof run>) =>
      JSON.stringify([[...r.take].sort(), r.left, r.noYield, [...r.bound].sort()]);
    for (let n = 0; n < 100; n += 1) expect(key(run(shuffle(items, next)))).toBe(key(first));
  });
});

describe('the band (C2)', () => {
  const two = (a: number, b: number) =>
    bandedFill({
      amount: 100_000,
      items: [
        { id: 'high', yield: a, room: 100_000, groups: [] },
        { id: 'low', yield: b, room: 100_000, groups: [] },
      ],
      groupRoom: {},
      band: 0.005,
    });

  it('shares evenly between two yields 0.3 points apart', () => {
    const r = two(0.05, 0.047);
    expect(r.take.get('high')).toBe(50_000);
    expect(r.take.get('low')).toBe(50_000);
  });

  it('fills the higher first when they are 0.8 points apart', () => {
    const r = two(0.05, 0.042);
    expect(r.take.get('high')).toBe(100_000);
    expect(r.take.has('low')).toBe(false);
  });

  it('hands what a capped asset cannot take to the others in its band, then to the next band', () => {
    const r = bandedFill({
      amount: 100_000,
      items: [
        { id: 'a', yield: 0.05, room: 20_000, groups: [] },
        { id: 'b', yield: 0.048, room: 100_000, groups: [] },
        { id: 'c', yield: 0.03, room: 100_000, groups: [] },
      ],
      groupRoom: {},
      band: 0.005,
    });
    expect(r.take.get('a')).toBe(20_000);
    expect(r.take.get('b')).toBe(80_000);
    expect(r.take.has('c')).toBe(false);
    expect(r.bound.get('a')).toEqual({ by: 'own' });
  });

  it('splits an odd unit by rank, not by input order', () => {
    const items: FillItem[] = [
      { id: 'b', yield: 0.04, room: 10, groups: [] },
      { id: 'a', yield: 0.04, room: 10, groups: [] },
    ];
    const r = bandedFill({ amount: 3, items, groupRoom: {}, band: 0 });
    expect(r.take.get('a')).toBe(2);
    expect(r.take.get('b')).toBe(1);
  });
});

describe('caps and groups (C8)', () => {
  it('leaves an asset with no yield out, by name, and never counts it as zero', () => {
    const r = bandedFill({
      amount: 100,
      items: [
        { id: 'read', yield: 0.01, room: 50, groups: [] },
        { id: 'unread', yield: null, room: 1000, groups: [] },
      ],
      groupRoom: {},
      band: 0,
    });
    expect(r.noYield).toEqual(['unread']);
    expect(r.take.has('unread')).toBe(false);
    expect(r.left).toBe(50);
  });

  it('holds an issuer cap across several assets of one issuer, and names it', () => {
    const r = bandedFill({
      amount: 100_000,
      items: [
        { id: 'm1', yield: 0.06, room: 60_000, groups: ['issuer:maple'] },
        { id: 'm2', yield: 0.059, room: 60_000, groups: ['issuer:maple'] },
        { id: 'k', yield: 0.04, room: 60_000, groups: ['issuer:kamino'] },
      ],
      groupRoom: { 'issuer:maple': 50_000, 'issuer:kamino': 50_000 },
      band: 0.005,
    });
    expect((r.take.get('m1') ?? 0) + (r.take.get('m2') ?? 0)).toBe(50_000);
    expect(r.take.get('m1')).toBe(25_000);
    expect(r.take.get('k')).toBe(50_000);
    expect(r.bound.get('m1')).toEqual({ by: 'group', group: 'issuer:maple' });
    expect(r.bound.get('k')).toEqual({ by: 'group', group: 'issuer:kamino' });
  });

  it('holds the credit budget', () => {
    const r = bandedFill({
      amount: 100_000,
      items: [
        { id: 'credit', yield: 0.08, room: 100_000, groups: ['credit'] },
        { id: 'rate', yield: 0.04, room: 100_000, groups: [] },
      ],
      groupRoom: { credit: 25_000 },
      band: 0.005,
    });
    expect(r.take.get('credit')).toBe(25_000);
    expect(r.take.get('rate')).toBe(75_000);
  });

  it('never gives an asset more than its room, on random cases', () => {
    const next = rng(99);
    for (let n = 0; n < 500; n += 1) {
      const items: FillItem[] = Array.from({ length: 2 + Math.floor(next() * 8) }, (_, k) => ({
        id: `x${k}`,
        yield: next() < 0.1 ? null : Math.round(next() * 1000) / 10_000,
        room: Math.floor(next() * 50_000),
        groups: [`g${k % 3}`],
      }));
      const groupRoom = { g0: Math.floor(next() * 60_000), g1: Math.floor(next() * 60_000) };
      const amount = Math.floor(next() * 200_000);
      const r = bandedFill({ amount, items, groupRoom, band: next() * 0.01 });
      let total = 0;
      for (const i of items) {
        const t = r.take.get(i.id) ?? 0;
        expect(t).toBeLessThanOrEqual(i.room);
        total += t;
      }
      for (const [g, cap] of Object.entries(groupRoom)) {
        const inG = items
          .filter((i) => i.groups.includes(g))
          .reduce((s, i) => s + (r.take.get(i.id) ?? 0), 0);
        expect(inG).toBeLessThanOrEqual(cap);
      }
      expect(total + r.left).toBe(amount);
    }
  });
});
