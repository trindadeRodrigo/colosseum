import type { PortfolioExposureResponse } from '@colosseum/schemas';
import {
  EXPOSURE,
  EXPOSURE_OF_INCOME,
  EXPOSURE_OF_NOTHING,
  PLANS,
  RH_EMPTY,
  RH_SILENT,
  SOL_GROW,
  SOL_INCOME,
  SOL_STALE,
  SOL_UNPRICED,
} from './answers';

// What GET /v1/portfolio/exposure answers for one vault alone, for the vaults of ./answers.ts that
// have none made for them there: the tests of a plan's page ask for each vault's own. Every figure is
// sample, as in that file, and agrees with it: a vault's sums are the holdings of its newest snapshot
// there, each list of shares adds up to 10,000, and the size an exit is costed at is the vault's own
// holding. Nothing the product ships may import this file.
//
//   SOL_GROW      two parts, both measured, one on a curve with no time: no number is shown for it
//   SOL_STALE     one part measured, one not: its tier is named as the fallback
//   SOL_UNPRICED  one part measured, and a holding with no price that is in no sum
//   RH_SILENT     on the mock: nothing measured, every issuer the mock
//   RH_EMPTY      holds nothing: no chain has a sum (`EXPOSURE_OF_NOTHING`)

type Chain = PortfolioExposureResponse['chains'][number];

const [solanaOfIncome, robinhoodNothing] = EXPOSURE_OF_INCOME.chains;
const [solanaNothing] = EXPOSURE_OF_NOTHING.chains;
const [, robinhoodOfAll] = EXPOSURE.chains;
if (!solanaOfIncome || !robinhoodNothing || !solanaNothing || !robinhoodOfAll)
  throw new Error('the sample exposure has lost a chain');

/** Bearing's stamp on a cost it measured, as the sample answers write it. */
const [measuredExit] = solanaOfIncome.exit;
if (!measuredExit?.source || !measuredExit.method || !measuredExit.fetchedAt)
  throw new Error('the sample exposure has lost its measured exit');
const measured = {
  source: measuredExit.source,
  method: measuredExit.method,
  fetchedAt: measuredExit.fetchedAt,
  provenance: 'live',
} as const;

/** When a vault's newest snapshot was taken, as the sample plans say. */
function readAt(address: string): string {
  const plan = PLANS.chains.flatMap((chain) => chain.plans).find((p) => p.address === address);
  if (!plan?.newest) throw new Error(`no snapshot of ${address} in the sample plans`);
  return plan.newest.observedAt;
}

/** One vault on Solana's test network: its sums, and a Robinhood Chain that holds nothing of it. */
function onSolana(
  address: string,
  sums: Pick<Chain, 'valueUsd' | 'byUnderlying' | 'byIssuer' | 'rollUp' | 'exit' | 'unvalued'>,
): PortfolioExposureResponse {
  return {
    total: {
      valueUsd: sums.valueUsd,
      provenance: 'sandbox',
      byUnderlying: sums.byUnderlying,
      byIssuer: sums.byIssuer,
    },
    chains: [
      {
        chain: 'solana',
        name: 'Solana devnet',
        provenance: 'sandbox',
        vaults: 1,
        observedAt: readAt(address),
        source: (solanaOfIncome as Chain).source,
        method: (solanaOfIncome as Chain).method,
        ...sums,
      },
      robinhoodNothing as Chain,
    ],
    unavailable: EXPOSURE_OF_INCOME.unavailable,
    disclaimer: EXPOSURE_OF_INCOME.disclaimer,
  };
}

export const EXPOSURE_OF_GROW: PortfolioExposureResponse = onSolana(SOL_GROW, {
  valueUsd: '2051.37',
  byUnderlying: [
    { key: 'SPY', usd: '1025', bps: 4997 },
    { key: 'USDY', usd: '926.5', bps: 4517 },
    { key: 'USD', usd: '99.87', bps: 486 },
  ],
  byIssuer: [
    { key: 'backed', usd: '1025', bps: 4997 },
    { key: 'ondo', usd: '926.5', bps: 4517 },
    { key: 'test network', usd: '99.87', bps: 486 },
  ],
  rollUp: {
    byIssuer: [
      { key: 'backed', bps: 4997 },
      { key: 'ondo', bps: 4517 },
      { key: 'test network', bps: 486 },
    ],
    byChain: [{ key: 'solana', bps: 10_000 }],
    byClass: [
      { key: 'etf', bps: 4997 },
      { key: 'dollar_yield', bps: 4517 },
      { key: 'cash', bps: 486 },
    ],
    flags: ['exit_quote_missing'],
    exit: { quotedBps: null, quotedAt: null, measuredWorstBps: 2.63, measuredShareBps: 10_000 },
  },
  exit: [
    // measured on a curve that has no time: the time is left out, never made up
    {
      asset: 'solana:spyx',
      usd: '1025',
      measured: true,
      costBps: 3.1,
      source: measured.source,
      method: measured.method,
      provenance: 'live',
    },
    { asset: 'solana:usdy', usd: '926.5', measured: true, costBps: 2.4, ...measured },
  ],
  unvalued: [],
});

export const EXPOSURE_OF_STALE: PortfolioExposureResponse = onSolana(SOL_STALE, {
  valueUsd: '251.9',
  byUnderlying: [
    { key: 'USDY', usd: '130.8', bps: 5192 },
    { key: 'syrupUSDC', usd: '108.6', bps: 4311 },
    { key: 'USD', usd: '12.5', bps: 497 },
  ],
  byIssuer: [
    { key: 'ondo', usd: '130.8', bps: 5192 },
    { key: 'maple', usd: '108.6', bps: 4311 },
    { key: 'test network', usd: '12.5', bps: 497 },
  ],
  rollUp: {
    byIssuer: [
      { key: 'ondo', bps: 5192 },
      { key: 'maple', bps: 4311 },
      { key: 'test network', bps: 497 },
    ],
    byChain: [{ key: 'solana', bps: 10_000 }],
    byClass: [
      { key: 'dollar_yield', bps: 9503 },
      { key: 'cash', bps: 497 },
    ],
    flags: ['exit_partly_measured', 'exit_quote_missing', 'issuer_concentration'],
    exit: { quotedBps: null, quotedAt: null, measuredWorstBps: 1.1, measuredShareBps: 5688 },
  },
  exit: [
    { asset: 'solana:usdy', usd: '130.8', measured: true, costBps: 1.2, ...measured },
    // not measured: the tier is named as the fallback, and a tier states no cost
    {
      asset: 'solana:syrupusdc',
      usd: '108.6',
      measured: false,
      costBps: null,
      fallbackTier: 'B',
    },
  ],
  unvalued: [],
});

export const EXPOSURE_OF_UNPRICED: PortfolioExposureResponse = onSolana(SOL_UNPRICED, {
  // what has a price: the gold is in no sum
  valueUsd: '500.28',
  byUnderlying: [
    { key: 'USDY', usd: '250.7', bps: 5011 },
    { key: 'USD', usd: '249.58', bps: 4989 },
  ],
  byIssuer: [
    { key: 'ondo', usd: '250.7', bps: 5011 },
    { key: 'test network', usd: '249.58', bps: 4989 },
  ],
  rollUp: {
    byIssuer: [
      { key: 'ondo', bps: 5011 },
      { key: 'test network', bps: 4989 },
    ],
    byChain: [{ key: 'solana', bps: 10_000 }],
    byClass: [
      { key: 'dollar_yield', bps: 5011 },
      { key: 'cash', bps: 4989 },
    ],
    flags: ['exit_quote_missing', 'issuer_concentration'],
    exit: { quotedBps: null, quotedAt: null, measuredWorstBps: 0.7, measuredShareBps: 10_000 },
  },
  exit: [{ asset: 'solana:usdy', usd: '250.7', measured: true, costBps: 1.4, ...measured }],
  unvalued: [{ asset: 'solana:paxg', vault: SOL_UNPRICED, display: '0.06' }],
});

/** On the mock, where the other vault of the chain holds nothing: the chain's own sums, of one vault. */
export const EXPOSURE_OF_SILENT: PortfolioExposureResponse = {
  total: {
    valueUsd: robinhoodOfAll.valueUsd,
    provenance: 'mock',
    byUnderlying: robinhoodOfAll.byUnderlying,
    byIssuer: robinhoodOfAll.byIssuer,
  },
  chains: [solanaNothing, { ...robinhoodOfAll, vaults: 1 }],
  unavailable: EXPOSURE_OF_INCOME.unavailable,
  disclaimer: EXPOSURE_OF_INCOME.disclaimer,
};

/** The exposure of each sample vault alone, by its address. One that was never read has none. */
export const EXPOSURE_BY_PLAN: Readonly<Record<string, PortfolioExposureResponse>> = {
  [SOL_GROW]: EXPOSURE_OF_GROW,
  [SOL_INCOME]: EXPOSURE_OF_INCOME,
  [SOL_STALE]: EXPOSURE_OF_STALE,
  [SOL_UNPRICED]: EXPOSURE_OF_UNPRICED,
  [RH_SILENT]: EXPOSURE_OF_SILENT,
  [RH_EMPTY]: EXPOSURE_OF_NOTHING,
};
