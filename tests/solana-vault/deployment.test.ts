import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNode,
  deploymentAssets,
  MAINNET_GENESIS_HASH,
  type SolanaDeploymentRecord,
  type VaultNodeRpc,
} from '@colosseum/chain-solana/vault';
import { basketAssets, createDb } from '@colosseum/db';
import { parseChainConfigs } from '@colosseum/schemas';
import { getAddressDecoder } from '@solana/kit';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { solanaDeployment } from '../../apps/api/src/deployments';
import { holdToRecord, solanaFromEnv } from '../../apps/api/src/routes/v1/index';
import { fillBasketAssets } from '../../scripts/solana/basket-assets';

// Where the API's real Solana chain gets its addresses and its tokens: the record the deploy commits
// (deployments/solana-<network>.json, written by the TNET-4 set-up), and `basket_assets` filled from it.

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const run = randomUUID().slice(0, 8);

function record(): SolanaDeploymentRecord {
  const token = (slug: string, n: number) => ({
    id: `solana:${slug}-${run}`,
    symbol: `t${slug.toUpperCase()}`,
    name: `test ${slug}`,
    modelOf: `${slug.toUpperCase()}x`,
    mint: key(n),
    tokenProgram: 'token-2022' as const,
    decimals: 8,
    reserve: key(n + 20),
  });
  const listed = (slug: string, n: number, kind: 'stock' | 'gold', index: number) => ({
    ...token(slug, n),
    kind,
    session: kind === 'stock' ? (1 as const) : (0 as const),
    priceIndex: index,
    twapIndex: index + 1,
    indexSource: 'test-network' as const,
    maxWeightBps: 5_000,
    keeperOn: kind === 'stock',
    range: kind === 'stock' ? { minPrice: '400000000', maxPrice: '600000000' } : null,
    spreadBps: 30,
    pairs: { buy: key(n + 40), sell: key(n + 60) },
  });
  return {
    network: 'solana-devnet',
    chain: 'solana',
    provenance: 'sandbox',
    genesisHash: null,
    programs: { basket: key(1), mockRouter: key(2) },
    accounts: {
      config: key(4),
      assets: key(5),
      priceAccount: key(3),
      router: key(6),
      lookupTable: null,
    },
    roles: {
      admin: key(7),
      guardian: key(8),
      defaultKeeper: key(9),
      priceOwner: key(2),
      exchangeAdmin: key(7),
      priceWriter: null,
      tokenAuthority: key(7),
    },
    params: {
      toleranceBps: 75,
      lossCapBps: 100,
      bandBps: 50,
      twapDevBps: 200,
      maxPriceAgeS: 120,
      assetCooldownS: 3_600,
      publishDelayS: 60,
      sessionOpenUtcS: 52_200,
      sessionCloseUtcS: 72_000,
    },
    closedDays: ['2026-11-26'],
    cash: {
      ...token('usdc', 10),
      kind: 'cash',
      modelOf: 'USDC',
      tokenProgram: 'token',
      decimals: 6,
    },
    assets: [listed('spyx', 11, 'stock', 344), listed('gldx', 12, 'gold', 100)],
    retired: [{ id: null, symbol: null, mint: key(13), tokenProgram: 'token', keeperOn: false }],
  };
}
const file = (r: unknown) => () => JSON.stringify(r);

/** The record after a deploy dropped an asset from its config: listed for good, in `retired`. */
function retire(r: SolanaDeploymentRecord, slug: string): SolanaDeploymentRecord {
  const gone = r.assets.find((a) => a.id === `solana:${slug}-${run}`);
  if (!gone) throw new Error(`no ${slug}`);
  return {
    ...r,
    assets: r.assets.filter((a) => a !== gone),
    retired: [
      ...r.retired,
      {
        id: gone.id,
        symbol: gone.symbol,
        mint: gone.mint,
        tokenProgram: gone.tokenProgram,
        keeperOn: false,
      },
    ],
  };
}

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
    // A field the record does not have is another shape: refused, not ignored.
    expect(() =>
      solanaDeployment({}, file({ ...record(), keeperKey: key(30) }), '/records'),
    ).toThrow('not a Solana deployment record');
    // The devnet file has to be the devnet record: one that says it is mainnet's is not run.
    expect(() =>
      solanaDeployment({}, file({ ...record(), network: 'mainnet-beta' }), '/records'),
    ).toThrow('is the record of mainnet-beta, and CHAIN_NETWORK_SOLANA asks for solana-devnet');
    expect(() =>
      solanaDeployment({ CHAIN_NETWORK_SOLANA: 'local' }, file(record()), '/records'),
    ).toThrow('asks for solana-local');
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

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** A node that answers its genesis hash and nothing else. */
const node = (genesis: string) =>
  ({ getGenesisHash: () => ({ send: async () => genesis }) }) as unknown as VaultNodeRpc;

describe('the node behind SOLANA_RPC_URL is the network the record is for', () => {
  it("refuses mainnet's genesis whatever the label, and a node of another network than the record's", async () => {
    await expect(assertNode(node(MAINNET_GENESIS_HASH), null)).rejects.toThrow('mainnet node');
    await expect(
      assertNode(node(MAINNET_GENESIS_HASH), { ...record(), genesisHash: MAINNET_GENESIS_HASH }),
    ).rejects.toThrow('mainnet node');
    await expect(
      assertNode(node(DEVNET_GENESIS), { ...record(), genesisHash: key(50) }),
    ).rejects.toThrow('not the network of the record solana-devnet');
    await expect(
      assertNode(node(DEVNET_GENESIS), { ...record(), genesisHash: DEVNET_GENESIS }),
    ).resolves.toBeUndefined();
    // A record that names no genesis is held to "not mainnet" alone.
    await expect(assertNode(node(DEVNET_GENESIS), record())).resolves.toBeUndefined();
    // A node that never answers fails the start instead of hanging it.
    const silent = {
      getGenesisHash: () => ({ send: () => new Promise<string>(() => {}) }),
    } as unknown as VaultNodeRpc;
    await expect(assertNode(silent, record(), 50)).rejects.toThrow(
      'did not say its network in 50 ms',
    );
  });

  it('does not start a testnet label on a mainnet node', async () => {
    const { db, client } = createDb();
    try {
      await expect(
        solanaFromEnv({ SOLANA_RPC_URL: 'http://127.0.0.1:1' }, 'live', db, null, () =>
          node(MAINNET_GENESIS_HASH),
        ),
      ).rejects.toThrow('mainnet node');
    } finally {
      await client.end();
    }
  });
});

describe('a chain on the mock reads no record', () => {
  it('starts on the mock with a record it would refuse for a real chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'records-'));
    writeFileSync(join(dir, 'solana-devnet.json'), JSON.stringify({ ...record(), extra: true }));
    const env = { CHAIN_MODE_SOLANA: 'mock', CHAIN_NETWORK_SOLANA: 'testnet' };
    try {
      const app = await buildApp({ env, deployments: dir });
      await app.close();
      // The same record for a live chain is refused at start.
      await expect(
        buildApp({ env: { ...env, CHAIN_MODE_SOLANA: 'live' }, deployments: dir }),
      ).rejects.toThrow('not a Solana deployment record');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("basket_assets is held to the record's mints at start", () => {
  it('passes the rows the record makes, and stops on a mint, a decimals or a cash it does not name', () => {
    const rows = deploymentAssets(record());
    expect(() => holdToRecord(rows, record())).not.toThrow();
    const [cash, spyx, gldx] = rows;
    if (!cash || !spyx || !gldx) throw new Error('rows');
    expect(() => holdToRecord([cash, { ...spyx, address: key(31) }], record())).toThrow(
      'is not a token of solana-devnet',
    );
    expect(() => holdToRecord([cash, { ...spyx, decimals: 6 }], record())).toThrow(
      'has decimals 6, and solana-devnet says 8',
    );
    // A price entry moved by hand: the keeper and the reads would value the asset at another entry.
    expect(() => holdToRecord([cash, { ...spyx, priceRef: '345' }], record())).toThrow(
      'has priceRef 345, and solana-devnet says 344',
    );
    expect(() => holdToRecord([cash, { ...gldx, session: 'us_equity' }], record())).toThrow(
      'has session us_equity',
    );
    expect(() => holdToRecord([cash, { ...spyx, maxWeightBps: 9_000 }], record())).toThrow(
      'has maxWeightBps 9000, and solana-devnet says 5000',
    );
    expect(() => holdToRecord([cash, { ...gldx, autoFollowEligible: true }], record())).toThrow(
      'has autoFollowEligible true',
    );
    // A token the deploy retired: its row is let through, as a vault may still hold it.
    expect(() => holdToRecord(rows, retire(record(), 'gldx'))).not.toThrow();
    expect(() => holdToRecord([spyx, gldx], record())).toThrow(
      "the cash row is not solana-devnet's cash",
    );
    expect(() => holdToRecord([{ ...gldx, cls: 'cash' }, spyx], record())).toThrow(
      "the cash row is not solana-devnet's cash",
    );
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
    const devnet = node(DEVNET_GENESIS);
    const inputs = await solanaFromEnv(
      { SOLANA_RPC_URL: 'http://127.0.0.1:1' },
      'readonly',
      db,
      null,
      () => devnet,
    );
    const mine = inputs?.assets.filter((a) => ids.includes(a.id));
    expect(mine?.map((a) => a.id).sort()).toEqual([...ids].sort());
    expect(mine?.find((a) => a.id === spyx?.id)?.maxWeightBps).toBe(4_000);

    // The deploy retires gold: its row goes, the others stay, and a second run removes nothing more.
    const retired = retire(moved, 'gldx');
    expect((await fillBasketAssets(db, retired)).map((f) => [f.id, f.outcome])).toEqual([
      [`solana:usdc-${run}`, 'same'],
      [`solana:spyx-${run}`, 'same'],
      [`solana:gldx-${run}`, 'removed'],
    ]);
    expect((await fillBasketAssets(db, retired)).map((f) => f.outcome)).toEqual(['same', 'same']);
  });
});
