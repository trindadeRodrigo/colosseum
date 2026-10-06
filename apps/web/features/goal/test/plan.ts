import { BasketProposal, type BasketSheet, type Provenance } from '@colosseum/schemas';

// What the tests of the goal screen share: the first reader's answers as the API on `staging` gives
// them, and a plan in the frozen shape for the double of the route that will build one. The plan holds
// no rate: its figures are zeros, and it says where its one observation came from.

/** POST /goals for "R$ 5.000 por mês a partir de 2029, resgate em até 7 dias": read whole. */
export const READ_IN_REAIS = {
  goalId: '5d0d5c5e-6f0f-4a53-9d0a-6f6f1a2b3c4d',
  sheet: {
    language: 'pt',
    currency: 'BRL',
    target: { kind: 'monthly_cashflow', amountBrl: 5000, startMonth: '2029-01' },
    profile: 'income',
    horizonMonths: 147,
    liquidityWindowDays: 7,
    riskBudget: 'low',
    creditTolerance: 'limited',
    fxStance: 'hedge_near_term',
  },
  candidate: {
    language: 'pt',
    currency: 'BRL',
    target: { kind: 'monthly_cashflow', amountBrl: 5000, startMonth: '2029-01' },
    profile: 'income',
    horizonMonths: 147,
    liquidityWindowDays: 7,
    riskBudget: 'low',
    creditTolerance: 'limited',
    fxStance: 'hedge_near_term',
  },
  validationErrors: [],
  parser: { method: 'rules' },
  disclaimer: 'the disclaimer',
};

/**
 * POST /goals for "Grow $40,000 for an apartment by June 2028": the first reader finds no amount in
 * reais and no date it can read, and fills the time frame with 36 months of its own.
 */
export const READ_IN_DOLLARS = {
  goalId: '0b9a8f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
  sheet: null,
  candidate: {
    language: 'en',
    currency: 'BRL',
    target: { kind: 'balance', amountBrl: null, byMonth: '2029-10' },
    profile: 'accumulation',
    horizonMonths: 36,
    liquidityWindowDays: 90,
    riskBudget: 'medium',
    creditTolerance: 'limited',
    fxStance: 'hedge_near_term',
  },
  validationErrors: [
    { path: 'target.amountBrl', message: 'could not find an amount in reais (e.g. "R$3.000")' },
    { path: 'target.byMonth', message: 'could not find a horizon (e.g. "em 3 anos", "by 2029")' },
    { path: 'target.amountBrl', message: 'Invalid input: expected number, received null' },
  ],
  parser: { method: 'llm', model: 'a-model' },
  disclaimer: 'the disclaimer',
};

export const SHEET: BasketSheet = {
  basketType: 'standard',
  goal: 'grow',
  amountUsd: 40000,
  horizonMonths: 36,
  risk: 'medium',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: true, glide: true },
  language: 'en',
};

/** A plan in the frozen shape, for a sheet. Its one observation carries the label given. */
export function proposalFor(sheet: BasketSheet, provenance: Provenance = 'mock'): BasketProposal {
  const chain = sheet.chains[0] ?? 'solana';
  return BasketProposal.parse({
    sheet,
    engineVersion: 'personal-0.1',
    paramsHash: 'params',
    shelfVersion: 'shelf',
    inputsHash: 'inputs',
    lines: [
      {
        chain,
        assetId: `${chain}:one`,
        weightBps: 6000,
        amountUsd: sheet.amountUsd * 0.6,
        reasons: [],
      },
      {
        chain,
        assetId: `${chain}:two`,
        weightBps: 4000,
        amountUsd: sheet.amountUsd * 0.4,
        reasons: [],
      },
    ],
    recipes: [
      {
        chain,
        amountUsd: sheet.amountUsd,
        components: [
          { kind: 'asset', asset: `${chain}:one`, weightBps: 6000 },
          { kind: 'asset', asset: `${chain}:two`, weightBps: 4000 },
        ],
      },
    ],
    removed: [],
    card: {
      moneyTodayUsd: sheet.amountUsd,
      termMonths: sheet.horizonMonths,
      cashFlow: 'none',
      expectedReturn: { lowPct: 0, highPct: 0, basis: 'none stated', lossInFallUsd: 0 },
      exit: { text: 'not measured', costBps: null },
    },
    flags: [],
    observations: [
      {
        id: 'obs-1',
        kind: 'liquidity',
        source: 'a test',
        method: 'fixture',
        fetchedAt: '2026-10-04T12:00:00.000Z',
        provenance,
      },
    ],
    disclaimer: 'the disclaimer',
  });
}

/** The candidates' ids in the doubles: Carry has the plan's id, as the API stores it. */
export const CANDIDATE_IDS = {
  cover: '1c0a7e3b-5d2f-4a6b-8c9d-0e1f2a3b4c5d',
  spread: '2d1b8f4c-6e3a-4b7c-9d0e-1f2a3b4c5d6e',
  carry: '3e2c9a5d-7f4b-4c8d-8e1f-2a3b4c5d6e7f',
} as const;

/** What a candidate is compared on, with nothing measured: a goal with no withdrawals. */
export const SCORECARD = {
  monthsCovered: null,
  base: null,
  stresses: [],
  carryObservedBps: 410,
  exit: { costBps: null, measuredShareBps: 0 },
  concentration: {
    byIssuer: [
      { key: 'one', bps: 6000 },
      { key: 'two', bps: 4000 },
    ],
    byClass: [{ key: 'dollar-yield', bps: 10_000 }],
    largestIssuerBps: 6000,
    issuers: 2,
  },
  creditBasisBps: 0,
};

export const ROLL_UP = {
  byIssuer: [{ key: 'one', bps: 6000 }],
  byChain: [{ key: 'solana', bps: 10_000 }],
  byClass: [{ key: 'stock', bps: 6000 }],
  flags: [],
  exit: { quotedBps: null, quotedAt: null, measuredWorstBps: 42, measuredShareBps: 6000 },
};

/**
 * What POST /v1/baskets/personalize answers for a sheet (DESIGN-VAULT section 7): the table's plan for
 * agents, and the candidates the web reads, each named and stored under its own id.
 */
export function builtFor(
  sheet: BasketSheet,
  provenance: Provenance = 'mock',
  names: readonly ('cover' | 'spread' | 'carry')[] = ['cover', 'spread', 'carry'],
) {
  const proposal = proposalFor(sheet, provenance);
  return {
    id: CANDIDATE_IDS.carry,
    proposal,
    rollUp: ROLL_UP,
    candidates: names.map((candidate) => ({
      candidate,
      id: CANDIDATE_IDS[candidate],
      proposal,
      rollUp: ROLL_UP,
      scorecard: SCORECARD,
    })),
    candidatesNotShown: (['cover', 'spread', 'carry'] as const)
      .filter((c) => !names.includes(c))
      .map((candidate) => ({ candidate, why: `${candidate} holds the same as another.` })),
  };
}
