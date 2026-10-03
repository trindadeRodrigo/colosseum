import { readFileSync } from 'node:fs';
import {
  createDb,
  riskAssetSnapshots,
  riskLendingSnapshots,
  riskPools,
  riskReferencePrices,
} from '@colosseum/db';
import {
  dailyCloses,
  defaultRegimeParams,
  fitCurve,
  maxNotionalAt,
  type Regime,
  regimeAt,
} from '@colosseum/risk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capacityAtTau,
  type LendingRow,
  lastPerBucket,
  lendingHistoryPoints,
  type PriceRow,
  pricePoints,
} from '../../apps/api/src/history';
import { buildRiskApp } from '../../apps/risk-api/src/app';

// Time series for line charts: /risk/assets/:id/history, /risk/assets/:id/prices,
// /risk/facts/lending/:account/history. Stored rows only; nulls stay null; the last row of each UTC hour or day.
type Pt = { notionalUsd: number; outUsd: number | null };
const snap = JSON.parse(
  readFileSync('fixtures/risk/history/asset-snapshot-tslax.json', 'utf8'),
) as {
  fetchedAt: string;
  refMidUsd: number;
  pools: number;
  sell: Pt[];
  buy: Pt[];
};
const lend = JSON.parse(readFileSync('fixtures/risk/history/lending-rows.json', 'utf8'));
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);

/** The capacity series recipe as apps/api/src/facts.ts wrote it before it was shared (item 15, risk-0.3). */
function factsRecipe(side: Pt[], tau: number) {
  const pts = side.filter((p) => Number.isFinite(p.outUsd));
  if (!pts.length) return null;
  const c = fitCurve(
    pts.map((p) => ({
      notionalUsd: p.notionalUsd,
      cost: 1 - (p.outUsd as number) / p.notionalUsd,
    })),
    { quantile: 0.5, minSamples: 1 },
  );
  return maxNotionalAt(c, tau);
}

describe('history: pure functions', () => {
  it('capacity per snapshot equals the facts.ts computation, sell and buy, on a frozen TSLAx snapshot', () => {
    for (const tau of [0.0025, 0.01, 0.05])
      for (const side of [snap.sell, snap.buy]) {
        const want = factsRecipe(side, tau);
        const got = capacityAtTau(side, tau);
        expect(want).not.toBeNull();
        expect(got.capacityUsd).toBe(want?.notionalUsd);
        expect(got.lowerBound).toBe(want?.lowerBound);
        expect(got.capacityUsd as number).toBeGreaterThan(0);
      }
    // a side with no finite point is null, never 0
    expect(capacityAtTau([{ notionalUsd: 100, outUsd: null }], 0.01)).toEqual({
      capacityUsd: null,
      lowerBound: false,
    });
    expect(capacityAtTau([], 0.01).capacityUsd).toBeNull();
  });

  it('keeps the last row of each UTC hour and of each UTC day, oldest first', () => {
    const at = (s: string) => ({ at: new Date(s) });
    const rows = [
      at('2026-10-01T11:59:00Z'),
      at('2026-10-01T10:05:00Z'),
      at('2026-10-01T10:55:00Z'),
      at('2026-10-01T11:00:00Z'),
      at('2026-10-02T00:00:00Z'),
    ];
    expect(lastPerBucket(rows, (r) => r.at, 'hour').map((r) => r.at.toISOString())).toEqual([
      '2026-10-01T10:55:00.000Z',
      '2026-10-01T11:59:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ]);
    expect(lastPerBucket(rows, (r) => r.at, 'day').map((r) => r.at.toISOString())).toEqual([
      '2026-10-01T11:59:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ]);
  });

  it('prices: hourly keeps nulls with their reason; daily is the last market-hours price of each ET day', () => {
    // Thu 2026-10-01 and Fri 2026-10-02, ET = UTC − 4. Market hours 13:30–20:00Z.
    const row = (
      t: string,
      priceUsd: number | null,
      nullReason: string | null = null,
    ): PriceRow => ({
      observedAt: new Date(t),
      priceUsd,
      regime: regimeAt(new Date(t), P),
      quality: priceUsd === null ? null : 'traded',
      nullReason,
    });
    const rows = [
      row('2026-10-01T15:00:00Z', 100),
      row('2026-10-01T19:00:00Z', 101), // Thu close
      row('2026-10-01T22:00:00Z', 150), // after hours: not a close
      row('2026-10-02T14:00:00Z', 102),
      row('2026-10-02T19:00:00Z', null, 'stale'), // Fri's last market hour has no price
      row('2026-10-03T03:00:00Z', 160), // Fri 23:00 ET: off hours
    ];
    const hourly = pricePoints(rows, 'hour');
    expect(hourly).toHaveLength(6);
    expect(hourly[4]).toMatchObject({ priceUsd: null, nullReason: 'stale' });
    const daily = pricePoints(rows, 'day');
    expect(daily.map((p) => [p.t, p.priceUsd])).toEqual([
      ['2026-10-01T19:00:00.000Z', 101],
      ['2026-10-02T14:00:00.000Z', 102],
    ]);
    expect(daily.every((p) => p.regime === 'us_market_hours' && p.nullReason === null)).toBe(true);
    // the same closes as the market-risk facts use
    expect(daily.map((p) => p.t)).toEqual(
      dailyCloses(
        rows
          .filter((r) => r.priceUsd !== null)
          .map((r) => ({
            at: r.observedAt.toISOString(),
            priceUsd: r.priceUsd as number,
            regime: r.regime as Regime,
            quality: r.quality,
          })),
      ).map((c) => c.at),
    );
  });

  it('lending: last observation of each UTC day; available from stored tokens × price; nulls keep reasons', () => {
    const r = lend.reserve;
    const base = (t: string, over: Partial<LendingRow> = {}): LendingRow => ({
      observedAt: new Date(t),
      kind: 'kamino_reserve_hourly',
      available: r.available,
      priceUsd: r.priceUsd,
      suppliedUsd: r.suppliedUsd,
      borrowedUsd: r.borrowedUsd,
      shareLentOut: r.shareLentOut,
      supplyApy: r.supplyApy,
      borrowApy: r.borrowApy,
      usdNullReason: null,
      ...over,
    });
    const pts = lendingHistoryPoints(
      [
        base('2026-09-01T06:00:00Z', { shareLentOut: 0.1 }),
        base('2026-09-01T18:00:00Z'),
        base('2026-09-02T23:00:00Z', {
          priceUsd: null,
          suppliedUsd: null,
          borrowedUsd: null,
          usdNullReason: 'stale',
        }),
        base('2026-09-03T01:00:00Z', { kind: 'jl_vault', available: null }),
      ],
      'day',
    );
    expect(pts.map((p) => p.t)).toEqual([
      '2026-09-01T18:00:00.000Z',
      '2026-09-02T23:00:00.000Z',
      '2026-09-03T01:00:00.000Z',
    ]);
    expect(pts[0]).toMatchObject({
      shareLentOut: r.shareLentOut,
      availableUsd: r.available * r.priceUsd,
      availableBasis: 'available_x_price',
      usdNullReason: null,
    });
    expect(pts[1]).toMatchObject({
      suppliedUsd: null,
      borrowedUsd: null,
      availableUsd: null,
      availableNullReason: 'stale',
      usdNullReason: 'stale',
      supplyApy: r.supplyApy,
    });
    expect(pts[2]).toMatchObject({
      availableUsd: null,
      availableBasis: null,
      availableNullReason: 'not_applicable_vault',
      usdNullReason: null,
    });
    // where available is not stored on a reserve row, supplied − borrowed in USD, and it says so
    expect(
      lendingHistoryPoints([base('2026-09-04T00:00:00Z', { available: null })], 'day')[0],
    ).toMatchObject({
      availableUsd: r.suppliedUsd - r.borrowedUsd,
      availableBasis: 'supplied_minus_borrowed_usd',
    });
  });
});

// Over HTTP, on rows seeded with provenance 'fixture' at times relative to the clock; removed after.
const MINT = 'FIXTUREhistoryMint1111111111111111111111111';
const SYMBOL = 'FIXTUREHISTx';
const ACCOUNT = 'FIXTUREhistoryLending11111111111111111111111';
const meta = {
  source: 'fixture rows',
  method: 'fixture',
  fetchedAt: new Date(),
  provenance: 'fixture' as const,
};
const HOUR = 3_600_000;
const H = Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR; // a whole UTC hour, three hours ago
const snapTimes = [H + 10 * 60_000, H + 40 * 60_000, H + HOUR + 5 * 60_000].map((t) => new Date(t));
const priceHours = Array.from({ length: 168 }, (_, i) => new Date(H - i * HOUR)); // a week: always one trading day
const lendDays = Array.from({ length: 20 }, (_, i) => {
  const d = Math.floor(Date.now() / 86_400_000) * 86_400_000 - (i + 1) * 86_400_000;
  return [new Date(d + 6 * HOUR), new Date(d + 18 * HOUR)];
}).flat();
const { db, client } = createDb();

async function cleanup() {
  await db.delete(riskAssetSnapshots).where(eq(riskAssetSnapshots.assetMint, MINT));
  await db.delete(riskReferencePrices).where(eq(riskReferencePrices.mint, MINT));
  await db.delete(riskLendingSnapshots).where(eq(riskLendingSnapshots.account, ACCOUNT));
  await db.delete(riskPools).where(eq(riskPools.address, `${MINT}pool`));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(riskPools).values({
    address: `${MINT}pool`,
    program: 'fixture',
    venue: 'fixture',
    assetMint: MINT,
    assetSymbol: SYMBOL,
    quoteMint: 'FIXTUREquote',
    exitPath: 'direct_usd',
    assetIsToken0: 1,
    decimals0: 8,
    decimals1: 6,
    tier: 'X', // excluded tier: never listed by /risk/assets or /risk/pools
    status: 'fixture',
    methodVersion: 'fixture',
    ...meta,
  });
  await db.insert(riskAssetSnapshots).values(
    snapTimes.map((t, i) => ({
      assetMint: MINT,
      asset: SYMBOL,
      fetchedAt: t,
      refPool: `${MINT}pool`,
      refMidUsd: snap.refMidUsd,
      pools: snap.pools,
      sell: snap.sell,
      // the last snapshot's buy side has no finite point
      buy: i === 2 ? snap.buy.map((p) => ({ ...p, outUsd: null })) : snap.buy,
      methodVersion: 'fixture',
      source: 'fixture rows',
      method: 'fixture',
      provenance: 'fixture' as const,
    })),
  );
  await db.insert(riskReferencePrices).values(
    priceHours.map((t, i) => ({
      mint: MINT,
      observedAt: t,
      chain: 'solana',
      symbol: SYMBOL,
      priceUsd: i === 1 ? null : 100 + i,
      quality: i === 1 ? null : 'traded',
      nullReason: i === 1 ? 'stale' : null,
      regime: regimeAt(t, P),
      others: [],
      methodVersion: 'fixture-prices',
      ...meta,
    })),
  );
  const r = lend.reserve;
  await db.insert(riskLendingSnapshots).values(
    lendDays.map((t, i) => ({
      account: ACCOUNT,
      observedAt: t,
      kind: 'kamino_reserve_hourly',
      chain: 'solana',
      venue: 'kamino',
      market: 'Fixture Market',
      symbol: 'USDC',
      supplied: r.supplied,
      borrowed: r.borrowed,
      available: r.available,
      shareLentOut: i, // tells the rows apart
      supplyApy: r.supplyApy,
      borrowApy: r.borrowApy,
      priceUsd: i === 0 ? null : r.priceUsd,
      suppliedUsd: i === 0 ? null : r.suppliedUsd,
      borrowedUsd: i === 0 ? null : r.borrowedUsd,
      usdNullReason: i === 0 ? 'no_observation' : null,
      detail: {},
      methodVersion: 'fixture',
      ...meta,
    })),
  );
});
afterAll(async () => {
  await cleanup();
  await client.end();
});

describe('history routes', () => {
  it('GET /risk/assets/:id/history: last snapshot per UTC hour, capacity as facts.ts, null buy stays null', async () => {
    const app = await buildRiskApp();
    const res = await app.inject({ url: `/risk/assets/${SYMBOL}/history?days=1&tau=0.01` });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({
      asset: SYMBOL,
      assetMint: MINT,
      tau: 0.01,
      days: 1,
      resolution: 'hour',
      provenance: 'fixture',
      methodVersion: 'history-0.1',
    });
    expect(b.disclaimer).toBeTruthy();
    expect(b.points.map((p: { t: string }) => p.t)).toEqual([
      snapTimes[1]?.toISOString(),
      snapTimes[2]?.toISOString(),
    ]);
    expect(b.from).toBe(snapTimes[1]?.toISOString());
    expect(b.to).toBe(snapTimes[2]?.toISOString());
    const want = factsRecipe(snap.sell, 0.01);
    expect(b.points[0]).toMatchObject({
      sellCapacityUsd: want?.notionalUsd,
      sellLowerBound: want?.lowerBound,
      buyCapacityUsd: factsRecipe(snap.buy, 0.01)?.notionalUsd,
      refMidUsd: snap.refMidUsd,
      pools: snap.pools,
      regime: regimeAt(snapTimes[1] as Date, P),
    });
    expect(b.points[1]).toMatchObject({ buyCapacityUsd: null, buyLowerBound: false });
    expect((await app.inject({ url: '/risk/assets/FIXTUREnope/history' })).statusCode).toBe(404);
    await app.close();
  });

  it('GET /risk/assets/:id/prices: hourly with nulls up to 31 days, daily closes beyond', async () => {
    const app = await buildRiskApp();
    const hourly = (await app.inject({ url: `/risk/assets/${MINT}/prices?days=2` })).json();
    expect(hourly).toMatchObject({ resolution: 'hour', methodVersion: 'fixture-prices' });
    const nul = hourly.points.find((p: { t: string }) => p.t === priceHours[1]?.toISOString());
    expect(nul).toMatchObject({ priceUsd: null, nullReason: 'stale' });
    expect(hourly.points.every((p: { t: string }) => p.t >= hourly.from)).toBe(true);
    const daily = (await app.inject({ url: `/risk/assets/${SYMBOL}/prices?days=400` })).json();
    expect(daily.resolution).toBe('day');
    const closes = dailyCloses(
      priceHours
        .map((t, i) => ({
          at: t.toISOString(),
          priceUsd: 100 + i,
          regime: regimeAt(t, P),
          quality: 'traded',
          skip: i === 1,
        }))
        .filter((x) => !x.skip)
        .reverse(),
    );
    expect(closes.length).toBeGreaterThan(0);
    expect(daily.points.map((p: { t: string; priceUsd: number }) => [p.t, p.priceUsd])).toEqual(
      closes.map((c) => [c.at, c.priceUsd]),
    );
    expect((await app.inject({ url: '/risk/assets/FIXTUREnope/prices' })).statusCode).toBe(404);
    expect((await app.inject({ url: `/risk/assets/${SYMBOL}/prices?days=401` })).statusCode).toBe(
      400,
    );
    await app.close();
  });

  it('GET /risk/facts/lending/:account/history: daily last observation beyond 14 days; nulls keep reasons', async () => {
    const app = await buildRiskApp();
    const b = (await app.inject({ url: `/risk/facts/lending/${ACCOUNT}/history?days=30` })).json();
    expect(b).toMatchObject({
      account: ACCOUNT,
      venue: 'kamino',
      market: 'Fixture Market',
      symbol: 'USDC',
      resolution: 'day',
      provenance: 'fixture',
    });
    expect(b.points).toHaveLength(20);
    // each day's 18:00 row (even index in lendDays order is 06:00 of that day, odd is 18:00)
    const lastOfDay = lendDays.filter((_, i) => i % 2 === 1).map((t) => t.toISOString());
    expect(b.points.map((p: { t: string }) => p.t)).toEqual([...lastOfDay].reverse());
    // the newest day's 06:00 row (i = 0) has no USD figures: not the day's last, so not served
    expect(b.points.every((p: { usdNullReason: string | null }) => p.usdNullReason === null)).toBe(
      true,
    );
    const hourly = (
      await app.inject({ url: `/risk/facts/lending/${ACCOUNT}/history?days=14` })
    ).json();
    expect(hourly.resolution).toBe('hour');
    const first = hourly.points.find((p: { t: string }) => p.t === lendDays[0]?.toISOString());
    expect(first).toMatchObject({
      suppliedUsd: null,
      borrowedUsd: null,
      availableUsd: null,
      usdNullReason: 'no_observation',
      supplyApy: lend.reserve.supplyApy,
    });
    expect((await app.inject({ url: '/risk/facts/lending/FIXTUREnope/history' })).statusCode).toBe(
      404,
    );
    await app.close();
  });
});
