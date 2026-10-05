// Writes deployments/robinhood-testnet.json, the record the API and the guard read
// (`EvmDeploymentRecord`, packages/chain-evm/src/vault/deployment.ts), once the kit and the vault are
// deployed on Robinhood Chain's test network. Everything it says is read from the chain, through the
// factory, except what only the kit knows (each token's name and kind, the price writer): those come
// from the kit's own record and config. Reads, sends nothing.
//
//   FACTORY=<factory proxy> pnpm exec tsx scripts/testnet/robinhood/record.ts
//
// RH_TESTNET_RPC_URL replaces the public RPC; DEPLOY_BLOCK names the factory's block when the run's
// broadcast file is not there (contracts/broadcast/Deploy.s.sol/46630/run-latest.json); RECORD_OUT
// writes elsewhere, as a rehearsal does.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEvmRpc,
  EvmDeploymentRecord,
  VAULT_BEACON_ABI,
  VAULT_FACTORY_ABI,
} from '@colosseum/chain-evm/vault';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIT_STATE = join(ROOT, 'contracts', 'script', 'testnet', 'deployed', '46630.json');
const KIT_CONFIG = join(ROOT, 'contracts', 'script', 'testnet', 'config', '46630.json');
const BROADCAST = join(ROOT, 'contracts', 'broadcast', 'Deploy.s.sol', '46630', 'run-latest.json');
const OUT = process.env.RECORD_OUT ?? join(ROOT, 'deployments', 'robinhood-testnet.json');
const TESTNET_RPC = process.env.RH_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
/** ERC-1967's implementation slot. */
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO = '0x0000000000000000000000000000000000000000';

type Hex = `0x${string}`;

/** What the kit's run wrote (TestnetKit.s.sol, `TESTNET_RECORD`). */
export type KitState = {
  chainId: number;
  admin: string;
  priceWriter: string;
  cash: string;
  cashSymbol: string;
  router: string;
  tokens: { symbol: string; modelOf: string; address: string }[];
};

/** What the kit's config says of a token that the chain does not. */
export type KitConfig = {
  cash: { symbol: string; name: string };
  tokens: { symbol: string; name: string; kind: string }[];
};

/** One listed asset as the factory's `asset(token)` holds it. */
export type FactoryAsset = {
  feed: string;
  tokenDecimals: number;
  feedDecimals: number;
  maxAge: number;
  session: number;
  maxWeightBps: number;
  flags: number;
  averageFeed: string;
  minPrice: bigint;
  maxPrice: bigint;
};

export type ChainView = {
  chainId: number;
  deployBlock: number | null;
  contracts: {
    factory: string;
    registry: string;
    beacon: string;
    vaultLogic: string;
    factoryLogic: string;
    registryLogic: string;
  };
  admin: string;
  guardian: string;
  keeper: string;
  sequencerFeed: string;
  cashToken: string;
  routerPull: number;
  assets: Map<string, FactoryAsset>;
  removed: string[];
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const idOf = (symbol: string) => `robinhood:${symbol.toLowerCase()}`;

/** The record, from what the chain says and what only the kit knows. Throws where they disagree. */
export function buildRecord(
  kit: KitState,
  config: KitConfig,
  chain: ChainView,
): EvmDeploymentRecord {
  if (chain.chainId !== 46630)
    throw new Error(`the node answers chain id ${chain.chainId}, not 46630`);
  if (!same(chain.cashToken, kit.cash))
    throw new Error(`the factory's cash token is ${chain.cashToken}, not the kit's ${kit.cash}`);
  if (chain.routerPull !== 2) throw new Error(`the factory does not list ${kit.router} as pull 2`);
  const cashAsset = chain.assets.get(kit.cash.toLowerCase());
  if (!cashAsset) throw new Error('the factory does not list the test cash');
  const record = {
    network: 'robinhood-testnet',
    chain: 'robinhood',
    provenance: 'sandbox',
    evmChainId: chain.chainId,
    deployBlock: chain.deployBlock,
    contracts: chain.contracts,
    roles: {
      admin: chain.admin,
      guardian: chain.guardian,
      keeper: chain.keeper,
      priceWriter: kit.priceWriter,
      // The kit's admin holds the issuer's role on every test token and names their minters.
      tokenIssuer: kit.admin,
    },
    sequencerFeed: same(chain.sequencerFeed, ZERO) ? null : chain.sequencerFeed,
    routers: [{ address: kit.router, pull: 2 as const }],
    cash: {
      id: idOf(kit.cashSymbol),
      symbol: kit.cashSymbol,
      name: config.cash.name,
      address: kit.cash,
      decimals: cashAsset.tokenDecimals,
    },
    assets: kit.tokens.map((t) => {
      const a = chain.assets.get(t.address.toLowerCase());
      if (!a) throw new Error(`the factory does not list ${t.symbol} (${t.address})`);
      const c = config.tokens.find((x) => x.symbol === t.symbol);
      if (!c) throw new Error(`the kit's config has no ${t.symbol}`);
      const ranged = a.minPrice !== 0n || a.maxPrice !== 0n;
      return {
        id: idOf(t.symbol),
        symbol: t.symbol,
        name: c.name,
        address: t.address,
        decimals: a.tokenDecimals,
        modelOf: t.modelOf,
        kind: c.kind,
        feed: a.feed,
        feedDecimals: a.feedDecimals,
        averageFeed: a.averageFeed,
        maxAge: a.maxAge,
        session: a.session,
        maxWeightBps: a.maxWeightBps,
        keeperOn: (a.flags & 1) === 1,
        range: ranged ? { minPrice: a.minPrice.toString(), maxPrice: a.maxPrice.toString() } : null,
      };
    }),
    retired: chain.removed.map((address) => {
      const t = kit.tokens.find((x) => same(x.address, address));
      return { id: t ? idOf(t.symbol) : null, symbol: t?.symbol ?? null, address };
    }),
  };
  return EvmDeploymentRecord.parse(record);
}

/** The raw JSON the file holds: addresses as the chain gave them, in the record's field order. */
export function recordJson(record: EvmDeploymentRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function deployBlock(): number | null {
  if (process.env.DEPLOY_BLOCK) return Number(process.env.DEPLOY_BLOCK);
  if (!existsSync(BROADCAST)) return null;
  const run = JSON.parse(readFileSync(BROADCAST, 'utf8')) as {
    receipts: { blockNumber: string }[];
  };
  const first = run.receipts[0];
  return first ? Number(BigInt(first.blockNumber)) : null;
}

async function readChain(factory: Hex, kit: KitState): Promise<ChainView> {
  const rpc = createEvmRpc(TESTNET_RPC);
  const read = <T>(functionName: string, args: unknown[] = []) =>
    rpc.readContract({
      address: factory,
      abi: VAULT_FACTORY_ABI,
      functionName,
      args,
    } as never) as Promise<T>;
  const implementation = async (proxy: Hex) => {
    const word = await rpc.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT });
    return `0x${(word ?? '0x').slice(-40)}`;
  };
  const registry = await read<Hex>('registry');
  const beacon = await read<Hex>('beacon');
  const listed = await read<Hex[]>('assets');
  const assets = new Map<string, FactoryAsset>();
  for (const token of listed) {
    const a = await read<FactoryAsset & { maxAge: number }>('asset', [token]);
    assets.set(token.toLowerCase(), {
      feed: a.feed,
      tokenDecimals: Number(a.tokenDecimals),
      feedDecimals: Number(a.feedDecimals),
      maxAge: Number(a.maxAge),
      session: Number(a.session),
      maxWeightBps: Number(a.maxWeightBps),
      flags: Number(a.flags),
      averageFeed: a.averageFeed,
      minPrice: BigInt(a.minPrice),
      maxPrice: BigInt(a.maxPrice),
    });
  }
  return {
    chainId: await rpc.getChainId(),
    deployBlock: deployBlock(),
    contracts: {
      factory,
      registry,
      beacon,
      vaultLogic: (await rpc.readContract({
        address: beacon,
        abi: VAULT_BEACON_ABI,
        functionName: 'implementation',
      } as never)) as string,
      factoryLogic: await implementation(factory),
      registryLogic: await implementation(registry),
    },
    admin: await read<string>('admin'),
    guardian: await read<string>('guardian'),
    keeper: await read<string>('keeper'),
    sequencerFeed: await read<string>('sequencerFeed'),
    cashToken: await read<string>('cashToken'),
    routerPull: Number(await read<number>('routerPull', [kit.router])),
    assets,
    removed: await read<string[]>('removedAssets'),
  };
}

async function main() {
  const factory = process.env.FACTORY;
  if (!factory || !/^0x[0-9a-fA-F]{40}$/.test(factory))
    throw new Error('FACTORY names the factory proxy');
  const kit = JSON.parse(readFileSync(process.env.TESTNET_RECORD ?? KIT_STATE, 'utf8')) as KitState;
  const config = JSON.parse(readFileSync(KIT_CONFIG, 'utf8')) as KitConfig;
  const record = buildRecord(kit, config, await readChain(factory as Hex, kit));
  writeFileSync(OUT, recordJson(record));
  console.log(
    `${OUT}: factory ${record.contracts.factory}, ${record.assets.length} assets, cash ${record.cash.symbol}, block ${record.deployBlock}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
