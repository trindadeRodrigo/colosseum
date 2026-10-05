import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAIN_ERROR_RETRYABLE, ChainError, parseChainConfigs } from '@colosseum/schemas';
import { encodeErrorResult, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { displayAmount, fromScaled, multiplierString, toScaled } from '../src/vault/amounts';
import {
  assertNode,
  deploymentAddresses,
  deploymentAssets,
  EvmDeploymentRecord,
} from '../src/vault/deployment';
import { revertToChainError } from '../src/vault/errors';
import {
  BASKET_VAULT_ABI,
  INDEX_REGISTRY_ABI,
  VAULT_BEACON_ABI,
  VAULT_FACTORY_ABI,
} from '../src/vault/generated/abi';
import { dayOf, marketAt } from '../src/vault/market';
import { createEvmVaultReader } from '../src/vault/reader';
import type { EvmRpc } from '../src/vault/rpc';
import { unlistedAssetId, unlistedToken } from '../src/vault/unlisted';

// The parts of the EVM reader that need no node: the typed ABIs against idl/evm, the record, amounts,
// the session rule, ids of unlisted tokens, the refusal a revert maps to, and the node check. The reads
// themselves run on a fork of Robinhood Chain (fork.test.ts).

const IDL = join(import.meta.dirname, '..', '..', '..', 'idl', 'evm');

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

const RECORD = {
  network: 'robinhood-testnet',
  chain: 'robinhood',
  provenance: 'sandbox',
  evmChainId: 46_630,
  deployBlock: 12,
  contracts: {
    factory: A(1),
    registry: A(2),
    beacon: A(3),
    vaultLogic: A(4),
    factoryLogic: A(5),
    registryLogic: A(6),
  },
  roles: { admin: A(7), guardian: A(8), keeper: A(9), priceWriter: A(14), tokenIssuer: null },
  routers: [{ address: '0x204FAca1764B154221e35c0d20aBb3c525710498', pull: 2 }],
  sequencerFeed: null,
  cash: { id: 'robinhood:usdg', symbol: 'USDG', name: 'Test dollar', address: A(10), decimals: 6 },
  assets: [
    {
      id: 'robinhood:nvda',
      symbol: 'NVDA',
      name: 'Test NVDA',
      address: A(11),
      decimals: 18,
      modelOf: 'NVDA',
      kind: 'stock',
      feed: A(12),
      feedDecimals: 8,
      averageFeed: A(13),
      maxAge: 93_600,
      session: 1,
      maxWeightBps: 2500,
      keeperOn: true,
      range: { minPrice: '15000000000', maxPrice: '30000000000' },
    },
  ],
  retired: [],
};

describe('the typed ABIs', () => {
  it('are what idl/evm holds: `pnpm --filter @colosseum/chain-evm abi` writes them again', () => {
    const files = [
      [BASKET_VAULT_ABI, 'BasketVault'],
      [VAULT_FACTORY_ABI, 'VaultFactory'],
      [INDEX_REGISTRY_ABI, 'IndexRegistry'],
      [VAULT_BEACON_ABI, 'VaultBeacon'],
    ] as const;
    for (const [abi, file] of files)
      expect(abi, file).toEqual(JSON.parse(readFileSync(join(IDL, `${file}.json`), 'utf8')));
  });
});

describe('the deployment record', () => {
  it('reads a record, lower-cases its addresses, and makes the assets the app lists', () => {
    const record = EvmDeploymentRecord.parse(RECORD);
    expect(record.routers[0]?.address).toBe('0x204faca1764b154221e35c0d20abb3c525710498');
    expect(deploymentAddresses(record)).toEqual({
      factory: A(1),
      registry: A(2),
      beacon: A(3),
      router: '0x204faca1764b154221e35c0d20abb3c525710498',
    });
    const [cash, nvda] = deploymentAssets(record);
    expect(cash).toMatchObject({ cls: 'cash', priceKind: 'none', provenance: 'sandbox' });
    expect(nvda).toMatchObject({
      id: 'robinhood:nvda',
      priceKind: 'chainlink',
      priceRef: A(12),
      session: 'us_equity',
      autoFollowEligible: true,
      maxWeightBps: 2500,
      tier: 'C',
      issuer: 'test network',
    });
  });

  it('refuses a record of another shape: a field it does not have, another chain, a keeper with no range', () => {
    const bad = [
      { ...RECORD, extra: 1 },
      { ...RECORD, provenance: 'live' },
      { ...RECORD, network: 'base-testnet' },
      { ...RECORD, cash: { ...RECORD.cash, id: 'base:usdg' } },
      { ...RECORD, assets: [{ ...RECORD.assets[0], range: null }] },
      { ...RECORD, assets: [{ ...RECORD.assets[0], token: A(11) }] },
      { ...RECORD, routers: [{ address: A(20), pull: 3 }] },
      { ...RECORD, network: 'robinhood-mainnet' },
      // A record is for a test network or a local copy: never under a mainnet's number.
      { ...RECORD, evmChainId: 4663 },
      { ...RECORD, evmChainId: 8453 },
      { ...RECORD, roles: { ...RECORD.roles, priceWriter: undefined } },
      { ...RECORD, sequencerFeed: undefined },
    ];
    for (const record of bad) expect(EvmDeploymentRecord.safeParse(record).success).toBe(false);
  });

  it('takes a node only on the record’s chain id, never a mainnet’s, with code at the factory', async () => {
    const record = EvmDeploymentRecord.parse(RECORD);
    const node = (chainId: number, code: string | undefined) =>
      ({
        getChainId: async () => chainId,
        getCode: async () => code,
      }) as unknown as EvmRpc;
    await assertNode(node(46_630, '0x6080'), record);
    for (const [chainId, code] of [
      [4663, '0x6080'],
      [8453, '0x6080'],
      [31_337, '0x6080'],
      [46_630, undefined],
      [46_630, '0x'],
    ] as const) {
      const e = await assertNode(node(chainId, code), record).catch((x: unknown) => x);
      expect(e, `${chainId} ${code}`).toBeInstanceOf(ChainError);
      expect((e as ChainError).code).toBe('NotSupported');
    }
    // A record that says a mainnet's number, on a node that answers it, is refused as mainnet: the
    // schema refuses such a record, and the node check does not lean on the schema.
    const onMainnet = { ...record, evmChainId: 4663 };
    for (const chainId of [4663, 8453] as const) {
      const e = await assertNode(node(chainId, '0x6080'), {
        ...onMainnet,
        evmChainId: chainId,
      }).catch((x: unknown) => x);
      expect((e as ChainError).code).toBe('NotSupported');
      expect((e as ChainError).message).toContain("a mainnet's");
    }
    const silent = { getChainId: () => new Promise(() => {}), getCode: async () => '0x6080' };
    const e = await assertNode(silent as unknown as EvmRpc, record, 50).catch((x: unknown) => x);
    expect((e as ChainError).code).toBe('Unavailable');
  });
});

describe('amounts', () => {
  it('scales exactly, with no float', () => {
    expect(toScaled('2.55')).toBe(2_550_000_000_000_000_000n);
    expect(fromScaled(23_033_340_675n, 8)).toBe('230.33340675');
    expect(fromScaled(100_000_000n, 8)).toBe('1');
    expect(multiplierString(1_000_775_159_164_630_595n)).toBe('1.000775159164630595');
    expect(() => multiplierString(0n)).toThrow();
    expect(displayAmount(120_000_000_000_000_000n, '1.000775159164630595', 18)).toBe(
      '0.1200930190997556714',
    );
    expect(displayAmount(50_000_000n, '1', 6)).toBe('50');
  });
});

describe('the session', () => {
  // 2026-10-05 is a Monday.
  const monday = 1_791_158_400n;
  const rules = { sessionOpen: 52_200, sessionClose: 72_000, closedUntil: 0n, closedToday: false };
  it('is open Monday to Friday from the open to before the close, by UTC', () => {
    expect(dayOf(monday)).toBe(20_731);
    expect(marketAt('us_equity', rules, monday + 52_199n)).toBe('closed');
    expect(marketAt('us_equity', rules, monday + 52_200n)).toBe('open');
    expect(marketAt('us_equity', rules, monday + 71_999n)).toBe('open');
    expect(marketAt('us_equity', rules, monday + 72_000n)).toBe('closed');
    expect(marketAt('us_equity', rules, monday + 4n * 86_400n + 60_000n)).toBe('open');
    expect(marketAt('us_equity', rules, monday + 5n * 86_400n + 60_000n)).toBe('closed');
    expect(marketAt('us_equity', rules, monday - 86_400n + 60_000n)).toBe('closed');
  });
  it('is closed on a closed day and before closedUntil, and always open for an asset that always trades', () => {
    const at = monday + 60_000n;
    expect(marketAt('us_equity', { ...rules, closedToday: true }, at)).toBe('closed');
    expect(marketAt('us_equity', { ...rules, closedUntil: at + 1n }, at)).toBe('closed');
    expect(marketAt('us_equity', { ...rules, closedUntil: at }, at)).toBe('open');
    expect(marketAt('always', { ...rules, closedToday: true }, monday)).toBe('open');
  });
});

describe('unlisted tokens', () => {
  it('get an id made from the address, and give the address back', () => {
    const tsla = '0x322F0929c4625eD5bAd873c95208D54E1c003b2d';
    const id = unlistedAssetId('robinhood', tsla);
    expect(id).toBe('robinhood:token-322f0929c4625ed5bad873c95208d54e1c003b2d');
    expect(unlistedToken(id)).toBe(tsla.toLowerCase());
    expect(unlistedToken('robinhood:nvda')).toBeNull();
    expect(() => unlistedAssetId('robinhood', '0x12')).toThrow();
  });
});

describe('a revert', () => {
  const abi = parseAbi([
    'error NotOwner(address caller)',
    'error DeadlinePassed(uint64 deadline, uint64 now)',
    'error CreatorLimit(uint8 reason)',
    'error ReentrancyGuardReentrantCall()',
    'error Nobody()',
  ]);
  it("is the contract's code, with its name and numbers in the message", () => {
    const owner = revertToChainError(
      encodeErrorResult({ abi, errorName: 'NotOwner', args: [A(5) as `0x${string}`] }),
    );
    expect([owner.code, owner.message]).toEqual(['NotOwner', `NotOwner(${A(5)})`]);
    const late = revertToChainError(
      encodeErrorResult({ abi, errorName: 'DeadlinePassed', args: [10n, 11n] }),
    );
    expect([late.code, late.retryable]).toEqual(['Expired', CHAIN_ERROR_RETRYABLE.Expired]);
    const limit = revertToChainError(
      encodeErrorResult({ abi, errorName: 'CreatorLimit', args: [12] }),
    );
    expect([limit.code, limit.message]).toEqual(['CreatorLimit', 'CreatorLimit(12)']);
  });
  it('is Unknown, named where it can be, for anything else', () => {
    expect(
      revertToChainError(encodeErrorResult({ abi, errorName: 'ReentrancyGuardReentrantCall' })),
    ).toMatchObject({ code: 'Unknown', message: 'ReentrancyGuardReentrantCall()' });
    expect(revertToChainError(encodeErrorResult({ abi, errorName: 'Nobody' })).code).toBe(
      'Unknown',
    );
    expect(revertToChainError(undefined).code).toBe('Unknown');
    expect(revertToChainError('0x').code).toBe('Unknown');
  });
});

describe('the reader, made', () => {
  const record = EvmDeploymentRecord.parse(RECORD);
  const config = (env: Record<string, string>, contracts = deploymentAddresses(record)) =>
    parseChainConfigs(env, {
      robinhood: { factory: contracts.factory, registry: contracts.registry },
    }).robinhood;
  const rpc = {} as EvmRpc;

  it('takes an EVM config with a factory and a registry, and labels a test network sandbox', () => {
    const reader = createEvmVaultReader({
      config: config({}),
      rpc,
      assets: deploymentAssets(record),
    });
    expect(reader).toMatchObject({
      chain: 'robinhood',
      provenance: 'sandbox',
      factory: A(1),
      registry: A(2),
      capabilities: {
        trade: 'readonly',
        autoFollow: false,
        maxTradesPerTx: 8,
        tradesInCreate: true,
        needsApprove: true,
      },
    });
  });

  it('refuses at once what it cannot read with: no factory, two cash tokens, a Scope price, another chain', () => {
    const assets = deploymentAssets(record);
    const [cash, nvda] = assets;
    if (!cash || !nvda) throw new Error('no assets');
    const bad: Parameters<typeof createEvmVaultReader>[0][] = [
      { config: parseChainConfigs({}).robinhood, rpc, assets },
      { config: parseChainConfigs({}).solana, rpc, assets },
      { config: config({}), rpc, assets: [cash, { ...nvda, cls: 'cash' }] },
      { config: config({}), rpc, assets: [cash, { ...nvda, priceKind: 'scope', priceRef: '3' }] },
      { config: config({}), rpc, assets: [cash, { ...nvda, priceRef: 'feed' }] },
      { config: config({}), rpc, assets: [cash, { ...nvda, id: 'base:nvda', chain: 'base' }] },
      { config: config({}), rpc, assets: [cash, cash] },
    ];
    for (const options of bad) expect(() => createEvmVaultReader(options)).toThrow();
  });
});
