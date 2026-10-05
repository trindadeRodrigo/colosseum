import { adapterContract, type ReadsFixture } from '@colosseum/chain-mock/contract';
import {
  type BasketAsset,
  ChainError,
  type ChainErrorCode,
  isStalePrice,
  Price,
  parseChainConfigs,
  Recipe,
  TxStatus,
  VaultState,
} from '@colosseum/schemas';
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
} from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { displayAmount, fromScaled, multiplierString } from '../src/vault/amounts';
import {
  assertNode,
  deploymentAddresses,
  deploymentAssets,
  EvmDeploymentRecord,
} from '../src/vault/deployment';
import { VAULT_FACTORY_ABI } from '../src/vault/generated/abi';
import { marketAt } from '../src/vault/market';
import {
  createEvmVaultReader,
  type EvmVaultReader,
  GAS_NEW_VAULT,
  GAS_PER_LEG,
  GAS_PRICE_HEADROOM,
} from '../src/vault/reader';
import { createEvmRpc } from '../src/vault/rpc';
import { unlistedAssetId } from '../src/vault/unlisted';
import {
  ACCOUNTS,
  BTC8_HELD,
  buildWorld,
  DEPOSIT_RAW,
  type Fork,
  NVDA_GIFT,
  REAL,
  SCHEDULED_MULTIPLIER,
  STRANGER,
  type World,
} from './world';

// The EVM reader on a fork of Robinhood Chain mainnet (ADE-1). anvil forks the chain at a pinned block,
// the world deploys our contracts on it with the real dollar token, real stock tokens and the real NVDA
// feed, and every case reads it through the reader over real JSON-RPC. Nothing is sent to any network.
// It runs only when asked, since it needs anvil, the built contracts and an archive RPC:
//
//   cd contracts && forge build && cd ..
//   RH_FORK_URL=https://robinhood.drpc.org pnpm exec vitest run packages/chain-evm/test/fork.test.ts
//
// RH_FORK_PORT moves anvil off 28645.
//
// First the adapter contract's `reads` group (packages/chain-mock/src/contract.ts), the cases every
// adapter is held to. Then what this reader shows beyond the contract: exact balances, targets,
// multipliers and prices, the versions of shared portfolios, the factory's settings, the transactions
// that landed, and what it refuses.

const FORK_URL = process.env.RH_FORK_URL;
const PORT = Number(process.env.RH_FORK_PORT ?? 28_645);

const id = (slug: string) => `robinhood:${slug}`;

/** Parses, and fails on a field the schema does not name. */
function exact<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.parse(value);
  expect(value).toEqual(parsed);
  return parsed;
}

async function refuses(work: Promise<unknown>, code: ChainErrorCode): Promise<ChainError> {
  const outcome = await work.then(
    () => 'answered' as const,
    (e: unknown) => e,
  );
  expect(outcome, `expected a refusal with ${code}`).toBeInstanceOf(ChainError);
  expect((outcome as ChainError).code).toBe(code);
  return outcome as ChainError;
}

describe.skipIf(!FORK_URL)('on a fork of Robinhood Chain', () => {
  // Starting anvil and building the world sends about fifty transactions to it.
  vi.setConfig({ hookTimeout: 300_000, testTimeout: 120_000 });

  const notBefore = new Date().toISOString();
  let fork: Promise<Fork> | undefined;
  const start = () => {
    fork ??= buildWorld(FORK_URL ?? '', PORT);
    return fork;
  };
  afterAll(async () => (await fork)?.stop());

  const configOf = (world: World, network = 'local') => {
    const { factory, registry } = deploymentAddresses(world.record);
    return parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: network },
      { robinhood: { factory, registry } },
    ).robinhood;
  };
  const readerOn = async (
    change: { assets?: (a: BasketAsset[]) => BasketAsset[] } = {},
    stateOverride?: Parameters<typeof createEvmVaultReader>[0]['stateOverride'],
  ): Promise<{ reader: EvmVaultReader; world: World; fork: Fork }> => {
    const f = await start();
    const assets = deploymentAssets(f.world.record);
    const reader = createEvmVaultReader({
      config: configOf(f.world),
      rpc: createEvmRpc(f.world.rpcUrl),
      assets: change.assets ? change.assets(assets) : assets,
      ...(stateOverride ? { stateOverride } : {}),
    });
    return { reader, world: f.world, fork: f };
  };

  adapterContract(
    'robinhood reader, fork of mainnet',
    async (): Promise<ReadsFixture> => {
      const { reader, world } = await readerOn();
      return {
        adapter: reader,
        provenance: 'sandbox',
        notBefore,
        owner: ACCOUNTS.owner,
        stranger: STRANGER,
        vault: world.vault,
        manualVault: world.manualVault,
        newAssetVault: world.newAssetVault,
        depositRaw: DEPOSIT_RAW.toString(),
        unknownTxId: `0x${'11'.repeat(32)}`,
        stalePriced: id('spy'),
        scheduledAsset: id('nvda'),
      };
    },
    { groups: ['reads'] },
  );

  describe('what the reader shows beyond the contract', () => {
    const wallet = () =>
      createWalletClient({ chain: foundry, transport: http(`http://127.0.0.1:${PORT}`) });
    const sendAs = async (from: Address, to: Address, data: Hex) => {
      const f = await start();
      const hash = await wallet().sendTransaction({ account: from, to, data });
      const receipt = await f.client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
    };

    it('reads the record the world would commit', async () => {
      const { world } = await readerOn();
      const record = EvmDeploymentRecord.parse(JSON.parse(JSON.stringify(world.record)));
      expect(record).toEqual(world.record);
      expect(deploymentAssets(record).map((a) => a.id)).toEqual([
        id('usdg'),
        id('nvda'),
        id('spy'),
        id('gld'),
        id('meta'),
        id('btc8'),
      ]);
    });

    it('takes the node as the record says, and refuses another chain or a factory with no code', async () => {
      const { world } = await readerOn();
      const rpc = createEvmRpc(world.rpcUrl);
      await assertNode(rpc, world.record);
      await refuses(assertNode(rpc, { ...world.record, evmChainId: 46_630 }), 'NotSupported');
      await refuses(
        assertNode(rpc, {
          ...world.record,
          contracts: { ...world.record.contracts, factory: STRANGER },
        }),
        'NotSupported',
      );
    });

    it("reads the factory's settings, the pause included", async () => {
      const { reader, world } = await readerOn();
      const platform = await reader.getPlatform();
      expect(platform).toMatchObject({
        factory: world.record.contracts.factory,
        registry: world.record.contracts.registry,
        cashToken: REAL.usdg,
        keeper: ACCOUNTS.keeper,
        guardian: ACCOUNTS.guardian,
        admin: ACCOUNTS.deployer,
        keeperPaused: false,
        launched: false,
        closedUntil: 0,
        priceDevBps: 200,
        sequencerFeed: null,
        params: {
          toleranceBps: 125,
          lossCapBps: 100,
          bandBps: 50,
          assetCooldown: 3600,
          sessionOpen: 52_200,
          sessionClose: 72_000,
        },
        today: { closed: false },
      });
      const factory = world.record.contracts.factory as Address;
      const call = (fn: 'pauseKeeper' | 'unpauseKeeper') =>
        encodeFunctionData({ abi: VAULT_FACTORY_ABI, functionName: fn });
      await sendAs(ACCOUNTS.guardian, factory, call('pauseKeeper'));
      expect((await reader.getPlatform()).keeperPaused).toBe(true);
      await sendAs(ACCOUNTS.deployer, factory, call('unpauseKeeper'));
      expect((await reader.getPlatform()).keeperPaused).toBe(false);
    });

    it("reads each asset's settings: the keeper's switch, the feeds, the range, and what was taken off", async () => {
      const { reader, world } = await readerOn();
      const settings = await reader.getAssetSettings();
      const of = (token: string) => settings.find((s) => s.address === token);
      expect(settings.map((s) => s.address)).toEqual([
        REAL.usdg,
        REAL.nvda,
        REAL.spy,
        REAL.gld,
        REAL.meta,
        REAL.tsla,
        world.btc8,
        REAL.msft,
      ]);
      expect(of(REAL.nvda)).toEqual({
        asset: id('nvda'),
        address: REAL.nvda,
        listed: true,
        feed: REAL.nvdaFeed,
        averageFeed: world.feeds.nvdaAverage,
        tokenDecimals: 18,
        feedDecimals: 8,
        maxAge: 93_600,
        session: 'us_equity',
        source: 1,
        maxWeightBps: 5000,
        pauseProbe: REAL.nvda,
        pauseSelector: '0x5c975abb',
        scheduleSelector: '0x97a4064f',
        haltUntil: 0,
        keeperOn: true,
        range: { minPrice: '15000000000', maxPrice: '30000000000' },
      });
      expect(of(REAL.gld)).toMatchObject({ session: 'always', keeperOn: false, range: null });
      expect(of(REAL.usdg)).toMatchObject({
        asset: id('usdg'),
        pauseProbe: null,
        tokenDecimals: 6,
      });
      // Listed by the factory and not by the app, and one taken off the list.
      expect(of(REAL.tsla)).toMatchObject({
        asset: unlistedAssetId('robinhood', REAL.tsla),
        listed: true,
      });
      expect(of(REAL.msft)).toMatchObject({
        asset: unlistedAssetId('robinhood', REAL.msft),
        listed: false,
      });
    });

    it("prices from the factory's feeds: the real NVDA feed to the digit, by the block's clock", async () => {
      const { reader, fork } = await readerOn();
      const prices = await reader.getPrices([id('nvda'), id('spy'), id('gld'), id('usdg')]);
      for (const p of prices) exact(Price, p);
      // Cash is a dollar to the vault and has no feed of its own here.
      expect(prices.map((p) => p.asset)).toEqual([id('nvda'), id('spy'), id('gld')]);
      const block = await fork.client.getBlock();
      const [, answer, , updatedAt] = (await fork.client.readContract({
        address: REAL.nvdaFeed,
        abi: parseAbi([
          'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
        ]),
        functionName: 'latestRoundData',
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const [nvda, spy, gld] = prices;
      expect(nvda).toMatchObject({
        usdPerToken: fromScaled(answer, 8),
        ageSeconds: Number(block.timestamp - updatedAt),
        maxAgeSeconds: 93_600,
        provenance: 'sandbox',
        market: marketAt(
          'us_equity',
          { sessionOpen: 52_200, sessionClose: 72_000, closedUntil: 0n, closedToday: false },
          block.timestamp,
        ),
      });
      expect(nvda?.source).toContain(REAL.nvdaFeed);
      expect(Number(nvda?.usdPerToken)).toBeGreaterThan(100);
      expect(spy && isStalePrice(spy)).toBe(true);
      expect(gld).toMatchObject({ usdPerToken: '290', market: 'open' });
      expect(gld && isStalePrice(gld)).toBe(false);
      await refuses(reader.getPrices([id('aapl')]), 'MintNotAccepted');
    });

    it('refuses an asset list whose feed or cash token is not the factory’s', async () => {
      const { reader: wrongFeed } = await readerOn({
        assets: (list) =>
          list.map((a) => (a.id === id('gld') ? { ...a, priceRef: REAL.nvdaFeed } : a)),
      });
      const e = await refuses(wrongFeed.getPrices([id('gld')]), 'Unavailable');
      expect(e.retryable).toBe(false);
      const { reader: wrongCash, world } = await readerOn({
        assets: (list) => list.map((a) => (a.cls === 'cash' ? { ...a, address: REAL.tsla } : a)),
      });
      const e2 = await refuses(wrongCash.getVault(world.vault), 'Unavailable');
      expect([e2.retryable, e2.message.includes("the factory's cash token")]).toEqual([
        false,
        true,
      ]);
    });

    it("holds each listed token's decimals to the factory's, at 6, 8 and 18", async () => {
      const { reader, world } = await readerOn();
      const held = await reader.getWalletHoldings(ACCOUNTS.owner);
      expect(held.find((h) => h.asset === id('btc8'))).toEqual({
        asset: id('btc8'),
        raw: BTC8_HELD.toString(),
        multiplier: '1',
        display: '1.23456789',
      });
      const settled = (await reader.getAssetSettings()).map((x) => [x.asset, x.tokenDecimals]);
      expect(settled).toContainEqual([id('usdg'), 6]);
      expect(settled).toContainEqual([id('btc8'), 8]);
      expect(settled).toContainEqual([id('nvda'), 18]);
      const at = (slug: string, decimals: number) => (list: BasketAsset[]) =>
        list.map((a) => (a.id === id(slug) ? { ...a, decimals } : a));
      // Each read that shows a balance or a price refuses a list off by a power of ten.
      const cases = [
        [at('usdg', 18), (r: EvmVaultReader) => r.getVault(world.vault)],
        [at('nvda', 8), (r: EvmVaultReader) => r.getVaults(ACCOUNTS.owner)],
        [at('btc8', 6), (r: EvmVaultReader) => r.getWalletHoldings(ACCOUNTS.owner)],
        [at('btc8', 18), (r: EvmVaultReader) => r.getPrices([id('btc8')])],
      ] as const;
      for (const [assets, read] of cases) {
        const { reader: wrong } = await readerOn({ assets });
        const e = await refuses(read(wrong), 'Unavailable');
        expect(e.retryable).toBe(false);
        expect(e.message).toContain('decimals');
      }
    });

    it('refuses a stock token that answers no multiplier, and reads none on a token that has no need of one', async () => {
      const { reader: asStock } = await readerOn({
        assets: (list) =>
          list.map((a) => (a.id === id('btc8') ? { ...a, cls: 'stock' as const } : a)),
      });
      const e = await refuses(asStock.getWalletHoldings(ACCOUNTS.owner), 'Unknown');
      expect(e.message).toContain('uiMultiplier()');
      const { reader } = await readerOn();
      const held = await reader.getWalletHoldings(ACCOUNTS.owner);
      expect(held.find((h) => h.asset === id('usdg'))?.multiplier).toBe('1');
    });

    it('reads only a node on the chain id of its config', async () => {
      const { world } = await readerOn();
      const onTestnet = createEvmVaultReader({
        config: configOf(world, 'testnet'),
        rpc: createEvmRpc(world.rpcUrl),
        assets: deploymentAssets(world.record),
      });
      const e = await refuses(onTestnet.getPlatform(), 'Unavailable');
      expect(e.message).toContain('31337');
    });

    it('names the pinned block and the override in every eth_call of a read', async () => {
      const { world } = await readerOn();
      const seen: { method: string; params: unknown[] }[] = [];
      const spy = createPublicClient({
        transport: custom({
          async request({ method, params }) {
            seen.push({ method, params: params as unknown[] });
            const res = await fetch(world.rpcUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            });
            const body = (await res.json()) as {
              result?: unknown;
              error?: { code: number; message: string; data?: unknown };
            };
            if (body.error) throw Object.assign(new Error(body.error.message), body.error);
            return body.result;
          },
        }),
      });
      // Harmless: the balance of an address nobody reads.
      const override = [{ address: STRANGER as Address, balance: 1n }];
      const reader = createEvmVaultReader({
        config: configOf(world),
        rpc: spy as never,
        assets: deploymentAssets(world.record),
        stateOverride: override,
      });
      const reads: [string, () => Promise<unknown>][] = [
        ['getVault', () => reader.getVault(world.vault)],
        ['getVaults', () => reader.getVaults(ACCOUNTS.owner)],
        ['getPrices', () => reader.getPrices([id('nvda'), id('spy'), id('btc8')])],
        ['getRecipe', () => reader.getRecipe(world.recipeB)],
        ['listAutoFollowVaults', () => reader.listAutoFollowVaults()],
        ['getWalletHoldings', () => reader.getWalletHoldings(ACCOUNTS.owner)],
        [
          'funding',
          () => reader.funding(ACCOUNTS.owner, { cashRaw: '1', legs: 1, newVault: false }),
        ],
        ['getPlatform', () => reader.getPlatform()],
        ['getAssetSettings', () => reader.getAssetSettings()],
      ];
      for (const [name, read] of reads) {
        seen.length = 0;
        await read();
        const calls = seen.filter((r) => r.method === 'eth_call');
        expect(calls.length, name).toBeGreaterThan(0);
        const blocks = new Set(calls.map((c) => c.params[1]));
        expect(blocks.size, `${name}: one block`).toBe(1);
        expect([...blocks][0], `${name}: a block number`).toMatch(/^0x[0-9a-f]+$/);
        for (const c of calls)
          expect(
            Object.keys(c.params[2] ?? {}).map((k) => k.toLowerCase()),
            `${name}: the override`,
          ).toEqual([STRANGER]);
      }
    });

    it('hands every call the state override it was given, for a chain read without a fork', async () => {
      const { world } = await readerOn();
      // MockFeed keeps its answer in slot 0.
      const { reader } = await readerOn({}, [
        {
          address: world.feeds.gld,
          stateDiff: [
            {
              slot: `0x${'0'.repeat(64)}`,
              value: `0x${(123n * 10n ** 8n).toString(16).padStart(64, '0')}`,
            },
          ],
        },
      ]);
      const [gld] = await reader.getPrices([id('gld')]);
      expect(gld?.usdPerToken).toBe('123');
    });

    it('reads a vault to the unit: targets, balances, multipliers, the version it follows and the one in effect', async () => {
      const { reader, world, fork } = await readerOn();
      const vault = exact(VaultState, await reader.getVault(world.vault));
      const before = multiplierString(1_000_775_159_164_630_595n);
      // SPY and GLD carry their issuer's multiplier too, as the tokens answer it.
      const multiplierOf = async (token: Address) =>
        multiplierString(
          (await fork.client.readContract({
            address: token,
            abi: parseAbi(['function uiMultiplier() view returns (uint256)']),
            functionName: 'uiMultiplier',
          })) as bigint,
        );
      const [spyMultiplier, gldMultiplier] = [
        await multiplierOf(REAL.spy),
        await multiplierOf(REAL.gld),
      ];
      expect(spyMultiplier).not.toBe('1');
      expect(vault).toMatchObject({
        chain: 'robinhood',
        address: world.vault,
        owner: ACCOUNTS.owner,
        basketId: '7',
        recipeOnchainId: world.recipeA,
        acceptedVersion: 1,
        autoFollow: true,
        keeper: ACCOUNTS.keeper,
        cash: {
          asset: id('usdg'),
          raw: DEPOSIT_RAW.toString(),
          multiplier: '1',
          display: '50',
        },
        lossUsedBps: 0,
      });
      // Version 2 is in effect and changes weights only: the keeper may adopt it.
      expect(vault.pending).toMatchObject({ version: 2, newAssets: [] });
      // In the order the vault keeps them: by token address.
      expect(vault.positions).toEqual([
        {
          asset: id('spy'),
          raw: '0',
          multiplier: spyMultiplier,
          display: '0',
          targetBps: 3000,
          lastKeeperAt: null,
        },
        {
          asset: id('gld'),
          raw: '0',
          multiplier: gldMultiplier,
          display: '0',
          targetBps: 3000,
          lastKeeperAt: null,
        },
        {
          asset: id('nvda'),
          raw: NVDA_GIFT.toString(),
          multiplier: before,
          display: displayAmount(NVDA_GIFT, before, 18),
          scheduled: {
            multiplier: multiplierString(SCHEDULED_MULTIPLIER),
            effectiveAt: Number(world.scheduledAt),
          },
          targetBps: 4000,
          lastKeeperAt: null,
        },
      ]);
    });

    it('shows a listed token held with no target on it at a weight of zero', async () => {
      const { reader, world } = await readerOn();
      const manual = await reader.getVault(world.manualVault);
      expect(manual).toMatchObject({ autoFollow: false, recipeOnchainId: null, pending: null });
      expect(manual?.positions.map((p) => [p.asset, p.targetBps, p.raw])).toEqual([
        [id('spy'), 5000, '0'],
        [id('nvda'), 0, (NVDA_GIFT / 2n).toString()],
      ]);
    });

    it('names the assets a version would add, and reads the version that waits', async () => {
      const { reader, world } = await readerOn();
      const waiting = await reader.getVault(world.newAssetVault);
      expect(waiting?.pending).toMatchObject({ version: 2, newAssets: [id('meta')] });
      const { active, pending } = await reader.getRecipe(world.recipeB);
      exact(Recipe, active);
      expect(active).toMatchObject({
        version: 2,
        creator: ACCOUNTS.owner,
        onchainId: world.recipeB,
      });
      expect(active.components.map((c) => c.kind === 'asset' && c.asset)).toContain(id('meta'));
      expect(pending?.version).toBe(3);
      expect(pending?.effectiveAt).toBeGreaterThan(active.effectiveAt);

      const a = await reader.getRecipe(world.recipeA);
      expect(a.pending).toBeNull();
      expect(a.active).toMatchObject({
        version: 2,
        familyId: world.familyA.slice(2),
        metaHash: keccak256(new TextEncoder().encode('meta 2')).slice(2),
        kind: 'community',
        chain: 'robinhood',
      });
    });

    it('shows a target the app does not list under an id made from its address', async () => {
      const { reader, world } = await readerOn();
      const tsla = unlistedAssetId('robinhood', REAL.tsla);
      const [vault] = await reader.getVaults(ACCOUNTS.owner2);
      expect(vault?.address).toBe(world.unlistedVault);
      expect(vault?.positions.map((p) => p.asset)).toContain(tsla);
      const { active } = await reader.getRecipe(world.recipeC);
      expect(active.components).toContainEqual({ kind: 'asset', asset: tsla, weightBps: 3000 });
    });

    it('lists the vaults with auto-follow on, and those that follow one shared portfolio', async () => {
      const { reader, world } = await readerOn();
      expect(await reader.listAutoFollowVaults()).toEqual(
        [world.vault, world.newAssetVault, world.unlistedVault].sort(),
      );
      expect(await reader.listAutoFollowVaults(world.recipeA)).toEqual([world.vault]);
      await refuses(reader.listAutoFollowVaults('nope'), 'BadInput');
    });

    it('takes only a vault the factory made, and refuses what is not an id', async () => {
      const { reader, world } = await readerOn();
      expect(await reader.getVault(REAL.nvda)).toBeNull();
      expect(await reader.getVaults(STRANGER)).toEqual([]);
      expect((await reader.getVaults(ACCOUNTS.owner)).map((v) => v.basketId)).toEqual([
        '7',
        '8',
        '9',
      ]);
      await refuses(reader.getVaults(world.vault.toUpperCase().replace('0X', '0x')), 'BadInput');
      await refuses(reader.getRecipe('0x1234'), 'BadInput');
      await refuses(
        reader.getRecipe(keccak256(new TextEncoder().encode('none'))),
        'RecipeNotFound',
      );
      await refuses(
        reader.quote({ sell: id('usdg'), buy: id('nvda'), amountInRaw: '1' }, ACCOUNTS.owner),
        'NotSupported',
      );
    });

    it('tracks what landed, what reverted and why, and what can no longer land', async () => {
      const { reader, world } = await readerOn();
      expect(exact(TxStatus, await reader.track(world.landedTxId))).toEqual({
        status: 'confirmed',
        explorerUrl: '',
      });
      expect(exact(TxStatus, await reader.track(world.revertedTxId))).toMatchObject({
        status: 'reverted',
        error: { code: 'NotOwner' },
      });
      const never = `0x${'22'.repeat(32)}`;
      expect((await reader.track(never, '1')).status).toBe('expired');
      expect((await reader.track(never, String(2n ** 40n))).status).toBe('pending');
      expect((await reader.track(never)).status).toBe('pending');
      await refuses(reader.track('0x12'), 'BadInput');
    });

    it('reads the multiplier the token answers once its time has come, and nothing scheduled', async () => {
      const { reader, world, fork } = await readerOn();
      const test = createTestClient({
        chain: foundry,
        mode: 'anvil',
        transport: http(`http://127.0.0.1:${PORT}`),
      });
      const block = await fork.client.getBlock();
      const snapshot = await test.snapshot();
      try {
        await test.setNextBlockTimestamp({
          timestamp: world.scheduledAt > block.timestamp ? world.scheduledAt : block.timestamp + 1n,
        });
        await test.mine({ blocks: 1 });
        const vault = await reader.getVault(world.vault);
        const nvda = vault?.positions.find((p) => p.asset === id('nvda'));
        expect(nvda?.multiplier).toBe(multiplierString(SCHEDULED_MULTIPLIER));
        expect(nvda?.scheduled).toBeUndefined();
      } finally {
        await test.revert({ id: snapshot });
      }
    });

    it("counts the gas a plan's steps need at the node's price, doubled", async () => {
      const { reader, fork } = await readerOn();
      const funding = await reader.funding(ACCOUNTS.owner, {
        cashRaw: '1',
        legs: 3,
        newVault: true,
      });
      const price = await fork.client.getGasPrice();
      expect(BigInt(funding.gasNeedRaw)).toBe(
        (3n * GAS_PER_LEG + GAS_NEW_VAULT) * price * GAS_PRICE_HEADROOM,
      );
      expect(funding.gasHaveRaw).toBe(
        (await fork.client.getBalance({ address: ACCOUNTS.owner })).toString(),
      );
    });
  });
});
