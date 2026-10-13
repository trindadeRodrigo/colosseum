import type { AssetClass } from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { purposeOfMix } from './index';
import { RISKS } from './mix';
import { PERSONAL_PARAMS } from './params';

const line = (cls: AssetClass, weightBps: number) => ({ cls, weightBps });

describe('purposeOfMix: the goal and risk of a mix the person chose (gate DEPOSIT-DERIVE)', () => {
  it('reads 70% dollar yield and 30% in three stocks as a plan to grow, at low risk', () => {
    expect(
      purposeOfMix([
        line('dollar_yield', 7000),
        line('stock', 1000),
        line('stock', 1000),
        line('stock', 1000),
      ]),
    ).toEqual({ goal: 'grow', risk: 'low' });
  });

  it('reads dollar yield, gold and cash alone as a plan to protect, at the lowest risk', () => {
    expect(
      purposeOfMix([line('dollar_yield', 6000), line('gold', 3000), line('cash', 1000)]),
    ).toEqual({ goal: 'protect', risk: 'low' });
    expect(purposeOfMix([line('dollar_yield', 10_000)])).toEqual({ goal: 'protect', risk: 'low' });
  });

  it('reads crypto or another commodity as a plan to grow: a plan to protect cannot hold them', () => {
    expect(purposeOfMix([line('dollar_yield', 9500), line('crypto', 500)]).goal).toBe('grow');
    expect(purposeOfMix([line('dollar_yield', 9500), line('commodity', 500)]).goal).toBe('grow');
    // a commodity is not a stock or crypto: it does not count toward the risk
    expect(purposeOfMix([line('dollar_yield', 5000), line('commodity', 5000)]).risk).toBe('low');
  });

  it('raises the risk with the share in stocks and crypto, by the cap per issuer', () => {
    const spread = (bps: number) => [
      line('dollar_yield', 10_000 - bps),
      ...Array.from({ length: bps / 500 }, () => line('stock', 500)),
    ];
    expect(purposeOfMix(spread(5000)).risk).toBe('low');
    expect(purposeOfMix(spread(5500)).risk).toBe('medium');
    expect(purposeOfMix(spread(7000)).risk).toBe('medium');
    expect(purposeOfMix(spread(7500)).risk).toBe('high');
    expect(purposeOfMix(spread(10_000)).risk).toBe('high');
  });

  it('raises the risk with the largest single stock or crypto line, by the cap per stock', () => {
    expect(purposeOfMix([line('dollar_yield', 9000), line('stock', 1000)]).risk).toBe('low');
    expect(purposeOfMix([line('dollar_yield', 8500), line('stock', 1500)]).risk).toBe('medium');
    expect(purposeOfMix([line('dollar_yield', 7000), line('crypto', 3000)]).risk).toBe('high');
    // past every cap: the highest, never nothing
    expect(purposeOfMix([line('stock', 10_000)])).toEqual({ goal: 'grow', risk: 'high' });
  });

  it('gives a goal that holds every line, and a risk whose caps hold the mix unless none does', () => {
    const CLASSES: AssetClass[] = [
      'stock',
      'etf',
      'crypto',
      'gold',
      'commodity',
      'dollar_yield',
      'cash',
    ];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cls: fc.constantFrom(...CLASSES),
            weightBps: fc.integer({ min: 1, max: 10_000 }),
          }),
          {
            minLength: 1,
            maxLength: 16,
          },
        ),
        (lines) => {
          const { goal, risk } = purposeOfMix(lines);
          const safe = ['dollar_yield', 'gold', 'cash'];
          expect(goal).toBe(lines.every((l) => safe.includes(l.cls)) ? 'protect' : 'grow');
          const growth = lines.filter((l) => ['stock', 'etf', 'crypto'].includes(l.cls));
          const share = growth.reduce((n, l) => n + l.weightBps, 0);
          const largest = Math.max(0, ...growth.map((l) => l.weightBps));
          const holds = (r: (typeof RISKS)[number]) =>
            share <= (PERSONAL_PARAMS.capPerIssuerBps[r] ?? 0) &&
            largest <= (PERSONAL_PARAMS.capPerStockBps[r] ?? 0);
          // the lowest that holds it, and none below it does
          if (holds(risk))
            for (const lower of RISKS.slice(0, RISKS.indexOf(risk)))
              expect(holds(lower)).toBe(false);
          else expect(risk).toBe('high');
        },
      ),
    );
  });
});
