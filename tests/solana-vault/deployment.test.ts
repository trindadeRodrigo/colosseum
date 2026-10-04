import { randomUUID } from 'node:crypto';
import { deploymentAssets, type SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { basketAssets, createDb } from '@colosseum/db';
import { parseChainConfigs } from '@colosseum/schemas';
import { getAddressDecoder } from '@solana/kit';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { solanaDeployment } from '../../apps/api/src/deployments';
import { solanaFromEnv } from '../../apps/api/src/routes/v1/index';
import { fillBasketAssets } from '../../scripts/solana/basket-assets';

// Where the API's real Solana chain gets its addresses and its tokens: the record the deploy commits
// (deployments/solana-<network>.json, written by the TNET-4 set-up), and `basket_assets` filled from it.

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const run = randomUUID().slice(0, 8);

function record(): SolanaDeploymentRecord {
  const token = (slug: string, n: number) => ({
    id: `solana:${slug}-${run}`,
    symbol: `t${slug.toUpperCase()}`,
    modelOf: `${slug.toUpperCase()}x`,
    mint: key(n),
    tokenProgram: 'token-2022' as const,
    decimals: 8,
  });
  return {
    network: 'devnet',
    chain: 'solana',
    provenance: 'sandbox',
    programs: { basket: key(1), mockRouter: key(2) },
    accounts: { priceAccount: key(3) },
    cash: {
      ...token('usdc', 40),
      kind: 'cash',
      modelOf: 'USDC',
      tokenProgram: 'token',
      decimals: 6,
    },
    assets: [
      {
        ...token('spyx', 41),
        kind: 'stock',
        session: 1,
        priceIndex: 344,
        maxWeightBps: 5_000,
        keeperOn: true,
      },
      {
        ...token('gldx', 42),
        kind: 'gold',
        session: 0,
        priceIndex: 100,
        maxWeightBps: 3_000,
        keeperOn: false,
      },
    ],
  };
}
const file = (r: unknown) => () => JSON.stringify(r);

describe("the deploy's record gives a real Solana chain its addresses", () => {
  it('takes the program, the router and the price account from the record of the network', () => {
    const env = { CHAIN_MODE_SOLANA: 'live', CHAIN_NETWORK_SOLANA: 'testnet' };
    const done = solanaDeployment(env, file(record()), '/records');
    expect(done.contracts).toEqual({ solana: { program: key(1) } });
    const config = parseChainConfigs(done.env, done.contracts).solana;
    expect([config.router, config.priceSource.address, config.contracts.program]).toEqual([
      key(2),
      key(3),
      key(1),
    ]);
    // The environment may say the same thing, and nothing else.
    expect(() =>
      solanaDeployment({ ...env, CHAIN_ROUTER_SOLANA: key(2) }, file(record()), '/records'),
    ).not.toThrow();
    expect(() =>
      solanaDeployment({ ...env, CHAIN_ROUTER_SOLANA: key(9) }, file(record()), '/records'),
    ).toThrow('CHAIN_ROUTER_SOLANA names another address');
    expect(() =>
      solanaDeployment({ ...env, CHAIN_PRICE_SOURCE_SOLANA: key(9) }, file(record()), '/records'),
    ).toThrow('CHAIN_PRICE_SOURCE_SOLANA names another address');
  });

  it('reads the record of the network the environment names, and none for mainnet or where there is none', () => {
    const asked: string[] = [];
    const read = (f: string) => {
      asked.push(f);
      return null;
    };
    for (const network of ['testnet', 'local', 'mainnet'])
      expect(
        solanaDeployment({ CHAIN_NETWORK_SOLANA: network }, read, '/records').contracts,
      ).toEqual({});
    expect(asked).toEqual(['/records/solana-devnet.json', '/records/solana-local.json']);
    expect(() => solanaDeployment({}, () => '{"chain":"solana"}', '/records')).toThrow(
      'not a Solana deployment record',
    );
  });

  it('turns the record into the asset list, cash first, every figure labelled a test network', () => {
    const assets = deploymentAssets(record());
    expect(assets.map((a) => [a.id, a.cls, a.priceKind, a.priceRef, a.session])).toEqual([
      [`solana:usdc-${run}`, 'cash', 'none', '', 'always'],
      [`solana:spyx-${run}`, 'stock', 'scope', '344', 'us_equity'],
      [`solana:gldx-${run}`, 'gold', 'scope', '100', 'always'],
    ]);
    expect(assets.every((a) => a.provenance === 'sandbox')).toBe(true);
  });
});

describe('basket_assets, filled from the record, is what the API runs Solana on', () => {
  const { db, client } = createDb();
  const ids = deploymentAssets(record()).map((a) => a.id);
  afterAll(async () => {
    await db.delete(basketAssets).where(inArray(basketAssets.id, ids));
    await client.end();
  });

  it('fills it once, leaves it alone the second time, and the API reads it with the RPC it is given', async () => {
    const first = await fillBasketAssets(db, record());
    expect(first.map((f) => f.outcome)).toEqual(['added', 'added', 'added']);
    expect((await fillBasketAssets(db, record())).map((f) => f.outcome)).toEqual([
      'same',
      'same',
      'same',
    ]);
    const moved = record();
    const spyx = moved.assets[0];
    if (spyx) spyx.maxWeightBps = 4_000;
    expect((await fillBasketAssets(db, moved)).map((f) => f.outcome)).toEqual([
      'same',
      'changed',
      'same',
    ]);

    // Nothing for a chain that is not real; a real one needs the RPC; with it, the rows are its list.
    expect(await solanaFromEnv({}, 'mock', db)).toBeUndefined();
    await expect(solanaFromEnv({}, 'live', db)).rejects.toThrow('SOLANA_RPC_URL is not set');
    const inputs = await solanaFromEnv({ SOLANA_RPC_URL: 'http://127.0.0.1:1' }, 'readonly', db);
    const mine = inputs?.assets.filter((a) => ids.includes(a.id));
    expect(mine?.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect(mine?.find((a) => a.id === spyx?.id)?.maxWeightBps).toBe(4_000);
  });
});
