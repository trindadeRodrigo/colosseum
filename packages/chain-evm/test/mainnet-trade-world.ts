import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuiltTx, parseChainConfigs } from '@colosseum/schemas';
import {
  type Abi,
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  type Hex,
  http,
  type PublicClient,
  parseAbi,
  parseAbiParameters,
} from 'viem';
import { foundry } from 'viem/chains';
import { createEvmVaultAdapter, type EvmVaultAdapter } from '../src/vault/adapter';
import {
  deploymentAssets,
  deploymentLimits,
  deploymentPools,
  type EvmDeploymentRecord,
} from '../src/vault/deployment';
import { INDEX_REGISTRY_ABI, VAULT_FACTORY_ABI } from '../src/vault/generated/abi';
import { swapCalldata } from '../src/vault/routes';
import { createEvmRpc } from '../src/vault/rpc';

// The vault platform on a local copy of Robinhood Chain MAINNET, for the owner's trades: the real
// dollar token, the real NVDA and GLD tokens with their real Chainlink feeds, the real Universal
// Router and their real Uniswap v4 pools. The adapter builds, anvil's accounts sign, nothing leaves
// this machine. It needs anvil (Foundry), `forge build` in contracts/ and a node of Robinhood Chain
// that keeps old state in RH_FORK_URL.
//
// The block is RH_FORK_BLOCK, by default the one each listed token's pool was measured at
// (contracts/test/fork/ForkBlock.sol, ROBINHOOD-MAINNET-SCOPE of 2026-10-12).

export const FORK_BLOCK = BigInt(process.env.RH_FORK_BLOCK ?? 86_735_800);
const CHAIN_ID = 31_337;
const CONTRACTS = join(import.meta.dirname, '..', '..', '..', 'contracts');

export const MAINNET = {
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  usdgHolder: '0xfbcc34e25937282a3d0fbde054a9a49e9968c51a',
  nvda: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  nvdaFeed: '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15',
  gld: '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e',
  gldFeed: '0x470a51258068043bd43dc0a56245625c9fe86eb0',
  aapl: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
  aaplFeed: '0x6b22a786baa607d76728168703a39ea9c99f2cd0',
  tsla: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  tslaFeed: '0x4a1166a659a55625345e9515b32adecea5547c38',
  msft: '0xe93237c50d904957cf27e7b1133b510c669c2e74',
  msftFeed: '0x45c3c877c15e6ba2ebb19ea114ea508d14c1af2e',
  router: '0x204faca1764b154221e35c0d20abb3c525710498',
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
} as const;

// anvil's own accounts: unlocked by anvil, keys never needed here.
export const ACCOUNTS = {
  deployer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  guardian: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  owner: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  /** Whoever pushes a pool: a stranger with money. */
  pusher: '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
} as const;

/** The bound and the limits of contracts/script/config/4663.json, for the two tokens listed here. */
export const BOUND_BPS = 200;
export const RAIL_BPS = 1_000;
/** 4663.json's `sessionPriceAge`: a feed's answer is live for an hour. */
export const LIVE_SECONDS = 3_600;
/** 4663.json's `maxTradeUsdNotLive` and `staleRailMaxAge`: $20,000 a trade, four days. */
export const MAX_TRADE_USD_NOT_LIVE = 20_000;
export const RAIL_MAX_AGE = 4 * 86_400;
/**
 * Each token's average pool, from contracts/script/config/pool-feeds/4663.json: its Uniswap v3 pool
 * against USDG and the floor on its liquidity. NVDA's keeps 7,200 observations and is usable; GLD's
 * keeps 1,800, under an hour's worth, and is not.
 */
export const AVERAGE = {
  nvda: {
    pool: '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3',
    minLiquidity: '1900000000000000000',
    usable: true,
  },
  gld: {
    pool: '0xba2f1ed4ceb2169d538d1e614d847e83c5a55913',
    minLiquidity: '880000000000000000',
    usable: false,
  },
  msft: {
    pool: '0xeb60bcd1d920ad6e102690ccfc6fb488899e1510',
    minLiquidity: '80000000000000000',
    usable: true,
  },
  aapl: {
    pool: '0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d',
    minLiquidity: '200000000000000000',
    usable: true,
  },
  tsla: {
    pool: '0xf4acdaeeb7022862a763c9b1b885e11191c889e3',
    minLiquidity: '130000000000000000',
    usable: true,
  },
} as const;
/** The fee of each average pool (Uniswap v3), for a stranger's trade in it. */
export const AVERAGE_FEE = { nvda: 500, gld: 500, msft: 3000, aapl: 500, tsla: 3000 } as const;
export const MAX_TRADE_USD = {
  nvda: 50_000,
  gld: 1_000,
  msft: 5_000,
  aapl: 50_000,
  tsla: 50_000,
} as const;
const MAX_AGE = 93_600;
export const OWNER_CASH = 20_000_000_000n;
const PUSHER_CASH = 400_000_000_000n;

const ERC20 = parseAbi([
  'function transfer(address, uint256) returns (bool)',
  'function approve(address, uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const PERMIT2 = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const PAUSED = '0x5c975abb';
const EFFECTIVE_AT = '0x97a4064f';
const NONE = '0x0000000000000000000000000000000000000000' as Address;

export type MainnetTradeWorld = {
  adapter: EvmVaultAdapter;
  client: PublicClient;
  record: EvmDeploymentRecord;
  /** Sends a built step as its signer and waits for it; throws when it reverts. */
  land(tx: BuiltTx): Promise<void>;
  /** The same, and says whether it reverted instead of throwing. */
  send(tx: BuiltTx): Promise<'success' | 'reverted'>;
  /**
   * A stranger trades `amountIn` of `tokenIn` for `tokenOut` in the asset's own pool, through the real
   * router: what pushing a pool is. Returns what the stranger received.
   */
  push(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint>;
  /** The same in the asset's average pool, a Uniswap v3 pool at `fee`. */
  pushAverage(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint): Promise<bigint>;
  rpcUrl: string;
  balanceOf(token: Address, holder: Address): Promise<bigint>;
  vaultOf(basketId: string): Promise<Address>;
  /** Moves the copy's clock on and mines a block. */
  later(seconds: number): Promise<void>;
  stop(): void;
};

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(CONTRACTS, 'out', file, `${name}.json`), 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function startAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    'anvil',
    [
      '--fork-url',
      forkUrl,
      '--fork-block-number',
      FORK_BLOCK.toString(),
      '--chain-id',
      String(CHAIN_ID),
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
      // The fork URL may carry a key: it is never repeated.
      throw new Error(`anvil did not start: ${said.replaceAll(forkUrl, '<fork url>')}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function buildMainnetTradeWorld(
  forkUrl: string,
  port: number,
): Promise<MainnetTradeWorld> {
  const anvil = await startAnvil(forkUrl, port);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = http(rpcUrl, { timeout: 120_000 });
  const client = createPublicClient({ chain: foundry, transport });
  const wallet = createWalletClient({ chain: foundry, transport });
  const test = createTestClient({ chain: foundry, mode: 'anvil', transport });
  try {
    const mined = (hash: Hex) => client.waitForTransactionReceipt({ hash });
    const call = async (
      from: Address,
      to: Address,
      abi: Abi | readonly unknown[],
      functionName: string,
      args: readonly unknown[] = [],
    ) => {
      const data = encodeFunctionData({ abi: abi as Abi, functionName, args } as never);
      const receipt = await mined(await wallet.sendTransaction({ account: from, to, data }));
      if (receipt.status !== 'success') throw new Error(`${functionName} reverted on the copy`);
    };
    const deploy = async (file: string, name: string, args: readonly unknown[] = []) => {
      const { abi, bytecode } = artifact(file, name);
      const receipt = await mined(
        await wallet.deployContract({
          account: ACCOUNTS.deployer,
          abi,
          bytecode,
          args: args as never,
        }),
      );
      if (!receipt.contractAddress) throw new Error(`${name} was not created`);
      return receipt.contractAddress.toLowerCase() as Address;
    };
    for (const address of Object.values(ACCOUNTS))
      await test.setBalance({ address, value: 100n * 10n ** 18n });

    // The platform, as Deploy.s.sol makes it, the admin left with the deployer: nothing here is about keys.
    const vaultLogic = await deploy('BasketVault.sol', 'BasketVault');
    const beacon = await deploy('VaultBeacon.sol', 'VaultBeacon', [vaultLogic, ACCOUNTS.deployer]);
    const factoryLogic = await deploy('VaultFactory.sol', 'VaultFactory');
    const factory = await deploy('ERC1967Proxy.sol', 'ERC1967Proxy', [
      factoryLogic,
      encodeFunctionData({
        abi: VAULT_FACTORY_ABI,
        functionName: 'initialize',
        args: [
          ACCOUNTS.deployer,
          beacon,
          {
            toleranceBps: 125,
            lossCapBps: 100,
            bandBps: 50,
            assetCooldown: 3600,
            sessionOpen: 52_200,
            sessionClose: 72_000,
          },
        ],
      }),
    ]);
    const registryLogic = await deploy('IndexRegistry.sol', 'IndexRegistry');
    const registry = await deploy('ERC1967Proxy.sol', 'ERC1967Proxy', [
      registryLogic,
      encodeFunctionData({
        abi: INDEX_REGISTRY_ABI,
        functionName: 'initialize',
        args: [factory, 172_800],
      }),
    ]);
    const onFactory = (fn: string, args: readonly unknown[]) =>
      call(ACCOUNTS.deployer, factory, VAULT_FACTORY_ABI, fn, args);
    await onFactory('setRegistry', [registry]);
    await onFactory('setGuardian', [ACCOUNTS.guardian]);
    // The assets as 4663.json lists them: owner-signed only, no keeper switch, no average feed.
    const listed = (token: Address, feed: Address, tokenDecimals: number, stock: boolean) =>
      onFactory('setAsset', [
        token,
        {
          feed,
          tokenDecimals,
          feedDecimals: stock ? 8 : 0,
          maxAge: stock ? MAX_AGE : 0,
          session: stock ? 1 : 0,
          source: stock ? 1 : 0,
          maxWeightBps: 0,
          pauseProbe: stock ? token : NONE,
          pauseSelector: stock ? PAUSED : '0x00000000',
          scheduleSelector: stock ? EFFECTIVE_AT : '0x00000000',
          haltUntil: 0n,
          flags: 0,
          averageFeed: NONE,
          minPrice: 0n,
          maxPrice: 0n,
        },
      ]);
    await listed(MAINNET.usdg, NONE, 6, false);
    await listed(MAINNET.nvda, MAINNET.nvdaFeed, 18, true);
    await listed(MAINNET.gld, MAINNET.gldFeed, 18, true);
    await listed(MAINNET.msft, MAINNET.msftFeed, 18, true);
    // Two tokens with a feed of our own (the contracts' MockFeed), each the real feed's last answer
    // moved, at the real feed's own time: a feed that last spoke before the market moved. AAPL's is
    // 12% under the real one, past the rail; TSLA's is 3% under, an ordinary move overnight.
    const ROUND = parseAbi([
      'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
    ]);
    const behind = async (feed: Address, times: bigint, over: bigint) => {
      const real = (await client.readContract({
        address: feed,
        abi: ROUND,
        functionName: 'latestRoundData',
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const ours = await deploy('Feeds.sol', 'MockFeed');
      await call(ACCOUNTS.deployer, ours, parseAbi(['function set(int256, uint256)']), 'set', [
        (real[1] * times) / over,
        real[3],
      ]);
      return ours;
    };
    const aaplFeed = await behind(MAINNET.aaplFeed, 88n, 100n);
    const tslaFeed = await behind(MAINNET.tslaFeed, 100n, 103n);
    await listed(MAINNET.tsla, tslaFeed, 18, true);
    await listed(MAINNET.aapl, aaplFeed, 18, true);
    await onFactory('setCashToken', [MAINNET.usdg]);
    await onFactory('setRouter', [MAINNET.router, 2]);

    // Real dollars for the owner and for the stranger, from a holder of the real token.
    await test.impersonateAccount({ address: MAINNET.usdgHolder });
    await test.setBalance({ address: MAINNET.usdgHolder, value: 10n ** 18n });
    await call(MAINNET.usdgHolder, MAINNET.usdg, ERC20, 'transfer', [ACCOUNTS.owner, OWNER_CASH]);
    await call(MAINNET.usdgHolder, MAINNET.usdg, ERC20, 'transfer', [ACCOUNTS.pusher, PUSHER_CASH]);
    await test.stopImpersonatingAccount({ address: MAINNET.usdgHolder });

    const stock = (
      slug: 'nvda' | 'gld' | 'msft' | 'aapl' | 'tsla',
      address: Address,
      feed: Address,
      kind: 'stock' | 'gold',
      pool: { fee: number; tickSpacing: number },
    ): EvmDeploymentRecord['assets'][number] => ({
      id: `robinhood:${slug}`,
      symbol: slug.toUpperCase(),
      name: slug.toUpperCase(),
      address,
      decimals: 18,
      modelOf: slug.toUpperCase(),
      kind,
      feed,
      feedDecimals: 8,
      averageFeed: NONE,
      maxAge: MAX_AGE,
      session: 1,
      maxWeightBps: 0,
      keeperOn: false,
      range: null,
      pool,
      maxTradeUsd: MAX_TRADE_USD[slug],
      average: AVERAGE[slug],
    });
    const record: EvmDeploymentRecord = {
      network: 'robinhood-local',
      chain: 'robinhood',
      provenance: 'sandbox',
      evmChainId: CHAIN_ID,
      deployBlock: Number(FORK_BLOCK) + 1,
      contracts: { factory, registry, beacon, vaultLogic, factoryLogic, registryLogic },
      roles: {
        admin: ACCOUNTS.deployer,
        guardian: ACCOUNTS.guardian,
        keeper: NONE,
        priceWriter: null,
        tokenIssuer: null,
      },
      sequencerFeed: null,
      priceBoundBps: BOUND_BPS,
      staleRailBps: RAIL_BPS,
      sessionPriceAge: LIVE_SECONDS,
      maxTradeUsdNotLive: MAX_TRADE_USD_NOT_LIVE,
      staleRailMaxAge: RAIL_MAX_AGE,
      routers: [{ address: MAINNET.router, pull: 2 }],
      cash: {
        id: 'robinhood:usdg',
        symbol: 'USDG',
        name: 'Global Dollar',
        address: MAINNET.usdg,
        decimals: 6,
      },
      assets: [
        stock('nvda', MAINNET.nvda, MAINNET.nvdaFeed, 'stock', { fee: 100, tickSpacing: 1 }),
        stock('gld', MAINNET.gld, MAINNET.gldFeed, 'gold', { fee: 2100, tickSpacing: 21 }),
        stock('msft', MAINNET.msft, MAINNET.msftFeed, 'stock', { fee: 3000, tickSpacing: 60 }),
        stock('aapl', MAINNET.aapl, aaplFeed, 'stock', { fee: 3000, tickSpacing: 60 }),
        stock('tsla', MAINNET.tsla, tslaFeed, 'stock', { fee: 3000, tickSpacing: 60 }),
      ],
      retired: [],
    };
    const pools = deploymentPools(record);
    const config = parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: 'local', CHAIN_ROUTER_ROBINHOOD: MAINNET.router },
      { robinhood: { factory, registry } },
    ).robinhood;
    const adapter = createEvmVaultAdapter({
      config,
      rpc: createEvmRpc(rpcUrl),
      assets: deploymentAssets(record),
      pools,
      limits: deploymentLimits(record),
      trade: 'live',
      autoFollow: false,
    });

    const send = async (tx: BuiltTx) => {
      const hash = await wallet.sendTransaction({
        account: tx.signer as Address,
        to: tx.evm?.to as Address,
        data: tx.payload as Hex,
        value: 0n,
        // A step that will revert still has to land, so its gas is not estimated.
        gas: BigInt(tx.evm?.gas ?? 3_000_000),
        chain: foundry,
      });
      return (await mined(hash)).status;
    };
    const balanceOf = (token: Address, holder: Address) =>
      client.readContract({
        address: token,
        abi: ERC20,
        functionName: 'balanceOf',
        args: [holder],
      });
    // The stranger's standing approvals, as any trader of the router has them.
    for (const token of [
      MAINNET.usdg,
      MAINNET.nvda,
      MAINNET.gld,
      MAINNET.msft,
      MAINNET.tsla,
    ] as const) {
      await call(ACCOUNTS.pusher, token, ERC20, 'approve', [MAINNET.permit2, (1n << 256n) - 1n]);
      await call(ACCOUNTS.pusher, MAINNET.permit2, PERMIT2, 'approve', [
        token,
        MAINNET.router,
        (1n << 160n) - 1n,
        281_474_976_710_655,
      ]);
    }

    return {
      adapter,
      client,
      record,
      send,
      land: async (tx) => {
        if ((await send(tx)) !== 'success') throw new Error(`${tx.description} reverted`);
      },
      push: async (tokenIn, tokenOut, amountIn) => {
        const before = await balanceOf(tokenOut, ACCOUNTS.pusher);
        const deadline = (await client.getBlock()).timestamp + 600n;
        const receipt = await mined(
          await wallet.sendTransaction({
            account: ACCOUNTS.pusher,
            to: MAINNET.router,
            data: swapCalldata(pools, { tokenIn, tokenOut, amountIn, deadline }),
            gas: 1_500_000n,
          }),
        );
        if (receipt.status !== 'success') throw new Error('the push reverted on the copy');
        return (await balanceOf(tokenOut, ACCOUNTS.pusher)) - before;
      },
      pushAverage: async (tokenIn, tokenOut, fee, amountIn) => {
        const before = await balanceOf(tokenOut, ACCOUNTS.pusher);
        const deadline = (await client.getBlock()).timestamp + 600n;
        // Universal Router 2.1's V3_SWAP_EXACT_IN: (recipient, amountIn, amountOutMin, path, payerIsUser,
        // minHopPriceX36), the last left empty.
        const input = encodeAbiParameters(
          parseAbiParameters('address, uint256, uint256, bytes, bool, uint256[]'),
          [
            ACCOUNTS.pusher,
            amountIn,
            0n,
            encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, tokenOut]),
            true,
            [],
          ],
        );
        const receipt = await mined(
          await wallet.sendTransaction({
            account: ACCOUNTS.pusher,
            to: MAINNET.router,
            data: encodeFunctionData({
              abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']),
              functionName: 'execute',
              args: ['0x00', [input], deadline],
            }),
            gas: 3_000_000n,
          }),
        );
        if (receipt.status !== 'success') throw new Error('the push of the average pool reverted');
        return (await balanceOf(tokenOut, ACCOUNTS.pusher)) - before;
      },
      rpcUrl,
      balanceOf,
      vaultOf: async (basketId) =>
        (
          (await client.readContract({
            address: factory,
            abi: VAULT_FACTORY_ABI,
            functionName: 'vaultOf',
            args: [ACCOUNTS.owner, `0x${BigInt(basketId).toString(16).padStart(64, '0')}`],
          })) as string
        ).toLowerCase() as Address,
      later: async (seconds) => {
        await test.increaseTime({ seconds });
        await test.mine({ blocks: 1 });
      },
      stop: () => anvil.kill('SIGTERM'),
    };
  } catch (e) {
    anvil.kill('SIGTERM');
    throw e;
  }
}
