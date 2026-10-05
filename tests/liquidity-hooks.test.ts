import { readFileSync } from 'node:fs';
import {
  applyHaircut,
  buildRiskSheet,
  buildSchedule,
  buildScheduleWithStresses,
  proposeRebalance,
  REGISTRY,
  REGISTRY_BY_ID,
  solve,
} from '@colosseum/engine';
import {
  type AssetCurves,
  createLiquidityProvider,
  type DepthCurve,
  defaultRegimeParams,
  fitCurve,
  type Regime,
} from '@colosseum/risk';
import type {
  ConstraintSheet,
  DepthObservation,
  PlanLeg,
  Policy,
  YieldObservation,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// HANDOFF-RISK §6 P3.2–P3.5 with a fixture LiquidityProvider (synthetic curves, provenance 'fixture').
const inp = JSON.parse(readFileSync('fixtures/risk/engine-baseline-inputs.json', 'utf8'));
const syn = JSON.parse(readFileSync('fixtures/risk/curves-synthetic.json', 'utf8')) as Record<
  'spyx' | 'stable',
  Record<Regime, Array<[number, number]>>
>;
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const curve = (pts: Array<[number, number]>): DepthCurve =>
  fitCurve(
    pts.flatMap(([n, c]) => [0, 1, 2].map(() => ({ notionalUsd: n, cost: c }))),
    { quantile: 0.5, minSamples: 3 },
  );
const curves = (id: string, set: 'spyx' | 'stable'): AssetCurves => ({
  assetId: id,
  byRegime: Object.fromEntries(Object.entries(syn[set]).map(([r, pts]) => [r, curve(pts)])),
});
const provider = createLiquidityProvider({
  curves: new Map([
    ['spyx', curves('spyx', 'spyx')],
    ['qqqx', curves('qqqx', 'spyx')],
    ['usdy', curves('usdy', 'stable')],
    ['syrupusdc', curves('syrupusdc', 'stable')],
  ]),
  regimeParams: P,
  methodVersion: 'risk-0.2',
  provenance: 'fixture',
});
const yields = new Map<string, YieldObservation>(
  (inp.yields as Array<[string, string, number]>).map(([id, method, quoted]) => {
    const h = applyHaircut(REGISTRY_BY_ID.get(id) as never, method, quoted);
    return [
      id,
      {
        assetId: id,
        quotedYield: quoted,
        haircutYield: h.haircutYield,
        haircutRule: h.rule.id,
        source: 'fixture',
        method,
        fetchedAt: '2026-09-30T00:00:00.000Z',
        provenance: 'fixture',
      },
    ];
  }),
);
const assets = new Map(REGISTRY.map((a) => [a.id, a]));
const sheets = inp.sheets as Record<string, ConstraintSheet>;
const run = (sheet: ConstraintSheet, capitalUsd: number, withLiq: boolean) =>
  solve({
    sheet,
    capitalUsd,
    assets: REGISTRY,
    yields,
    fxUsdBrl: inp.fxUsdBrl,
    nowMonth: inp.nowMonth,
    liquidity: withLiq ? provider : undefined,
  });
const w = (r: ReturnType<typeof solve>, id: string) =>
  r.legs.find((l) => l.assetId === id)?.weight ?? 0;

describe('P3.2 sizing: stock weights capped by measured weekend exit capacity', () => {
  it('SPYx and QQQx weights fall as capital rises past weekend capacity; binding text names regime and capacity', () => {
    const hr = sheets.high_risk as ConstraintSheet;
    const small = run(hr, 100_000, true);
    const large = run(hr, 2_000_000, true);
    expect(w(small, 'spyx')).toBeGreaterThan(w(large, 'spyx'));
    expect(w(small, 'qqqx')).toBeGreaterThan(w(large, 'qqqx'));
    const b = large.bindingConstraints.find((x) => x.startsWith('spyx capped'));
    expect(b).toContain('weekend');
    expect(b).toContain('$100,000');
    // without a provider the large plan keeps the registry-cap weights
    expect(w(run(hr, 2_000_000, false), 'spyx')).toBeGreaterThan(w(large, 'spyx'));
  });
});

describe('P3.3 risk sheet: liquidity block per covered leg', () => {
  for (const name of ['high_risk', 'income', 'accumulation']) {
    it(`${name}: covered legs carry score, capacity, weekend ratio, dates`, () => {
      const sheet = sheets[name] as ConstraintSheet;
      const solved = run(sheet, inp.capitalUsd, true);
      const held = REGISTRY.filter((a) => solved.legs.some((l) => l.assetId === a.id));
      const legAmounts = new Map(solved.legs.map((l) => [l.assetId, l.amountUsd]));
      const rs = buildRiskSheet({
        assets: held,
        yields,
        depth: new Map<string, DepthObservation[]>(),
        liquidity: { provider, tau: 0.01, windowDays: sheet.liquidityWindowDays, legAmounts },
      });
      const covered = rs.filter((e) => provider.covers(e.assetId));
      expect(covered.length).toBeGreaterThan(0);
      for (const e of covered) {
        expect(e.liquidity?.provenance).toBe('fixture');
        if (['spyx', 'qqqx'].includes(e.assetId)) expect(e.liquidity?.worstRegime).toBe('weekend');
        expect(typeof e.liquidity?.score).toBe('number');
        expect(e.liquidity?.samples).toBeGreaterThan(0);
      }
      if (name === 'high_risk')
        expect(covered.map((e) => e.assetId)).toEqual(expect.arrayContaining(['spyx', 'qqqx']));
      for (const e of rs.filter((x) => !provider.covers(x.assetId)))
        expect(e.liquidity).toBeUndefined();
    });
  }
});

describe('P3.4 schedule: exit cost and liquidity_dry', () => {
  it('liquidity_dry appears only for plans holding stocks, and only with a provider', () => {
    const hr = sheets.high_risk as ConstraintSheet;
    const solved = run(hr, inp.capitalUsd, true);
    const base = {
      sheet: hr,
      legs: solved.legs,
      assets,
      yields,
      capitalUsd: inp.capitalUsd,
      fxUsdBrl: inp.fxUsdBrl,
      nowMonth: inp.nowMonth,
    };
    expect(
      buildScheduleWithStresses({ ...base, liquidity: provider }).stresses.map((s) => s.id),
    ).toContain('liquidity_dry');
    expect(buildScheduleWithStresses(base).stresses.map((s) => s.id)).not.toContain(
      'liquidity_dry',
    );
    const inc = sheets.income as ConstraintSheet;
    const incSolved = run(inc, inp.capitalUsd, true);
    expect(
      buildScheduleWithStresses({
        ...base,
        sheet: inc,
        legs: incSolved.legs,
        liquidity: provider,
      }).stresses.map((s) => s.id),
    ).not.toContain('liquidity_dry');
  });
  it('liquidityOk changes when a withdrawal is drawn from stocks at exit cost', () => {
    const inc = sheets.income as ConstraintSheet;
    const legs: PlanLeg[] = [
      { assetId: 'usdc', weight: 0.02, amountUsd: 2_000, reasoning: 'fixture' },
      { assetId: 'spyx', weight: 0.98, amountUsd: 98_000, reasoning: 'fixture' },
    ];
    const base = {
      sheet: inc,
      legs,
      assets,
      yields,
      capitalUsd: 100_000,
      fxUsdBrl: inp.fxUsdBrl,
      nowMonth: inp.nowMonth,
      months: 36,
    };
    // today's engine draws stock at par (no exit cost); with measured liquidity it pays the exit cost
    const without = buildSchedule(base);
    const withLiq = buildSchedule({ ...base, liquidity: provider });
    expect(without.liquidityOk).toBe(true);
    expect(withLiq.rows.at(-1)?.balanceUsd ?? 0).toBeLessThan(without.rows.at(-1)?.balanceUsd ?? 0);
    // a withdrawal larger than what stock can raise at ≤ exitImpactCapPct (weekend curve) is funded at par but
    // not at exit cost: liquidityOk flips
    const big = { ...inc, target: { ...inc.target, amountBrl: 3_000_000 } } as ConstraintSheet;
    const bigLegs: PlanLeg[] = [
      { assetId: 'usdc', weight: 0.02, amountUsd: 100_000, reasoning: 'fixture' },
      { assetId: 'spyx', weight: 0.98, amountUsd: 4_900_000, reasoning: 'fixture' },
    ];
    const bigBase = { ...base, sheet: big, legs: bigLegs, capitalUsd: 5_000_000, months: 16 };
    expect(buildSchedule(bigBase).liquidityOk).toBe(true);
    expect(buildSchedule({ ...bigBase, liquidity: provider }).liquidityOk).toBe(false);
    const dry = buildScheduleWithStresses({ ...base, liquidity: provider }).stresses.find(
      (s) => s.id === 'liquidity_dry',
    );
    expect(dry).toBeDefined();
  });
});

describe('P3.5 policy: liquidity_breach proposal respects every invariant', () => {
  const policy: Policy = {
    id: 'p',
    planId: 'plan',
    wallet: 'W',
    allowedAssets: ['usdc', 'spyx', 'usdy'],
    bands: [
      { assetId: 'usdc', min: 0, max: 0.5 },
      { assetId: 'spyx', min: 0, max: 0.9 },
      { assetId: 'usdy', min: 0, max: 0.5 },
    ],
    trigger: {
      driftPct: 50,
      minIntervalHours: 1,
      liquidity: {
        impactTolerancePct: 1,
        horizonMonths: 3,
        shareOfDepth: 0.25,
        dryFactorFloor: 0.25,
      },
    },
    withdrawalDestination: 'OWNER',
    mechanism: 'user_signed',
    mechanismByAsset: {},
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const positions = [
    { assetId: 'usdc', valueUsd: 10_000 },
    { assetId: 'spyx', valueUsd: 200_000 },
  ];
  const assessment = provider.assess({
    cashUsd: 10_000,
    brlUsd: 0,
    liquid: [],
    illiquid: [{ assetId: 'spyx', valueUsd: 200_000 }],
    withdrawals: [{ at: '2026-10-10T12:00:00Z', usd: 30_000 }],
    windowDays: 7,
    tau: 0.01,
    shareOfDepth: 0.25,
    dryFactorFloor: 0.25,
  });
  const targets = { usdc: 0.05, spyx: 0.95 };
  const prop = proposeRebalance({
    policy,
    targets,
    positions,
    dexAssets: new Set(['usdy']),
    liquidity: assessment,
  });
  it('proposes illiquid → USDC orders with reason liquidity_breach', () => {
    expect(assessment.likelyBreach).toBe(true);
    expect(prop.triggered).toBe(true);
    expect(prop.reason).toBe('liquidity_breach');
    expect(prop.orders.length).toBeGreaterThan(0);
    for (const o of prop.orders) {
      expect(o.reason.startsWith('liquidity_breach')).toBe(true);
      expect(o.toAssetId).toBe('usdc');
      expect(o.fromAssetId).toBe('spyx');
    }
  });
  it('invariants: owner destination, allowed assets, never above band max, only reduces illiquid legs', () => {
    const total = positions.reduce((s, p) => s + p.valueUsd, 0);
    const toUsdc = prop.orders.reduce((s, o) => s + o.amountUsd, 0);
    expect(prop.orders.every((o) => o.destination === 'OWNER')).toBe(true);
    expect(
      prop.orders.every(
        (o) =>
          policy.allowedAssets.includes(o.fromAssetId) &&
          policy.allowedAssets.includes(o.toAssetId),
      ),
    ).toBe(true);
    expect((10_000 + toUsdc) / total).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(prop.orders.every((o) => o.amountUsd <= 200_000)).toBe(true);
    expect(prop.orders.every((o) => o.mechanism === 'user_signed')).toBe(true);
  });
  it('respects the minimum interval and does nothing without a likely breach', () => {
    const recent = proposeRebalance({
      policy,
      targets,
      positions,
      dexAssets: new Set(),
      liquidity: assessment,
      now: new Date('2026-10-01T01:00:00Z'),
      lastRebalanceAt: new Date('2026-10-01T00:30:00Z'),
    });
    expect(recent.triggered).toBe(false);
    const calm = proposeRebalance({
      policy,
      targets,
      positions,
      dexAssets: new Set(),
      liquidity: { ...assessment, likelyBreach: false },
    });
    expect(calm.orders.every((o) => !o.reason.startsWith('liquidity_breach'))).toBe(true);
  });
});
