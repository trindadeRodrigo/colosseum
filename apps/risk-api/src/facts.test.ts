import { readFileSync } from 'node:fs';
import { createDb, riskDepthCurves, riskPoolFlow, riskPools } from '@colosseum/db';
import {
  addSwap,
  costAt,
  type DepthCurve,
  FLOW_METHOD_VERSION,
  type FlowBucket,
  type FlowHour,
  fitCurve,
  poolFlow,
  type Regime,
  roundTripCost,
} from '@colosseum/risk';
import { AssetFacts, collectFacts } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRiskApp } from './app';

// PLAN-ANALYTICS items 7 and 11: GET /risk/facts/assets/:id serves the sheet the pure builder makes from the
// stored rows, and a missing fact reaches the response as null with its reason. The fixture asset is seeded
// with provenance 'fixture' and tier X (never listed), and removed afterwards.
const MINT = 'FIXTUREfactsMint1111111111111111111111111111';
const POOL = 'FIXTUREfactsPool1111111111111111111111111111';
const SYMBOL = 'FIXTUREFACTS';
const syn = JSON.parse(readFileSync('fixtures/risk/curves-synthetic.json', 'utf8')).spyx as Record<
  Regime,
  Array<[number, number]>
>;
const curve = (pts: Array<[number, number]>, samples: number): DepthCurve =>
  fitCurve(
    pts.flatMap(([n, c]) => Array.from({ length: samples }, () => ({ notionalUsd: n, cost: c }))),
    { quantile: 0.5, minSamples: 3 },
  );
// market hours measured on both sides; the weekend has one sample per size, below the minimum of three
const sell: Partial<Record<Regime, DepthCurve>> = {
  us_market_hours: curve(syn.us_market_hours, 3),
  weekend: curve(syn.weekend, 1),
};
const buy: Partial<Record<Regime, DepthCurve>> = { us_market_hours: curve(syn.us_market_hours, 3) };
const { db, client } = createDb();

// flow (item 16): ten priced sales of 100 USD in one market-hours row, three purchases on a weekend row
const FLOW_TO = '2026-09-07T10:00:00.000Z';
const flowHours: FlowHour[] = [
  {
    hour: '2026-09-04T15:00:00.000Z',
    regime: 'us_market_hours',
    quoteUsd: 1,
    depth2pctSellUsd: 2_000,
  },
  { hour: '2026-09-05T15:00:00.000Z', regime: 'weekend', quoteUsd: 1, depth2pctSellUsd: 1_000 },
];
const flowBuckets = new Map<string, FlowBucket>();
const hm = new Map(flowHours.map((h) => [h.hour, h]));
for (let i = 0; i < 10; i++)
  addSwap(
    flowBuckets,
    { t: Date.parse(flowHours[0]?.hour as string) / 1000 + i, side: 'sell', quote: 100 },
    hm,
    () => 'us_market_hours',
  );
for (let i = 0; i < 3; i++)
  addSwap(
    flowBuckets,
    { t: Date.parse(flowHours[1]?.hour as string) / 1000 + i, side: 'buy', quote: 50 },
    hm,
    () => 'weekend',
  );
const flowRows = poolFlow(flowBuckets.values(), flowHours, FLOW_TO);

beforeAll(async () => {
  await db
    .insert(riskPoolFlow)
    .values(
      flowRows.map((g) => ({
        pool: POOL,
        assetMint: MINT,
        assetSymbol: SYMBOL,
        regime: g.regime,
        window: g.window,
        swaps: g.swaps,
        sellSwaps: g.sellSwaps,
        buySwaps: g.buySwaps,
        unpricedSwaps: g.unpricedSwaps,
        sellUsd: g.sellUsd,
        buyUsd: g.buyUsd,
        hours: g.hours,
        medianDepthSellUsd: g.medianDepthSellUsd,
        dataFrom: new Date(g.from),
        dataTo: new Date(g.to),
        methodVersion: FLOW_METHOD_VERSION,
        source: 'fixture flow rows',
        method: 'fixture',
        fetchedAt: new Date(),
        provenance: 'fixture' as const,
      })),
    )
    .onConflictDoNothing();
  const now = new Date();
  await db
    .insert(riskPools)
    .values({
      address: POOL,
      program: 'fixture',
      venue: 'fixture',
      assetMint: MINT,
      assetSymbol: SYMBOL,
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
  for (const [side, curves] of [
    ['sell', sell],
    ['buy', buy],
  ] as const)
    for (const [regime, c] of Object.entries(curves) as Array<[Regime, DepthCurve]>)
      await db
        .insert(riskDepthCurves)
        .values({
          assetMint: MINT,
          assetSymbol: SYMBOL,
          side,
          regime,
          points: c.points,
          insufficientFrom: c.insufficientFrom,
          quantile: c.quantile,
          minSamples: c.minSamples,
          samples: c.samples,
          dataFrom: new Date('2026-10-01T00:00:00Z'),
          dataTo: new Date('2026-10-02T00:00:00Z'),
          computedAt: now,
          methodVersion: 'risk-0.3',
          source: 'fixtures/risk/curves-synthetic.json',
          method: 'fixture',
          provenance: 'fixture',
        })
        .onConflictDoNothing();
});
afterAll(async () => {
  await db.delete(riskPoolFlow).where(eq(riskPoolFlow.assetMint, MINT));
  await db.delete(riskDepthCurves).where(eq(riskDepthCurves.assetMint, MINT));
  await db.delete(riskPools).where(eq(riskPools.address, POOL));
  await client.end();
});

describe('GET /risk/facts/assets/:id', () => {
  it('serves the sheet: measured costs equal the stored curves, with their source', async () => {
    const app = await buildRiskApp();
    const size = 20_000;
    const res = await app.inject({ url: `/risk/facts/assets/${SYMBOL}?sizeUsd=${size}` });
    expect(res.statusCode).toBe(200);
    const sheet = AssetFacts.parse(res.json());
    expect(collectFacts(sheet).invalid).toEqual([]);
    expect(sheet).toMatchObject({
      symbol: SYMBOL,
      mint: MINT,
      sizeUsd: size,
      provenance: 'fixture',
    });

    const rth = sheet.costs.find((c) => c.regime === 'us_market_hours');
    const k = costAt(sell.us_market_hours as DepthCurve, size) as number;
    expect(rth?.exit.total).toMatchObject({
      value: k,
      quality: 'measured',
      source: 'fixtures/risk/curves-synthetic.json',
      methodVersion: 'risk-0.3',
      fetchedAt: '2026-10-02T00:00:00.000Z',
      provenance: 'fixture',
    });
    expect(rth?.entry.total.value).toBe(k);
    expect(rth?.roundTrip.value).toBeCloseTo(roundTripCost(k, k), 12);
    expect(res.json().disclaimer).toBeTruthy();
    await app.close();
  });

  it('a regime that is not measured arrives as null with its reason', async () => {
    const app = await buildRiskApp();
    const sheet = AssetFacts.parse(
      (await app.inject({ url: `/risk/facts/assets/${MINT}` })).json(),
    );
    const by = (r: string) => sheet.costs.find((c) => c.regime === r);
    expect(by('weekend')?.exit.total).toMatchObject({
      value: null,
      reason: 'insufficient_samples',
    });
    expect(by('weekend')?.exitCapacityUsd).toMatchObject({ value: null });
    expect(by('us_offhours_weekday')?.exit.total).toMatchObject({
      value: null,
      reason: 'no_samples_in_regime',
    });
    expect(sheet.weekendRatio).toMatchObject({ value: null, reason: 'insufficient_samples' });
    expect(sheet.coverage.regimesMeasured).toEqual(['us_market_hours']);
    expect(sheet.liquidityStability.lpTop1Share).toMatchObject({ value: null });
    expect(sheet.lendingUse.collateralUsd).toMatchObject({ value: null, reason: 'not_applicable' });
    await app.close();
  });

  it('serves the flow block from risk_pool_flow; a bucket too thin arrives as null with its reason', async () => {
    const app = await buildRiskApp();
    const sheet = AssetFacts.parse(
      (await app.inject({ url: `/risk/facts/assets/${SYMBOL}` })).json(),
    );
    expect(collectFacts(sheet).invalid).toEqual([]);
    const flow = sheet.flow;
    const mh = flow?.byRegime.find((r) => r.regime === 'us_market_hours');
    expect(mh?.volumeUsd).toMatchObject({
      value: 1_000,
      quality: 'lower_bound',
      fetchedAt: FLOW_TO,
      source: 'risk_pool_flow (fixture flow rows)',
      methodVersion: FLOW_METHOD_VERSION,
      provenance: 'fixture',
    });
    expect(mh?.netSellPressure.value).toBe(1);
    // 1,000 USD in one hourly row against 2,000 USD of ±2% sell depth
    expect(mh?.turnoverPerHour.value).toBe(0.5);
    const we = flow?.byRegime.find((r) => r.regime === 'weekend');
    expect(we?.swaps.value).toBe(3);
    expect(we?.volumeUsd).toEqual({
      value: null,
      reason: 'insufficient_samples',
      unit: 'usd',
      regime: 'weekend',
      detail: '3 priced swaps (0 unpriced), 8 needed',
    });
    expect(flow?.byPool).toHaveLength(1);
    expect(flow?.byPool[0]).toMatchObject({ pool: POOL, venue: 'fixture', quote: 'fixture' });
    expect(flow?.holders.top10Share).toMatchObject({ value: null, reason: 'not_collected' });
    await app.close();
  });

  it('an unknown asset is a 404, and a bad size is rejected', async () => {
    const app = await buildRiskApp();
    expect((await app.inject({ url: '/risk/facts/assets/NOSUCHASSET' })).statusCode).toBe(404);
    expect((await app.inject({ url: `/risk/facts/assets/${SYMBOL}?sizeUsd=-5` })).statusCode).toBe(
      400,
    );
    await app.close();
  });
});
