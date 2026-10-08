import type { Db } from '@colosseum/db';
import { type AssetFactsInput, buildAssetFacts, type DepthCurve } from '@colosseum/risk';
import type { AssetFacts, BasketAsset } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import { createAgentAnalytics, projectSheet } from './agent-analytics';

// The conversation's analytics without a database: the sheet and the twins are handed in. The sheet is
// the real builder's, from rows written here.
const db = {} as Db;
const assets = launchShelf().assets.filter((asset) => asset.chain === 'solana');
const cash = assets.find((asset) => asset.cls === 'cash') as BasketAsset;
const stocks = assets.filter((asset) => asset.cls === 'stock');
const stock = stocks[0] as BasketAsset;
const listed = assets.filter((asset) => asset.cls !== 'cash');

const GRID = [100, 1_000, 10_000, 100_000];
const curve = (costs: number[]): DepthCurve => ({
  points: GRID.map((n, i) => ({ notionalUsd: n, cost: costs[i] as number, samples: 40 })),
  insufficientFrom: null,
  quantile: 0.5,
  minSamples: 8,
  from: '2026-10-06T00:00:00.000Z',
  to: '2026-10-08T00:00:00.000Z',
  samples: 160,
});
const meta = {
  source: 'risk_depth_curves',
  method: 'fitCurve_isotonic_pl_ln_notional',
  methodVersion: 'risk-0.3',
  provenance: 'live' as const,
};
// Weekdays measured, no weekend yet, no reference prices: the hosted data as it is on Oct 8.
const measured = (sizeUsd = 10_000): AssetFacts =>
  buildAssetFacts({
    assetId: 'spyx',
    symbol: 'SPYx',
    chain: 'solana',
    mint: 'SPYXmainnetMint',
    sizeUsd,
    tau: 0.01,
    asOf: '2026-10-08T12:00:00.000Z',
    sell: {
      assetId: 'spyx',
      byRegime: {
        us_market_hours: curve([0.001, 0.002, 0.004, 0.02]),
        us_offhours_weekday: curve([0.001, 0.003, 0.008, 0.05]),
      },
    },
    buy: null,
    curveMeta: meta,
    platformFeeBps: 0,
    lp: {
      ...meta,
      source: 'risk_lp_concentration',
      fetchedAt: '2026-10-08T11:00:00.000Z',
      top1: 0.4,
      top3: 0.63,
      top10: 0.9,
      lpExitN: 3,
      sellWithoutTopN: [{ notionalUsd: 10_000, costPct: 1.5 }],
    },
    lpWithdrawals: null,
    capacitySeries: null,
    lendingCollateral: null,
    tracking: [],
    issuer: null,
    gapGridPct: [5, 20],
  } satisfies AssetFactsInput);

describe('projectSheet', () => {
  const figures = projectSheet(measured());
  const of = (metric: string, regime?: string) =>
    figures.find((f) => f.metric === metric && (regime === undefined || f.regime === regime));

  it('keeps the measured figures with their pins', () => {
    expect(of('exit_worst')).toEqual({
      metric: 'exit_worst',
      regime: 'us_offhours_weekday',
      value: 0.008,
      unit: 'fraction',
      source: 'risk_depth_curves',
      method: 'fitCurve_isotonic_pl_ln_notional (risk-0.3)',
      fetchedAt: '2026-10-08T00:00:00.000Z',
      provenance: 'live',
    });
    expect(of('exit', 'us_market_hours')?.value).toBe(0.004);
    expect(of('cap1pct')).toMatchObject({ regime: 'us_offhours_weekday', unit: 'usd' });
    expect(of('cap1pct')?.value).toBeGreaterThan(10_000);
    expect(of('lp_top1')).toMatchObject({ value: 0.4, source: 'risk_lp_concentration' });
    expect(of('lp_exit')).toMatchObject({ value: 0.015, unit: 'fraction' });
  });

  it('keeps every missing figure as null with its reason, never zero', () => {
    expect(of('exit', 'weekend')).toEqual({
      metric: 'exit',
      regime: 'weekend',
      value: null,
      reason: 'no_samples_in_regime',
    });
    expect(of('weekend')).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
    expect(of('volatility')).toMatchObject({ value: null });
    expect(of('drawdown')).toMatchObject({ value: null });
    expect(of('volume_28d')).toEqual({
      metric: 'volume_28d',
      value: null,
      reason: 'not_collected',
    });
    for (const figure of figures)
      if (figure.value === null) expect(figure.reason).toBeTruthy();
      else expect(Number.isFinite(figure.value)).toBe(true);
    // The worst, each other regime, then the eight others.
    expect(figures.filter((f) => f.metric === 'exit').map((f) => f.regime)).toEqual([
      'us_market_hours',
      'weekend',
      'us_holiday',
    ]);
    expect(figures.map((f) => f.metric)).toEqual([
      'exit_worst',
      'exit',
      'exit',
      'exit',
      'cap1pct',
      'weekend',
      'lp_top1',
      'lp_exit',
      'cap_variation',
      'volume_28d',
      'volatility',
      'drawdown',
    ]);
  });

  it('says why the worst regime is unknown when nothing is measured', () => {
    const none = projectSheet(
      buildAssetFacts({
        ...({} as AssetFactsInput),
        assetId: 'x',
        symbol: 'X',
        chain: 'base',
        mint: null,
        sizeUsd: 10_000,
        tau: 0.01,
        asOf: '2026-10-08T12:00:00.000Z',
        sell: null,
        buy: null,
        curveMeta: meta,
        uncoveredReason: 'chain_not_covered',
        platformFeeBps: 0,
        lp: null,
        lpWithdrawals: null,
        capacitySeries: null,
        lendingCollateral: null,
        tracking: [],
        issuer: null,
        gapGridPct: [5],
      }),
    );
    expect(none.find((f) => f.metric === 'exit_worst')).toEqual({
      metric: 'exit_worst',
      value: null,
      reason: 'chain_not_covered',
    });
    expect(none.every((f) => f.value === null)).toBe(true);
  });
});

describe('createAgentAnalytics', () => {
  const noTwins = vi.fn(async () => []);

  it('reads a sheet per listed non-cash asset at the reference size, under its own address on a live chain', async () => {
    const sheet = vi.fn(async (_db: Db, id: string) => (id === stock.address ? measured() : null));
    const read = createAgentAnalytics({ sheet, twins: noTwins });
    const result = await read({ db, chain: 'solana', assets, provenance: 'live', sizeUsd: null });
    if ('unavailable' in result) throw new Error(result.unavailable);
    expect(result).toMatchObject({ sizeUsd: 10_000, basis: 'reference', tau: 0.01 });
    expect(sheet).toHaveBeenCalledTimes(listed.length);
    expect(sheet).not.toHaveBeenCalledWith(db, cash.address, expect.anything());
    expect(sheet).toHaveBeenCalledWith(db, stock.address, 10_000);
    const row = result.assets.find((a) => a.assetId === stock.id);
    expect(row?.modelledOn).toBeNull();
    expect(row?.figures?.find((f) => f.metric === 'exit_worst')).toMatchObject({
      provenance: 'live',
      source: 'risk_depth_curves',
    });
    // Bearing knows no sheet for the others: null, which the context says is unknown.
    expect(result.assets.filter((a) => a.figures === null)).toHaveLength(listed.length - 1);
  });

  it("reads a test-network token's mainnet model and labels its figures sandbox, naming the model", async () => {
    const sheet = vi.fn(async (_db: Db, id: string) =>
      id === 'SPYXmainnetMint' ? measured() : null,
    );
    const twins = vi.fn(async () => [
      { id: stock.id, symbol: stock.symbol, twinSymbol: 'SPYx', twinMint: 'SPYXmainnetMint' },
    ]);
    const read = createAgentAnalytics({ sheet, twins });
    const result = await read({
      db,
      chain: 'solana',
      assets,
      provenance: 'sandbox',
      sizeUsd: null,
    });
    if ('unavailable' in result) throw new Error(result.unavailable);
    expect(twins).toHaveBeenCalledWith(db, listed, 'sandbox');
    const row = result.assets.find((a) => a.assetId === stock.id);
    expect(row?.modelledOn).toBe('SPYx');
    const figures = row?.figures?.filter((f) => f.value !== null) ?? [];
    expect(figures.length).toBeGreaterThan(3);
    for (const figure of figures)
      expect(figure).toMatchObject({
        provenance: 'sandbox',
        source: expect.stringContaining(
          `mainnet SPYx figures applied to the test-network token ${stock.symbol}`,
        ),
      });
  });

  it('never says live on a chain that is not', async () => {
    const read = createAgentAnalytics({ sheet: async () => measured(), twins: noTwins });
    const result = await read({ db, chain: 'solana', assets, provenance: 'mock', sizeUsd: null });
    if ('unavailable' in result) throw new Error(result.unavailable);
    const values = result.assets.flatMap((a) => a.figures ?? []).filter((f) => f.value !== null);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((f) => f.value !== null && f.provenance === 'mock')).toBe(true);
  });

  it("refers the costs to the vault's whole-dollar value, and to the reference size without one", async () => {
    const sheet = vi.fn(async (_db: Db, _id: string, size: number) => measured(size));
    const read = createAgentAnalytics({ sheet, twins: noTwins });
    expect(
      await read({ db, chain: 'solana', assets: [stock], provenance: 'live', sizeUsd: 2_500.4 }),
    ).toMatchObject({ sizeUsd: 2_500, basis: 'vault' });
    expect(sheet).toHaveBeenLastCalledWith(db, stock.address, 2_500);
    for (const sizeUsd of [0, Number.NaN, null])
      expect(
        await read({ db, chain: 'solana', assets: [stock], provenance: 'live', sizeUsd }),
      ).toMatchObject({ sizeUsd: 10_000, basis: 'reference' });
  });

  it('keeps a read for ten minutes, and reads again after', async () => {
    let clock = 0;
    const sheet = vi.fn(async () => measured());
    const read = createAgentAnalytics({ sheet, twins: noTwins, now: () => clock });
    const query = {
      db,
      chain: 'solana' as const,
      assets,
      provenance: 'live' as const,
      sizeUsd: null,
    };
    await read(query);
    clock = 9 * 60_000;
    await read(query);
    expect(sheet).toHaveBeenCalledTimes(listed.length);
    clock = 11 * 60_000;
    await read(query);
    expect(sheet).toHaveBeenCalledTimes(2 * listed.length);
  });

  it('reads at most the set number of sheets at once, across conversations', async () => {
    let running = 0;
    let most = 0;
    const sheet = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return null;
    });
    const read = createAgentAnalytics({ sheet, twins: noTwins, concurrency: 2 });
    await Promise.all([
      read({ db, chain: 'solana', assets, provenance: 'live', sizeUsd: null }),
      read({ db, chain: 'solana', assets, provenance: 'live', sizeUsd: 5_000 }),
    ]);
    expect(sheet).toHaveBeenCalledTimes(2 * listed.length);
    expect(most).toBe(2);
  });

  it('answers a code instead of figures when the reads fail or run late, and does not keep a failure', async () => {
    const failing = vi.fn(async (): Promise<AssetFacts | null> => {
      throw new Error('too many connections');
    });
    const read = createAgentAnalytics({ sheet: failing, twins: noTwins });
    const query = {
      db,
      chain: 'solana' as const,
      assets: [stock],
      provenance: 'live' as const,
      sizeUsd: null,
    };
    expect(await read(query)).toEqual({ unavailable: 'analytics_failed' });
    expect(await read(query)).toEqual({ unavailable: 'analytics_failed' });
    expect(failing).toHaveBeenCalledTimes(2);

    const late = createAgentAnalytics({
      sheet: () => new Promise(() => {}),
      twins: noTwins,
      timeoutMs: 10,
    });
    expect(await late(query)).toEqual({ unavailable: 'analytics_timeout' });
  });
});
