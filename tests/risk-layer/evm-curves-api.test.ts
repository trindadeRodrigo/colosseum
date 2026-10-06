import { assets, createDb, riskDepthCurves } from '@colosseum/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURVE_METHOD_VERSIONS,
  curveVersionOf,
  EVM_METHOD_VERSION,
  RISK_METHOD_VERSION,
} from '../../apps/api/src/curve-version';
import { loadAssetFacts, loadPlanFacts } from '../../apps/api/src/facts';
import { loadLiquidityProvider } from '../../apps/api/src/liquidity';

// PLAN-UNIVERSE RU.8, the item's check on fixture rows: an EVM stock answers under its own symbol and
// evmq-0.1, from the curve the EVM collector's rows were fitted into. A curve stored for the same address
// under the Solana name (what compute wrote before RU.8, and what a refresh bundle built before it still
// writes) is never served. Needs the database (pnpm db:up); the rows are this test's own and are removed.
const ID = 'fixturechain:ru8';
const SOLANA_ID = 'fixturesol-ru8';
// not a token: an address in mixed case, as the collector writes one
const MINT = '0x00000000000000000000000000000000Ab8F17cE';
const SOLANA_MINT = 'Fixture1111111111111111111111111111111111Ru8';
const GRID = [100, 1_000, 10_000];
const { db, client } = createDb();

const curve = (
  assetMint: string,
  assetSymbol: string,
  methodVersion: string,
  side: 'sell' | 'buy',
  cost: number,
) => ({
  assetMint,
  assetSymbol,
  side,
  regime: 'us_market_hours',
  points: GRID.map((notionalUsd, i) => ({ notionalUsd, cost: cost * (i + 1), samples: 40 })),
  insufficientFrom: null,
  quantile: 0.5,
  minSamples: 8,
  samples: 40 * GRID.length,
  dataFrom: new Date('2026-10-05T14:00:00Z'),
  dataTo: new Date('2026-10-05T19:00:00Z'),
  computedAt: new Date('2026-10-05T20:00:00Z'),
  methodVersion,
  source: `fixture (${methodVersion})`,
  method: 'fitCurve_isotonic_pl_ln_notional',
  provenance: 'fixture' as const,
});
const asset = (id: string, symbol: string, chain: 'solana' | 'evm', mint: string) => ({
  id,
  symbol,
  name: 'Fixture stock',
  kind: 'equity' as const,
  chain,
  mint,
  eligibleProfiles: [],
  capWeight: '0',
  mintPath: 'unavailable' as const,
  metadata: {},
  provenance: 'fixture' as const,
});
type Sheet = Awaited<ReturnType<typeof loadAssetFacts>>;
/** The exit cost of the sheet in market hours, with what it says of itself. */
const exitIn = (sheet: Sheet) =>
  sheet?.costs.find((c) => c.regime === 'us_market_hours')?.exit.total as
    | { value: number | null; methodVersion?: string; source?: string }
    | undefined;
const OWN = 0.001;
const STRAY = 0.05;

beforeAll(async () => {
  expect(MINT).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await db
    .insert(assets)
    .values([asset(ID, 'FIXEVM', 'evm', MINT), asset(SOLANA_ID, 'FIXSOL', 'solana', SOLANA_MINT)])
    .onConflictDoNothing();
  await db
    .insert(riskDepthCurves)
    .values([
      curve(MINT, 'FIXEVM', EVM_METHOD_VERSION, 'sell', OWN),
      curve(MINT, 'FIXEVM', EVM_METHOD_VERSION, 'buy', OWN),
      // the mislabelled rows: the address cut to six letters, under the Solana version
      curve(MINT, MINT.slice(0, 6), RISK_METHOD_VERSION, 'sell', STRAY),
      curve(MINT, MINT.slice(0, 6), RISK_METHOD_VERSION, 'buy', STRAY),
      curve(SOLANA_MINT, 'FIXSOL', RISK_METHOD_VERSION, 'sell', OWN),
      // and the other way round, which nothing writes: never served either
      curve(SOLANA_MINT, 'FIXSOL', EVM_METHOD_VERSION, 'sell', STRAY),
    ])
    .onConflictDoNothing();
});
afterAll(async () => {
  await db.delete(riskDepthCurves).where(inArray(riskDepthCurves.assetMint, [MINT, SOLANA_MINT]));
  await db.delete(assets).where(inArray(assets.id, [ID, SOLANA_ID]));
  await client.end();
});

describe('the version an address is read under', () => {
  it('is the EVM collector’s for an EVM address and risk-0.3 for a Solana one', () => {
    expect(curveVersionOf(MINT)).toBe('evmq-0.1');
    expect(curveVersionOf('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC')).toBe('evmq-0.1');
    expect(curveVersionOf('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W')).toBe('risk-0.3');
    expect(curveVersionOf(SOLANA_MINT)).toBe('risk-0.3');
    expect(CURVE_METHOD_VERSIONS).toEqual(['risk-0.3', 'evmq-0.1']);
  });
});

describe('the fact sheet of an EVM stock (GET /risk/facts/assets/:id)', () => {
  it('answers with its own symbol and evmq-0.1, by id and by address', async () => {
    for (const key of [ID, MINT]) {
      const sheet = await loadAssetFacts(db, key, { sizeUsd: 1_000 });
      expect(sheet?.assetId).toBe(ID);
      expect(sheet?.symbol).toBe('FIXEVM');
      expect(sheet?.chain).toBe('evm');
      expect(sheet?.mint).toBe(MINT);
      expect(sheet?.coverage.regimesMeasured).toEqual(['us_market_hours']);
      const exit = exitIn(sheet);
      expect(exit?.methodVersion).toBe('evmq-0.1');
      expect(exit?.source).toBe('fixture (evmq-0.1)');
      expect(exit?.value).toBeCloseTo(OWN * 2, 12);
    }
  });

  it('carries no fact of another chain or issuer: no xStocks route, no Solana network fee', async () => {
    const sheet = await loadAssetFacts(db, ID, { sizeUsd: 1_000 });
    for (const f of Object.values(sheet?.issuerRoute ?? {})) expect(f.value).toBeNull();
    for (const c of sheet?.costs ?? []) expect(c.exit.networkFeeUsd.value).toBeNull();
    expect(JSON.stringify(sheet)).not.toMatch(/xstocks/i);
  });

  it('a plan holding it is assessed on its evmq-0.1 curve, not on the stray one', async () => {
    const withdrawals = [{ at: '2026-10-07T15:00:00.000Z', usd: 500 }];
    const now = new Date('2026-10-06T15:00:00.000Z');
    const plan = await loadPlanFacts(db, [{ assetId: ID, valueUsd: 1_000 }], { withdrawals, now });
    const text = JSON.stringify(plan);
    expect(text).toContain('risk_depth_curves (evmq-0.1) of 1 legs');
    expect(text).not.toContain('risk_depth_curves (risk-0.3)');
    const sol = await loadPlanFacts(db, [{ assetId: SOLANA_ID, valueUsd: 1_000 }], {
      withdrawals,
      now,
    });
    expect(JSON.stringify(sol)).toContain('risk_depth_curves (risk-0.3) of 1 legs');
  });

  it('does not find it under the lower-case address: the spelling is the collector’s', async () => {
    expect(await loadAssetFacts(db, MINT.toLowerCase())).toBeNull();
  });

  it('a Solana asset is read under risk-0.3 as before', async () => {
    const sheet = await loadAssetFacts(db, SOLANA_ID, { sizeUsd: 1_000 });
    const exit = exitIn(sheet);
    expect(exit?.methodVersion).toBe('risk-0.3');
    expect(exit?.value).toBeCloseTo(OWN * 2, 12);
  });
});

describe('the liquidity provider', () => {
  it('covers the EVM stock from its evmq-0.1 curve and the Solana one from risk-0.3', async () => {
    const p = await loadLiquidityProvider(db, [
      { id: ID, mint: MINT },
      { id: SOLANA_ID, mint: SOLANA_MINT },
    ]);
    expect(p?.covers(ID)).toBe(true);
    expect(p?.exitCostIn(ID, 1_000, 'us_market_hours')?.cost).toBeCloseTo(OWN * 2, 12);
    expect(p?.entryCostIn(ID, 1_000, 'us_market_hours')?.cost).toBeCloseTo(OWN * 2, 12);
    expect(p?.exitCostIn(SOLANA_ID, 1_000, 'us_market_hours')?.cost).toBeCloseTo(OWN * 2, 12);
  });

  it('has nothing for an EVM address that only has a curve under the Solana name', async () => {
    const own = and(
      eq(riskDepthCurves.assetMint, MINT),
      eq(riskDepthCurves.methodVersion, EVM_METHOD_VERSION),
    );
    const kept = await db.select().from(riskDepthCurves).where(own);
    await db.delete(riskDepthCurves).where(own);
    try {
      expect(await loadLiquidityProvider(db, [{ id: ID, mint: MINT }])).toBeUndefined();
      const sheet = await loadAssetFacts(db, ID, { sizeUsd: 1_000 });
      expect(sheet?.coverage.regimesMeasured).toEqual([]);
      expect(exitIn(sheet)?.value ?? null).toBeNull();
    } finally {
      await db.insert(riskDepthCurves).values(kept);
    }
  });
});
