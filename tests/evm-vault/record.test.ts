import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deploymentAssets,
  deploymentPools,
  EvmDeploymentRecord,
  poolOf,
  v4Pools,
} from '@colosseum/chain-evm/vault';
import { deploymentsOf } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';

// The guard's deployment for Robinhood Chain's test network is the deploy's record, address for
// address: the guard derives every contract it holds a transaction to from it, so it may say nothing
// the deploy did not.

const ROOT = join(import.meta.dirname, '..', '..');
const record = EvmDeploymentRecord.parse(
  JSON.parse(readFileSync(join(ROOT, 'deployments', 'robinhood-testnet.json'), 'utf8')),
);

describe("the guard's Robinhood Chain test network", () => {
  it('is the record: chain id, factory, beacon, registry, router, cash and every token with its decimals', () => {
    const guard = deploymentsOf('testnet').robinhood;
    if (guard?.family !== 'evm') throw new Error('the guard has no EVM entry for robinhood');
    expect(guard.evmChainId).toBe(record.evmChainId);
    expect(guard.factory.toLowerCase()).toBe(record.contracts.factory);
    expect(guard.beacon.toLowerCase()).toBe(record.contracts.beacon);
    expect(guard.registry?.toLowerCase()).toBe(record.contracts.registry);
    expect(guard.routers.map((r) => r.toLowerCase())).toEqual(record.routers.map((r) => r.address));
    expect(guard.cash).toBe(record.cash.id);
    expect(
      Object.fromEntries(
        Object.entries(guard.assets).map(([id, a]) => [id, [a.token.toLowerCase(), a.decimals]]),
      ),
    ).toEqual(
      Object.fromEntries(deploymentAssets(record).map((a) => [a.id, [a.address, a.decimals]])),
    );
  });

  it("names each asset's pool as the record does: what the builder trades through is what the guard holds it to", () => {
    const guard = deploymentsOf('testnet').robinhood;
    if (guard?.family !== 'evm') throw new Error('the guard has no EVM entry for robinhood');
    const pools = deploymentPools(record);
    expect(guard.assets[guard.cash]?.pool).toBeUndefined();
    const listed = Object.entries(guard.assets).filter(([id]) => id !== guard.cash);
    expect(listed.length).toBe(record.assets.length);
    for (const [id, asset] of listed) {
      const built = poolOf(
        pools,
        record.cash.address as `0x${string}`,
        asset.token.toLowerCase() as `0x${string}`,
      );
      expect(asset.pool, id).toEqual(built);
      expect(asset.pool, id).toEqual(record.assets.find((a) => a.id === id)?.pool);
    }
    // The router's route names no pool of its own: the shape is each asset's.
    expect(Object.values(guard.routes)).toEqual([
      { kind: 'universal-router-v4', hooks: `0x${'0'.repeat(40)}` },
    ]);
  });
});

// Mainnet is not deployed to: the guard's file is a placeholder and the contracts' file is refused
// while it holds an unconfirmed value. What both can already say is which tokens are listed and which
// pool each trades in, and they have to say the same, token for token.
describe("Robinhood Chain mainnet, before a deploy: the guard's file and the contracts' file", () => {
  type GuardFile = {
    placeholder?: boolean;
    chains: {
      robinhood: {
        evmChainId: number;
        cash: string;
        routers: string[];
        routes: Record<string, { kind: string; hooks: string }>;
        assets: Record<
          string,
          { address: string; decimals: number; pool?: { fee: number; tickSpacing: number } }
        >;
      };
    };
  };
  type ContractsFile = {
    chainId: number;
    cashToken: string;
    routers: { router: string }[];
    assets: {
      token: string;
      tokenDecimals: number;
      feed: string;
      feedDescription?: string;
      pool?: { fee: number; tickSpacing: number };
    }[];
  };
  const guard = (
    JSON.parse(
      readFileSync(join(ROOT, 'packages', 'sdk', 'deployments', 'mainnet.json'), 'utf8'),
    ) as GuardFile
  ).chains.robinhood;
  const contracts = JSON.parse(
    readFileSync(join(ROOT, 'contracts', 'script', 'config', '4663.json'), 'utf8'),
  ) as ContractsFile;
  const lower = (s: string) => s.toLowerCase();

  it('list the same tokens, with the same decimals and the same pool for each', () => {
    expect(guard.evmChainId).toBe(contracts.chainId);
    expect(lower(guard.assets[guard.cash]?.address ?? '')).toBe(lower(contracts.cashToken));
    expect(guard.routers.map(lower)).toEqual(contracts.routers.map((r) => lower(r.router)));
    const [cash, ...stocks] = contracts.assets;
    expect(lower(cash?.token ?? '')).toBe(lower(contracts.cashToken));
    expect(cash?.pool).toBeUndefined();
    expect(guard.assets[guard.cash]?.pool).toBeUndefined();
    // More than NVDA: the launch lists every token that has a pool which quotes.
    expect(stocks.length).toBeGreaterThan(1);
    const fromGuard = Object.fromEntries(
      Object.entries(guard.assets)
        .filter(([id]) => id !== guard.cash)
        .map(([, a]) => [lower(a.address), { decimals: a.decimals, pool: a.pool }]),
    );
    const fromContracts = Object.fromEntries(
      stocks.map((a) => [lower(a.token), { decimals: a.tokenDecimals, pool: a.pool }]),
    );
    expect(fromGuard).toEqual(fromContracts);
    for (const a of stocks) {
      expect(a.pool, a.token).toMatchObject({
        fee: expect.any(Number),
        tickSpacing: expect.any(Number),
      });
      expect(a.feedDescription, a.token).toBeTruthy();
    }
    // One token, one entry, one feed.
    expect(new Set(stocks.map((a) => lower(a.token))).size).toBe(stocks.length);
    expect(new Set(stocks.map((a) => lower(a.feed))).size).toBe(stocks.length);
  });

  it('state the bound to the feed and a largest trade for every token, the thinnest the tightest', () => {
    const file = contracts as ContractsFile & { priceBoundBps?: number };
    // 2%: the bound the fork test holds every listed token's fill to (MAX_COST_BPS).
    expect(file.priceBoundBps).toBe(200);
    const [, ...stocks] = contracts.assets as (ContractsFile['assets'][number] & {
      maxTradeUsd?: number;
      feedDescription?: string;
    })[];
    for (const a of stocks) {
      expect(Number.isInteger(a.maxTradeUsd), a.token).toBe(true);
      expect(a.maxTradeUsd, a.token).toBeGreaterThanOrEqual(1_000);
    }
    const least = Math.min(...stocks.map((a) => a.maxTradeUsd ?? 0));
    // GLD, whose feed is itself made from pools, has the tightest limit of all.
    expect(stocks.find((a) => a.feedDescription === 'GLD / USD')?.maxTradeUsd).toBe(least);
    expect(least).toBe(1_000);
  });

  it('state what stands in for a stale feed: the rail, and an average pool per token that says whether it can be used', () => {
    const file = contracts as ContractsFile & {
      staleRailBps?: number;
      maxTradeUsdNotLive?: number;
      staleRailMaxAge?: number;
      sessionPriceAge?: number;
    };
    expect(file.staleRailBps).toBe(1_000);
    // A feed is live for an hour; past it one trade is $20,000 at most; the rail leans on a feed's
    // last answer for four days and no longer.
    expect(file.sessionPriceAge).toBe(3_600);
    expect(file.maxTradeUsdNotLive).toBe(20_000);
    expect(file.staleRailMaxAge).toBe(4 * 86_400);
    const [, ...stocks] = contracts.assets as (ContractsFile['assets'][number] & {
      feedDescription?: string;
      average?: { pool: string; fee: number; minLiquidity: string; usable: boolean };
    })[];
    // The pool and its floor are the ones the keeper's pool-average file names for the token.
    const feeds = JSON.parse(
      readFileSync(join(ROOT, 'contracts', 'script', 'config', 'pool-feeds', '4663.json'), 'utf8'),
    ) as { assets: { token: string; pool: string; fee: number; minLiquidity: string }[] };
    for (const a of stocks) {
      const named = feeds.assets.find((f) => lower(f.token) === lower(a.token));
      expect(a.average, a.token).toEqual({
        pool: named?.pool,
        fee: named?.fee,
        minLiquidity: named?.minLiquidity,
        usable: expect.any(Boolean),
      });
    }
    // The two whose pools keep under an hour of history say so, and are not traded on a stale feed.
    const unusable = stocks.filter((a) => !a.average?.usable).map((a) => a.feedDescription);
    expect(unusable.sort()).toEqual(['GLD / USD', 'Robinhood META / USD']);
  });

  it('the builder writes each mainnet token the pool the guard would hold it to', () => {
    const [, ...stocks] = contracts.assets;
    const pools = v4Pools(
      contracts.cashToken,
      stocks.map((a) => ({ address: a.token, pool: a.pool ?? { fee: -1, tickSpacing: -1 } })),
    );
    for (const [id, a] of Object.entries(guard.assets)) {
      if (id === guard.cash) continue;
      expect(poolOf(pools, pools.cash, lower(a.address) as `0x${string}`), id).toEqual(a.pool);
    }
    expect(
      new Set(Object.values(pools.byToken).map((p) => `${p.fee}/${p.tickSpacing}`)).size,
    ).toBeGreaterThan(1);
  });

  it("the guard's file names the deployed contracts; the contracts' file holds no unconfirmed value", () => {
    // Deployed on 2026-10-12: the guard loads mainnet, and its three addresses are the record's.
    const record = JSON.parse(
      readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.json'), 'utf8'),
    ) as { contracts: { factory: string; beacon: string; registry: string } };
    const loaded = deploymentsOf('mainnet').robinhood as unknown as Record<string, string>;
    for (const name of ['factory', 'beacon', 'registry'] as const)
      expect(loaded[name]?.toLowerCase(), name).toBe(record.contracts[name]);
    // Every value of the contracts' file was confirmed by a person on 2026-10-12: the marker word the
    // deploy script refuses on is gone, and every note that stood beside a proposed value says who
    // confirmed it and when.
    const text = readFileSync(join(ROOT, 'contracts', 'script', 'config', '4663.json'), 'utf8');
    expect(text).not.toContain('TODO');
    const file = JSON.parse(text) as Record<string, unknown> & {
      assets: Record<string, unknown>[];
    };
    const notes = [file, ...file.assets.slice(1)].flatMap((o) =>
      Object.entries(o).filter(
        ([k, v]) =>
          /Note$|^note$/.test(k) &&
          typeof v === 'string' &&
          k !== 'ownerNote' &&
          k !== 'guardianNote',
      ),
    );
    expect(notes.length).toBeGreaterThan(40);
    for (const [key, note] of notes)
      expect(note, key).toMatch(/^Confirmed by Thom( Gabriel)?,? (on )?2026-10-12/);
    // A ceiling for every token, none at zero.
    for (const a of file.assets.slice(1)) expect(a.maxWeightBps).toBeGreaterThan(0);
  });
});
