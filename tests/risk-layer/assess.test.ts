import { readFileSync } from 'node:fs';
import {
  type AssetCurves,
  assessLiquidity,
  type DepthCurve,
  defaultRegimeParams,
  fitCurve,
  gapSim,
  type IssuerModel,
  liquidityScore,
  type Regime,
  recoverableValue,
  weekendRatio,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const issuer = JSON.parse(readFileSync('fixtures/risk/issuer-models.json', 'utf8')).models
  .xstocks as IssuerModel;
const syn = JSON.parse(readFileSync('fixtures/risk/curves-synthetic.json', 'utf8')).spyx as Record<
  Regime,
  Array<[number, number]>
>;
const curve = (pts: Array<[number, number]>): DepthCurve =>
  fitCurve(
    pts.flatMap(([n, c]) => [0, 1, 2].map(() => ({ notionalUsd: n, cost: c }))),
    { quantile: 0.5, minSamples: 3 },
  );
const spyx: AssetCurves = {
  assetId: 'spyx',
  byRegime: Object.fromEntries(Object.entries(syn).map(([r, pts]) => [r, curve(pts)])),
};
const SAT = new Date('2026-10-03T10:00:00Z');

describe('Phase 1 acceptance: recoverable value (HANDOFF-RISK §6 P1.2)', () => {
  it('Saturday 10:00Z, $50k, 24h: DEX only', () => {
    const r = recoverableValue(spyx, issuer, 50_000, SAT, 24, P);
    expect(r.path).toBe('dex');
    expect(r.regimes).toEqual(['weekend']);
    expect(r.primary?.status).toBe('window_closed');
  });
  it('same at 72h lists the primary path, labelled assumption, not counted (settles after horizon)', () => {
    const r = recoverableValue(spyx, issuer, 50_000, SAT, 72, P);
    expect(r.primary?.provenance).toBe('assumption');
    expect(r.primary?.status).toBe('settles_after_horizon');
    expect(r.path).toBe('dex');
    // a better regime is reachable inside 72h: Monday market hours
    expect(r.dex?.regime).toBe('us_market_hours');
  });
  it('Saturday and Tuesday 11:00 ET give different numbers', () => {
    const sat = recoverableValue(spyx, issuer, 400_000, SAT, 4, P).value as number;
    const tue = recoverableValue(spyx, issuer, 400_000, new Date('2026-10-06T15:00:00Z'), 4, P)
      .value as number;
    expect(tue).toBeGreaterThan(sat);
  });
});

describe('Phase 1 acceptance: breach and likely breach (§6 P1.3)', () => {
  const base = {
    brlUsd: 0,
    liquid: [],
    illiquid: [{ assetId: 'spyx', valueUsd: 200_000, curves: spyx }],
    withdrawals: [{ at: '2026-10-10T12:00:00Z', usd: 30_000 }],
    windowDays: 7,
    tau: 0.01,
    shareOfDepth: 0.25,
    dryFactorFloor: 0.25,
    regimeParams: P,
  };
  it('fixture A: withdrawal beyond cash + liquid → no breach, likely breach, orders remove it', () => {
    const a = assessLiquidity({ ...base, cashUsd: 10_000 });
    expect(a.breach).toBe(false);
    expect(a.likelyBreach).toBe(true);
    expect(a.orders.length).toBeGreaterThan(0);
    expect(a.orders.every((o) => o.toAssetId === 'usdc' && o.reason === 'liquidity_breach')).toBe(
      true,
    );
    expect(a.afterOrders.likelyBreach).toBe(false);
  });
  it('fixture B: enough cash → neither', () => {
    const b = assessLiquidity({ ...base, cashUsd: 40_000 });
    expect(b.breach).toBe(false);
    expect(b.likelyBreach).toBe(false);
    expect(b.orders).toEqual([]);
  });
  it('is deterministic', () => {
    expect(assessLiquidity({ ...base, cashUsd: 10_000 })).toEqual(
      assessLiquidity({ ...base, cashUsd: 10_000 }),
    );
  });
});

describe('score, weekend ratio, gap simulator', () => {
  it('score uses the worst regime and the measured weekend ratio', () => {
    const s = liquidityScore(spyx, ['us_market_hours', 'weekend'], 0.01, 400_000);
    expect(s.worstRegime).toBe('weekend');
    expect(s.score).toBeCloseTo(0.25, 9);
    expect(weekendRatio(spyx, 0.01)).toBeCloseTo(0.25, 9);
  });
  it('gap simulator splits liquidatable at reopen and unliquidatable while closed', () => {
    const m = {
      ltvLiq: 0.5,
      closeFactor: 0.2,
      fullLiqLtv: 0.95,
      liqBonus: 0.05,
      bandPct: 0.05,
      provenance: 'fixture' as const,
      source: 'test',
    };
    const g = gapSim(
      m,
      [
        { collateralUsd: 100_000, debtUsd: 46_000 },
        { collateralUsd: 100_000, debtUsd: 30_000 },
      ],
      0.1,
      () => 0.01,
    );
    expect(g.liquidatableDebtUsd).toBe(46_000);
    expect(g.unliquidatableWhileClosedDebtUsd).toBe(46_000);
    expect(g.assumptions.length).toBeGreaterThan(0);
  });
});
