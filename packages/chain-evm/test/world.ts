import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Abi,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseAbi,
} from 'viem';
import { foundry } from 'viem/chains';
import type { EvmDeploymentRecord } from '../src/vault/deployment';
import { revertDataOf, revertToChainError } from '../src/vault/errors';
import {
  BASKET_VAULT_ABI,
  INDEX_REGISTRY_ABI,
  VAULT_FACTORY_ABI,
} from '../src/vault/generated/abi';

// A world of vaults on a local copy of Robinhood Chain: anvil forks mainnet at the block the contract
// tests pin, and the test deploys our contracts on it as `contracts/script/Deploy.s.sol` does, then
// lists the real dollar token and real stock tokens with the real NVDA feed, opens vaults and publishes
// shared portfolios. Nothing is sent to any network: every transaction goes to the anvil this starts,
// from anvil's own unlocked accounts or an account it impersonates. No key is held here.
//
// It needs Foundry (anvil) and the built contracts (`cd contracts && forge build`), and an archive RPC
// of Robinhood Chain in RH_FORK_URL (https://robinhood.drpc.org serves the pinned block; the chain's own
// public RPC does not keep that much history).

export const PINNED_BLOCK = 77_417_307n;
/** Not mainnet's 4663: a signature made on this copy must not be good on mainnet. */
export const FORK_CHAIN_ID = 31_337;

const CONTRACTS = join(import.meta.dirname, '..', '..', '..', 'contracts');

// Real tokens and feeds of Robinhood Chain mainnet (contracts/test/fork, scripts/risk-evm/config.ts).
export const REAL = {
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  nvda: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  spy: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
  gld: '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e',
  meta: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35',
  tsla: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  msft: '0xe93237c50d904957cf27e7b1133b510c669c2e74',
  nvdaFeed: '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15',
  usdgFeed: '0x61b7e5650328764b076a108eff5fa7282a1b9ad2',
  nvdaHolder: '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3',
  usdgHolder: '0xfbcc34e25937282a3d0fbde054a9a49e9968c51a',
} as const;

/** NVDA's beacon proxy keeps its multiplier here (read from a trace on the fork): the one before, the next, and when. */
const NVDA_MULTIPLIER_SLOTS = {
  before: '0x395525728d1d6f4af44d273368682dd92b28e7464d750ef3212d3cb7f5959d00',
  next: '0x395525728d1d6f4af44d273368682dd92b28e7464d750ef3212d3cb7f5959d01',
  at: '0x395525728d1d6f4af44d273368682dd92b28e7464d750ef3212d3cb7f5959d02',
} as const;

// anvil's own accounts: unlocked by anvil, funded with ether, keys never needed here.
export const ACCOUNTS = {
  deployer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  guardian: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  keeper: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  owner: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  owner2: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
} as const;
/** An address that holds nothing on this chain and owns no vault. */
export const STRANGER = '0x00000000000000000000000000000000c0ffee01';

const PARAMS = {
  toleranceBps: 125,
  lossCapBps: 100,
  bandBps: 50,
  assetCooldown: 3600,
  sessionOpen: 52_200,
  sessionClose: 72_000,
} as const;
const PUBLISH_DELAY = 60;
const MAX_AGE = 93_600;
export const DEPOSIT_RAW = 50_000_000n;
export const NVDA_GIFT = 120_000_000_000_000_000n;
/** What the owner holds of the 8-decimal token: 1.23456789 of it. */
export const BTC8_HELD = 123_456_789n;
/** The multiplier the world schedules on NVDA, a week after the later of the two clocks. */
export const SCHEDULED_MULTIPLIER = 1_010_000_000_000_000_000n;

const PAUSED = '0x5c975abb';
const EFFECTIVE_AT = '0x97a4064f';

const ERC20 = parseAbi([
  'function transfer(address, uint256) returns (bool)',
  'function approve(address, uint256) returns (bool)',
]);
const MOCK_FEED = parseAbi(['function set(int256 answer, uint256 updatedAt)']);
const MINTABLE = parseAbi(['function mint(address to, uint256 amount)']);

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(CONTRACTS, 'out', file, `${name}.json`), 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export type World = {
  rpcUrl: string;
  record: EvmDeploymentRecord;
  feeds: {
    nvdaAverage: Address;
    spy: Address;
    gld: Address;
    meta: Address;
    tsla: Address;
    btc8: Address;
  };
  /** A token of 8 decimals of our own (the contracts' MockToken), listed as such. */
  btc8: Address;
  /** The first vault: follows `recipeA` at version 1 with auto-follow on; version 2 is in effect. */
  vault: Address;
  /** Its own target on SPY, auto-follow off, and NVDA sent in with no target on it. */
  manualVault: Address;
  /** Follows `recipeB` at version 1, auto-follow on; version 2 adds META, version 3 waits. */
  newAssetVault: Address;
  /** owner2's: follows `recipeC`, which holds TSLA, a token the factory lists and the app does not. */
  unlistedVault: Address;
  recipeA: Hex;
  recipeB: Hex;
  recipeC: Hex;
  familyA: Hex;
  /** NVDA's scheduled multiplier takes effect then. */
  scheduledAt: bigint;
  /** A deposit that landed. */
  landedTxId: Hex;
  /** A call that landed and reverted with `NotOwner`. */
  revertedTxId: Hex;
  /** The fork's clock when the world was done. */
  builtAt: bigint;
};

export type Fork = { world: World; stop(): void; client: PublicClient };

/** Starts anvil on `port`, forked at the pinned block, and resolves once it answers. */
async function startAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    'anvil',
    [
      '--fork-url',
      forkUrl,
      '--fork-block-number',
      PINNED_BLOCK.toString(),
      '--chain-id',
      String(FORK_CHAIN_ID),
      '--port',
      String(port),
      '--silent',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
    },
  );
  let said = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    said = (said + chunk.toString()).slice(-2_000);
  });
  const url = `http://127.0.0.1:${port}`;
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    if (Date.now() > until || child.exitCode !== null) {
      child.kill('SIGTERM');
      throw new Error(`anvil did not start: ${said.replaceAll(forkUrl, '<fork url>')}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

const sorted = (weights: { token: Address; bps: number }[]) =>
  [...weights].sort((a, b) => (BigInt(a.token) < BigInt(b.token) ? -1 : 1));

export async function buildWorld(forkUrl: string, port: number): Promise<Fork> {
  const anvil = await startAnvil(forkUrl, port);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = http(rpcUrl, { timeout: 60_000 });
  const client = createPublicClient({ chain: foundry, transport });
  const wallet = createWalletClient({ chain: foundry, transport });
  const test = createTestClient({ chain: foundry, mode: 'anvil', transport });

  try {
    const mined = async (hash: Hex) => {
      const receipt = await client.waitForTransactionReceipt({ hash });
      return receipt;
    };
    const send = async (from: Address, to: Address, data: Hex, gas?: bigint) =>
      mined(await wallet.sendTransaction({ account: from, to, data, ...(gas ? { gas } : {}) }));
    const call = async (
      from: Address,
      to: Address,
      abi: Abi | readonly unknown[],
      functionName: string,
      args: readonly unknown[] = [],
    ) => {
      const data = encodeFunctionData({ abi: abi as Abi, functionName, args } as never);
      // Simulated first, so a call that would revert says why instead of failing on its gas.
      await client.call({ account: from, to, data }).catch((e: unknown) => {
        throw new Error(
          `${functionName} would revert: ${revertToChainError(revertDataOf(e)).message}`,
        );
      });
      const receipt = await send(from, to, data);
      if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
      return receipt;
    };
    const deploy = async (file: string, name: string, args: readonly unknown[] = []) => {
      const { abi, bytecode } = artifact(file, name);
      const hash = await wallet.deployContract({
        account: ACCOUNTS.deployer,
        abi,
        bytecode,
        args: args as never,
      });
      const receipt = await mined(hash);
      if (!receipt.contractAddress) throw new Error(`${name} was not created`);
      return receipt.contractAddress.toLowerCase() as Address;
    };
    const as = async <T>(who: Address, work: () => Promise<T>) => {
      await test.impersonateAccount({ address: who });
      await test.setBalance({ address: who, value: 10n ** 18n });
      try {
        return await work();
      } finally {
        await test.stopImpersonatingAccount({ address: who });
      }
    };
    const clock = async () => (await client.getBlock()).timestamp;

    // On a fork the accounts keep what mainnet gives them, which can be nothing: gas for each.
    for (const address of Object.values(ACCOUNTS))
      await test.setBalance({ address, value: 100n * 10n ** 18n });

    // The platform, as Deploy.s.sol makes it.
    const vaultLogic = await deploy('BasketVault.sol', 'BasketVault');
    const beacon = await deploy('VaultBeacon.sol', 'VaultBeacon', [vaultLogic, ACCOUNTS.deployer]);
    const factoryLogic = await deploy('VaultFactory.sol', 'VaultFactory');
    const factory = await deploy('ERC1967Proxy.sol', 'ERC1967Proxy', [
      factoryLogic,
      encodeFunctionData({
        abi: VAULT_FACTORY_ABI,
        functionName: 'initialize',
        args: [ACCOUNTS.deployer, beacon, PARAMS],
      }),
    ]);
    const registryLogic = await deploy('IndexRegistry.sol', 'IndexRegistry');
    const registry = await deploy('ERC1967Proxy.sol', 'ERC1967Proxy', [
      registryLogic,
      encodeFunctionData({
        abi: INDEX_REGISTRY_ABI,
        functionName: 'initialize',
        args: [factory, PUBLISH_DELAY],
      }),
    ]);
    const admin = ACCOUNTS.deployer;
    const onFactory = (fn: string, args: readonly unknown[]) =>
      call(admin, factory, VAULT_FACTORY_ABI, fn, args);
    await onFactory('setRegistry', [registry]);
    await onFactory('setGuardian', [ACCOUNTS.guardian]);
    await onFactory('setKeeper', [ACCOUNTS.keeper]);
    await onFactory('setPriceDevBps', [200]);

    // Feeds of our own where the chain has none we can use: NVDA's one-hour average, and a price for
    // each other stock. SPY's is two days old: stale against its 26-hour limit.
    const now = await clock();
    const feed = async (answer: bigint, updatedAt: bigint) => {
      const address = await deploy('Feeds.sol', 'MockFeed');
      await call(admin, address, MOCK_FEED, 'set', [answer, updatedAt]);
      return address;
    };
    const nvdaRound = (await client.readContract({
      address: REAL.nvdaFeed,
      abi: parseAbi([
        'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
      ]),
      functionName: 'latestRoundData',
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const feeds = {
      nvdaAverage: await feed(nvdaRound[1], nvdaRound[3]),
      spy: await feed(600_00000000n, now - 200_000n),
      gld: await feed(290_00000000n, now - 60n),
      meta: await feed(700_00000000n, now - 60n),
      tsla: await feed(400_00000000n, now - 60n),
      btc8: await feed(60_000_00000000n, now - 60n),
    };
    const none = '0x0000000000000000000000000000000000000000';
    const assetConfig = (
      token: Address,
      c: {
        feed: Address;
        tokenDecimals: number;
        session: number;
        keeper?: { average: Address; min: bigint; max: bigint };
        stock?: boolean;
      },
    ) => ({
      feed: c.feed,
      tokenDecimals: c.tokenDecimals,
      feedDecimals: 8,
      maxAge: MAX_AGE,
      session: c.session,
      source: 1,
      maxWeightBps: 5000,
      pauseProbe: c.stock ? token : none,
      pauseSelector: c.stock ? PAUSED : '0x00000000',
      scheduleSelector: c.stock ? EFFECTIVE_AT : '0x00000000',
      haltUntil: 0n,
      flags: c.keeper ? 1 : 0,
      averageFeed: c.keeper?.average ?? none,
      minPrice: c.keeper?.min ?? 0n,
      maxPrice: c.keeper?.max ?? 0n,
    });
    const list = (token: Address, c: Parameters<typeof assetConfig>[1]) =>
      onFactory('setAsset', [token, assetConfig(token, c)]);
    await list(REAL.usdg, { feed: REAL.usdgFeed, tokenDecimals: 6, session: 0 });
    await list(REAL.nvda, {
      feed: REAL.nvdaFeed,
      tokenDecimals: 18,
      session: 1,
      stock: true,
      keeper: { average: feeds.nvdaAverage, min: 150_00000000n, max: 300_00000000n },
    });
    await list(REAL.spy, { feed: feeds.spy, tokenDecimals: 18, session: 1, stock: true });
    await list(REAL.gld, { feed: feeds.gld, tokenDecimals: 18, session: 0, stock: true });
    await list(REAL.meta, { feed: feeds.meta, tokenDecimals: 18, session: 1, stock: true });
    await list(REAL.tsla, { feed: feeds.tsla, tokenDecimals: 18, session: 1, stock: true });
    // Listed and taken off again: a retired asset.
    await list(REAL.msft, { feed: feeds.meta, tokenDecimals: 18, session: 1, stock: true });
    await onFactory('removeAsset', [REAL.msft]);
    // Decimals 6 (USDG), 18 (the stock tokens) and 8: a token of our own, which the owner holds.
    const btc8 = await deploy('Tokens.sol', 'MockToken', [8]);
    await list(btc8, { feed: feeds.btc8, tokenDecimals: 8, session: 0 });
    await call(admin, btc8, MINTABLE, 'mint', [ACCOUNTS.owner, BTC8_HELD]);
    await onFactory('setCashToken', [REAL.usdg]);

    // The owners' cash, from a holder of the real dollar token.
    await as(REAL.usdgHolder, async () => {
      await call(REAL.usdgHolder, REAL.usdg, ERC20, 'transfer', [ACCOUNTS.owner, 1_000_000_000n]);
      await call(REAL.usdgHolder, REAL.usdg, ERC20, 'transfer', [ACCOUNTS.owner2, 200_000_000n]);
    });

    // Shared portfolios. The id is keccak256(abi.encode(creator, familyId)).
    const family = (name: string) => keccak256(new TextEncoder().encode(`ade-1 ${name}`));
    const indexId = (creator: Address, familyId: Hex) =>
      keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator, familyId]),
      );
    const meta = (n: number) => keccak256(new TextEncoder().encode(`meta ${n}`));
    const publishFirst = (creator: Address, familyId: Hex, w: { token: Address; bps: number }[]) =>
      call(creator, registry, INDEX_REGISTRY_ABI, 'create', [familyId, sorted(w), meta(1), 0, 0]);
    const publishNext = (
      creator: Address,
      id: Hex,
      w: { token: Address; bps: number }[],
      n: number,
    ) => call(creator, registry, INDEX_REGISTRY_ABI, 'publish', [id, sorted(w), meta(n)]);

    const familyA = family('a');
    const familyB = family('b');
    const familyC = family('c');
    const recipeA = indexId(ACCOUNTS.owner, familyA);
    const recipeB = indexId(ACCOUNTS.owner, familyB);
    const recipeC = indexId(ACCOUNTS.owner2, familyC);
    await publishFirst(ACCOUNTS.owner, familyA, [
      { token: REAL.nvda, bps: 4000 },
      { token: REAL.spy, bps: 3000 },
      { token: REAL.gld, bps: 3000 },
    ]);
    await publishFirst(ACCOUNTS.owner, familyB, [
      { token: REAL.nvda, bps: 4000 },
      { token: REAL.spy, bps: 3000 },
      { token: REAL.gld, bps: 3000 },
    ]);
    await publishFirst(ACCOUNTS.owner2, familyC, [
      { token: REAL.nvda, bps: 4000 },
      { token: REAL.spy, bps: 3000 },
      { token: REAL.tsla, bps: 3000 },
    ]);

    // Vaults, each created with its first deposit: the owner approves the vault's address first.
    const deadline = (await clock()) + 3_600n;
    const open = async (
      owner: Address,
      plan: bigint,
      w: { token: Address; bps: number }[],
      index: Hex,
      autoFollow: boolean,
    ) => {
      const vault = (
        (await client.readContract({
          address: factory,
          abi: VAULT_FACTORY_ABI,
          functionName: 'vaultOf',
          args: [owner, `0x${plan.toString(16).padStart(64, '0')}`],
        })) as string
      ).toLowerCase() as Address;
      await call(owner, REAL.usdg, ERC20, 'approve', [vault, DEPOSIT_RAW]);
      const receipt = await call(owner, factory, VAULT_FACTORY_ABI, 'createVaultAndBuy', [
        `0x${plan.toString(16).padStart(64, '0')}`,
        sorted(w),
        index,
        index === `0x${'0'.repeat(64)}` ? 0 : 1,
        autoFollow,
        DEPOSIT_RAW,
        [],
        deadline,
      ]);
      return { vault, receipt };
    };
    const zero = `0x${'0'.repeat(64)}` as Hex;
    const { vault, receipt: landed } = await open(ACCOUNTS.owner, 7n, [], recipeA, true);
    const { vault: manualVault } = await open(
      ACCOUNTS.owner,
      8n,
      [{ token: REAL.spy, bps: 5000 }],
      zero,
      false,
    );
    const { vault: newAssetVault } = await open(ACCOUNTS.owner, 9n, [], recipeB, true);
    const { vault: unlistedVault } = await open(ACCOUNTS.owner2, 1n, [], recipeC, true);

    // A position in the first vault: NVDA sent in by a holder (the builders' swaps are ADE-2's).
    // And NVDA in the manual vault, which has no target on it: what was sent in stays the owner's.
    await as(REAL.nvdaHolder, async () => {
      await call(REAL.nvdaHolder, REAL.nvda, ERC20, 'transfer', [vault, NVDA_GIFT]);
      await call(REAL.nvdaHolder, REAL.nvda, ERC20, 'transfer', [manualVault, NVDA_GIFT / 2n]);
    });

    // Recipe A's version 2 changes weights only; B's version 2 adds META. A version may follow the last
    // one only a publish delay later, and takes effect a delay after it is published. Then B's version
    // 3, which waits.
    const later = async () => {
      await test.increaseTime({ seconds: PUBLISH_DELAY + 1 });
      await test.mine({ blocks: 1 });
    };
    await later();
    await publishNext(
      ACCOUNTS.owner,
      recipeA,
      [
        { token: REAL.nvda, bps: 3000 },
        { token: REAL.spy, bps: 3000 },
        { token: REAL.gld, bps: 4000 },
      ],
      2,
    );
    await publishNext(
      ACCOUNTS.owner,
      recipeB,
      [
        { token: REAL.nvda, bps: 3000 },
        { token: REAL.spy, bps: 3000 },
        { token: REAL.gld, bps: 2000 },
        { token: REAL.meta, bps: 2000 },
      ],
      2,
    );
    await later();
    await publishNext(
      ACCOUNTS.owner,
      recipeB,
      [
        { token: REAL.nvda, bps: 3000 },
        { token: REAL.spy, bps: 2500 },
        { token: REAL.gld, bps: 2500 },
        { token: REAL.meta, bps: 2000 },
      ],
      3,
    );

    // A multiplier the issuer has scheduled on NVDA: the one in force stays, the next waits a week
    // past the later of the fork's clock and the wall clock.
    const inForce = await client.getStorageAt({
      address: REAL.nvda,
      slot: NVDA_MULTIPLIER_SLOTS.next,
    });
    const wall = BigInt(Math.floor(Date.now() / 1000));
    const forkNow = await clock();
    const scheduledAt = (wall > forkNow ? wall : forkNow) + 7n * 86_400n;
    const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
    await test.setStorageAt({
      address: REAL.nvda,
      index: NVDA_MULTIPLIER_SLOTS.before,
      value: inForce ?? word(0n),
    });
    await test.setStorageAt({
      address: REAL.nvda,
      index: NVDA_MULTIPLIER_SLOTS.next,
      value: word(SCHEDULED_MULTIPLIER),
    });
    await test.setStorageAt({
      address: REAL.nvda,
      index: NVDA_MULTIPLIER_SLOTS.at,
      value: word(scheduledAt),
    });

    // A call that lands and reverts: the keeper sets the targets of a vault it does not own.
    const reverted = await send(
      ACCOUNTS.keeper,
      vault,
      encodeFunctionData({ abi: BASKET_VAULT_ABI, functionName: 'setTargets', args: [[]] }),
      200_000n,
    );
    if (reverted.status !== 'reverted') throw new Error('the reverted call landed');

    const record: EvmDeploymentRecord = {
      network: 'robinhood-local',
      chain: 'robinhood',
      provenance: 'sandbox',
      evmChainId: FORK_CHAIN_ID,
      deployBlock: Number(PINNED_BLOCK) + 1,
      contracts: { factory, registry, beacon, vaultLogic, factoryLogic, registryLogic },
      roles: {
        admin,
        guardian: ACCOUNTS.guardian,
        keeper: ACCOUNTS.keeper,
        priceWriter: null,
        tokenIssuer: null,
      },
      routers: [],
      sequencerFeed: null,
      cash: {
        id: 'robinhood:usdg',
        symbol: 'USDG',
        name: 'Global Dollar',
        address: REAL.usdg,
        decimals: 6,
      },
      assets: [
        stock('nvda', 'NVDA', REAL.nvda, REAL.nvdaFeed, feeds.nvdaAverage, 1, true),
        stock('spy', 'SPY', REAL.spy, feeds.spy, none, 1, false, 'etf'),
        stock('gld', 'GLD', REAL.gld, feeds.gld, none, 0, false, 'gold'),
        stock('meta', 'META', REAL.meta, feeds.meta, none, 1, false),
        {
          ...stock('btc8', 'BTC8', btc8, feeds.btc8, none, 0, false, 'crypto'),
          decimals: 8,
        },
      ],
      retired: [{ id: 'robinhood:msft', symbol: 'MSFT', address: REAL.msft }],
    };
    return {
      client: client as unknown as PublicClient,
      stop: () => anvil.kill('SIGTERM'),
      world: {
        rpcUrl,
        record,
        feeds,
        btc8,
        vault,
        manualVault,
        newAssetVault,
        unlistedVault,
        recipeA,
        recipeB,
        recipeC,
        familyA,
        scheduledAt,
        landedTxId: landed.transactionHash,
        revertedTxId: reverted.transactionHash,
        builtAt: await clock(),
      },
    };
  } catch (e) {
    anvil.kill('SIGTERM');
    throw e;
  }
}

function stock(
  slug: string,
  symbol: string,
  address: Address,
  feed: Address,
  averageFeed: Address,
  session: 0 | 1,
  keeperOn: boolean,
  kind: 'stock' | 'etf' | 'gold' | 'crypto' = 'stock',
): EvmDeploymentRecord['assets'][number] {
  return {
    id: `robinhood:${slug}`,
    symbol,
    name: symbol,
    address,
    decimals: 18,
    modelOf: symbol,
    kind,
    feed,
    feedDecimals: 8,
    averageFeed,
    maxAge: MAX_AGE,
    session,
    maxWeightBps: 5000,
    keeperOn,
    range: keeperOn ? { minPrice: '15000000000', maxPrice: '30000000000' } : null,
  };
}
