import type { AssetId, ChainId } from '@colosseum/schemas';
import { addressBytes, hexDecode, hexEncode, utf8Encode } from '../bytes';
import { keccak256 } from '../hash';
import { isRawAmount } from './context';
import { BASKET_PROGRAM } from './generated/basket-program';
import { DEPLOYMENT_FILES } from './generated/deployment-files';
import { GuardRefusal } from './refusal';
import { count, deepFreeze, type Loose, must, only, text } from './strict';
import type {
  EvmDeployment,
  FeeLimit,
  GuardDeployment,
  GuardDeployments,
  MockDeployment,
  SolanaDeployment,
} from './types';

// Where a deployment comes from. The guard derives every address it holds a transaction to from the
// deployment, so whoever writes the deployment decides what passes. It is therefore never read from the
// server that builds the transactions: it is a file committed in this package, one per network
// (packages/sdk/deployments/<network>.json), written when that network is deployed to and reviewed like
// code. `deploymentsOf(network)` reads the committed file, from the frozen copy the package carries,
// and is the only thing that makes a `GuardDeployment`: the guard refuses any other object.
// `readDeploymentFile(content)` checks a file's content the same way and makes no deployment.

export const DEPLOYMENT_FORMAT = 'guard-deployment/1';
export const DEPLOYMENT_NETWORKS = ['mainnet', 'testnet', 'local', 'mock'] as const;
export type DeploymentNetwork = (typeof DEPLOYMENT_NETWORKS)[number];

/** A chain's entry in a file for a real network, on Solana. */
export type SolanaEntry = {
  family: 'solana';
  /** The vault program. Optional, and when stated it is the id in idl/basket.json and no other. */
  program?: string;
  /** `Config.router_program`: the only program a vault swaps through. */
  router: string;
  cash: AssetId;
  assets: Record<AssetId, { mint: string; tokenProgram: 'token' | 'token-2022'; decimals: number }>;
  fee?: FeeLimit;
};
/** A chain's entry in a file for a real network, on an EVM chain. Addresses in lower case or with their checksum. */
export type EvmEntry = {
  family: 'evm';
  /** The network's own number. On mainnet and on the test network it has to be the chain's. */
  evmChainId: number;
  factory: string;
  beacon: string;
  /** Only when the factory holds another proxy than the committed build's. */
  proxyCreationCode?: string;
  routers: string[];
  cash: AssetId;
  /** Each asset's token contract. The field is `address`: a secret scanner reads `token` as a credential. */
  assets: Record<AssetId, { address: string; decimals: number }>;
  fee?: FeeLimit;
};
/** A chain's entry in the mock's file: the chain runs on packages/chain-mock and moves nothing. */
export type MockEntry = { family: 'mock'; cash: AssetId; cashDecimals: number };

/** The file: packages/sdk/deployments/<network>.json. */
export type DeploymentFile = {
  format: typeof DEPLOYMENT_FORMAT;
  network: DeploymentNetwork;
  chains: Partial<Record<ChainId, SolanaEntry | EvmEntry | MockEntry>>;
};

/**
 * Every chain a file may name, with the number each of its EVM networks goes by. Keyed by `ChainId`, so
 * a new chain does not compile until it has a line here. deployment.test.ts holds the numbers to the
 * shared presets.
 */
export const CHAIN_NUMBERS: Record<ChainId, { mainnet: number; testnet: number } | null> = {
  solana: null,
  robinhood: { mainnet: 4663, testnet: 46630 },
  base: { mainnet: 8453, testnet: 84532 },
};

const LOADED = new WeakSet<object>();

/** True only for a deployment `deploymentsOf` returned. A copy of one is not one. */
export const isLoadedDeployment = (value: unknown): value is GuardDeployment =>
  typeof value === 'object' && value !== null && LOADED.has(value);

/** An EVM address with its checksum (EIP-55), from its lower-case form. */
function checksummed(lower: string): string {
  const hash = hexEncode(keccak256(utf8Encode(lower.slice(2))));
  let out = '0x';
  for (let i = 0; i < 40; i += 1) {
    const ch = lower[2 + i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** Lower case, from lower case or from mixed case whose checksum holds. */
function evmAddress(value: unknown, what: string): string {
  must(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), `${what} is not an address`);
  const lower = (value as string).toLowerCase();
  must(
    value === lower || value === checksummed(lower),
    `${what} is written in mixed case and its checksum does not hold`,
  );
  must(!/^0x0{40}$/.test(lower), `${what} is the zero address`);
  return lower;
}

/** A token's decimals as the chain keeps them: a whole number from 0 to 255 (a mint's `u8`, ERC-20's `uint8`). */
function decimalsOf(value: unknown, what: string, field = 'decimals'): number {
  must(count(value, 0) && (value as number) <= 255, `the ${field} of ${what} are not 0 to 255`);
  return value as number;
}

function solanaAddress(value: unknown, what: string): string {
  must(typeof value === 'string', `${what} is not an address`);
  try {
    addressBytes(value as string);
  } catch {
    throw new Error(`${what} is not an address`);
  }
  return value as string;
}

function feeOf(value: unknown, family: 'solana' | 'evm'): FeeLimit | undefined {
  if (value === undefined) return undefined;
  const fee = only('the fee ceiling', value, ['maxFeeNativeRaw', 'maxGas']);
  must(isRawAmount(fee.maxFeeNativeRaw), 'the fee ceiling is not raw units');
  must(
    fee.maxGas === undefined || (family === 'evm' && count(fee.maxGas, 1)),
    'the gas ceiling is not a number, or is stated for a chain that has none',
  );
  return {
    maxFeeNativeRaw: fee.maxFeeNativeRaw as string,
    ...(fee.maxGas === undefined ? {} : { maxGas: fee.maxGas as number }),
  };
}

/** The assets of a chain's entry: each an asset of that chain, the cash among them, no address twice. */
function assetsOf<T>(
  chain: ChainId,
  entry: Loose,
  seen: string[],
  one: (asset: Loose, id: string) => { address: string; value: T },
): { cash: AssetId; assets: Record<AssetId, T> } {
  const listed = only('the list of assets', entry.assets, Object.keys(entry.assets ?? {}));
  const assets: Record<AssetId, T> = {};
  for (const [id, asset] of Object.entries(listed)) {
    must(
      id.startsWith(`${chain}:`) && id.length > chain.length + 1,
      `${id} is not an asset of ${chain}`,
    );
    const read = one(asset as Loose, id);
    seen.push(read.address);
    assets[id] = read.value;
  }
  must(Object.keys(assets).length > 0, 'it lists no asset');
  must(text(entry.cash) && Object.hasOwn(assets, entry.cash), 'its cash is not one of its assets');
  return { cash: entry.cash as AssetId, assets };
}

function solanaOf(entry: Loose, network: DeploymentNetwork): SolanaDeployment {
  only('the entry', entry, ['family', 'program', 'router', 'cash', 'assets', 'fee']);
  must(
    entry.program === undefined || entry.program === BASKET_PROGRAM.address,
    'the vault program is not the one in the committed interface file',
  );
  const seen = [BASKET_PROGRAM.address, solanaAddress(entry.router, 'the router')];
  const { cash, assets } = assetsOf('solana', entry, seen, (a, id) => {
    const asset = only(`the asset ${id}`, a, ['mint', 'tokenProgram', 'decimals']);
    must(
      asset.tokenProgram === 'token' || asset.tokenProgram === 'token-2022',
      `${id} names no token program`,
    );
    const mint = solanaAddress(asset.mint, `the mint of ${id}`);
    return {
      address: mint,
      value: {
        mint,
        tokenProgram: asset.tokenProgram as 'token' | 'token-2022',
        decimals: decimalsOf(asset.decimals, id),
      },
    };
  });
  must(new Set(seen).size === seen.length, 'two of its addresses are the same');
  const fee = feeOf(entry.fee, 'solana');
  return {
    family: 'solana',
    chain: 'solana',
    provenance: network === 'mainnet' ? 'live' : 'sandbox',
    router: seen[1] as string,
    cash,
    assets,
    ...(fee ? { fee } : {}),
  };
}

function evmOf(
  chain: Exclude<ChainId, 'solana'>,
  entry: Loose,
  network: DeploymentNetwork,
): EvmDeployment {
  only('the entry', entry, [
    'family',
    'evmChainId',
    'factory',
    'beacon',
    'proxyCreationCode',
    'routers',
    'cash',
    'assets',
    'fee',
  ]);
  must(count(entry.evmChainId, 1), 'its chain id is not a number');
  const numbers = CHAIN_NUMBERS[chain];
  // A local copy keeps whatever number it runs under. Mainnet and the test network have one each.
  if (network === 'mainnet' || network === 'testnet')
    must(
      numbers !== null && entry.evmChainId === numbers[network],
      `its chain id is not the one ${chain} has on ${network}`,
    );
  const factory = evmAddress(entry.factory, 'the factory');
  const beacon = evmAddress(entry.beacon, 'the beacon');
  must(Array.isArray(entry.routers), 'it names no list of routers');
  const routers = (entry.routers as unknown[]).map((r) => evmAddress(r, 'a router'));
  const seen = [factory, beacon, ...routers];
  const { cash, assets } = assetsOf(chain, entry, seen, (a, id) => {
    const asset = only(`the asset ${id}`, a, ['address', 'decimals']);
    const token = evmAddress(asset.address, `the token of ${id}`);
    return { address: token, value: { token, decimals: decimalsOf(asset.decimals, id) } };
  });
  must(new Set(seen).size === seen.length, 'two of its addresses are the same');
  let proxyCreationCode: string | undefined;
  if (entry.proxyCreationCode !== undefined) {
    must(typeof entry.proxyCreationCode === 'string', "the proxy's creation code is not hex");
    const code = hexDecode(entry.proxyCreationCode as string);
    must(code.length > 0, "the proxy's creation code is empty");
    proxyCreationCode = `0x${hexEncode(code)}`;
  }
  const fee = feeOf(entry.fee, 'evm');
  return {
    family: 'evm',
    chain,
    provenance: network === 'mainnet' ? 'live' : 'sandbox',
    evmChainId: entry.evmChainId as number,
    factory,
    beacon,
    ...(proxyCreationCode ? { proxyCreationCode } : {}),
    routers,
    cash,
    assets,
    ...(fee ? { fee } : {}),
  };
}

function mockOf(chain: ChainId, entry: Loose): MockDeployment {
  only('the entry', entry, ['family', 'cash', 'cashDecimals']);
  must(
    text(entry.cash) && entry.cash.startsWith(`${chain}:`) && entry.cash.length > chain.length + 1,
    `its cash is not an asset of ${chain}`,
  );
  return {
    family: 'mock',
    chain,
    cash: entry.cash as AssetId,
    cashDecimals: decimalsOf(entry.cashDecimals, String(entry.cash), 'cashDecimals'),
  };
}

function read(content: unknown, mark: boolean): DeploymentsRead {
  const file = only('it', content, ['format', 'network', 'chains']);
  must(file.format === DEPLOYMENT_FORMAT, `its format is not ${DEPLOYMENT_FORMAT}`);
  const network = DEPLOYMENT_NETWORKS.find((n) => n === file.network);
  must(network !== undefined, 'it names no network');
  const chains = only('its list of chains', file.chains, Object.keys(CHAIN_NUMBERS));
  must(Object.keys(chains).length > 0, 'it names no chain');

  const out: Partial<Record<ChainId, SolanaDeployment | EvmDeployment | MockDeployment>> = {};
  for (const [name, value] of Object.entries(chains)) {
    const chain = name as ChainId;
    try {
      const entry = only('the entry', value, Object.keys((value ?? {}) as object));
      // The mock is a network of its own: a file is all mock or has none of it, so a transaction that
      // moves nothing is never taken for one that does.
      const family = chain === 'solana' ? 'solana' : 'evm';
      must(
        entry.family === (network === 'mock' ? 'mock' : family),
        network === 'mock'
          ? "a chain of the mock's file is not a mock"
          : `its family is not ${family}`,
      );
      const deployment =
        network === 'mock'
          ? mockOf(chain, entry)
          : chain === 'solana'
            ? solanaOf(entry, network as DeploymentNetwork)
            : evmOf(chain, entry, network as DeploymentNetwork);
      const loaded = deepFreeze(deployment);
      if (mark) LOADED.add(loaded);
      out[chain] = loaded;
    } catch (e) {
      throw new Error(`${chain}: ${e instanceof Error ? e.message : 'it cannot be read'}`);
    }
  }
  return Object.freeze(out);
}

/** What a deployment file states, checked, and not a deployment the guard takes. */
export type DeploymentsRead = Readonly<
  Partial<Record<ChainId, SolanaDeployment | EvmDeployment | MockDeployment>>
>;

const refused = (e: unknown) =>
  new GuardRefusal(
    'deployment',
    `the deployment file: ${e instanceof Error ? e.message : 'it cannot be read'}`,
  );

/**
 * Checks the content of a deployment file, as a deploy does before it commits one, and says what it
 * states. What comes back is not a deployment: the guard refuses it. Throws a `GuardRefusal` with code
 * `deployment` on anything that is not exactly such a file.
 */
export function readDeploymentFile(content: unknown): DeploymentsRead {
  try {
    return read(content, false);
  } catch (e) {
    throw refused(e);
  }
}

/**
 * The deployments of the file committed for `network`, the one way to a deployment the guard takes:
 * only the files this package carries are read here, and nothing a caller hands over.
 */
export function deploymentsOf(network: DeploymentNetwork): GuardDeployments {
  const file = Object.hasOwn(DEPLOYMENT_FILES, network) ? DEPLOYMENT_FILES[network] : undefined;
  if (file === undefined)
    throw new GuardRefusal('deployment', `no deployment file is committed for ${network}`);
  try {
    return read(file, true) as GuardDeployments;
  } catch (e) {
    throw refused(e);
  }
}
