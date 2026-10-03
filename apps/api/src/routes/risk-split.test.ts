import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@colosseum/db';
import { defaultRegimeParams } from '@colosseum/risk';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, describe, expect, it } from 'vitest';
import { nearestSize, registerRiskSplitRoute, splitStore } from './risk-split';

// GET /risk/assets/:id/split on rows written in the split snapshot's own format into a temporary folder.
const DIR = mkdtempSync(join(tmpdir(), 'risk-split-'));
const MINT = 'FIXTUREmintSPLIT';
const row = (
  fetchedAt: string,
  notionalUsd: number,
  legs: Array<[string, number, number]>,
  side = 'sell',
) => ({
  assetMint: MINT,
  asset: 'FIXx',
  fetchedAt,
  slot: 1,
  side,
  notionalUsd,
  outUsd: legs.reduce((s, l) => s + l[2], 0),
  costPct: 1.5,
  poolsUsed: legs.length,
  pools: 3,
  refPool: 'FIXTUREref',
  refMidUsd: 100,
  split: { total: 0.015, poolFee: 0.002, transferFee: 0, basis: 0, impact: 0.013 },
  legs: legs.map(([pool, amountIn, outUsd]) => ({
    pool,
    amountIn,
    unfilledShare: 0,
    outUsd,
    midUsd: 100,
    feeRate: 0.001,
  })),
  solUsd: 120,
  source: 'fixture rows',
  method: 'routed_greedy_32_chunks with per-pool split',
  methodVersion: 'split-0.1',
  provenance: 'live',
});
// Sat 2026-09-05 15:00Z is the weekend; Wed 2026-09-02 15:00Z (11:00 ET) is market hours
writeFileSync(
  join(DIR, '2026-09-02.jsonl'),
  [
    row('2026-09-02T15:00:00.000Z', 50_000, [
      ['FIXTUREpoolA', 400, 39_700],
      ['FIXTUREpoolB', 100, 9_900],
    ]),
  ]
    .map((r) => JSON.stringify(r))
    .join('\n'),
);
writeFileSync(
  join(DIR, '2026-09-05.jsonl'),
  `${[
    row('2026-09-05T15:00:00.000Z', 50_000, [
      ['FIXTUREpoolA', 300, 29_800],
      ['FIXTUREpoolB', 200, 19_800],
    ]),
    row('2026-09-05T15:00:00.000Z', 250_000, [['FIXTUREpoolA', 2_500, 245_000]]),
    row('2026-09-05T15:00:00.000Z', 50_000, [['FIXTUREpoolA', 500, 49_000]], 'buy'),
  ]
    .map((r) => JSON.stringify(r))
    .join('\n')}\n{"torn`,
);
const { db, client } = createDb();
afterAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  await client.end();
});
async function app() {
  const a = Fastify();
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);
  await registerRiskSplitRoute(
    a,
    db,
    async (id) => (id === 'FIXx' ? { mint: MINT, symbol: 'FIXx' } : null),
    defaultRegimeParams({ closed: [], earlyClose13ET: [] }),
    splitStore(DIR),
  );
  return a;
}

describe('GET /risk/assets/:id/split', () => {
  it('the nearest grid size on a log scale', () => {
    expect(nearestSize(100_000)).toBe(50_000);
    expect(nearestSize(120_000)).toBe(250_000);
    expect(nearestSize(7)).toBe(100);
    expect(nearestSize(1e9)).toBe(5_000_000);
  });

  it('the newest sell row at the nearest size: legs by share, shares sum to 1, value in at the reference mid, leg cost', async () => {
    const a = await app();
    const b = (await a.inject({ url: '/risk/assets/FIXx/split?sizeUsd=100000' })).json();
    expect(b).toMatchObject({
      askedUsd: 100_000,
      notionalUsd: 50_000,
      fetchedAt: '2026-09-05T15:00:00.000Z',
      regime: 'weekend',
      reason: null,
      costPct: 0.015,
    });
    expect(b.legs.map((l: { pool: string }) => l.pool)).toEqual(['FIXTUREpoolA', 'FIXTUREpoolB']);
    expect(b.legs[0]).toMatchObject({
      amountIn: 300,
      amountInUsd: 30_000,
      outUsd: 29_800,
      share: 0.6,
      venue: null,
    });
    expect(b.legs[0].costPct).toBeCloseTo(200 / 30_000, 12);
    expect(b.legs.reduce((s: number, l: { share: number }) => s + l.share, 0)).toBeCloseTo(1, 12);
    await a.close();
  });

  it('regime keeps the newest row of that time of week; none there is no_samples_in_regime; unknown asset 404', async () => {
    const a = await app();
    const m = (
      await a.inject({ url: '/risk/assets/FIXx/split?sizeUsd=50000&regime=us_market_hours' })
    ).json();
    expect(m).toMatchObject({ regime: 'us_market_hours', fetchedAt: '2026-09-02T15:00:00.000Z' });
    expect(m.legs[0]).toMatchObject({ pool: 'FIXTUREpoolA', share: 0.8 });
    const h = (
      await a.inject({ url: '/risk/assets/FIXx/split?sizeUsd=50000&regime=us_holiday' })
    ).json();
    expect(h).toMatchObject({ legs: [], reason: 'no_samples_in_regime', notionalUsd: null });
    const buy = (await a.inject({ url: '/risk/assets/FIXx/split?side=buy&sizeUsd=50000' })).json();
    expect(buy.legs[0]).toMatchObject({ amountInUsd: 500, costPct: null });
    expect((await a.inject({ url: '/risk/assets/NOPE/split?sizeUsd=1000' })).statusCode).toBe(404);
    await a.close();
  });

  it('no files for the asset: not_collected, never an empty success', async () => {
    const a = Fastify();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await registerRiskSplitRoute(
      a,
      db,
      async () => ({ mint: 'OTHER', symbol: 'OTHx' }),
      defaultRegimeParams({ closed: [], earlyClose13ET: [] }),
      splitStore(DIR),
    );
    expect((await a.inject({ url: '/risk/assets/OTHx/split?sizeUsd=1000' })).json()).toMatchObject({
      legs: [],
      reason: 'not_collected',
    });
    await a.close();
  });
});
