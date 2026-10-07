import type { PortfolioRebalancesResponse } from '@colosseum/schemas';
import { REBALANCES, SOL_GROW, SOL_STALE } from './answers';

// Sample steps for the tests of the rebalancing page, beside the shared sample answers (answers.ts),
// for the cases those do not hold. Every figure is sample: nothing here was read from a chain, and
// nothing the product ships may import this file. Three steps on Solana's test network are added:
//
//   LOOSE         a buy of the person's own that our server filed under no vault (`vault: null`),
//                 with a quote whose cost is not a whole number of basis points
//   KEEPER_SPYX   a trade of the keeper's worked out from two snapshots, on a token the test network's
//                 deployment names (SPYx, eight decimals), so its amounts before and after can be
//                 written in the token's own units; the shared sample's keeper trades are of USDY,
//                 which that deployment does not name
//   FAILED_SELL   a sale that failed before it had a transaction, made because a part had drifted: the
//                 one reason other than `manual` in these samples, and the one sale of a step of the
//                 person's own
//
// They are here for what the page has to draw, and are not held to the plans of answers.ts: a vault's
// last keeper time there does not know these trades.

export const SIG_LOOSE =
  '4Nd1mYQ7WcKq9oRj8Zx2PfT5sVbGhJ3uAeDy6LkXwCn1Mz9Hr4TtEo7BpQa2Gv5Yd8JsUf3KiWxRb6NcZm1Lp';
export const ORDER_LOOSE = 'b3c1d5e7-2f4a-4b6c-8d0e-1f3a5b7c9d2e';
export const ORDER_FAILED_SELL = 'c4d2e6f8-3a5b-4c7d-9e1f-2a4b6c8d0e3f';

const ADAPTER = 'Solana devnet, read over RPC by the vault adapter';
const READER = 'Solana devnet, read over RPC by the vault reader';
const QUOTE_METHOD =
  'the route the step was last built with, quoted against the reference price of the asset';
const KEEPER_METHOD =
  "worked out from two snapshots of the vault between which the vault's last keeper time on the asset changed: the amounts are what the vault held of the asset in each snapshot, the time is the chain's time of the keeper's last trade on the asset, and every trade of the asset between the two snapshots is in this one entry. It is not read from a record of the trade: the keeper's own log is not in the database, so there is no transaction id, no quote and no reason";

type Entry = PortfolioRebalancesResponse['chains'][number]['entries'][number];

export const LOOSE: Entry = {
  chain: 'solana',
  vault: null,
  at: '2026-10-06T12:00:00.000Z',
  by: 'owner',
  derived: false,
  kind: 'swap',
  why: 'manual',
  outcome: 'confirmed',
  trades: [
    {
      sell: 'solana:usdc',
      buy: 'solana:spyx',
      asset: 'solana:spyx',
      amountInRaw: '250000000',
      expected: {
        inRaw: '250000000',
        outRaw: '39000000',
        minOutRaw: '38805000',
        costBps: 12.5,
      },
    },
  ],
  orderId: ORDER_LOOSE,
  txId: SIG_LOOSE,
  explorerUrl: `https://solscan.io/tx/${SIG_LOOSE}?cluster=devnet`,
  source: ADAPTER,
  method: QUOTE_METHOD,
  fetchedAt: '2026-10-06T11:59:59.000Z',
  provenance: 'sandbox',
};

export const KEEPER_SPYX: Entry = {
  chain: 'solana',
  vault: SOL_GROW,
  at: '2026-10-06T15:24:10.000Z',
  by: 'keeper',
  derived: true,
  kind: 'keeper_leg',
  why: null,
  outcome: 'confirmed',
  trades: [
    {
      sell: 'solana:spyx',
      buy: 'solana:usdc',
      asset: 'solana:spyx',
      rawBefore: '162000000',
      rawAfter: '160000000',
      before: {
        observedAt: '2026-10-06T15:20:00.000Z',
        weightBps: 5210,
        targetBps: 5000,
        driftBps: 210,
      },
      after: {
        observedAt: '2026-10-06T15:30:00.000Z',
        weightBps: 4996,
        targetBps: 5000,
        driftBps: -4,
      },
    },
  ],
  orderId: null,
  txId: null,
  explorerUrl: null,
  source: READER,
  method: KEEPER_METHOD,
  fetchedAt: '2026-10-06T15:30:00.000Z',
  provenance: 'sandbox',
};

export const FAILED_SELL: Entry = {
  chain: 'solana',
  vault: SOL_STALE,
  at: '2026-10-06T23:00:00.000Z',
  by: 'owner',
  derived: false,
  kind: 'swap',
  why: 'drift',
  outcome: 'failed',
  trades: [
    {
      sell: 'solana:syrupusdc',
      buy: 'solana:usdc',
      asset: 'solana:syrupusdc',
      amountInRaw: '8000000',
    },
  ],
  orderId: ORDER_FAILED_SELL,
  txId: null,
  explorerUrl: null,
  source: ADAPTER,
  method: QUOTE_METHOD,
  fetchedAt: '2026-10-06T22:59:59.000Z',
  provenance: 'sandbox',
};

/** The shared sample with the three steps above filed among Solana's, newest first. */
export const REBALANCES_MORE: PortfolioRebalancesResponse = {
  ...REBALANCES,
  chains: REBALANCES.chains.map((chain) =>
    chain.chain === 'solana'
      ? {
          ...chain,
          entries: [...chain.entries, LOOSE, KEEPER_SPYX, FAILED_SELL].sort(
            (a, b) => Date.parse(b.at) - Date.parse(a.at),
          ),
        }
      : chain,
  ),
};
