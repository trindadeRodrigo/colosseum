import type { BasketSheet, BasketSheetDraft } from '@colosseum/schemas';

// POST /v1/baskets/intake as `staging` answers it (apps/api/src/routes/v1/intake.ts), for the tests of
// the Invest screen and its conversation. Every sentence here is made up, and stands for one our
// server writes from its templates.

/** A draft with nothing read: every field null. */
export const DRAFT: BasketSheetDraft = {
  basketType: null,
  goal: null,
  amountUsd: null,
  horizonMonths: null,
  risk: null,
  themes: null,
  country: null,
  chains: null,
  incomeTargetUsdMonthly: null,
  rules: null,
  language: null,
  currency: null,
  obligations: null,
  sleeves: null,
  restoreSplit: null,
};

/** "Grow $2,000 over 5 years, high risk", on Solana, as the server confirms it. */
export const SHEET: BasketSheet = {
  basketType: 'standard',
  goal: 'grow',
  amountUsd: 2000,
  horizonMonths: 60,
  risk: 'high',
  themes: [],
  chains: ['solana'],
  rules: { useHoldings: true, glide: false },
  language: 'en',
};

/** An answer of the route: what is given, over one that read nothing and asks nothing. */
export function answer(
  over: {
    draft?: Partial<BasketSheetDraft>;
    questions?: unknown[];
    sheet?: unknown;
    readBack?: string[];
    assumptions?: string[];
    mix?: unknown;
    narratives?: unknown[];
    method?: 'model' | 'rules';
  } = {},
) {
  return {
    reader: {
      method: over.method ?? 'model',
      model: over.method === 'rules' ? null : 'a-test-model',
      provenance: over.method === 'rules' ? null : 'mock',
      why: over.method === 'rules' ? 'model_not_configured' : null,
    },
    language: 'en',
    draft: { ...DRAFT, ...over.draft },
    limits: { creditTolerance: null, cannotHoldClasses: null },
    questions: over.questions ?? [],
    flags: [],
    disagreements: [],
    sheet: over.sheet ?? null,
    readBack: over.readBack ?? null,
    assumptions: over.assumptions ?? [],
    mix: over.mix ?? null,
    narratives: over.narratives ?? [],
  };
}
