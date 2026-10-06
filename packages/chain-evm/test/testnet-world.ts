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
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseAbi,
  stringToBytes,
} from 'viem';
import { createEvmVaultAdapter, type EvmVaultAdapter } from '../src/vault/adapter';
import {
  deploymentAddresses,
  deploymentAssets,
  EvmDeploymentRecord,
} from '../src/vault/deployment';
import { revertDataOf, revertToChainError } from '../src/vault/errors';
import { INDEX_REGISTRY_ABI, VAULT_FACTORY_ABI } from '../src/vault/generated/abi';
import { ROBINHOOD_TESTNET_POOLS } from '../src/vault/routes';
import { createEvmRpc } from '../src/vault/rpc';

// A world of vaults on a local copy of Robinhood Chain's test network (46630), as TNET-1 and TNET-2
// deployed it: anvil forks the network at its latest block, and every vault, shared portfolio, deposit
// and trade of the world is built by the adapter under test and sent to that anvil from anvil's own
// unlocked accounts. Nothing is sent to the test network itself, and no key is held here: anvil signs
// for its accounts, and impersonates the deployer, the market and the price writer for the set-up.
//
// Set-up the network's own keys would do and an agent may not (CLAUDE.md): on the copy only, the
// deployer sets the keeper to an anvil account, opens the keeper's session to the whole day (so the
// keeper's cases run outside US hours), and shortens the publish delay to its floor of 60 s.

const RECORD_FILE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'deployments',
  'robinhood-testnet.json',
);
export const TESTNET_RECORD = EvmDeploymentRecord.parse(
  JSON.parse(readFileSync(RECORD_FILE, 'utf8')),
);
/** The kit's market: it holds the minter role on every test token. */
const MARKET = '0xfca8d20550bf0f5424cfc8e8cbbc47af5f1546cc';

export const ACCOUNTS = {
  keeper: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  owner: '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
} as const;
export const STRANGER = '0x00000000000000000000000000000000c0ffee02';
export const DEPOSIT_RAW = 20_000_000n;

const ERC20 = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const FEED = parseAbi([
  'function write(int256 answer, uint256 updatedAt) returns (uint80)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);
const MARKET_ABI = parseAbi(['function recentre(address token) returns (bool)']);

export const id = (symbol: string) => `robinhood:${symbol.toLowerCase()}`;

export type TestnetWorld = {
  rpcUrl: string;
  adapter: EvmVaultAdapter;
  client: PublicClient;
  vault: Address;
  manualVault: Address;
  newAssetVault: Address;
  recipeA: Hex;
  recipeB: Hex;
  familyA: string;
  /** B's family id: its version 3 waits. */
  familyB: string;
  sign(tx: BuiltTx): Promise<string>;
  send(tx: BuiltTx): Promise<{ txId: string; validUntil?: string }>;
  withPriceMoved(asset: string, bps: number, work: () => Promise<void>): Promise<void>;
  /** Moves the test price of `asset` by `bps` and the market's pool with it, and leaves them moved. */
  movePrice(asset: string, bps: number): Promise<void>;
  /** Moves the copy's clock on by `seconds` and mines a block. */
  later(seconds: number): Promise<void>;
  /** Sends signed bytes as they are, with no preflight, and waits for the block: a revert still lands. */
  sendRaw(wire: string): Promise<string>;
  stop(): void;
};

async function startAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    'anvil',
    // No suggested priority fee, as the network itself suggests none: fees are the network's.
    ['--fork-url', forkUrl, '--port', String(port), '--no-priority-fee', '--silent'],
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

const family = (name: string) => keccak256(stringToBytes(`ade-2 ${name}`)).slice(2);
const meta = (name: string) => keccak256(stringToBytes(`ade-2 meta ${name}`)).slice(2);

export async function buildTestnetWorld(forkUrl: string, port: number): Promise<TestnetWorld> {
  const anvil = await startAnvil(forkUrl, port);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chain = {
    id: TESTNET_RECORD.evmChainId,
    name: 'Robinhood Chain testnet (local copy)',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const transport = http(rpcUrl, { timeout: 60_000 });
  const client = createPublicClient({ chain, transport }) as unknown as PublicClient;
  const wallet = createWalletClient({ chain, transport });
  const test = createTestClient({ chain, mode: 'anvil', transport });
  try {
    const { factory } = deploymentAddresses(TESTNET_RECORD);
    const registry = TESTNET_RECORD.contracts.registry as Address;
    const admin = TESTNET_RECORD.roles.admin as Address;
    const writer = TESTNET_RECORD.roles.priceWriter as Address;

    const mined = (hash: Hex) => client.waitForTransactionReceipt({ hash });
    /** A set-up call from an account anvil impersonates: simulated first, so a refusal says why. */
    const as = async (
      from: Address,
      to: Address,
      abi: Abi | readonly unknown[],
      fn: string,
      args: unknown[] = [],
    ) => {
      const data = encodeFunctionData({ abi: abi as Abi, functionName: fn, args } as never);
      await test.impersonateAccount({ address: from });
      await test.setBalance({ address: from, value: 10n ** 18n });
      try {
        await client.call({ account: from, to, data }).catch((e: unknown) => {
          throw new Error(`${fn} would revert: ${revertToChainError(revertDataOf(e)).message}`);
        });
        const receipt = await mined(
          await wallet.sendTransaction({ account: from, to, data, chain }),
        );
        if (receipt.status !== 'success') throw new Error(`${fn} reverted`);
      } finally {
        await test.stopImpersonatingAccount({ address: from });
      }
    };

    /** Sends what the adapter built, as its signer, on the nonce and gas it states, landing even if it reverts. */
    const send = async (tx: BuiltTx) => {
      const hash = await wallet.sendTransaction({
        account: tx.signer as Address,
        to: tx.evm?.to as Address,
        data: tx.payload as Hex,
        value: 0n,
        ...(tx.evm?.nonce !== undefined ? { nonce: tx.evm.nonce } : {}),
        ...(tx.evm?.gas !== undefined ? { gas: BigInt(tx.evm.gas) } : {}),
        chain,
      });
      await mined(hash);
      return {
        txId: hash,
        ...(tx.lastValidBlockHeight !== undefined
          ? { validUntil: String(tx.lastValidBlockHeight) }
          : {}),
      };
    };
    /** Signs as anvil's account, with the nonce and gas the build states, as an embedded wallet does. */
    const sign = async (tx: BuiltTx) => {
      const price = await client.getGasPrice();
      return (await client.request({
        method: 'eth_signTransaction' as never,
        params: [
          {
            from: tx.signer,
            to: tx.evm?.to,
            data: tx.payload,
            value: '0x0',
            nonce: `0x${(tx.evm?.nonce ?? 0).toString(16)}`,
            gas: `0x${(tx.evm?.gas ?? 21_000).toString(16)}`,
            maxFeePerGas: `0x${(2n * price).toString(16)}`,
            maxPriorityFeePerGas: '0x0',
            chainId: `0x${TESTNET_RECORD.evmChainId.toString(16)}`,
          },
        ] as never,
      })) as string;
    };
    const land = async (tx: BuiltTx) => {
      const { txId } = await send(tx);
      const receipt = await client.getTransactionReceipt({ hash: txId as Hex });
      if (receipt.status !== 'success') throw new Error(`${tx.description} reverted on the copy`);
    };

    for (const address of [ACCOUNTS.owner, ACCOUNTS.keeper])
      await test.setBalance({ address, value: 100n * 10n ** 18n });

    // The copy's own set-up, as the deployer: a keeper, the whole day as the session, the shortest delay.
    const [toleranceBps, lossCapBps, bandBps, assetCooldown] = (await client.readContract({
      address: factory as Address,
      abi: VAULT_FACTORY_ABI,
      functionName: 'params',
    })) as readonly [number, number, number, number, number, number];
    await as(admin, factory as Address, VAULT_FACTORY_ABI, 'setKeeper', [ACCOUNTS.keeper]);
    await as(admin, factory as Address, VAULT_FACTORY_ABI, 'setParams', [
      { toleranceBps, lossCapBps, bandBps, assetCooldown, sessionOpen: 0, sessionClose: 86_400 },
    ]);
    await as(admin, registry, INDEX_REGISTRY_ABI, 'setPublishDelay', [60]);
    // Test cash for the owner, minted by the market as it mints what its pools are owed.
    await as(MARKET, TESTNET_RECORD.cash.address as Address, ERC20, 'mint', [
      ACCOUNTS.owner,
      2_000_000_000n,
    ]);

    const config = parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: 'testnet' },
      { robinhood: { factory, registry } },
    ).robinhood;
    const adapter = createEvmVaultAdapter({
      config: { ...config, router: deploymentAddresses(TESTNET_RECORD).router },
      rpc: createEvmRpc(rpcUrl),
      assets: deploymentAssets(TESTNET_RECORD),
      pools: ROBINHOOD_TESTNET_POOLS,
      trade: 'live',
      autoFollow: true,
    });
    const owner = ACCOUNTS.owner;
    const later = async (seconds = 61) => {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
    };

    // Two shared portfolios of the owner's, each built by the adapter and sent.
    const recipe = (familyId: string, version: number, weights: [string, number][]) => ({
      schemaVersion: 1 as const,
      familyId,
      chain: 'robinhood' as const,
      onchainId: null,
      creator: owner,
      kind: 'community' as const,
      version,
      effectiveAt: 0,
      components: weights.map(([slug, weightBps]) => ({
        kind: 'asset' as const,
        asset: id(slug),
        weightBps,
      })),
      metaHash: meta(`${familyId}:${version}`),
      maxFeeBps: 0 as const,
      flags: 0 as const,
    });
    const familyA = family('a');
    const familyB = family('b');
    await land(
      await adapter.buildPublishRecipe({
        creator: owner,
        recipe: recipe(familyA, 1, [
          ['tspy', 4000],
          ['tqqq', 3000],
          ['tnvda', 3000],
        ]),
      }),
    );
    await land(
      await adapter.buildPublishRecipe({
        creator: owner,
        recipe: recipe(familyB, 1, [
          ['tspy', 4000],
          ['tqqq', 3000],
          ['tnvda', 3000],
        ]),
      }),
    );
    // The registry's id: keccak256(abi.encode(creator, familyId)).
    const indexOf = (familyId: string) =>
      keccak256(`0x${owner.slice(2).padStart(64, '0')}${familyId}` as Hex);
    const recipeA = indexOf(familyA);
    const recipeB = indexOf(familyB);

    // Three vaults, each approved and opened through the adapter.
    const open = async (basketId: string, args: Record<string, unknown>, deposit: bigint) => {
      await land(await adapter.buildApprove({ owner, basketId, amountRaw: deposit.toString() }));
      await land(
        await adapter.buildCreateVault({
          owner,
          basketId,
          targets: [],
          depositRaw: deposit.toString(),
          slippageBps: 100,
          ...args,
        } as never),
      );
      const vault = await client.readContract({
        address: factory as Address,
        abi: VAULT_FACTORY_ABI,
        functionName: 'vaultOf',
        args: [owner, `0x${BigInt(basketId).toString(16).padStart(64, '0')}`],
      });
      return (vault as string).toLowerCase() as Address;
    };
    const vault = await open(
      '1',
      {
        recipeOnchainId: recipeA,
        autoFollow: true,
        trades: [
          { sell: id('tusdg'), buy: id('tspy'), amountInRaw: '30000000' },
          { sell: id('tusdg'), buy: id('tqqq'), amountInRaw: '20000000' },
          { sell: id('tusdg'), buy: id('tnvda'), amountInRaw: '20000000' },
        ],
      },
      100_000_000n,
    );
    const manualVault = await open(
      '2',
      { targets: [{ asset: id('tspy'), weightBps: 5000 }], autoFollow: false },
      50_000_000n,
    );
    const newAssetVault = await open(
      '3',
      { recipeOnchainId: recipeB, autoFollow: true },
      50_000_000n,
    );

    // B's version 2 adds tAAPL and takes effect; its version 3 waits.
    await later();
    await land(
      await adapter.buildPublishRecipe({
        creator: owner,
        recipe: recipe(familyB, 2, [
          ['tspy', 3000],
          ['tqqq', 3000],
          ['tnvda', 2000],
          ['taapl', 2000],
        ]),
      }),
    );
    await later();
    await land(
      await adapter.buildPublishRecipe({
        creator: owner,
        recipe: recipe(familyB, 3, [
          ['tspy', 3000],
          ['tqqq', 2500],
          ['tnvda', 2500],
          ['taapl', 2000],
        ]),
      }),
    );

    // The approvals the contract's cases spend: twice the deposit for the first vault, once for the
    // manual one, once for a plan not yet opened.
    await land(
      await adapter.buildApprove({
        owner,
        basketId: '1',
        amountRaw: (2n * DEPOSIT_RAW).toString(),
      }),
    );
    await land(
      await adapter.buildApprove({ owner, basketId: '2', amountRaw: DEPOSIT_RAW.toString() }),
    );
    await land(
      await adapter.buildApprove({ owner, basketId: '77', amountRaw: DEPOSIT_RAW.toString() }),
    );

    const movePrice = async (assetId: string, bps: number) => {
      // The test price moves, and the market moves its pool to it.
      const a = TESTNET_RECORD.assets.find((x) => x.id === assetId);
      if (!a) throw new Error(`${assetId} has no test price`);
      const [, answer] = (await client.readContract({
        address: a.feed as Address,
        abi: FEED,
        functionName: 'latestRoundData',
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      const moved = (answer * BigInt(10_000 + bps)) / 10_000n;
      const now = (await client.getBlock()).timestamp;
      await as(writer, a.feed as Address, FEED, 'write', [moved, now]);
      await as(writer, MARKET, MARKET_ABI, 'recentre', [a.address]);
    };
    const withPriceMoved = async (assetId: string, bps: number, work: () => Promise<void>) => {
      // The copy is put back afterwards.
      const snapshot = await test.snapshot();
      try {
        await movePrice(assetId, bps);
        await work();
      } finally {
        await test.revert({ id: snapshot });
      }
    };
    const sendRaw = async (wire: string) => {
      const hash = await client.request({
        method: 'eth_sendRawTransaction' as never,
        params: [wire] as never,
      });
      await mined(hash as Hex);
      return hash as string;
    };

    return {
      rpcUrl,
      adapter,
      client,
      vault,
      manualVault,
      newAssetVault,
      recipeA,
      recipeB,
      familyA,
      familyB,
      sign,
      send,
      withPriceMoved,
      movePrice,
      later,
      sendRaw,
      stop: () => anvil.kill('SIGTERM'),
    };
  } catch (e) {
    anvil.kill('SIGTERM');
    throw e;
  }
}
