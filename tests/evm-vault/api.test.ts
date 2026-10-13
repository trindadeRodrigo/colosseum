import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentAssets, EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { basketAssets, createDb } from '@colosseum/db';
import { parseChainConfigs } from '@colosseum/schemas';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { evmDeployment } from '../../apps/api/src/deployments';
import { holdToEvmRecord, robinhoodFromEnv } from '../../apps/api/src/routes/v1/index';
import { fillChainAssets } from '../../scripts/solana/basket-assets';

// What the API needs to run Robinhood Chain on the EVM adapter: the deploy's record (the factory,
// the registry, the router), `basket_assets` held to it, and the node behind ROBINHOOD_RPC_URL.

const ROOT = join(import.meta.dirname, '..', '..');
const recordText = readFileSync(join(ROOT, 'deployments', 'robinhood-testnet.json'), 'utf8');
const record = () => EvmDeploymentRecord.parse(JSON.parse(recordText));

describe("the deploy's record gives Robinhood Chain its addresses", () => {
  const dir = mkdtempSync(join(tmpdir(), 'evm-records-'));
  writeFileSync(join(dir, 'robinhood-testnet.json'), recordText);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('takes the factory, the registry and the router from the record of the network', () => {
    const r = record();
    const { env, contracts, record: read } = evmDeployment('robinhood', {}, undefined, dir);
    expect(read).toEqual(r);
    expect(contracts).toEqual({
      robinhood: { factory: r.contracts.factory, registry: r.contracts.registry },
    });
    expect(env.CHAIN_ROUTER_ROBINHOOD).toBe(r.routers[0]?.address);
    const config = parseChainConfigs(env, contracts).robinhood;
    expect([config.router, config.contracts.factory, config.evmChainId]).toEqual([
      r.routers[0]?.address,
      r.contracts.factory,
      r.evmChainId,
    ]);
    // The environment may say the same router, in any case, and no other.
    const same = r.routers[0]?.address.toUpperCase().replace('0X', '0x') ?? '';
    expect(
      evmDeployment('robinhood', { CHAIN_ROUTER_ROBINHOOD: same }, undefined, dir).record,
    ).toEqual(r);
    expect(() =>
      evmDeployment('robinhood', { CHAIN_ROUTER_ROBINHOOD: `0x${'1'.repeat(40)}` }, undefined, dir),
    ).toThrow('CHAIN_ROUTER_ROBINHOOD names another address');
  });

  it('reads none for mainnet or where there is none, and refuses a record of another network', () => {
    expect(
      evmDeployment('robinhood', { CHAIN_NETWORK_ROBINHOOD: 'mainnet' }, undefined, dir).record,
    ).toBeNull();
    expect(
      evmDeployment('robinhood', { CHAIN_NETWORK_ROBINHOOD: 'local' }, undefined, dir).record,
    ).toBeNull();
    const other = { ...JSON.parse(recordText), network: 'robinhood-local' };
    expect(() => evmDeployment('robinhood', {}, () => JSON.stringify(other), dir)).toThrow(
      'is the record of robinhood-local',
    );
    expect(() => evmDeployment('robinhood', {}, () => '{}', dir)).toThrow(
      'is not an EVM deployment record',
    );
  });
});

describe("basket_assets is held to the record's tokens", () => {
  it('passes the rows the record makes, and stops on a token, a decimals or a cash it does not name', () => {
    const r = record();
    const rows = deploymentAssets(r);
    expect(holdToEvmRecord(rows, r)).toEqual(rows);
    const [cash, first, ...rest] = rows;
    if (!cash || !first) throw new Error('the record lists nothing');
    expect(() => holdToEvmRecord([cash, { ...first, decimals: 8 }, ...rest], r)).toThrow(
      'has decimals 8',
    );
    expect(() =>
      holdToEvmRecord([cash, { ...first, priceRef: `0x${'2'.repeat(40)}` }, ...rest], r),
    ).toThrow('has priceRef');
    expect(() => holdToEvmRecord([first, ...rest], r)).toThrow("is not robinhood-testnet's cash");
    const stranger = { ...first, id: 'robinhood:other', address: `0x${'3'.repeat(40)}` };
    expect(() => holdToEvmRecord([...rows, stranger], r)).toThrow(
      'is not a token of robinhood-testnet',
    );
  });

  it('runs on nothing for a chain that is not real, and needs the record and the RPC for one that is', async () => {
    const { db, client } = createDb();
    try {
      expect(await robinhoodFromEnv({}, 'mock', db, record())).toBeUndefined();
      await expect(
        robinhoodFromEnv({ ROBINHOOD_RPC_URL: 'http://127.0.0.1:1' }, 'live', db, null),
      ).rejects.toThrow('there is no deploy record');
      await expect(robinhoodFromEnv({}, 'readonly', db, record())).rejects.toThrow(
        'ROBINHOOD_RPC_URL is not set',
      );
    } finally {
      await client.end();
    }
  });
});

describe('basket_assets, filled from the record', () => {
  const { db, client } = createDb();
  const run = randomUUID().slice(0, 8);
  // The record's own tokens, under ids of this run, so the test touches only its rows.
  const mine = () => {
    const r = record();
    return {
      ...r,
      cash: { ...r.cash, id: `${r.cash.id}-${run}` },
      assets: r.assets.map((a) => ({ ...a, id: `${a.id}-${run}` })),
    };
  };
  const ids = deploymentAssets(mine()).map((a) => a.id);
  afterAll(async () => {
    await db.delete(basketAssets).where(inArray(basketAssets.id, ids));
    await client.end();
  });

  it('fills it once, leaves it alone the second time, and changes a row the record changed', async () => {
    const fill = (r: ReturnType<typeof mine>) =>
      fillChainAssets(
        db,
        'robinhood',
        deploymentAssets(r),
        r.retired.map((x) => x.address),
      );
    expect((await fill(mine())).map((f) => f.outcome)).toEqual(ids.map(() => 'added'));
    expect((await fill(mine())).map((f) => f.outcome)).toEqual(ids.map(() => 'same'));
    const moved = mine();
    const first = moved.assets[0];
    if (first) first.maxWeightBps = 4_000;
    expect((await fill(moved)).map((f) => f.outcome)).toEqual(
      ids.map((_, i) => (i === 1 ? 'changed' : 'same')),
    );
  });
});
