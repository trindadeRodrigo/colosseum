import { readFileSync } from 'node:fs';
import { createDb, riskDepthCurves, riskPools } from '@colosseum/db';
import {
  type AssetCurves,
  assessLiquidity,
  type DepthCurve,
  defaultRegimeParams,
  fitCurve,
  type Regime,
} from '@colosseum/risk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSESS_MAX_WITHDRAWALS } from '../../api/src/routes/risk';
import { buildRiskApp } from './app';

// HANDOFF-RISK §6 P2.2 and P2.3: the standalone API serves only /risk/* and /docs, and
// POST /risk/positions/assess reproduces the Phase 1 fixture result. The fixture asset is seeded with
// provenance 'fixture' and tier X (never listed), and removed afterwards.
const MINT = 'FIXTUREspyxMint11111111111111111111111111111';
const POOL = 'FIXTUREspyxPool11111111111111111111111111111';
const syn = JSON.parse(readFileSync('fixtures/risk/curves-synthetic.json', 'utf8')).spyx as Record<
  Regime,
  Array<[number, number]>
>;
const curve = (pts: Array<[number, number]>): DepthCurve =>
  fitCurve(
    pts.flatMap(([n, c]) => [0, 1, 2].map(() => ({ notionalUsd: n, cost: c }))),
    { quantile: 0.5, minSamples: 3 },
  );
const curves: AssetCurves = {
  assetId: 'FIXTURESPYX',
  byRegime: Object.fromEntries(Object.entries(syn).map(([r, pts]) => [r, curve(pts)])),
};
const { db, client } = createDb();

beforeAll(async () => {
  const now = new Date();
  await db
    .insert(riskPools)
    .values({
      address: POOL,
      program: 'fixture',
      venue: 'fixture',
      assetMint: MINT,
      assetSymbol: 'FIXTURESPYX',
      quoteMint: 'fixture',
      exitPath: 'direct_usd',
      assetIsToken0: 1,
      decimals0: 8,
      decimals1: 6,
      tier: 'X',
      status: 'fixture',
      methodVersion: 'fixture',
      source: 'fixtures/risk/curves-synthetic.json',
      method: 'fixture',
      fetchedAt: now,
      provenance: 'fixture',
    })
    .onConflictDoNothing();
  for (const [regime, c] of Object.entries(curves.byRegime) as Array<[Regime, DepthCurve]>)
    await db
      .insert(riskDepthCurves)
      .values({
        assetMint: MINT,
        assetSymbol: 'FIXTURESPYX',
        side: 'sell',
        regime,
        points: c.points,
        insufficientFrom: c.insufficientFrom,
        quantile: c.quantile,
        minSamples: c.minSamples,
        samples: c.samples,
        computedAt: now,
        methodVersion: 'risk-0.3',
        source: 'fixtures/risk/curves-synthetic.json',
        method: 'fixture',
        provenance: 'fixture',
      })
      .onConflictDoNothing();
});
afterAll(async () => {
  await db.delete(riskDepthCurves).where(eq(riskDepthCurves.assetMint, MINT));
  await db.delete(riskPools).where(eq(riskPools.address, POOL));
  await client.end();
});

describe('standalone risk API', () => {
  it('serves only /risk/* routes and the docs', async () => {
    const app = await buildRiskApp();
    await app.ready();
    const paths = Object.keys((app.swagger() as { paths: Record<string, unknown> }).paths);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.startsWith('/risk/'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/plans' })).statusCode).toBe(404);
    await app.close();
  });

  it('POST /risk/positions/assess reproduces the Phase 1 fixture result', async () => {
    const app = await buildRiskApp();
    const body = {
      cashUsd: 10_000,
      illiquid: [{ asset: 'FIXTURESPYX', valueUsd: 200_000 }],
      withdrawals: [{ at: '2026-10-10T12:00:00Z', usd: 30_000 }],
      windowDays: 7,
    };
    const res = await app.inject({ method: 'POST', url: '/risk/positions/assess', payload: body });
    expect(res.statusCode).toBe(200);
    const http = res.json();
    const direct = assessLiquidity({
      cashUsd: 10_000,
      brlUsd: 0,
      liquid: [],
      illiquid: [{ assetId: 'FIXTURESPYX', valueUsd: 200_000, curves }],
      withdrawals: body.withdrawals,
      windowDays: 7,
      tau: 0.01,
      shareOfDepth: 0.25,
      dryFactorFloor: 0.25,
      regimeParams: defaultRegimeParams(
        JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
      ),
    });
    expect(http.breach).toBe(false);
    expect(http.likelyBreach).toBe(true);
    expect(http.orders).toEqual(direct.orders);
    expect(http.checks).toEqual(direct.checks);
    expect(http.disclaimer).toContain('not licensed');
    await app.close();
  });

  it('POST /risk/positions/assess refuses a body above its bounds and answers the largest one quickly', async () => {
    const app = await buildRiskApp();
    const withdrawals = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        at: new Date(Date.UTC(2026, 10 + i, 15, 12, i % 60)).toISOString(),
        usd: 1_000,
      }));
    const body = (n: number) => ({
      cashUsd: 10_000,
      illiquid: [{ asset: 'FIXTURESPYX', valueUsd: 200_000 }],
      withdrawals: withdrawals(n),
      windowDays: 365,
    });
    const over = await app.inject({
      method: 'POST',
      url: '/risk/positions/assess',
      payload: body(ASSESS_MAX_WITHDRAWALS + 1),
    });
    expect(over.statusCode).toBe(400);
    const t = performance.now();
    const max = await app.inject({
      method: 'POST',
      url: '/risk/positions/assess',
      payload: body(ASSESS_MAX_WITHDRAWALS),
    });
    expect(max.statusCode).toBe(200);
    expect(performance.now() - t).toBeLessThan(2_000);
    await app.close();
  });
});
