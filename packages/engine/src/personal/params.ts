import type { PersonalParameters } from './types';

// The parameter table of the personalization engine: every number it uses, and nothing else.
//
// These are starting values. Rodrigo owns the table (DESIGN-VAULT section 17, item 4): when he sets
// a number he changes it here, flips its mark in PERSONAL_PARAMS_STATUS to 'set' and bumps `version`.
// The rules in ./rules.test.ts hold whatever these numbers are.

export const PERSONAL_PARAMS: PersonalParameters = {
  version: 'personal-0.1-starting',

  // Sleeve sizes by goal and risk, in basis points of the plan. What a row leaves out of 10,000 is cash.
  sleeves: {
    'grow:low': { growthBps: 6000, dollarYieldBps: 3000, goldBps: 1000 },
    'grow:medium': { growthBps: 8000, dollarYieldBps: 1500, goldBps: 500 },
    'grow:high': { growthBps: 9500, dollarYieldBps: 500, goldBps: 0 },
    'income:low': { growthBps: 0, dollarYieldBps: 10_000, goldBps: 0 },
    'income:medium': { growthBps: 0, dollarYieldBps: 10_000, goldBps: 0 },
    'income:high': { growthBps: 0, dollarYieldBps: 10_000, goldBps: 0 },
    // A plan to protect holds no stock tokens (gate PROTECT-NO-STOCKS, Oct 3). The stock share each
    // row had (20%, 35%, 50%) is in dollar yield for now, which leaves the three rows the same.
    'protect:low': { growthBps: 0, dollarYieldBps: 7500, goldBps: 2500 },
    'protect:medium': { growthBps: 0, dollarYieldBps: 7500, goldBps: 2500 },
    'protect:high': { growthBps: 0, dollarYieldBps: 7500, goldBps: 2500 },
  },

  // The least held in dollar yield when the goal's date is within `monthsLeft` months.
  glideFloor: [
    { monthsLeft: 6, dollarYieldBps: 8000 },
    { monthsLeft: 12, dollarYieldBps: 6000 },
    { monthsLeft: 24, dollarYieldBps: 4000 },
    { monthsLeft: 36, dollarYieldBps: 2000 },
    { monthsLeft: 60, dollarYieldBps: 1000 },
  ],

  // The least kept in cash when the money may be needed within `monthsLeft` months.
  cashFloor: [
    { monthsLeft: 3, cashBps: 2000 },
    { monthsLeft: 6, cashBps: 1000 },
    { monthsLeft: 12, cashBps: 500 },
  ],

  // The most of the plan in one stock or one crypto asset, by risk.
  capPerStockBps: { low: 1000, medium: 2000, high: 3500 },
  // The most of the plan with one issuer, by risk.
  capPerIssuerBps: { low: 5000, medium: 7000, high: 10_000 },

  // Of a token's measured exit capacity, the share one plan may count on: the most dollars a line of
  // it holds (gate EXIT-SOURCE, Oct 3). RES-1 (Rodrigo's research note, PR #23,
  // docs/vault/research/portfolio-method.md section 2.2) reads it as ESMA's caution not to count on a
  // full day's volume, and keeps it.
  shareOfDepth: 0.25,
  // The exit cost at which that capacity is read: 1%.
  tau: 0.01,
  // The fallback where no capacity is measured: the most dollars one token takes, by its tier on the
  // shelf. A plan that uses it says so on the line.
  tierCeilingUsd: { A: 50_000, B: 10_000, C: 1500 },

  minLineBps: 50,
  minLineUsd: 5,
  maxLinesPerChain: 8,

  holdingMinBps: 100,
  fallBps: 2000,
  atEndMinBps: 3000,
  wayStepUsd: 100,

  // A plan to protect starts from no shared portfolio: the one it had (Storm Cellar) holds stocks.
  defaultTheme: { grow: 'the-500', income: null, protect: null },
  defaultUnderlying: { growth: 'SPY', gold: 'GLD' },
};

/** `changed` is a change made since the prototype that Rodrigo has not read yet: he clears it. */
type Mark = { status: 'starting' | 'set'; from: string; changed?: string };

/** Where each number came from, and whether Rodrigo has set it. `params.test.ts` holds this complete. */
export const PERSONAL_PARAMS_STATUS: Record<Exclude<keyof PersonalParameters, 'version'>, Mark> = {
  sleeves: {
    status: 'starting',
    from: 'The prototype table for grow and protect. The income rows are new: the prototype gave income plans a stock sleeve, and stock tokens stay out of income plans (section 17, item 5).',
    changed:
      'Oct 3, gate PROTECT-NO-STOCKS: the protect rows lost their stock share (20%, 35%, 50%), moved to dollar yield. The three rows are now the same (75% dollar yield, 25% gold), so risk moves a plan to protect only through the cap per issuer.',
  },
  glideFloor: { status: 'starting', from: 'The prototype table, unchanged.' },
  cashFloor: {
    status: 'starting',
    from: 'New here; the prototype held no cash. The top step is the cash ceiling of the structurer (cashMax, 20%).',
  },
  capPerStockBps: { status: 'starting', from: 'The prototype (singleNameCap), unchanged.' },
  capPerIssuerBps: { status: 'starting', from: 'The prototype (issuerCap), unchanged.' },
  tierCeilingUsd: {
    status: 'starting',
    from: 'The prototype, from the sizes that define the tiers of the launch shelf: a leg up to $50k, up to $10k, up to about $1k to $2k.',
    changed:
      'Oct 3, gate EXIT-SOURCE: a fallback only. Where an exit capacity is measured, a line may hold shareOfDepth of it and the tier is not read.',
  },
  shareOfDepth: {
    status: 'starting',
    from: 'The value the structurer and the risk layer use (0.25).',
  },
  tau: { status: 'starting', from: 'The value the structurer and the risk layer use (1%).' },
  minLineBps: { status: 'starting', from: 'DESIGN-VAULT 3.6: 50 in the MVP.' },
  minLineUsd: { status: 'starting', from: 'The prototype (minLineUsd), unchanged.' },
  maxLinesPerChain: {
    status: 'starting',
    from: 'DESIGN-VAULT 3.6: 8 in the MVP; the vault allows 16.',
  },
  holdingMinBps: { status: 'starting', from: 'The prototype (holdingMinShare, 1% of the amount).' },
  fallBps: { status: 'starting', from: 'DESIGN-VAULT section 17, item 6: the loss in a 20% fall.' },
  atEndMinBps: {
    status: 'starting',
    from: 'The prototype: from 30% in dollar yield the card shows a cash flow.',
  },
  wayStepUsd: { status: 'starting', from: 'The prototype: round hundreds of dollars.' },
  defaultTheme: {
    status: 'starting',
    from: 'The prototype for grow. None for income: an income plan holds dollar yield only.',
    changed:
      'Oct 3, gate PROTECT-NO-STOCKS: none for protect either. Storm Cellar, which the prototype started it from, holds stocks; a plan to protect with nothing chosen is built from the sleeves.',
  },
  defaultUnderlying: {
    status: 'starting',
    from: 'The prototype: SPY for stocks and GLD for gold when no shared portfolio fills the sleeve.',
  },
};
