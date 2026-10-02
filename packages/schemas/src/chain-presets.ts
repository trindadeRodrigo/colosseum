import type { ChainId } from './chain';
import type { ChainConfig, Network } from './chain-config';
import type { Chain } from './enums';

// Data, not interface: what is known about each network before anything of ours is deployed. Kept in
// its own file so the hash test that freezes the interfaces (FRAME-3) need not freeze addresses.

export type ChainPreset = Omit<ChainConfig, 'id' | 'family' | 'name' | 'network' | 'contracts'>;
export type ChainPresets = Record<
  ChainId,
  { family: Chain; name: string; networks: Record<Network, ChainPreset> }
>;

const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Universal Router 2.1.2 on Robinhood Chain (DESIGN-VAULT section 5), lower-cased. */
const ROBINHOOD_UNIVERSAL_ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498';

const solanaMainnet: ChainPreset = {
  networkName: 'mainnet-beta',
  evmChainId: null,
  explorerTx: 'https://solscan.io/tx/{txId}',
  router: JUPITER_V6,
  // The Scope prices account is not written in full anywhere in this repo: set CHAIN_PRICE_SOURCE_SOLANA.
  priceSource: { kind: 'scope', address: null },
};
const robinhoodMainnet: ChainPreset = {
  networkName: 'Robinhood Chain',
  evmChainId: 4663,
  // No explorer address for mainnet is recorded in this repo yet.
  explorerTx: null,
  router: ROBINHOOD_UNIVERSAL_ROUTER,
  priceSource: { kind: 'chainlink', address: null },
};
const baseMainnet: ChainPreset = {
  networkName: 'Base',
  evmChainId: 8453,
  explorerTx: 'https://basescan.org/tx/{txId}',
  // Our SlipstreamAdapter, once deployed.
  router: null,
  priceSource: { kind: 'chainlink', address: null },
};

/**
 * Test networks have no Jupiter, no Universal Router 2.1.2 and no price feeds
 * (docs/vault/research/test-networks.md): their router and price source are ours, and stay null here
 * until a deploy sets them.
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
