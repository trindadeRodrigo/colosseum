import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
