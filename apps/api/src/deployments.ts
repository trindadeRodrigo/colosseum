import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvmDeploymentRecord,
  deploymentAddresses as evmDeploymentAddresses,
} from '@colosseum/chain-evm/vault';
import { deploymentAddresses, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { type EnvLike, envKey, Network, readEnv } from '@colosseum/schemas';

// Where a real chain's addresses come from: the record its deploy committed, never the environment
// alone. On Solana that is `deployments/solana-<network>.json` at the repo root, chosen by
// CHAIN_NETWORK_SOLANA. Its program is the vault the API builds for, and its router and price
// account are the config's: CHAIN_ROUTER_SOLANA and CHAIN_PRICE_SOURCE_SOLANA may say the same
// thing, and the API does not start when either says something else.

export const DEPLOYMENTS_DIR = fileURLToPath(new URL('../../../deployments/', import.meta.url));

/** The record's file for a network, or null for one that has none (mainnet is not deployed by it). */
export function solanaRecordFile(network: string, dir = DEPLOYMENTS_DIR): string | null {
  if (network === 'testnet') return join(dir, 'solana-devnet.json');
  if (network === 'local') return join(dir, 'solana-local.json');
  return null;
}

export type SolanaDeployed = {
  /** The environment with the record's router and price account in it. */
  env: EnvLike;
  /** The program, for the chain config's `contracts`. Empty where there is no record. */
  contracts: { solana?: { program: string } };
  record: SolanaDeploymentRecord | null;
};

/**
 * Reads the network's record where there is one and puts its addresses in place. Throws when the
 * record cannot be read, or when the environment names another router or price account than it.
 */
export function solanaDeployment(
  env: EnvLike,
  read: (file: string) => string | null = (file) =>
    existsSync(file) ? readFileSync(file, 'utf8') : null,
  dir = DEPLOYMENTS_DIR,
): SolanaDeployed {
  const network = Network.safeParse(readEnv(env, envKey('CHAIN_NETWORK', 'solana')) ?? 'testnet');
  const file = network.success ? solanaRecordFile(network.data, dir) : null;
  const text = file ? read(file) : null;
  if (!file || text === null) return { env, contracts: {}, record: null };
  let record: SolanaDeploymentRecord;
  try {
    record = SolanaDeploymentRecord.parse(JSON.parse(text));
  } catch {
    throw new Error(`${file} is not a Solana deployment record this API reads`);
  }
  // The record names its network; it has to be the one the file is for, which is the one the
  // environment asked for. A devnet file that says mainnet is not run as devnet.
  const expected = basename(file, '.json');
  if (record.network !== expected)
    throw new Error(
      `${file} is the record of ${record.network}, and CHAIN_NETWORK_SOLANA asks for ${expected}`,
    );
  const { program, router, priceAccount } = deploymentAddresses(record);
  const agree = (key: string, value: string) => {
    // As written: an address is case-sensitive, and readEnv lower-cases.
    const given = env[key]?.trim();
    if (given && given !== value)
      throw new Error(`${key} names another address than ${file}: the record is what was deployed`);
  };
  agree(envKey('CHAIN_ROUTER', 'solana'), router);
  agree(envKey('CHAIN_PRICE_SOURCE', 'solana'), priceAccount);
  return {
    env: {
      ...env,
      [envKey('CHAIN_ROUTER', 'solana')]: router,
      [envKey('CHAIN_PRICE_SOURCE', 'solana')]: priceAccount,
    },
    contracts: { solana: { program } },
    record,
  };
}

/** An EVM chain's record for a network: `deployments/robinhood-testnet.json`, `robinhood-local.json`. */
export function evmRecordFile(chain: 'robinhood' | 'base', network: string, dir = DEPLOYMENTS_DIR) {
  if (network === 'testnet' || network === 'local') return join(dir, `${chain}-${network}.json`);
  return null;
}

export type EvmDeployed = {
  /** The environment with the record's router in it. */
  env: EnvLike;
  /** The factory and the registry, for the chain config's `contracts`. Empty where there is no record. */
  contracts: Partial<Record<'robinhood' | 'base', { factory: string; registry: string }>>;
  record: EvmDeploymentRecord | null;
};

/**
 * The same for an EVM chain: reads the network's record where there is one, and puts its factory, its
 * registry and its router in place. Throws when the record cannot be read, is another network's, or
 * when CHAIN_ROUTER_<CHAIN> names another router than it.
 */
export function evmDeployment(
  chain: 'robinhood' | 'base',
  env: EnvLike,
  read: (file: string) => string | null = (file) =>
    existsSync(file) ? readFileSync(file, 'utf8') : null,
  dir = DEPLOYMENTS_DIR,
): EvmDeployed {
  const network = Network.safeParse(readEnv(env, envKey('CHAIN_NETWORK', chain)) ?? 'testnet');
  const file = network.success ? evmRecordFile(chain, network.data, dir) : null;
  const text = file ? read(file) : null;
  if (!file || text === null) return { env, contracts: {}, record: null };
  let record: EvmDeploymentRecord;
  try {
    record = EvmDeploymentRecord.parse(JSON.parse(text));
  } catch {
    throw new Error(`${file} is not an EVM deployment record this API reads`);
  }
  const expected = basename(file, '.json');
  if (record.network !== expected || record.chain !== chain)
    throw new Error(
      `${file} is the record of ${record.network}, and ${envKey('CHAIN_NETWORK', chain)} asks for ${expected}`,
    );
  const { factory, registry, router } = evmDeploymentAddresses(record);
  const key = envKey('CHAIN_ROUTER', chain);
  const given = env[key]?.trim().toLowerCase();
  if (given && router && given !== router)
    throw new Error(`${key} names another address than ${file}: the record is what was deployed`);
  return {
    env: router ? { ...env, [key]: router } : env,
    contracts: { [chain]: { factory, registry } },
    record,
  };
}
