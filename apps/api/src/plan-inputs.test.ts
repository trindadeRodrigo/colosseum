import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import {
  assets as assetsTable,
  createDb,
  riskDepthCurves,
  riskPools,
  yieldObservations,
} from '@colosseum/db';
import { YieldObservation } from '@colosseum/schemas';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEPLOYMENTS_DIR } from './deployments';
import { bearingPlanInputs } from './plan-inputs';
import readings from './testing/fixtures/model-readings.json';

// The server's plan inputs on the devnet shelf, against the database: the readings of jlUSDC and
// syrupUSDC are found by symbol, as the readings are kept, on Solana only, and handed to the two
// stand-ins labelled sandbox.

const record = SolanaDeploymentRecord.parse(
  JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, 'solana-devnet.json'), 'utf8')),
);
const shelf = deploymentAssets(record);
const MODEL = z.array(z.object({ symbol: z.string(), reading: YieldObservation })).parse(readings);

const { db, client } = createDb();
const tag = randomUUID().slice(0, 8);
const ids: string[] = [];
// A time no other row has, so this test's readings are the newest and are told apart.
const fetchedAt = new Date('2031-01-01T00:00:00.000Z');

async function storeReading(symbol: string, chain: 'solana' | 'evm', provenance: 'live' | 'mock') {
  const id = `test-${tag}-${symbol.toLowerCase()}-${chain}-${provenance}`;
  ids.push(id);
  await db.insert(assetsTable).values({
    id,
    symbol,
    name: `${symbol} (test row)`,
    kind: 'usd_yield',
    chain,
    mint: `${tag}${symbol}${chain}${provenance}`,
    eligibleProfiles: [],
    capWeight: '0.5',
    mintPath: 'lending_deposit',
    metadata: {},
    provenance: 'live',
  });
  const model = MODEL.find((m) => m.symbol === symbol)?.reading;
  if (!model) throw new Error(`no fixture for ${symbol}`);
  await db.insert(yieldObservations).values({
    assetId: id,
    quotedYield: String(model.quotedYield),
    haircutYield: String(model.haircutYield),
    haircutRule: model.haircutRule,
    source: `${model.source} (${chain}, ${provenance})`,
    method: model.method,
    fetchedAt,
    provenance,
  });
}

// SPYx's measured depth, under a mainnet mint of this test's own that outweighs any other SPYx row.
const twinMint = `${tag}SPYxMainnetTwin`;
const twinPool = `${tag}SPYxPool`;
async function storeTwin() {
  const at = new Date('2026-10-06T00:00:00.000Z');
  const prov = { source: 'test row', method: 'test', fetchedAt: at, provenance: 'live' as const };
  await db.insert(riskPools).values({
    address: twinPool,
    program: 'test',
    venue: 'raydium_clmm',
    assetMint: twinMint,
    assetSymbol: 'SPYx',
    quoteMint: 'test',
    exitPath: 'direct_usd',
    assetIsToken0: 1,
    decimals0: 8,
    decimals1: 6,
    tvlUsd: 1e15,
    tier: 'A',
    status: 'confirmed',
    methodVersion: 'test',
    ...prov,
  });
  const points = [100, 10_000, 1_000_000].map((n) => ({
    notionalUsd: n,
    cost: n / 100_000_000,
    samples: 50,
  }));
  for (const regime of ['us_market_hours', 'us_offhours_weekday', 'weekend']) {
    await db.insert(riskDepthCurves).values({
      assetMint: twinMint,
      assetSymbol: 'SPYx',
      side: 'sell',
      regime,
      points,
      quantile: 0.5,
      minSamples: 8,
      samples: 50,
      dataFrom: at,
      dataTo: at,
      computedAt: at,
      methodVersion: 'risk-0.3',
      ...prov,
    });
  }
}

beforeAll(async () => {
  await storeTwin();
  await storeReading('jlUSDC', 'solana', 'live');
  await storeReading('syrupUSDC', 'solana', 'live');
  // Neither of these is a Solana model's live reading: another family's, and a mock figure.
  await storeReading('syrupUSDC', 'evm', 'live');
  await storeReading('jlUSDC', 'solana', 'mock');
});
afterAll(async () => {
  await db.delete(riskDepthCurves).where(inArray(riskDepthCurves.assetMint, [twinMint]));
  await db.delete(riskPools).where(inArray(riskPools.address, [twinPool]));
  await db.delete(yieldObservations).where(inArray(yieldObservations.assetId, ids));
  await db.delete(assetsTable).where(inArray(assetsTable.id, ids));
  await client.end();
});

describe('the devnet stand-ins, with their models’ readings stored', () => {
  it('take the live Solana readings of the tokens they model, labelled sandbox', async () => {
    const { yields = [] } = await bearingPlanInputs({ db, chain: 'solana', assets: shelf });
    const mine = yields.filter((y) => y.fetchedAt === fetchedAt.toISOString());
    expect(mine.map((y) => y.assetId).sort()).toEqual(['solana:jlusdc', 'solana:syrupusdc']);
    for (const y of mine) {
      expect(y.provenance).toBe('sandbox');
      expect(y.source).toContain('(solana, live)');
      expect(y.source).toContain('applied to');
    }
    // nothing else on the shelf takes a reading it does not model
    expect(new Set(yields.map((y) => y.assetId))).toEqual(
      new Set(['solana:jlusdc', 'solana:syrupusdc']),
    );
    expect(yields.every((y) => y.provenance === 'sandbox')).toBe(true);
  });
});

describe('the devnet stand-ins, with their models’ depth stored', () => {
  it('read the sell depth of the mainnet token they model, labelled sandbox with the twin named', async () => {
    const { liquidity } = await bearingPlanInputs({ db, chain: 'solana', assets: shelf });
    expect(liquidity?.provider.covers('solana:spyx')).toBe(true);
    expect(liquidity?.provider.provenance).toBe('sandbox');
    expect(liquidity?.source).toContain('SPYx for tSPYx');
    // a stand-in whose model has no depth stored reads none
    expect(liquidity?.provider.covers('solana:paxg')).toBe(false);
  });

  it('read nothing for a live shelf: a live token is measured only under its own address', async () => {
    const live = shelf.map((a) => ({ ...a, provenance: 'live' as const }));
    const { liquidity } = await bearingPlanInputs({ db, chain: 'solana', assets: live });
    expect(liquidity?.provider.covers('solana:spyx') ?? false).toBe(false);
  });
});
