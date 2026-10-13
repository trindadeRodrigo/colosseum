import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainError } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { assertNode, deploymentAssets, EvmDeploymentRecord } from '../src/vault/deployment';
import type { EvmRpc } from '../src/vault/rpc';

// A mainnet's record is admitted only when it is complete: it says it is live, it carries the
// mainnet's own chain id, every address the deploy made, the timelock and what the deploy is expected
// to hold, and every trade limit. Nothing here reads a chain; no mainnet record is committed.

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const TESTNET = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'deployments', 'robinhood-testnet.json'),
    'utf8',
  ),
);
// biome-ignore lint/suspicious/noExplicitAny: a record as a file holds it, edited field by field below
type Json = any;
const asset = TESTNET.assets[0];

/** A complete record of Robinhood Chain mainnet, as a deploy behind a timelock would write it. */
const mainnet = (): Json => ({
  ...structuredClone(TESTNET),
  network: 'robinhood-mainnet',
  provenance: 'live',
  evmChainId: 4663,
  deployBlock: 86_800_000,
  roles: { admin: A(0x71), guardian: A(0x60), keeper: A(0), priceWriter: null, tokenIssuer: null },
  priceBoundBps: 200,
  staleRailBps: null,
  maxTradeUsdNotLive: null,
  staleRailMaxAge: null,
  cash: {
    ...structuredClone(TESTNET.cash),
    id: 'robinhood:usdg',
    symbol: 'USDG',
    name: 'Global Dollar',
  },
  assets: [
    {
      ...asset,
      id: 'robinhood:nvda',
      symbol: 'NVDA',
      name: 'NVIDIA',
      keeperOn: false,
      range: null,
      maxTradeUsd: 5000,
    },
  ],
  retired: [],
  timelock: {
    address: A(0x71),
    minDelay: 172_800,
    proposers: [A(0x5afe)],
    cancellers: [A(0x5afe)],
    executors: [A(0x5afe)],
  },
  expected: { launched: false, publishDelay: 172_800, keeperEnabled: false },
});

const refused = (change: (r: Json) => void) => {
  const record = mainnet();
  change(record);
  return EvmDeploymentRecord.safeParse(record).success === false;
};

describe('a mainnet record', () => {
  it('is admitted when it is complete, as live', () => {
    const record = EvmDeploymentRecord.parse(mainnet());
    expect([record.network, record.provenance, record.evmChainId]).toEqual([
      'robinhood-mainnet',
      'live',
      4663,
    ]);
  });

  it('is refused when it does not say what it is: its label, its number and its name go together', () => {
    expect(refused((r) => (r.provenance = 'sandbox'))).toBe(true);
    expect(refused((r) => (r.evmChainId = 46_630))).toBe(true);
    expect(refused((r) => (r.evmChainId = 8453))).toBe(true);
    expect(refused((r) => (r.network = 'robinhood-testnet'))).toBe(true);
    // And the other way: a test network's record never says live, and never carries a mainnet's number.
    expect(EvmDeploymentRecord.safeParse({ ...TESTNET, provenance: 'live' }).success).toBe(false);
    expect(EvmDeploymentRecord.safeParse({ ...TESTNET, evmChainId: 4663 }).success).toBe(false);
    expect(
      EvmDeploymentRecord.safeParse({ ...TESTNET, network: 'robinhood-mainnet' }).success,
    ).toBe(false);
    expect(EvmDeploymentRecord.safeParse(TESTNET).success).toBe(true);
  });

  it('is refused while anything a deploy writes is missing', () => {
    expect(refused((r) => (r.deployBlock = null))).toBe(true);
    for (const key of [
      'factory',
      'registry',
      'beacon',
      'vaultLogic',
      'factoryLogic',
      'registryLogic',
    ])
      expect(
        refused((r) => (r.contracts[key] = A(0))),
        key,
      ).toBe(true);
    expect(refused((r) => (r.roles.admin = A(0)))).toBe(true);
    expect(refused((r) => (r.roles.guardian = A(0)))).toBe(true);
    expect(refused((r) => delete r.timelock)).toBe(true);
    expect(refused((r) => delete r.expected)).toBe(true);
    expect(refused((r) => (r.routers = []))).toBe(true);
    expect(refused((r) => (r.cash.address = A(0)))).toBe(true);
    // The admin of a mainnet is its timelock, not a key beside it.
    expect(refused((r) => (r.roles.admin = A(0x99)))).toBe(true);
  });

  it('is refused while it is not whole: a blank token, feed or router, no tokens, a short or missing delay, nothing expected', () => {
    expect(refused((r) => (r.assets[0].address = A(0)))).toBe(true);
    expect(refused((r) => (r.assets[0].feed = A(0)))).toBe(true);
    expect(refused((r) => (r.routers[0].address = A(0)))).toBe(true);
    expect(refused((r) => (r.assets = []))).toBe(true);
    expect(refused((r) => delete r.timelock.minDelay)).toBe(true);
    expect(refused((r) => (r.timelock.minDelay = 172_799))).toBe(true);
    expect(refused((r) => (r.expected = {}))).toBe(true);
    for (const key of ['launched', 'publishDelay', 'keeperEnabled'])
      expect(
        refused((r) => delete r.expected[key]),
        key,
      ).toBe(true);
  });

  it('is Robinhood Chain’s alone: Base has no mainnet here, under its own number or any other', () => {
    const base = (r: Json) => {
      r.chain = 'base';
      r.network = 'base-mainnet';
      r.evmChainId = 8453;
      r.cash.id = 'base:usdg';
      r.assets[0].id = 'base:nvda';
    };
    expect(refused(base)).toBe(true);
    expect(refused((r) => (r.evmChainId = 1))).toBe(true);
    // Ethereum's number is a mainnet's too, in a test network's record.
    expect(EvmDeploymentRecord.safeParse({ ...TESTNET, evmChainId: 1 }).success).toBe(false);
  });

  it('is refused with anything of a test network in it: a price writer, a token issuer of ours', () => {
    expect(refused((r) => (r.roles.priceWriter = A(0x77)))).toBe(true);
    expect(refused((r) => (r.roles.tokenIssuer = A(0x78)))).toBe(true);
  });

  it('is refused with a trade left unchecked', () => {
    expect(refused((r) => (r.priceBoundBps = null))).toBe(true);
    expect(refused((r) => (r.assets[0].maxTradeUsd = null))).toBe(true);
  });

  it('lists its assets as live, and not as a test network’s', () => {
    const [cash, nvda] = deploymentAssets(EvmDeploymentRecord.parse(mainnet()));
    expect(cash).toMatchObject({ cls: 'cash', provenance: 'live' });
    expect(nvda).toMatchObject({ id: 'robinhood:nvda', provenance: 'live' });
    for (const a of [cash, nvda]) {
      expect(a?.issuer).not.toMatch(/test/i);
      expect(a?.sheet).not.toMatch(/test/i);
    }
    // The test network's own stay as they were.
    const [testCash] = deploymentAssets(EvmDeploymentRecord.parse(TESTNET));
    expect(testCash).toMatchObject({ provenance: 'sandbox', issuer: 'test network' });
  });
});

describe('the node check, for a mainnet record', () => {
  const node = (chainId: number, code: string | undefined = '0x6080') =>
    ({ getChainId: async () => chainId, getCode: async () => code }) as unknown as EvmRpc;

  it('takes a mainnet node for the mainnet record, and for no other', async () => {
    const live = EvmDeploymentRecord.parse(mainnet());
    await assertNode(node(4663), live);
    for (const chainId of [46_630, 8453, 31_337]) {
      const e = await assertNode(node(chainId), live).catch((x: unknown) => x);
      expect((e as ChainError).code, `${chainId}`).toBe('NotSupported');
    }
    const empty = await assertNode(node(4663, '0x'), live).catch((x: unknown) => x);
    expect(empty).toBeInstanceOf(ChainError);

    // A test network's record on a mainnet node is refused as before.
    const test = EvmDeploymentRecord.parse(TESTNET);
    const e = await assertNode(node(4663), test).catch((x: unknown) => x);
    expect((e as ChainError).message).toContain("a mainnet's");
  });
});
