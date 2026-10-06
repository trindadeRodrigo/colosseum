import { PortfolioResponse, type Price, type Provenance } from '@colosseum/schemas';
import type { PortfolioChain, Vault } from '../portfolio';

// What GET /v1/portfolio answers, for the tests of the monitor and the home page: one vault on Solana,
// on a test network, holding cash and two assets, valued by the API (packages/basket). Every figure is
// the API's; the screen only writes it out. Parsed with the shared schema, so a change to the frozen
// shape breaks these tests first.

export const READ_AT = '2026-10-05T14:00:00Z';
export const VAULT = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';
export const SECOND_VAULT = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const KEEPER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** The wallet of the tests' person (features/wallet/test/fake-port.ts, SOLANA). */
const OWNER = 'So11111111111111111111111111111111111111112';

export const price = (asset: string, usd: string, over: Partial<Price> = {}): Price => ({
  asset,
  usdPerToken: usd,
  source: 'Pyth Hermes',
  method: 'the feed’s price, read on chain by the vault reader',
  fetchedAt: '2026-10-05T13:59:30Z',
  provenance: 'sandbox',
  ageSeconds: 30,
  maxAgeSeconds: 120,
  market: 'open',
  ...over,
});

export function vault(over: Partial<Vault> = {}): Vault {
  return {
    chain: 'solana',
    address: VAULT,
    owner: OWNER,
    basketId: '7',
    recipeOnchainId: null,
    acceptedVersion: 1,
    autoFollow: true,
    keeper: KEEPER,
    cash: { asset: 'solana:usdc', raw: '250000000', multiplier: '1', display: '250' },
    positions: [
      {
        asset: 'solana:usdy',
        raw: '600000000',
        multiplier: '1',
        display: '600',
        targetBps: 6000,
        lastKeeperAt: null,
        valueUsd: '660',
        weightBps: 6346,
        driftBps: 346,
      },
      {
        asset: 'solana:paxg',
        raw: '50000000',
        multiplier: '1',
        display: '0.05',
        targetBps: 1500,
        lastKeeperAt: null,
        valueUsd: '130',
        weightBps: 1250,
        driftBps: -250,
      },
    ],
    lossUsedBps: 12,
    observedAt: READ_AT,
    pending: null,
    valueUsd: '1040',
    provenance: 'sandbox',
    ...over,
  };
}

export function chainOf(
  vaults: Vault[] = [vault()],
  over: Partial<PortfolioChain> = {},
): PortfolioChain {
  return {
    chain: 'solana',
    name: 'Solana devnet',
    mode: 'live',
    provenance: 'sandbox',
    vaults,
    prices: [price('solana:usdy', '1.1'), price('solana:paxg', '2600')],
    ...over,
  };
}

/** The body of a 200, checked against the frozen shape. */
export function portfolioBody(chain: PortfolioChain = chainOf()): PortfolioResponse {
  return PortfolioResponse.parse({ chains: [chain], disclaimer: 'from the constant' });
}

/** The same vault and prices, every label set to `provenance`. */
export function labelled(provenance: Provenance): PortfolioChain {
  const base = chainOf([vault({ provenance })]);
  return {
    ...base,
    provenance,
    prices: base.prices.map((p) => ({ ...p, provenance })),
  };
}

export const RH_VAULT = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
/** The tests' person's EVM wallet (features/wallet/test/fake-port.ts). */
const RH_OWNER = '0x204faca1764b154221e35c0d20abb3c525710498';

/**
 * A vault on Robinhood Chain, on the mock: its cash is the mock's `robinhood:usdc`, which the chain
 * calls tUSDG. Nothing about it may read USDC.
 */
export function robinhoodVault(over: Partial<Vault> = {}): Vault {
  return vault({
    chain: 'robinhood',
    address: RH_VAULT,
    owner: RH_OWNER,
    keeper: '0x2222222222222222222222222222222222222222',
    cash: { asset: 'robinhood:usdc', raw: '20000000', multiplier: '1', display: '20' },
    positions: [
      {
        asset: 'robinhood:tspy',
        raw: '10000000000000000',
        multiplier: '1',
        display: '0.01',
        targetBps: 5000,
        lastKeeperAt: null,
        valueUsd: '6.5',
        weightBps: 2453,
        driftBps: -2547,
      },
    ],
    valueUsd: '26.5',
    provenance: 'mock',
    ...over,
  });
}

export function robinhoodChain(vaults: Vault[] = [robinhoodVault()]): PortfolioChain {
  return {
    chain: 'robinhood',
    name: 'Robinhood Chain',
    mode: 'mock',
    provenance: 'mock',
    vaults,
    prices: [price('robinhood:tspy', '650', { provenance: 'mock', source: 'MOCK price' })],
  };
}

/** The body of a 200 with an entry per chain. */
export function portfolioOf(...chains: PortfolioChain[]): PortfolioResponse {
  return PortfolioResponse.parse({ chains, disclaimer: 'from the constant' });
}
