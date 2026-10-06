import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { assets as assetsTable, createDb, yieldObservations } from '@colosseum/db';
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

beforeAll(async () => {
  await storeReading('jlUSDC', 'solana', 'live');
  await storeReading('syrupUSDC', 'solana', 'live');
  // Neither of these is a Solana model's live reading: another family's, and a mock figure.
  await storeReading('syrupUSDC', 'evm', 'live');
  await storeReading('jlUSDC', 'solana', 'mock');
});
afterAll(async () => {
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
