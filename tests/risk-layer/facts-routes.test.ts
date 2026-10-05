import { assets, createDb, riskLendingCoverage, riskLendingFacts } from '@colosseum/db';
import { buildLendingPoolFacts, type LendingPoolFactsInput } from '@colosseum/risk';
import { LendingPoolFacts, PlanFacts } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPlanFacts } from '../../apps/api/src/facts';
import { ASSESS_MAX_LEGS } from '../../apps/api/src/routes/risk';
import { buildRiskApp } from '../../apps/risk-api/src/app';
import {
  type LendingReportFile,
  lendingCoverageRows,
  lendingFactsRows,
} from '../../scripts/risk/facts/lib-lending-import';

// PLAN-ANALYTICS item 11: each route over HTTP equals the pure builder on the same rows, and a null fact reaches
// the response with its reason. Rows are seeded through the import's own mapping (lib-lending-import.ts) with
// provenance 'fixture' and a report time a century ahead, so they are the latest while the test runs; removed after.
const ACCOUNT = 'FIXTURElendingFactsAccount1111111111111111';
const REPORT_AT = '2126-10-02T00:00:00.000Z';
const meta = {
  source: 'fixture rows',
  method: 'fixture',
  methodVersion: 'fixture',
  provenance: 'fixture' as const,
  fetchedAt: '2026-10-02T18:00:00.000Z',
};
const input: LendingPoolFactsInput = {
  account: ACCOUNT,
  chain: 'solana',
  venue: 'kamino',
  market: 'Fixture Market',
  symbol: 'USDC',
  verification: 'onchain',
  provenance: 'fixture',
  withdrawal: {
    suppliedUsd: { value: 1_000_000, ...meta },
    availableUsd: { value: 100_000, ...meta },
    shareLentOut: { value: 0.9, ...meta },
    hoursAboveAlarmShare: { reason: 'insufficient_samples' },
  },
  rates: {
    supplyApy: { value: 0.05, ...meta },
    supplyApyVariation: { reason: 'insufficient_samples' },
    borrowApy: { value: 0.06, ...meta },
  },
  lenders: {
    top1Share: { value: 0.5, ...meta, lowerBound: true },
    top3Share: { reason: 'not_collected', detail: 'no supplier attributed' },
    top10Share: { reason: 'not_collected' },
  },
  collateral: [],
  history: {
    liquidations: { value: 3, ...meta },
    liquidatedUsd: { value: 1_234, ...meta },
    socialisedLossUsd: { reason: 'not_collected' },
    parameterChanges30d: { value: 0, ...meta },
  },
  dataFrom: null,
  dataTo: null,
};
const sheet = buildLendingPoolFacts(input);
const report: LendingReportFile = {
  method: 'fixture',
  source: 'fixture report',
  fetched_at: REPORT_AT,
  provenance: 'fixture',
  windows: { positionsHour: '2026-10-02/18' },
  lendingPoolFacts: { sheets: [sheet] },
  coverageBoth: {
    rows: [
      {
        gapPct: 20,
        asset: 'FIXTUREX',
        seizedUsd: 1_000,
        earlier: { capacityUsd: 3_000, regime: 'weekend', ratio: 3 },
        margin: {
          capacityUsd: 2_900,
          regime: 'us_market_hours',
          derived: false,
          lowerBound: false,
          tau: 0.0476,
          limitingOracle: 'kamino FIXTUREX @Fixture Market',
          ratio: 2.9,
          regimesMissing: ['weekend:no_samples_in_regime'],
        },
      },
      {
        gapPct: 30,
        asset: 'FIXTUREX',
        seizedUsd: 2_000,
        earlier: { capacityUsd: 3_000, regime: 'weekend', ratio: 1.5 },
        margin: {
          capacityUsd: null,
          regime: null,
          derived: null,
          lowerBound: null,
          tau: null,
          limitingOracle: null,
          ratio: null,
          reason: 'no_samples_in_regime',
          regimesMissing: ['us_market_hours:no_samples_in_regime'],
        },
      },
    ],
  },
};
const CASH_ID = 'fixturecash';
const { db, client } = createDb();

beforeAll(async () => {
  const facts = lendingFactsRows(report);
  expect(facts.rejected).toEqual([]);
  await db.insert(riskLendingFacts).values(facts.rows).onConflictDoNothing();
  await db.insert(riskLendingCoverage).values(lendingCoverageRows(report)).onConflictDoNothing();
  // a cash leg of the plan: its own registry row, so the test does not depend on the seeded `usdc`
  await db
    .insert(assets)
    .values({
      id: CASH_ID,
      symbol: 'FIXTURECASH',
      name: 'Fixture cash',
      kind: 'cash',
      chain: 'solana',
      eligibleProfiles: [],
      capWeight: '1',
      mintPath: 'dex_swap',
      metadata: {},
      provenance: 'fixture',
    })
    .onConflictDoNothing();
});
afterAll(async () => {
  await db.delete(riskLendingFacts).where(eq(riskLendingFacts.account, ACCOUNT));
  await db.delete(riskLendingCoverage).where(eq(riskLendingCoverage.asset, 'FIXTUREX'));
  await db.delete(assets).where(eq(assets.id, CASH_ID));
  await client.end();
});

describe('lending, plan and coverage routes', () => {
  it('GET /risk/facts/lending/:account equals the builder; a null fact keeps its reason', async () => {
    const app = await buildRiskApp();
    const res = await app.inject({ url: `/risk/facts/lending/${ACCOUNT}` });
    expect(res.statusCode).toBe(200);
    const { reportAt, disclaimer, ...body } = res.json();
    expect(reportAt).toBe(REPORT_AT);
    expect(disclaimer).toBeTruthy();
    expect(LendingPoolFacts.parse(body)).toEqual(sheet);
    expect(body.lenders.top3Share).toEqual({
      value: null,
      reason: 'not_collected',
      unit: 'fraction',
      detail: 'no supplier attributed',
    });
    expect(body.lenders.top1Share).toMatchObject({ value: 0.5, quality: 'lower_bound' });
    expect((await app.inject({ url: '/risk/facts/lending/nope' })).statusCode).toBe(404);
    const list = (await app.inject({ url: '/risk/facts/lending' })).json();
    expect(list.reportAt).toBe(REPORT_AT);
    expect(list.pools).toEqual([
      { account: ACCOUNT, venue: 'kamino', market: 'Fixture Market', symbol: 'USDC' },
    ]);
    await app.close();
  });

  it('GET /risk/lending/coverage serves both ratios; a ratio not measured is null with its reason', async () => {
    const app = await buildRiskApp();
    const body = (await app.inject({ url: '/risk/lending/coverage?asset=FIXTUREX' })).json();
    expect(body.reportAt).toBe(REPORT_AT);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toMatchObject({
      gapPct: 20,
      earlierRatio: 3,
      ratio: 2.9,
      regime: 'us_market_hours',
      nullReason: null,
      regimesMissing: ['weekend:no_samples_in_regime'],
    });
    expect(body.rows[1]).toMatchObject({
      gapPct: 30,
      ratio: null,
      nullReason: 'no_samples_in_regime',
    });
    expect(
      (await app.inject({ url: '/risk/lending/coverage?asset=FIXTUREX&gapPct=30' })).json().rows,
    ).toHaveLength(1);
    await app.close();
  });

  it('POST /risk/facts/plan equals the loader on the same rows, and refuses a body above its bounds', async () => {
    const app = await buildRiskApp();
    const positions = [
      { assetId: 'FIXTUREnotAnAsset', valueUsd: 1_000 },
      { assetId: CASH_ID, valueUsd: 3_000 },
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/risk/facts/plan',
      payload: { positions },
    });
    expect(res.statusCode).toBe(200);
    const { disclaimer, ...body } = res.json();
    expect(disclaimer).toBeTruthy();
    // equal to the loader on the same rows; the only difference allowed is the clock time of the two calls
    const unclock = (x: unknown) =>
      JSON.parse(JSON.stringify(x), (k, v) => (k === 'fetchedAt' ? 'clock' : v));
    const direct = await loadPlanFacts(db, positions);
    expect(unclock(PlanFacts.parse(body))).toEqual(unclock(direct));
    expect(body.exit.legs[0].exit).toMatchObject({ value: null, reason: 'not_collected' });
    expect(body.measuredShare).toBe(0.75);
    const tooMany = Array.from({ length: ASSESS_MAX_LEGS + 1 }, () => positions[1]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/risk/facts/plan',
          payload: { positions: tooMany },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
});
