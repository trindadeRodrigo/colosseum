import { z } from 'zod';
import { PriceKind } from './basket-asset';
import { Address, ChainId } from './chain';
import { Chain, Provenance } from './enums';
import { type ChainMode, type EnvLike, envKey } from './flags';

// GATES 2026-10-02 (SHOW): built and shown on test networks first, mainnet later by configuration.
// So a chain's network, its chain id and the addresses that differ per network live here, never in the
// code that uses them. No RPC URL is part of this: those can carry keys and stay in each app's env.

export const Network = z.enum(['mainnet', 'testnet', 'local']);
export type Network = z.infer<typeof Network>;

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
  /** Our own deployments on this network, by name: `program`, `factory`, `registry`, `cash`. */
  contracts: z.record(z.string(), Address),
  /**
   * The label on every figure read from this network. This is the existing Provenance, not a second
   * scale: `live` is mainnet only, and a test network or a local copy is `sandbox`.
   */
  provenance: Provenance,
});
export type ChainConfig = z.infer<typeof ChainConfig>;

export function networkProvenance(network: Network): Provenance {
  return network === 'mainnet' ? 'live' : 'sandbox';
}

/** What a figure from this chain is labelled with, given how the chain is run. The mock wins. */
export function chainProvenance(network: Network, mode: ChainMode): Provenance {
  return mode === 'mock' ? 'mock' : networkProvenance(network);
}

type Preset = Omit<ChainConfig, 'id' | 'family' | 'name' | 'network' | 'provenance' | 'contracts'>;
export type ChainPresets = Record<
  ChainId,
  { family: Chain; name: string; networks: Record<Network, Preset> }
>;

const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Universal Router 2.1.2 on Robinhood Chain (DESIGN-VAULT section 5). */
const ROBINHOOD_UNIVERSAL_ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498';

const solanaMainnet: Preset = {
  networkName: 'mainnet-beta',
  evmChainId: null,
  explorerTx: 'https://solscan.io/tx/{txId}',
  router: JUPITER_V6,
  // The Scope prices account is not written in full anywhere in this repo: set CHAIN_PRICE_SOURCE_SOLANA.
  priceSource: { kind: 'scope', address: null },
};
const robinhoodMainnet: Preset = {
  networkName: 'Robinhood Chain',
  evmChainId: 4663,
  // No explorer address for mainnet is recorded in this repo yet.
  explorerTx: null,
  router: ROBINHOOD_UNIVERSAL_ROUTER,
  priceSource: { kind: 'chainlink', address: null },
};
const baseMainnet: Preset = {
  networkName: 'Base',
  evmChainId: 8453,
  explorerTx: 'https://basescan.org/tx/{txId}',
  // Our SlipstreamAdapter, once deployed.
  router: null,
  priceSource: { kind: 'chainlink', address: null },
};

/**
 * What is known per network before anything of ours is deployed. Test networks have no Jupiter, no
 * Universal Router 2.1.2 and no price feeds (docs/vault/research/test-networks.md): their router and
 * price source are ours, and stay null here until a deploy sets them.
 * `local` is a copy of mainnet on the developer's machine, as the two rigs under spikes/ run: mainnet's
 * ids and addresses, no explorer, and never labelled live.
 */
export const CHAIN_PRESETS: ChainPresets = {
  solana: {
    family: 'solana',
    name: 'Solana',
    networks: {
      mainnet: solanaMainnet,
      testnet: {
        networkName: 'devnet',
        evmChainId: null,
        explorerTx: 'https://solscan.io/tx/{txId}?cluster=devnet',
        router: null,
        priceSource: { kind: 'scope', address: null },
      },
      local: { ...solanaMainnet, networkName: 'local copy of mainnet', explorerTx: null },
    },
  },
  robinhood: {
    family: 'evm',
    name: 'Robinhood Chain',
    networks: {
      mainnet: robinhoodMainnet,
      testnet: {
        networkName: 'Robinhood Chain testnet',
        evmChainId: 46630,
        explorerTx: 'https://explorer.testnet.chain.robinhood.com/tx/{txId}',
        router: null,
        priceSource: { kind: 'chainlink', address: null },
      },
      local: { ...robinhoodMainnet, networkName: 'local copy of mainnet', explorerTx: null },
    },
  },
  base: {
    family: 'evm',
    name: 'Base',
    networks: {
      mainnet: baseMainnet,
      testnet: {
        networkName: 'Base Sepolia',
        evmChainId: 84532,
        explorerTx: 'https://sepolia.basescan.org/tx/{txId}',
        router: null,
        priceSource: { kind: 'chainlink', address: null },
      },
      local: { ...baseMainnet, networkName: 'local copy of mainnet', explorerTx: null },
    },
  },
};

function address(env: EnvLike, key: string): string | undefined {
  const v = env[key]?.trim();
  if (!v) return undefined;
  const parsed = Address.safeParse(v);
  if (!parsed.success)
    throw new Error(`${key}: expected a base58 address or a lower-case 0x address`);
  return parsed.data;
}

/**
 * Pure: one config per chain from the record it is given.
 * - CHAIN_NETWORK_<CHAIN> = mainnet | testnet | local. Unset means testnet, so nothing reaches mainnet
 *   by omission.
 * - CHAIN_ROUTER_<CHAIN> and CHAIN_PRICE_SOURCE_<CHAIN> replace the preset's address.
 * `contracts` come from the second argument, which a deploy fills.
 */
export function parseChainConfigs(
  env: EnvLike,
  contracts: Partial<Record<ChainId, Record<string, string>>> = {},
  presets: ChainPresets = CHAIN_PRESETS,
): Record<ChainId, ChainConfig> {
  const one = (id: ChainId): ChainConfig => {
    const key = envKey('CHAIN_NETWORK', id);
    const raw = env[key]?.trim().toLowerCase();
    const network = Network.safeParse(raw || 'testnet');
    if (!network.success)
      throw new Error(`${key}: expected ${Network.options.join(', ')}, got "${env[key]}"`);
    const { family, name, networks } = presets[id];
    const preset = networks[network.data];
    return ChainConfig.parse({
      id,
      family,
      name,
      network: network.data,
      ...preset,
      router: address(env, envKey('CHAIN_ROUTER', id)) ?? preset.router,
      priceSource: {
        kind: preset.priceSource.kind,
        address: address(env, envKey('CHAIN_PRICE_SOURCE', id)) ?? preset.priceSource.address,
      },
      contracts: contracts[id] ?? {},
      provenance: networkProvenance(network.data),
    });
  };
  return { solana: one('solana'), robinhood: one('robinhood'), base: one('base') };
}

/** `explorerTx` with the id filled in, or null when the network has no explorer. */
export function explorerTxUrl(
  config: Pick<ChainConfig, 'explorerTx'>,
  txId: string,
): string | null {
  return config.explorerTx ? config.explorerTx.replace('{txId}', txId) : null;
}
