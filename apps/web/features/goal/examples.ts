import type { BasketSheetDraft, Language } from '@colosseum/schemas';

// The goal screen's example chips are this app's own sentences, so what each one says is known here,
// field by field, and is never sent to a reader to guess. The reader on `staging` (POST /goals) was made
// for goals in reais: it reads no dollar amount, no "18 months" and no "protect", and its default answer
// is "accumulation", so a chip sent to it came back as a goal to grow with no amount and no time frame.
// A chip sent as it is fills the sheet from here; a chip the person has changed is read like any text.

/** What each chip says, in the order the dictionaries list them (`goal.examples.list`, both languages). */
export const EXAMPLE_FIELDS: readonly Pick<
  BasketSheetDraft,
  'goal' | 'amountUsd' | 'horizonMonths' | 'risk' | 'incomeTargetUsdMonthly'
>[] = [
  // "Grow $2,000 for ten years, high risk"
  {
    goal: 'grow',
    amountUsd: 2_000,
    horizonMonths: 120,
    risk: 'high',
    incomeTargetUsdMonthly: null,
  },
  // "Protect $50,000 for 18 months, low risk"
  {
    goal: 'protect',
    amountUsd: 50_000,
    horizonMonths: 18,
    risk: 'low',
    incomeTargetUsdMonthly: null,
  },
  // "$80,000 for $300 a month of income, 5 years, low risk": whole, as the other two are, so the
  // product's own example opens with nothing left to fill
  {
    goal: 'income',
    amountUsd: 80_000,
    horizonMonths: 60,
    risk: 'low',
    incomeTargetUsdMonthly: 300,
  },
];

/** The draft of a chip sent as it is, in the page's language; null for any other text. */
export function exampleDraft(
  text: string,
  examples: readonly string[],
  language: Language,
): BasketSheetDraft | null {
  const at = examples.indexOf(text.trim());
  const fields = at < 0 ? undefined : EXAMPLE_FIELDS[at];
  if (!fields) return null;
  return {
    basketType: 'standard',
    ...fields,
    themes: null,
    country: null,
    chains: null,
    rules: null,
    language,
    currency: null,
    obligations: null,
    sleeves: null,
    restoreSplit: null,
  };
}
