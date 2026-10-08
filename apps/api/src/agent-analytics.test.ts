import type { Db } from '@colosseum/db';
import { type AssetFactsInput, buildAssetFacts, type DepthCurve } from '@colosseum/risk';
import type { AssetFacts, BasketAsset } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import { createAgentAnalytics, projectSheet, roundSize } from './agent-analytics';

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
const measured = (sizeUsd = 10_000, over: Partial<AssetFactsInput> = {}): AssetFacts =>
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
    ...over,
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
    // The capacity at the tolerance is the plan inputs' figure: one per measure.
    expect(figures.some((f) => (f.metric as string) === 'cap1pct')).toBe(false);
    expect(of('lp_top1')).toMatchObject({ value: 0.4, source: 'risk_lp_concentration' });
    expect(of('lp_exit')).toMatchObject({ value: 0.015, unit: 'fraction' });
  });

  it('names the size a figure was measured at when it is not the sheet size, and a lower bound', () => {
    const shallow = curve([0.001, 0.002, 0.003, 0.004]);
    const sheet = measured(10_000, {
      sell: {
        assetId: 'spyx',
        byRegime: { us_market_hours: shallow, us_offhours_weekday: shallow },
      },
      lp: {
        ...meta,
        fetchedAt: '2026-10-08T11:00:00.000Z',
        top1: 0.4,
        top3: 0.63,
        top10: 0.9,
        lpExitN: 3,
        sellWithoutTopN: [{ notionalUsd: 25_000, costPct: 1.5 }],
      },
    });
    const projected = projectSheet(sheet);
    expect(projected.find((f) => f.metric === 'lp_exit')).toMatchObject({
      value: 0.015,
      sizeUsd: 25_000,
    });
    expect(projected.find((f) => f.metric === 'exit_worst')).not.toHaveProperty('sizeUsd');
    expect(projected.find((f) => f.metric === 'exit_worst')).not.toHaveProperty('lowerBound');
    // A fact the data only bounds from below stays one.
    const bounded = structuredClone(sheet);
    const worst = bounded.costs.find((c) => c.regime === bounded.worstRegime)?.exit.total;
    if (!worst || worst.value === null) throw new Error('fixture has no worst exit');
    worst.quality = 'lower_bound';
    expect(projectSheet(bounded).find((f) => f.metric === 'exit_worst')).toMatchObject({
      lowerBound: true,
    });
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

  it('rounds a vault value to two significant figures, so a turn after a price move reads the same sheets', () => {
    expect([1, 99.4, 2_537, 2_500.4, 123_456].map(roundSize)).toEqual([
      1, 99, 2_500, 2_500, 120_000,
    ]);
  });

  it('reads an EVM token under the lower-case address the collectors store', async () => {
    const sheet = vi.fn(async () => null);
    const read = createAgentAnalytics({ sheet, twins: noTwins });
    const evm = {
      ...stock,
      chain: 'robinhood' as const,
      address: '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01',
    };
    await read({ db, chain: 'robinhood', assets: [evm], provenance: 'live', sizeUsd: null });
    expect(sheet).toHaveBeenCalledWith(db, '0xabcdef0123456789abcdef0123456789abcdef01', 10_000);
  });

  it('keeps a read for ten minutes, then serves it once more while it is read again', async () => {
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
    const stale = await read(query);
    if ('unavailable' in stale) throw new Error(stale.unavailable);
    // The kept figures answer at once; the new read fills the cache behind them.
    expect(stale.assets.every((row) => row.figures !== null && !row.unread)).toBe(true);
    await vi.waitFor(() => expect(sheet).toHaveBeenCalledTimes(2 * listed.length));
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

  it('answers a code when every read fails, and does not keep a failure', async () => {
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
  });

  it('waits a short while, then goes on; the reads carry on and the next turn gets them', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sheet = vi.fn(async () => {
      await gate;
      return measured();
    });
    const read = createAgentAnalytics({ sheet, twins: noTwins, waitMs: 20 });
    const query = {
      db,
      chain: 'solana' as const,
      assets,
      provenance: 'live' as const,
      sizeUsd: null,
    };
    const first = await read(query);
    if ('unavailable' in first) throw new Error(first.unavailable);
    expect(first.incomplete).toBe(`analytics_partial_${listed.length}_of_${listed.length}`);
    expect(first.assets.every((row) => row.unread === 'reading' && row.figures === null)).toBe(
      true,
    );
    release();
    await vi.waitFor(async () => {
      const second = await read(query);
      if ('unavailable' in second) throw new Error(second.unavailable);
      expect(second.incomplete).toBeUndefined();
      expect(second.assets.every((row) => row.figures?.length)).toBe(true);
    });
    // One read per sheet, however many turns asked.
    expect(sheet).toHaveBeenCalledTimes(listed.length);
  });

  it('leaves sheets past the pending limit for a later turn', async () => {
    const sheet = vi.fn((): Promise<AssetFacts | null> => new Promise(() => {}));
    const read = createAgentAnalytics({ sheet, twins: noTwins, waitMs: 10, maxPending: 2 });
    const result = await read({
      db,
      chain: 'solana',
      assets,
      provenance: 'live',
      sizeUsd: null,
    });
    if ('unavailable' in result) throw new Error(result.unavailable);
    expect(sheet).toHaveBeenCalledTimes(2);
    expect(result.assets.filter((row) => row.unread === 'reading')).toHaveLength(2);
    expect(result.assets.filter((row) => row.unread === 'failed')).toHaveLength(listed.length - 2);
  });

  it("warms a chain's reference-size reads from the start, so the first new goal finds them kept", async () => {
    vi.useFakeTimers();
    try {
      const sheet = vi.fn(async () => measured());
      const read = createAgentAnalytics({ sheet, twins: noTwins, ttlMs: 60_000 });
      read.warm?.({ db, chain: 'solana', assets, provenance: 'live' });
      await vi.waitFor(() => expect(sheet).toHaveBeenCalledTimes(listed.length));
      const first = await read({ db, chain: 'solana', assets, provenance: 'live', sizeUsd: null });
      if ('unavailable' in first) throw new Error(first.unavailable);
      expect(first.incomplete).toBeUndefined();
      expect(sheet).toHaveBeenCalledTimes(listed.length);
      // Kept current on a timer, and stopped with the server.
      await vi.advanceTimersByTimeAsync(91_000);
      await vi.waitFor(() => expect(sheet).toHaveBeenCalledTimes(2 * listed.length));
      read.stop?.();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sheet).toHaveBeenCalledTimes(2 * listed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
