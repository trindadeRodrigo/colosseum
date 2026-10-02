import {
  type ChainConfig,
  ChainId,
  chainProvenance,
  type EnvLike,
  parseChainConfigs,
} from '@colosseum/schemas';
import { defineChain, type Chain as ViemChain } from 'viem';

// Which network the browser wallet signs for, per chain. The chain's id, names and explorer come from
// the shared chain configs (packages/schemas); the RPC URLs are here because a chain config holds none.
// Every URL in this file ships in client code, so none may carry a key.

export type WalletNetwork = 'mainnet' | 'testnet';
export type SolanaCluster = 'solana:mainnet' | 'solana:devnet';

export type WalletChain = {
  config: ChainConfig;
  network: WalletNetwork;
  rpcUrl: string;
  /** `sandbox` on a test network: every figure read from it is shown as "test network". */
  provenance: 'live' | 'sandbox';
  gas: { symbol: string; decimals: number };
  /**
   * EVM only: the most the wallet may commit to fees (gas × the highest fee per gas) on a transaction
   * that states no fee of its own. Null on Solana, where the fee is in the bytes the API built.
   */
  feeCeilingRaw: bigint | null;
};
export type WalletChains = Record<ChainId, WalletChain>;

const RPC: Record<ChainId, Record<WalletNetwork, string>> = {
  solana: {
    mainnet: 'https://api.mainnet-beta.solana.com',
    testnet: 'https://api.devnet.solana.com',
  },
  robinhood: {
    mainnet: 'https://rpc.mainnet.chain.robinhood.com',
    testnet: 'https://rpc.testnet.chain.robinhood.com',
  },
  base: { mainnet: 'https://mainnet.base.org', testnet: 'https://sepolia.base.org' },
};

const GAS: Record<ChainId, WalletChain['gas']> = {
  solana: { symbol: 'SOL', decimals: 9 },
  robinhood: { symbol: 'ETH', decimals: 18 },
  base: { symbol: 'ETH', decimals: 18 },
};

/**
 * 0.001 ETH. A wallet made at sign-in signs with no prompt and takes its gas and fee from an RPC, so
 * an RPC that answers wrongly could have it sign its whole balance away as fees. A vault transaction
 * on these chains costs a small fraction of this.
 */
const EVM_FEE_CEILING_WHEN_NONE_IS_STATED = 10n ** 15n;
const FEE_CEILING: Record<ChainId, bigint | null> = {
  solana: null,
  robinhood: EVM_FEE_CEILING_WHEN_NONE_IS_STATED,
  base: EVM_FEE_CEILING_WHEN_NONE_IS_STATED,
};

/** The public variables this file reads, one per chain. Unset means the test network. */
export type PublicWalletEnv = Partial<
  Record<`NEXT_PUBLIC_CHAIN_NETWORK_${Uppercase<ChainId>}`, string>
>;

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` only where the name is written out, so the record is built
 * here by hand and passed to the pure function below.
 */
export function publicWalletEnv(): PublicWalletEnv {
  return {
    NEXT_PUBLIC_CHAIN_NETWORK_SOLANA: process.env.NEXT_PUBLIC_CHAIN_NETWORK_SOLANA,
    NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: process.env.NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD,
    NEXT_PUBLIC_CHAIN_NETWORK_BASE: process.env.NEXT_PUBLIC_CHAIN_NETWORK_BASE,
  };
}

const NETWORKS: readonly WalletNetwork[] = ['testnet', 'mainnet'];

/**
 * Pure: the wallet's table of chains. Unset means the test network, so nothing reaches mainnet by
 * omission. Throws on a value it does not know; the message names the variable and never repeats the
 * value.
 * `local` is refused: it is a copy of mainnet with mainnet's chain id, so a signature made for it is
 * valid on mainnet too, and a browser wallet may hold real funds.
 */
export function walletChains(env: PublicWalletEnv = {}): WalletChains {
  const networks: EnvLike = {};
  for (const id of ChainId.options) {
    const upper = id.toUpperCase() as Uppercase<ChainId>;
    const key = `NEXT_PUBLIC_CHAIN_NETWORK_${upper}` as const;
    const value = env[key]?.trim().toLowerCase() || 'testnet';
    if (!NETWORKS.includes(value as WalletNetwork))
      throw new Error(`${key}: expected mainnet or testnet`);
    networks[`CHAIN_NETWORK_${upper}`] = value;
  }
  const configs = parseChainConfigs(networks);
  const one = (id: ChainId): WalletChain => {
    const config = configs[id];
    const network = config.network as WalletNetwork;
    return {
      config,
      network,
      rpcUrl: RPC[id][network],
      provenance: chainProvenance(network, 'live') === 'live' ? 'live' : 'sandbox',
      gas: GAS[id],
      feeCeilingRaw: FEE_CEILING[id],
    };
  };
  return { solana: one('solana'), robinhood: one('robinhood'), base: one('base') };
}

export function solanaCluster(chain: WalletChain): SolanaCluster {
  return chain.network === 'mainnet' ? 'solana:mainnet' : 'solana:devnet';
}

/** A chain config as the viem chain a wallet provider is told about. EVM chains only. */
export function toViemChain(chain: WalletChain): ViemChain {
  const { config } = chain;
  if (config.evmChainId === null) throw new Error(`${config.id} is not an EVM chain`);
  const explorer = config.explorerTx?.replace(/\/tx\/\{txId\}$/, '');
  return defineChain({
    id: config.evmChainId,
    name: config.networkName,
    nativeCurrency: { name: 'Ether', symbol: chain.gas.symbol, decimals: chain.gas.decimals },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
    ...(explorer ? { blockExplorers: { default: { name: 'Explorer', url: explorer } } } : {}),
    testnet: chain.network !== 'mainnet',
  });
}

/** The EVM chains, the default first. Base comes after Robinhood Chain (GATES, BASE). */
const EVM_CHAINS: readonly ChainId[] = ['robinhood', 'base'];

/**
 * What the wallet provider is told about EVM: both networks of every EVM chain, so the mainnet entries
 * are present, and as the default the network Robinhood Chain is set to.
 */
export function evmChainsForProvider(chains: WalletChains): {
  supportedChains: ViemChain[];
  defaultChain: ViemChain;
} {
  const all = (network: WalletNetwork) =>
    walletChains({
      NEXT_PUBLIC_CHAIN_NETWORK_SOLANA: network,
      NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: network,
      NEXT_PUBLIC_CHAIN_NETWORK_BASE: network,
    });
  const tables = NETWORKS.map(all);
  const supportedChains = EVM_CHAINS.flatMap((id) => tables.map((t) => toViemChain(t[id])));
  const defaultChain = toViemChain(chains.robinhood);
  return { supportedChains, defaultChain };
}
