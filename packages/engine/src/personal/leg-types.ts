import { z } from 'zod';

// What kind of yield a dollar-yield token carries (change C9 of docs/vault/research/portfolio-method.md,
// section 2.2, tokenised assets). A token can be more than one: syrupUSDC lends to borrowers (credit)
// and its disclosures allow basis trades (basis).
//
//   rate             passes through a sovereign or money-market rate (USDY, SGOV)
//   credit           lends to borrowers, and a default is written down across the pool (syrupUSDC)
//   basis            earns from a futures or funding spread; can pay less than nothing
//   market_deposit   a deposit in a lending market, which can be blocked at full use (jlUSDC, Kamino)
//
// LOCAL TYPE. Data, not logic: one row per token symbol, each with where it was read and when. It
// moves onto the shelf asset (`BasketAsset` in packages/schemas) with the schema commit of slice 2,
// which Thom approves. A dollar-yield token with no row is left out of a plan, with the reason: its
// kind is never guessed.

export const LegType = z.enum(['rate', 'credit', 'basis', 'market_deposit']);
export type LegType = z.infer<typeof LegType>;

export type LegTypeRow = { types: LegType[]; source: string; readAt: string };

export const LEG_TYPES: Record<string, LegTypeRow> = {
  syrupUSDC: {
    types: ['credit', 'basis'],
    source:
      'Maple Finance, "Withdrawal Process", "Risk Disclosures", "Defaults and Impairments" (docs.maple.finance), as read in docs/vault/research/portfolio-method.md [64]',
    readAt: '2026-10-03',
  },
  USDY: {
    types: ['rate'],
    source:
      'Ondo Finance, "USDY Basics" (docs.ondo.finance), as read in docs/vault/research/portfolio-method.md [63]',
    readAt: '2026-10-03',
  },
  jlUSDC: {
    types: ['market_deposit'],
    source:
      'Jupiter Lend USDC deposit, docs/vault/research/open-questions/launch-shelf.md (dollar yield on Solana)',
    readAt: '2026-10-01',
  },
  SGOV: {
    types: ['rate'],
    source:
      'iShares 0-3 Month Treasury Bond ETF as a Robinhood Chain stock token, docs/vault/research/open-questions/launch-shelf.md',
    readAt: '2026-10-01',
  },
  // The extended shelf on Robinhood Chain (docs/vault/research/yield-shelf/robinhood.md, Oct 6): test
  // tokens only.
  steakUSDG: {
    types: ['market_deposit'],
    source:
      'A curated vault that lends USDG in four lending markets: a withdrawal waits when all is lent. Its borrowers post basis and credit tokens, which this type does not say, as read in docs/vault/research/yield-shelf/robinhood.md, section 3',
    readAt: '2026-10-06',
  },
  syrupUSDG: {
    types: ['credit', 'basis'],
    source:
      'The USDG form of syrupUSDC, typed as it is: loans to institutions, and disclosures that allow basis trades, as read in docs/vault/research/yield-shelf/robinhood.md, section 3',
    readAt: '2026-10-06',
  },
  // MOCK: the stand-in dollar-yield token of the mock chain (packages/chain-mock), so a plan built on
  // the mock has a dollar-yield line. Typed as a rate leg, the strictest kind with no credit in it.
  mYIELD: {
    types: ['rate'],
    source:
      'packages/chain-mock/src/shelf.ts: the mock chain stand-in token, not a real asset (MOCK)',
    readAt: '2026-10-05',
  },
  // The Solana test network's stand-ins take the leg types of the tokens they model, so a plan on it
  // holds dollar yield as one on mainnet would. Not real assets: their figures are labelled sandbox.
  tjlUSDC: {
    types: ['market_deposit'],
    source: 'fixtures/testnet: the test-network stand-in of jlUSDC, typed as jlUSDC is (sandbox)',
    readAt: '2026-10-05',
  },
  tsyrupUSDC: {
    types: ['credit', 'basis'],
    source:
      'fixtures/testnet: the test-network stand-in of syrupUSDC, typed as syrupUSDC is (sandbox)',
    readAt: '2026-10-05',
  },
};

/** Leg types that count against the credit budget. */
export const CREDIT_LEG_TYPES: readonly LegType[] = ['credit', 'basis'];

export const legTypesOf = (symbol: string): LegTypeRow | null => LEG_TYPES[symbol] ?? null;
