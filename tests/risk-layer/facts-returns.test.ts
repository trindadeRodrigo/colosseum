import {
  annualCostDrag,
  breakEvenReturn,
  lossUsd,
  netReturn,
  netReturnAtSize,
  roundTripCost,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 5: hand-computed cases, and net below gross whenever a cost is positive.
describe('round trip and net return', () => {
  it('hand-computed', () => {
    // enter at 1%, exit at 2%: 0.99 × 0.98 = 0.9702 kept
    expect(roundTripCost(0.01, 0.02)).toBeCloseTo(0.0298, 12);
    // +10% gross: 0.99 × 1.10 × 0.98 = 1.06722
    expect(netReturn(0.1, 0.01, 0.02)).toBeCloseTo(0.06722, 12);
    expect(breakEvenReturn(0.01, 0.02)).toBeCloseTo(1 / 0.9702 - 1, 12);
    expect(netReturn(breakEvenReturn(0.01, 0.02), 0.01, 0.02)).toBeCloseTo(0, 12);
    // $10k at 0.5%, $0.02 network fee, 10 bps platform fee: 50 + 0.02 + 10
    expect(lossUsd(10_000, 0.005, { networkFeeUsd: 0.02, platformFeeBps: 10 })).toBeCloseTo(
      60.02,
      10,
    );
    expect(lossUsd(10_000, 0.005)).toBe(50);
  });

  it('fixed fees move the break-even', () => {
    const be = breakEvenReturn(0.01, 0.02, 0.001);
    expect(netReturn(be, 0.01, 0.02, 0.001)).toBeCloseTo(0, 12);
    expect(be).toBeGreaterThan(breakEvenReturn(0.01, 0.02));
  });

  it('net is below gross whenever any cost is positive', () => {
    for (const g of [-0.5, -0.1, 0, 0.05, 0.4])
      for (const [cIn, cOut, f] of [
        [0.001, 0, 0],
        [0, 0.002, 0],
        [0, 0, 0.0005],
        [0.01, 0.03, 0.001],
      ] as const)
        expect(netReturn(g, cIn, cOut, f)).toBeLessThan(g);
    expect(netReturn(0.07, 0, 0)).toBeCloseTo(0.07, 12);
  });

  it('the yearly drag compounds the round trip', () => {
    expect(annualCostDrag(0.01, 0.02, 365)).toBeCloseTo(0.0298, 12);
    expect(annualCostDrag(0.01, 0.02, 182.5)).toBeCloseTo(1 - 0.9702 ** 2, 12);
    expect(annualCostDrag(0.01, 0.02, 0)).toBeNaN();
  });

  it('the exit is priced at the size the position has become', () => {
    const exitCostAt = (n: number) => (n <= 10_000 ? 0.002 : n <= 20_000 ? 0.01 : null);
    const r = netReturnAtSize({
      notionalUsd: 10_000,
      gross: 0.5,
      entryCostAt: () => 0.001,
      exitCostAt,
    });
    // 10,000 × 0.999 × 1.5 = 14,985 exits at 1%, not at the 0.2% of the entry size
    expect(r.exitNotionalUsd).toBeCloseTo(14_985, 8);
    expect(r.exitCost).toBe(0.01);
    expect(r.net).toBeCloseTo(0.999 * 1.5 * 0.99 - 1, 12);
    expect(r.lossUsd).toBeCloseTo(10 + 149.85, 8);
    expect(r.missing).toBeNull();
  });

  it('an unmeasured size gives null and says which side', () => {
    const tooBig = netReturnAtSize({
      notionalUsd: 10_000,
      gross: 2,
      entryCostAt: () => 0.001,
      exitCostAt: (n) => (n <= 20_000 ? 0.01 : null),
    });
    expect(tooBig).toMatchObject({ net: null, missing: 'exit', entryCost: 0.001 });
    expect(
      netReturnAtSize({
        notionalUsd: 10_000,
        gross: 0,
        entryCostAt: () => null,
        exitCostAt: () => 0,
      }),
    ).toMatchObject({ net: null, missing: 'entry' });
  });

  it('fixed fees are charged on the way in and on the way out', () => {
    const r = netReturnAtSize({
      notionalUsd: 1_000,
      gross: 0,
      entryCostAt: () => 0,
      exitCostAt: () => 0,
      networkFeeUsd: 0.5,
    });
    expect(r.lossUsd).toBeCloseTo(1, 12);
    expect(r.net).toBeCloseTo(-0.001, 12);
  });
});
