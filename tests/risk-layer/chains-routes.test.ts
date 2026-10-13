import { assets, createDb, riskDepthCurves, riskPoolFlow } from '@colosseum/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { curveKey, EVM_METHOD_VERSION } from '../../apps/api/src/curve-version';
import { loadLiquidityProvider } from '../../apps/api/src/liquidity';
import { buildRiskApp } from '../../apps/risk-api/src/app';

// Bearing per chain (web/bearing-chains): the risk routes answer for Robinhood Chain when asked with
// `chain=robinhood`, and as before when no chain is named. A Robinhood stock is its seeded `assets` row
// (`robinhood:<SYM>`) with the EVM collector's curves; its pools are not in the registry (RU.14, DU6),
// so its pool figures are null with the reason. The plan inputs find its curve whatever the case of the
// address they hold. Needs the database (pnpm db:up); the rows are this test's own and are removed.
const ID = 'robinhood:fixrh';
const SYMBOL = 'FIXRH';
// not a token: an address in mixed case, as the collector writes one
const MINT = '0x00000000000000000000000000000000Fc4A1B2e';
const POOL = '0x00000000000000000000000000000000Fc4A1Bf1';
const REGIMES = ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'] as const;
const GRID = [100, 10_000, 1_000_000];
const AT = new Date('2026-10-06T12:00:00Z');
const prov = {
  source: 'fixture',
  method: 'fixture',
  fetchedAt: AT,
  provenance: 'fixture' as const,
};
const { db, client } = createDb();
const app = await buildRiskApp();

beforeAll(async () => {
  await db.insert(assets).values({
    id: ID,
    symbol: SYMBOL,
    name: 'Fixture stock token on Robinhood Chain',
    kind: 'equity',
    chain: 'evm',
    mint: MINT,
    eligibleProfiles: [],
    capWeight: '0',
    mintPath: 'unavailable',
    metadata: {},
    provenance: 'fixture',
  });
  await db.insert(riskDepthCurves).values(
    REGIMES.flatMap((regime) =>
      (['sell', 'buy'] as const).map((side) => ({
        assetMint: MINT,
        assetSymbol: SYMBOL,
        side,
        regime,
        // selling $1M costs 1%: the capacity at 1% is $1M in every regime
        points: GRID.map((notionalUsd) => ({ notionalUsd, cost: notionalUsd / 1e8, samples: 40 })),
        insufficientFrom: null,
        quantile: 0.5,
        minSamples: 8,
        samples: 120,
        dataFrom: AT,
        dataTo: AT,
        computedAt: AT,
        methodVersion: EVM_METHOD_VERSION,
        ...prov,
      })),
    ),
  );
  await db.insert(riskPoolFlow).values({
    pool: POOL,
    assetMint: MINT,
    assetSymbol: SYMBOL,
    regime: 'all',
    window: '24h',
    swaps: 10,
    sellSwaps: 6,
    buySwaps: 4,
    unpricedSwaps: 0,
    sellUsd: 600,
    buyUsd: 400,
    hours: 24,
    dataFrom: new Date('2026-10-05T12:00:00Z'),
    dataTo: AT,
    methodVersion: 'evm-flow-fixture',
    venue: 'uniswap_v3',
    quoteSymbol: 'USDG',
    quoteMint: '0x0000000000000000000000000000000000000001',
    ...prov,
  });
});
afterAll(async () => {
  await db.delete(riskPoolFlow).where(inArray(riskPoolFlow.pool, [POOL]));
  await db.delete(riskDepthCurves).where(inArray(riskDepthCurves.assetMint, [MINT]));
  await db.delete(assets).where(inArray(assets.id, [ID]));
  await app.close();
  await client.end();
});

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
};
type Row = { id?: string; symbol: string; chain: string; poolTvlUsd: number | null } & Record<
  string,
  unknown
>;

describe('GET /risk/assets with a chain', () => {
  it('lists Robinhood Chain’s stocks under their ids, with the EVM curves and no pool TVL', async () => {
    const { status, body } = await get('/risk/assets?chain=robinhood');
    expect(status).toBe(200);
    expect(body.chain).toBe('robinhood');
    expect(body.methodVersion).toBe('evmq-0.1');
    // listed by symbol
    const symbols = (body.assets as Row[]).map((a) => a.symbol);
    expect(symbols).toEqual([...symbols].sort());
    const row = (body.assets as Row[]).find((a) => a.id === ID);
    expect(row?.symbol).toBe(SYMBOL);
    expect(row?.assetMint).toBe(MINT);
    expect(row?.chain).toBe('robinhood');
    expect(row?.poolTvlUsd).toBeNull();
    expect(row?.poolsNullReason).toContain('not collected on Robinhood Chain');
    const cap = (row?.capacityAtTau as Record<string, { capacityUsd: number }> | undefined)
      ?.us_market_hours;
    expect(cap?.capacityUsd).toBeCloseTo(1_000_000, -3);
  });

  it('answers as before with no chain named: Solana, and no Robinhood row', async () => {
    const { body } = await get('/risk/assets');
    expect(body.chain).toBe('solana');
    expect(body.methodVersion).toBe('risk-0.3');
    expect((body.assets as Row[]).some((a) => a.symbol === SYMBOL)).toBe(false);
    for (const a of body.assets as Row[]) expect(a.chain).toBe('solana');
  });
});

describe('a Robinhood Chain stock’s own routes', () => {
  it('resolve it by id and by address in any case', async () => {
    for (const key of [ID, MINT, MINT.toLowerCase()]) {
      const { status, body } = await get(`/risk/assets/${encodeURIComponent(key)}/history?days=30`);
      expect(status, key).toBe(200);
      expect(body.asset).toBe(SYMBOL);
    }
  });

  it('read its own curves for the recoverable value, with no xStocks issuer route', async () => {
    const { status, body } = await get(
      `/risk/recoverable?asset=${encodeURIComponent(ID)}&notional=10000&hours=168&holderKyc=false`,
    );
    expect(status).toBe(200);
    expect(body.methodVersion).toBe('evmq-0.1');
  });
});

describe('a chain Bearing does not measure', () => {
  it('is refused with 400 on every route that takes a chain', async () => {
    for (const url of [
      '/risk/assets?chain=base',
      '/risk/pools?chain=base',
      '/risk/assets?chain=nope',
    ])
      expect((await get(url)).status, url).toBe(400);
  });
});

describe('GET /risk/pools with a chain', () => {
  it('is empty on Robinhood Chain and says why', async () => {
    const { body } = await get('/risk/pools?chain=robinhood');
    expect(body.pools).toEqual([]);
    expect(body.nullReason).toContain('not collected on Robinhood Chain');
  });
});

describe('GET /risk/chains', () => {
  it('puts the chains side by side, every figure sourced or null with its reason', async () => {
    const { status, body } = await get('/risk/chains');
    expect(status).toBe(200);
    const rows = body.chains as Array<Record<string, Record<string, unknown> & { value: unknown }>>;
    expect(rows.map((r) => r.chain)).toEqual(['solana', 'robinhood']);
    const rh = rows[1] as (typeof rows)[number];
    expect(rh.assetsTracked?.value).toBeGreaterThanOrEqual(1);
    expect(rh.poolTvlUsd?.value).toBeNull();
    expect(rh.poolTvlUsd?.nullReason).toContain('not collected on Robinhood Chain');
    expect(rh.exitCapacityUsd?.value).toBeGreaterThanOrEqual(1_000_000 * 0.99);
    expect(rh.exitCapacityUsd?.methodVersion).toBe('evmq-0.1');
    expect(rh.volume24hUsd?.value).toBeGreaterThanOrEqual(1_000);
    expect(rh.volume24hUsd?.source).toContain('risk_pool_flow');
    for (const r of rows)
      for (const k of ['assetsTracked', 'poolTvlUsd', 'exitCapacityUsd', 'volume24hUsd']) {
        const f = r[k] as Record<string, unknown>;
        if (f.value === null) expect(f.nullReason, `${r.chain} ${k}`).toBeTruthy();
        else expect(f.source, `${r.chain} ${k}`).toBeTruthy();
      }
  });
});

describe('the plan inputs’ lookup of an EVM curve', () => {
  it('finds the collector’s mixed-case curve from the shelf’s lower-case address', async () => {
    expect(curveKey(MINT)).toBe(MINT.toLowerCase());
    expect(curveKey('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W')).toBe(
      'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
    );
    const provider = await loadLiquidityProvider(db, [
      { id: 'shelf:fixrh', mint: MINT.toLowerCase() },
    ]);
    expect(provider?.covers('shelf:fixrh')).toBe(true);
  });
});
