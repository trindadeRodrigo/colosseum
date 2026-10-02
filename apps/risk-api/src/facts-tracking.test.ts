import {
  createDb,
  riskDepthCurves,
  riskLendingPositions,
  riskPools,
  riskReferencePrices,
} from '@colosseum/db';
import { fitCurve, quantileOf } from '@colosseum/risk';
import { AssetFacts, collectFacts } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRiskApp } from './app';

// PLAN-ANALYTICS A-C (Step 11's reference prices): the asset sheet's tracking facts come from
// risk_reference_prices. In the hours whose answer is the pool mid, each live, fresh oracle's gap to it gives
// (mid − oracle) ÷ oracle; the fact is their median by regime. Hours answered by an oracle, and stale or dead
// oracle readings, are left out. A fixture asset is seeded with provenance 'fixture' and removed afterwards.
const MINT = 'FIXTUREtrackMint11111111111111111111111111111';
const POOL = 'FIXTUREtrackPool11111111111111111111111111111';
const SYMBOL = 'FIXTURETRACK';
const MARKET = 'FIXTUREtrackMarket';
const { db, client } = createDb();
const hour = (h: number) => new Date(Date.now() - h * 3_600_000);
// gapToAnswer = oracle ÷ answer − 1, as Step 11 stores it
const kaminoGaps = [0.001, -0.002, 0.0005];
const meta = { source: 'fixture', method: 'fixture', provenance: 'fixture' as const };

beforeAll(async () => {
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
      fetchedAt: now,
      ...meta,
    })
    .onConflictDoNothing();
  const c = fitCurve(
    [100, 10_000, 100_000].flatMap((n, i) =>
      Array.from({ length: 3 }, () => ({ notionalUsd: n, cost: 0.001 * (i + 1) })),
    ),
    { quantile: 0.5, minSamples: 3 },
  );
  await db
    .insert(riskDepthCurves)
    .values({
      assetMint: MINT,
      assetSymbol: SYMBOL,
      side: 'sell',
      regime: 'us_market_hours',
      points: c.points,
      insufficientFrom: c.insufficientFrom,
      quantile: c.quantile,
      minSamples: c.minSamples,
      samples: c.samples,
      dataFrom: hour(48),
      dataTo: hour(1),
      computedAt: now,
      methodVersion: 'risk-0.3',
      ...meta,
    })
    .onConflictDoNothing();
  await db
    .insert(riskLendingPositions)
    .values({
      market: MARKET,
      collateralAsset: SYMBOL,
      observedAt: hour(1),
      chain: 'solana',
      venue: 'fixture',
      positions: 1,
      positionsWithDebt: 1,
      collateralUnits: 1,
      collateralUsd: 1_000,
      ltvBucketsPct: {},
      buckets: {},
      ltvNull: 0,
      ltvNullUnits: 0,
      methodVersion: 'fixture',
      fetchedAt: now,
      ...meta,
    })
    .onConflictDoNothing();
  const row = (h: number, priceSource: string, others: unknown[]) => ({
    mint: MINT,
    observedAt: hour(h),
    chain: 'solana',
    symbol: SYMBOL,
    priceUsd: 1,
    priceSource,
    quality: 'traded',
    regime: 'us_market_hours',
    others,
    methodVersion: 'fixture',
    fetchedAt: now,
    ...meta,
  });
  await db
    .insert(riskReferencePrices)
    .values([
      ...kaminoGaps.map((g, i) =>
        row(i + 2, 'pool_mid', [
          { priceSource: 'kamino_scope', gapToAnswer: g, live: true, stale: false },
          // a stale reading never counts
          { priceSource: 'jupiter_lend_oracle', gapToAnswer: 0.5, live: true, stale: true },
        ]),
      ),
      // an hour answered by an oracle is not a pool-mid comparison
      row(10, 'kamino_scope', [{ priceSource: 'kamino_scope', gapToAnswer: 0.3, live: true }]),
    ])
    .onConflictDoNothing();
});
afterAll(async () => {
  await db.delete(riskReferencePrices).where(eq(riskReferencePrices.mint, MINT));
  await db.delete(riskLendingPositions).where(eq(riskLendingPositions.market, MARKET));
  await db.delete(riskDepthCurves).where(eq(riskDepthCurves.assetMint, MINT));
  await db.delete(riskPools).where(eq(riskPools.address, POOL));
  await client.end();
});

describe('AssetFacts tracking from risk_reference_prices', () => {
  it('the pool mid against each oracle: the median over pool-mid hours, stale readings and oracle hours left out', async () => {
    const app = await buildRiskApp();
    const sheet = AssetFacts.parse(
      (await app.inject({ url: `/risk/facts/assets/${SYMBOL}` })).json(),
    );
    expect(collectFacts(sheet).invalid).toEqual([]);
    const kamino = sheet.tracking.find(
      (t) => t.against === 'kamino_scope' && t.regime === 'us_market_hours',
    );
    expect(kamino?.gap).toMatchObject({ quality: 'measured', samples: 3, provenance: 'fixture' });
    expect(kamino?.gap.value).toBeCloseTo(
      quantileOf(
        kaminoGaps.map((g) => 1 / (1 + g) - 1),
        0.5,
      ),
      15,
    );
    const jl = sheet.tracking.find(
      (t) => t.against === 'jupiter_lend_oracle' && t.regime === 'us_market_hours',
    );
    expect(jl?.gap).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
    await app.close();
  });
});
