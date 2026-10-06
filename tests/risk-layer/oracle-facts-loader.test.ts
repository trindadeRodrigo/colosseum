import { createDb, type Db, riskAssetSnapshots, riskPriceObservations } from '@colosseum/db';
import { afterAll, describe, expect, it } from 'vitest';
import { listedAsset, loadOracleInput, vaultPriceLimits } from '../../apps/api/src/oracle-facts';

// PLAN-UNIVERSE RU.9, the loader: which rows of risk_price_observations and risk_asset_snapshots reach the oracle
// block. Needs the database (pnpm db:up). The rows are this test's own, dated 2020 so no real row is in their
// window, written inside a transaction that is rolled back: nothing is left behind.
const { db, client } = createDb();
afterAll(() => client.end());

// tracked stocks of the committed asset lists, spelled as the collector writes them
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const NVDA_FEED = '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const NOW = new Date('2020-03-04T18:00:00Z');
const at = (h: number, m = 0) => new Date(Date.UTC(2020, 2, 4, h, m));

const obs = (o: {
  chain: string;
  mint: string;
  priceSource: string;
  ref: string;
  method: string;
  observedAt: Date;
  price: number;
  sourceTs?: Date | null;
}) => ({
  quote: 'usd',
  slot: 1,
  methodVersion: 'fixture-0.1',
  source: 'fixture rows at block 123 of a test',
  fetchedAt: o.observedAt,
  provenance: 'fixture' as const,
  sourceTs: null,
  ...o,
});
const snap = (assetMint: string, fetchedAt: Date, refMidUsd: number) => ({
  assetMint,
  asset: 'FIXTURE',
  fetchedAt,
  refPool: 'fixture-pool',
  refMidUsd,
  pools: 1,
  sell: [],
  buy: [],
  methodVersion: 'fixture-0.1',
  source: 'fixture',
  method: 'fixture',
  provenance: 'fixture' as const,
});

/** Runs `body` on rows that exist only inside a transaction, then rolls it back. */
async function withRows<T>(body: (tx: Db) => Promise<T>): Promise<T> {
  class Undo extends Error {}
  let out: T | undefined;
  try {
    await db.transaction(async (tx) => {
      out = await body(tx as unknown as Db);
      throw new Undo();
    });
  } catch (e) {
    if (!(e instanceof Undo)) throw e;
  }
  return out as T;
}

describe('the asset lists', () => {
  it('find an EVM stock whatever the case of its address, and a Solana one exactly', () => {
    expect(listedAsset(NVDA)?.asset.id).toBe('robinhood:nvda');
    expect(listedAsset(NVDA.toLowerCase())?.asset.id).toBe('robinhood:nvda');
    expect(listedAsset(NVDAX)?.asset.id).toBe('solana:nvdax');
    expect(listedAsset(NVDAX.toLowerCase())).toBeNull();
    expect(listedAsset('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBeNull();
  });

  it("give each chain its own vault's limits", () => {
    expect(vaultPriceLimits('solana')).toMatchObject({ maxAgeSeconds: 120, maxDistanceBps: 200 });
    expect(vaultPriceLimits('robinhood')).toMatchObject({ maxAgeSeconds: 93_600 });
    expect(vaultPriceLimits('solana').session.closedDays.has('2026-11-26')).toBe(true);
  });
});

describe('loadOracleInput', () => {
  it('is undefined for an address on no list: the sheet gets no oracle block', async () => {
    expect(await loadOracleInput(db, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', NOW)).toBe(
      undefined,
    );
    expect(await loadOracleInput(db, null, NOW)).toBe(undefined);
  });

  it('a tracked stock with no feed: no oracle, no rows read, the list reason kept', async () => {
    const amc = await loadOracleInput(db, '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b', NOW);
    expect(amc).toMatchObject({ feed: null, feedReason: 'no_feed', readings: null, mids: null });
  });

  it('a tracked stock with no reading in the window: the feed, and null rows', async () => {
    const inp = await loadOracleInput(db, NVDA, NOW);
    expect(inp?.feed).toMatchObject({ kind: 'chainlink', ref: NVDA_FEED });
    expect(inp?.readings).toBeNull();
    expect(inp?.mids).toBeNull();
  });

  it('Chainlink: the readings of the feed the list names, on its chain, inside the window', async () => {
    const inp = await withRows(async (tx) => {
      const row = (observedAt: Date, price: number, over = {}) =>
        obs({
          chain: 'robinhood',
          mint: NVDA,
          priceSource: 'chainlink',
          ref: NVDA_FEED,
          method: 'chainlink_latest_round_at_the_run_block',
          observedAt,
          price,
          sourceTs: at(10),
          ...over,
        });
      await tx.insert(riskPriceObservations).values([
        row(at(15), 101),
        row(at(16), 102),
        row(at(17), 103),
        // another feed's proxy, another chain's row, a row after `now` and one before the window
        row(at(15, 1), 900, { ref: `0x${'ab'.repeat(20)}` }),
        row(at(15, 2), 901, { chain: 'solana' }),
        row(at(19), 902),
        row(new Date('2020-01-01T00:00:00Z'), 903),
      ]);
      await tx
        .insert(riskAssetSnapshots)
        .values([snap(NVDA, at(15), 100.5), snap(NVDA, at(16), 101.5)]);
      return loadOracleInput(tx, NVDA, NOW);
    });
    expect(inp?.readings?.rows).toEqual([
      { at: at(15).toISOString(), price: 101, sourceTs: at(10).toISOString() },
      { at: at(16).toISOString(), price: 102, sourceTs: at(10).toISOString() },
      { at: at(17).toISOString(), price: 103, sourceTs: at(10).toISOString() },
    ]);
    expect(inp?.readings).toMatchObject({ methodVersion: 'fixture-0.1', provenance: 'fixture' });
    // the block of one run is not the source of every reading
    expect(inp?.readings?.source).toContain("at each run's block");
    expect(inp?.mids?.rows.map((m) => m.midUsd)).toEqual([100.5, 101.5]);
    expect(inp?.mids?.source).toBe('risk_asset_snapshots.ref_mid_usd');
    expect(inp?.limits.maxAgeSeconds).toBe(93_600);
  });

  it('Scope: the collector’s own reads of one reserve, the one with the most rows; klend’s logs left out', async () => {
    const inp = await withRows(async (tx) => {
      const row = (ref: string, observedAt: Date, price: number, method = 'scope_feed_read') =>
        obs({
          chain: 'solana',
          mint: NVDAX,
          priceSource: 'kamino_scope',
          ref,
          method,
          observedAt,
          price,
          sourceTs: method === 'scope_feed_read' ? new Date(observedAt.getTime() - 30_000) : null,
        });
      await tx
        .insert(riskPriceObservations)
        .values([
          row('reserveB', at(15), 201),
          row('reserveB', at(16), 202),
          row('reserveA', at(15), 201),
          row('reserveA', at(16), 202),
          row('reserveA', at(17), 203),
          row('reserveA', at(15, 30), 777, 'klend_refresh_log'),
        ]);
      await tx.insert(riskAssetSnapshots).values([snap(NVDAX, at(15, 1), 200)]);
      return loadOracleInput(tx, NVDAX, NOW);
    });
    expect(inp?.feed).toMatchObject({ kind: 'scope', ref: '332', averageRef: '269' });
    expect(inp?.readings?.rows.map((r) => r.price)).toEqual([201, 202, 203]);
    expect(inp?.readings?.rows[0]?.sourceTs).toBe(
      new Date(at(15).getTime() - 30_000).toISOString(),
    );
    expect(inp?.readings?.source).toContain('reserveA');
    expect(inp?.readings?.source).toContain('one of 2 reserves');
    expect(inp?.limits).toMatchObject({ maxAgeSeconds: 120, maxDistancePlaceholder: true });
  });

  it('left nothing behind', async () => {
    expect(await loadOracleInput(db, NVDA, NOW)).toMatchObject({ readings: null, mids: null });
  });
});
