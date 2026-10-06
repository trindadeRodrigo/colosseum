import { BasketSheetDraft, type Language } from '@colosseum/schemas';
import { type ParseOutcome, parseGoalRules } from '../parser/rules';

// The structurer's rules parser reads a goal sentence into a `ConstraintSheet`: a target in reais, a
// profile, a horizon, a risk budget. A plan's sheet is in dollars and has its own fields. This is what
// carries over, as the draft a form opens with when no model is there to read the sentence
// (DESIGN-VAULT section 7). The parser itself is not changed, and the model path is not called.

const GOAL_OF_PROFILE: Record<string, BasketSheetDraft['goal']> = {
  income: 'income',
  accumulation: 'grow',
  high_risk: 'grow',
};

const field = <T>(
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  value: unknown,
): T | null => {
  const parsed = schema.safeParse(value);
  return parsed.success && parsed.data !== undefined ? parsed.data : null;
};

/**
 * A goal sentence as the draft of a plan's sheet, read by the rules parser alone. A field the parser
 * has no way to read is null: the amount and the income target (it reads reais only, and as the goal's
 * target, not as the money put in), the themes, the country and the chains. `nowMonth` is YYYY-MM:
 * the parser counts months from it, so no clock is read.
 */
export function draftFromRules(
  text: string,
  nowMonth: string,
  hint?: Language,
): { draft: BasketSheetDraft; outcome: ParseOutcome } {
  const outcome = parseGoalRules(text, hint, nowMonth);
  const c = outcome.candidate;
  // With no date in the sentence the parser fills one in and says so in its errors.
  const dated = !outcome.errors.some((e) => e.path === 'target.byMonth');
  const shape = BasketSheetDraft.shape;
  const draft: BasketSheetDraft = {
    basketType: null,
    goal: GOAL_OF_PROFILE[String(c.profile)] ?? null,
    amountUsd: null,
    horizonMonths: dated ? field(shape.horizonMonths, c.horizonMonths) : null,
    risk: field(shape.risk, c.riskBudget),
    themes: null,
    country: null,
    chains: null,
    incomeTargetUsdMonthly: null,
    rules: null,
    language: field(shape.language, c.language),
    // The rules parser reads every amount as reais and knows no sleeves: it says nothing of these.
    currency: null,
    obligations: null,
    sleeves: null,
    restoreSplit: null,
  };
  return { draft, outcome };
}
