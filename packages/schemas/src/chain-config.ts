import { z } from 'zod';
import { PriceKind } from './basket-asset';
import { Address, ChainId, normalizeAddress } from './chain';
import { CHAIN_PRESETS, type ChainPresets } from './chain-presets';
import { Chain, type Provenance } from './enums';
import { type ChainMode, type EnvLike, envKey, type Flags, readEnv } from './flags';

// GATES 2026-10-02 (SHOW): built and shown on test networks first, mainnet later by configuration.
// So a chain's network, its chain id and the addresses that differ per network live here, never in the
// code that uses them. No RPC URL is part of this: those can carry keys and stay in each app's env.

export const Network = z.enum(['mainnet', 'testnet', 'local']);
export type Network = z.infer<typeof Network>;

/**
 * Where a chain is. It carries no provenance: the label on a figure depends on how the chain is run as
 * well, so it is worked out by chainProvenance() where the mode is known.
 */
export const ChainConfig = z.object({
  id: ChainId,
  family: Chain,
  /** The chain's name as a person reads it. */
  name: z.string().min(1),
  network: Network,
  /** The network's own name: 'devnet', 'Base Sepolia'. */
  networkName: z.string().min(1),
  /** Null on Solana. */
  evmChainId: z.number().int().positive().nullable(),
  /** A link to one transaction, with `{txId}` where the id goes. Null when there is no explorer. */
  explorerTx: z.string().nullable(),
  /** The exchange a vault may trade through: a program id on Solana, a contract on EVM. Null until set. */
  router: Address.nullable(),
  /**
   * Where reference prices come from. On Solana `address` is the Scope-layout price account. On EVM
   * feeds are per asset (`BasketAsset.priceRef`), so it stays null.
   */
  priceSource: z.object({ kind: PriceKind, address: Address.nullable() }),
  /** Our own deployments on this network, by name. REQUIRED_CONTRACTS lists the ones a chain needs. */
  contracts: z.record(z.string(), Address),
});
export type ChainConfig = z.infer<typeof ChainConfig>;

/**
 * The label on every figure read from a chain, given how it is run. This is the existing Provenance,
 * not a second scale:
 * - `mock`: the chain runs on packages/chain-mock, whatever network it is set to.
 * - `live`: mainnet, read or traded for real.
 * - `sandbox`: a test network, or a local copy of mainnet.
 * - null: the chain is off, so there is no figure to label.
 */
export function chainProvenance(network: Network, mode: ChainMode): Provenance | null {
  if (mode === 'off') return null;
  if (mode === 'mock') return 'mock';
  return network === 'mainnet' ? 'live' : 'sandbox';
}

/** The deployments a chain cannot run without, by family. */
export const REQUIRED_CONTRACTS: Record<Chain, readonly string[]> = {
  solana: ['program'],
  evm: ['factory', 'registry'],
};

// An error names the variable and never repeats its value.
function address(env: EnvLike, key: string, family: Chain): Address | undefined {
  const v = env[key]?.trim();
  if (!v) return undefined;
  try {
    return normalizeAddress(family, v);
  } catch {
    throw new Error(
      `${key}: expected ${family === 'evm' ? 'a 0x address' : 'a base58 address of 32 bytes'}`,
    );
  }
}

/**
 * Pure: one config per chain from the record it is given.
 * - CHAIN_NETWORK_<CHAIN> = mainnet | testnet | local. Unset means testnet, so nothing reaches mainnet
 *   by omission.
 * - CHAIN_ROUTER_<CHAIN> and CHAIN_PRICE_SOURCE_<CHAIN> replace the preset's address. Each must be an
 *   address of the chain's own family; an EVM address may be in any case and is stored lower-case.
 * `contracts` come from the second argument, which a deploy fills.
 */
export function parseChainConfigs(
  env: EnvLike,
  contracts: Partial<Record<ChainId, Record<string, string>>> = {},
  presets: ChainPresets = CHAIN_PRESETS,
): Record<ChainId, ChainConfig> {
  const one = (id: ChainId): ChainConfig => {
    const key = envKey('CHAIN_NETWORK', id);
    const network = Network.safeParse(readEnv(env, key) ?? 'testnet');
    if (!network.success) throw new Error(`${key}: expected ${Network.options.join(', ')}`);
    const { family, name, networks } = presets[id];
    const preset = networks[network.data];
    const deployed = Object.entries(contracts[id] ?? {}).map(([contract, value]) => {
      try {
        return [contract, normalizeAddress(family, value)];
      } catch {
        throw new Error(`contracts.${id}.${contract}: not an address of the ${family} family`);
      }
    });
    return ChainConfig.parse({
      id,
      family,
      name,
      network: network.data,
      ...preset,
      router: address(env, envKey('CHAIN_ROUTER', id), family) ?? preset.router,
      priceSource: {
        kind: preset.priceSource.kind,
        address:
          address(env, envKey('CHAIN_PRICE_SOURCE', id), family) ?? preset.priceSource.address,
      },
      contracts: Object.fromEntries(deployed),
    });
  };
  return { solana: one('solana'), robinhood: one('robinhood'), base: one('base') };
}

/**
 * Throws when a chain is set to `live` or `readonly` and its config cannot run it: no router, no price
 * account on Solana, or a deployment missing from `contracts`. Called once at start, so a chain that is
 * not deployed fails there and not on the first request.
 */
export function assertChainsReady(flags: Flags, configs: Record<ChainId, ChainConfig>): void {
  for (const id of ChainId.options) {
    const mode = flags.chainMode[id];
    if (mode !== 'live' && mode !== 'readonly') continue;
    const config = configs[id];
    const missing = [
      ...(config.router ? [] : [envKey('CHAIN_ROUTER', id)]),
      ...(config.priceSource.kind === 'scope' && !config.priceSource.address
        ? [envKey('CHAIN_PRICE_SOURCE', id)]
        : []),
      ...REQUIRED_CONTRACTS[config.family]
        .filter((name) => !config.contracts[name])
        .map((name) => `contracts.${id}.${name}`),
    ];
    if (missing.length)
      throw new Error(
        `${envKey('CHAIN_MODE', id)} is ${mode} on ${config.networkName}, but these are not set: ${missing.join(', ')}`,
      );
  }
}

/** A link to one transaction on the chain's explorer, or null when the network has none. */
export function explorerLink(config: Pick<ChainConfig, 'explorerTx'>, txId: string): string | null {
  return config.explorerTx ? config.explorerTx.replace('{txId}', txId) : null;
}
