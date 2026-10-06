import { type ChainId, explorerLink } from '@colosseum/schemas';
import {
  basketIdOfPlan,
  type DeploymentNetwork,
  deploymentsOf,
  type GuardDeployments,
} from '@colosseum/sdk';
import { publicWalletEnv, walletChains } from '../wallet/chains';

// Whether a chain can be bought on from this app: it needs a deployment committed for its network in
// packages/sdk/deployments/, which the guard derives every address from. The test network's file has
// Solana and Robinhood Chain (46630, since WEB-RH-BUY); Base has none, and nothing is signed there. The
// order runner reads the deployments it hands the executor from here too.

/**
 * The network a chain's deployment is read for. Every real network is this app's own
 * `NEXT_PUBLIC_CHAIN_NETWORK_<CHAIN>`, never the API's word. The one thing the API's word can choose is
 * the mock's file (with the throwaway wallet of development, the caller says `mock` too): its
 * transactions are no chain's, and a real wallet refuses to sign them (features/wallet/port.ts).
 */
export function networkFor(
  chain: ChainId,
  mock: boolean,
): Exclude<DeploymentNetwork, 'local'> | null {
  if (mock) return 'mock';
  try {
    return walletChains(publicWalletEnv())[chain].network;
  } catch {
    return null;
  }
}

/**
 * The deployments of the chain's network as the package loaded them from the committed file, handed on
 * as they came back. Null when the network has no file, or the file has no entry for the chain: nothing
 * is signed there.
 */
export function deploymentsFor(chain: ChainId, mock: boolean): GuardDeployments | null {
  const network = networkFor(chain, mock);
  if (!network) return null;
  try {
    const deployments = deploymentsOf(network);
    return deployments[chain] ? deployments : null;
  } catch {
    return null;
  }
}

/** The chain's own coin, which pays the network fee: this app's chain table, never the API's word. */
export function gasUnitsFor(chain: ChainId): { symbol: string; decimals: number } | null {
  try {
    return walletChains(publicWalletEnv())[chain].gas;
  } catch {
    return null;
  }
}

/** The chain runs on the mock: the API says so, or the wallet is the throwaway one of development. */
export const onMock = (
  port: { test: boolean; network(chain: ChainId): { provenance: string } | null },
  chain: ChainId,
): boolean => port.test || port.network(chain)?.provenance === 'mock';

/** True when an order on this chain can be signed from this app. */
export const chainReady = (chain: ChainId, mock: boolean): boolean =>
  deploymentsFor(chain, mock) !== null;

/**
 * The vault a plan was bought into, by its number on chain: the API's own rule, from the SDK
 * (`basketIdOfPlan`). The portfolio joins a vault to the goal of its plan with it.
 */
export const basketOfPlan = (proposalId: string): string => basketIdOfPlan(proposalId);

/**
 * A transaction's link on the explorer of the network this app signs for, from this app's own chain
 * table, never the API's word: a link the API sent could point anywhere, mainnet's explorer included.
 * Null on the mock, where a transaction is no network's, on a network with no explorer, and where there
 * is no transaction.
 */
export function explorerUrlFor(chain: ChainId, txId: string | null, mock: boolean): string | null {
  if (!txId || mock) return null;
  try {
    return explorerLink(walletChains(publicWalletEnv())[chain].config, txId);
  } catch {
    return null;
  }
}
