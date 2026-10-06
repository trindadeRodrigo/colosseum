import type { AssetId, ChainId } from '@colosseum/schemas';
import robinhoodTestnet from '../../../../deployments/robinhood-testnet.json';
import devnet from '../../../../deployments/solana-devnet.json';
import { deploymentsFor } from './readiness';

// What a raw amount of each token means: its decimals, from the deployment the guard derives every
// address from (`deploymentsOf(network)[chain]` of `@colosseum/sdk`: `assets[id].decimals`, and
// `cashDecimals` on the mock), never from what the API answers. A hostile API that said the cash token
// had 9 decimals would have a deposit of 40,000 dollars read as 40: the order screen shows and checks
// every amount with these. The symbol is a name only: the test network's deploy record names its tokens
// (deployments/solana-devnet.json, deployments/robinhood-testnet.json), the mock's dollar goes by the
// name of the chain it stands in for (USDC, tUSDG on Robinhood Chain), the mock's other tokens by the
// mock's own names and decimals, and any other token by its id. A chain with no deployment has no units
// here, and nothing is signed for it.

export type TokenUnits = { symbol: string; decimals: number };
export type ChainUnits = { cash: AssetId; tokens: Partial<Record<AssetId, TokenUnits>> };

/** The mock's dollar, as packages/chain-mock names it. Its decimals are the deployment's `cashDecimals`. */
export const MOCK_CASH_SYMBOL: Record<ChainId, string> = {
  solana: 'USDC',
  robinhood: 'tUSDG',
  base: 'USDC',
};

/**
 * The mock chain's shelf (packages/chain-mock), by slug: what a portfolio can be published with on the
 * mock, where the committed deployment names the cash token and nothing else. Sample throughout.
 */
const MOCK_SHELF = ['spy', 'nvda', 'tsla', 'gold', 'yield'] as const;
/**
 * The decimals of the mock's tokens as packages/chain-mock gives them (apps/web may not import the
 * mock, so tests/web-units.test.ts holds this to it): the chain's stock-token decimals, but 6 for the
 * dollar-yield token. With these an order on the mock reads in whole tokens, as one on a test network
 * does. Each goes by its slug in capitals, the name the rest of the app gives it.
 */
const MOCK_STOCK_DECIMALS: Record<ChainId, number> = { solana: 8, robinhood: 18, base: 8 };

const RECORDED: Record<string, string> = Object.fromEntries(
  [
    devnet.cash,
    ...devnet.assets,
    ...devnet.retired,
    robinhoodTestnet.cash,
    ...robinhoodTestnet.assets,
  ].flatMap((t) => (t.id && t.symbol ? [[t.id, t.symbol]] : [])),
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
        ...Object.fromEntries(
          MOCK_SHELF.map((slug) => [
            `${chain}:${slug}`,
            {
              symbol: slug.toUpperCase(),
              decimals: slug === 'yield' ? 6 : MOCK_STOCK_DECIMALS[chain],
            },
          ]),
        ),
        [deployment.cash]: { symbol: MOCK_CASH_SYMBOL[chain], decimals: deployment.cashDecimals },
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

/**
 * The assets a portfolio may name on this chain, other than cash: the committed deployment's on a real
 * network, the mock's shelf on the mock. Empty when no deployment is committed: nothing is published.
 */
export function assetsFor(chain: ChainId, mock: boolean): { id: AssetId; symbol: string }[] {
  const units = unitsFor(chain, mock);
  if (!units) return [];
  if (mock)
    return MOCK_SHELF.map((slug) => ({ id: `${chain}:${slug}`, symbol: slug.toUpperCase() }));
  return Object.entries(units.tokens)
    .filter(([id]) => id !== units.cash)
    .map(([id, token]) => ({ id, symbol: token?.symbol ?? id }));
}
