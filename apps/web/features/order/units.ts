import type { AssetId, ChainId } from '@colosseum/schemas';
import devnet from '../../../../deployments/solana-devnet.json';
import { deploymentsFor } from './readiness';

// What a raw amount of each token means: its decimals, from the deployment the guard derives every
// address from (`deploymentsOf(network)[chain]` of `@colosseum/sdk`: `assets[id].decimals`, and
// `cashDecimals` on the mock), never from what the API answers. A hostile API that said the cash token
// had 9 decimals would have a deposit of 40,000 dollars read as 40: the order screen shows and checks
// every amount with these. The symbol is a name only: the test network's deploy record names its tokens
// (deployments/solana-devnet.json), the mock's dollar is USDC, and any other token goes by its id. A
// chain with no deployment has no units here, and nothing is signed for it.

export type TokenUnits = { symbol: string; decimals: number };
export type ChainUnits = { cash: AssetId; tokens: Partial<Record<AssetId, TokenUnits>> };

/** The mock's dollar, as packages/chain-mock names it. Its decimals are the deployment's `cashDecimals`. */
export const MOCK_CASH_SYMBOL = 'USDC';

const RECORDED: Record<string, string> = Object.fromEntries(
  [devnet.cash, ...devnet.assets, ...devnet.retired].map((t) => [t.id, t.symbol]),
);
const symbolOf = (id: AssetId) => RECORDED[id] ?? id.slice(id.indexOf(':') + 1).toUpperCase();

/** The units of a chain's tokens on the network this app signs for, or null when none are committed. */
export function unitsFor(chain: ChainId, mock: boolean): ChainUnits | null {
  const deployment = deploymentsFor(chain, mock)?.[chain];
  if (!deployment) return null;
  if (deployment.family === 'mock')
    return {
      cash: deployment.cash,
      tokens: {
        [deployment.cash]: { symbol: MOCK_CASH_SYMBOL, decimals: deployment.cashDecimals },
      },
    };
  return {
    cash: deployment.cash,
    tokens: Object.fromEntries(
      Object.entries(deployment.assets).map(([id, asset]) => [
        id,
        { symbol: symbolOf(id), decimals: asset.decimals },
      ]),
    ),
  };
}
