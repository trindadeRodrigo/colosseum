import type { PersonalParameters } from './types';

// The parameter table of the personalization engine: every number it uses, and nothing else. (The one
// limit at the foot of this file is the shape of a content file, kept out of the table.)
//
// These are starting values. Rodrigo owns the table (DESIGN-VAULT section 17, item 4): when he sets
// a number he changes it here, flips its mark in PERSONAL_PARAMS_STATUS to 'set' and bumps `version`.
// The rules in ./rules.test.ts hold whatever these numbers are.

export const PERSONAL_PARAMS: PersonalParameters = {
  version: 'personal-0.3-starting-candidates',

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

  // A goal with no date ("no hard cap", "open-ended") is built over this many months, with no glide
  // (gate GLIDE-OPT-IN, Oct 6). The read-back says "no date set", never this number.
  openEndedHorizonMonths: 120,

  // The least kept in cash when the money may be needed within `monthsLeft` months.
  cashFloor: [
    { monthsLeft: 3, cashBps: 2000 },
    { monthsLeft: 6, cashBps: 1000 },
    { monthsLeft: 12, cashBps: 500 },
  ],

  // The most of the plan in one stock or one crypto asset, by risk.
  capPerStockBps: { low: 1000, medium: 2000, high: 3500 },
  // The most of the plan with one issuer, by risk, whatever the plan holds with it: the stocks and
  // crypto take what its dollar yield and gold leave of it. Dollar yield and gold also keep the 50% of
  // gate SOLVER-CAPS, counting those only (Rodrigo, Oct 5), which answered the open question here.
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
  defaultUnderlying: { growth: 'SPY', gold: ['PAXG', 'GLD'] },

  // Gate SOLVER-PARAMS (Rodrigo, Oct 5). Each is a starting number with the test that will tune it.
  // Tuned by C2: perturb each yield by its week-on-week spread; widen until adjacent ranks stop swapping.
  yieldBand: 0.005,
  // Tuned by C5 and R4: re-solve the fixture goals once yield tokens have curves; count money left unplaced.
  // The registry caps of the old solver (Kamino 60%, syrupUSDC 40%, USDY 40%). A token the table does not
  // name takes the figure of its leg type (Rodrigo, Oct 5): Kamino's for a market deposit, USDY's for a
  // rate leg, syrupUSDC's for credit and basis.
  capPerAssetBps: {
    bySymbol: { syrupUSDC: 4000, USDY: 4000 },
    byLegType: { market_deposit: 6000, rate: 4000, credit: 4000, basis: 4000 },
  },
  // Tuned by C8: inject an 80% loss on any credit or basis leg and count the months still paid.
  // Dollar yield, gold and cash only (Rodrigo, Oct 5): on Solana every stock token has one issuer.
  issuerCapBps: 5000,
  // The old solver's credit budget (creditShareByTolerance), tuned by the same C8 test.
  creditShareBps: { none: 0, limited: 2500, accept: 5000 },
  // Until the guided intake asks (Rodrigo, Oct 5): the old parser's default.
  defaultCreditTolerance: 'limited',
  // Tuned by C15: replay the withdrawals at 0, 3, 6, 12 and 24 months set aside.
  setAsideMonths: 6,
  // Tuned by C14: replay recorded prices at 3, 5 and 7 points and count rebalances and exit cost.
  driftBandBps: 500,
  // Tuned by C2's perturbation test, on the safe-yield sleeve's switches.
  switchDays: 7,
  // Rebalancing (slice 4): an FX reading older than this does not count a withdrawal in another
  // currency for the monthly refill, and the answer says so.
  fxMaxAgeDays: 3,
  // The named stresses of the status (slice 3, C12): the old engine's STRESS_PARAMS. Stocks, crypto and
  // gold fall by `fallBps`. Tuned by C8 (credit) and by the replay of section 2.2 (yields, FX).
  stress: { carryFallBps: 5000, creditGateMonths: 6, fxMoveBps: 2000, fxMoveMonths: 12 },
  // A way to close a gap by withdrawing less is tried in whole percents of each amount.
  wayScaleStepBps: 100,
  // The three candidates (gate THREE-PLANS, slice 3). Tuned by C10 and C11: on the grid of goals, no
  // candidate is dominated on the scorecard and each wins at least one line of it.
  candidates: {
    // Cover: a year of withdrawals set aside, half the person's credit limit in credit and basis legs
    // (Rodrigo, Oct 5), exit capacity read at half the cost and half the share of depth.
    cover: { setAsideMonths: 12, creditOfLimitBps: 5000, tau: 0.005, shareOfDepth: 0.125 },
    // Spread: dollar yield filled equally within its caps (every token in one band), one issuer at
    // most 30% of the plan.
    spread: { equalFill: true, issuerCapBps: 3000 },
    // The prompt's 10 points: closer than this, two candidates are one choice.
    distinctBps: 1000,
  },
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
  openEndedHorizonMonths: {
    status: 'starting',
    from: 'Gate GLIDE-OPT-IN (Rodrigo, Oct 6): ten years, the span the card and the dollar-yield range are read over when the person gives no date. With the glide off it moves no weight.',
  },
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
    changed: 'Oct 5, gate GOLD-PAXG: PAXG first, GLD where PAXG is not listed (Thom)',
  },
  yieldBand: {
    status: 'set',
    from: 'Gate SOLVER-PARAMS, Oct 5: yields within half a point count as equal.',
  },
  capPerAssetBps: {
    status: 'set',
    from: 'Gate SOLVER-PARAMS, Oct 5: the old registry caps; tokens the table does not name take their leg type figure (Rodrigo, Oct 5).',
  },
  issuerCapBps: {
    status: 'set',
    from: 'Gate SOLVER-PARAMS, Oct 5: one issuer at most 50% of a plan, for dollar yield, gold and cash (Rodrigo, Oct 5).',
  },
  creditShareBps: {
    status: 'set',
    from: 'Gate SOLVER-PARAMS, Oct 5: the old solver credit budget, carried over.',
  },
  defaultCreditTolerance: {
    status: 'set',
    from: 'Rodrigo, Oct 5: limited, the old parser default, until the guided intake asks.',
  },
  stress: {
    status: 'starting',
    from: 'The old engine (packages/engine/src/schedule, STRESS_PARAMS): yields fall by half, a credit leg gated for 6 months, the goal currency 20% up or down over 12 months. For Rodrigo: a parameter outside the SOLVER-PARAMS table.',
  },
  wayScaleStepBps: {
    status: 'starting',
    from: 'New in slice 3: a way to withdraw less names a whole percent of each amount. For Rodrigo: a parameter outside the SOLVER-PARAMS table.',
  },
  candidates: {
    status: 'starting',
    from: 'New in slice 3, gate THREE-PLANS; the moves are section 2.4 of the research note (Cover: 12 months set aside, less credit, tau and shareOfDepth tighter; Spread: equal fill, tighter issuer cap), the sizes are not in any document. Cover holds at most half the credit limit of the person (Rodrigo, Oct 5, in place of the 0 of the note); Cover halves tau (0.5%) and shareOfDepth (0.125); Spread caps one issuer at 30%; distinct from 1,000 bps (the prompt). For Rodrigo: parameters outside the SOLVER-PARAMS table.',
  },
  fxMaxAgeDays: {
    status: 'starting',
    from: 'New in slice 4 (rebalancing, the refill of the set-aside): a reading from the last three days, so a weekend without one still counts. Not in any document. For Rodrigo: a parameter outside the SOLVER-PARAMS table.',
  },
  setAsideMonths: {
    status: 'set',
    from: 'Gate SOLVER-PARAMS, Oct 5: 6 months of withdrawals, as today.',
  },
  driftBandBps: {
    status: 'set',
    from: 'Gate SOLVER-PARAMS, Oct 5: a rebalance proposed at 5 points of drift.',
  },
  switchDays: {
    status: 'set',
    from: 'Gate SOLVER-PARAMS, Oct 5: the safe-yield sleeve switches only when another stays ahead for a week.',
  },
};

/**
 * Not a number of the table, and so in no plan's hash: the shape of a content file, and what a keyword
 * must be to select anything (gate THEME-MATCHED). A row of `content/stocks/<chain>.json` carries
 * `least` to `most` business-line keywords. A filter by keyword matches only where at least `carriers`
 * tracked stocks of the chain carry it: a keyword one stock alone carries is that stock's name by
 * another word, and naming it would be picking the stock. Written here because the logic of this
 * folder holds no number of its own (`params.test.ts`).
 */
export const STOCK_KEYWORDS = { least: 3, most: 8, carriers: 2 } as const;

/**
 * The bounds on what the guided intake reads from outside the engine: the model's reply, in
 * characters, and the person's messages. They shape no plan, so they are not in the table above and
 * move no `paramsHash`. The market filter's own type sets no length (`market-filter.ts`): whoever
 * reads a value bounds it, here.
 */
export const INTAKE_LIMITS = {
  /** The value of a filter the model names: longer than any GICS name or keyword on the shelf. */
  filterValueChars: 80,
  /** The person's words the model quotes for it. */
  filterWordsChars: 100,
  /**
   * The last messages of a conversation read one by one, each as a possible answer to the question
   * before it: the first message and ten later ones, the most the API takes, and one to spare.
   */
  turnsRead: 12,
  /**
   * The names a filter must match on the person's chain to be held as a theme (Oct 7): a filter that
   * matches one name alone would be a stock pick by another name. A curated label is a person's
   * list and may hold one.
   */
  filterMinListed: 2,
  /**
   * How the person's words are held to the value a filter the model names must carry (Oct 7): a
   * word counts from this many letters, and two words are one where they share a stem this long
   * ("insurers" and "insurance"). Shorter words must be the same word, or its plural.
   */
  nameWordChars: 3,
  sameStemChars: 5,
  /**
   * How far back a clause is first read, in characters. A matter of speed and never of what is read:
   * a clause that runs further back is read from further back.
   */
  clauseReachChars: 240,
  /** How far before an ask its own figure may stand, in characters: "30% of my money in". */
  shareLeadChars: 24,
} as const;
