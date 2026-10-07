import type { ComposeContext, PersonalSheet, RiskLevel } from './types';

// Gate EXPLICIT-MIX (Rodrigo, Oct 6): when a person states what they want held, the plan holds it and
// no risk question is asked. The limits follow the mix, and the plan says which they are.
//
// The risk a mix takes is the lowest risk at which the plan holds the most in stocks and crypto that
// it holds at any risk. It is not worked out apart from placement, and not from what a plan says kept
// money out: the plan itself is made at each risk, by the same engine, and what each holds is read
// (`riskOfMix` in ./compose.ts). So whatever keeps stocks out at one risk and not at the next counts,
// by whatever name: the cap on one issuer, the cap on one stock, and also what that cap moves to
// names that have no room for it (their ceiling, the number of lines, the least a line can be), which
// the second review of Oct 6 found the earlier rule did not see (findings 1 and 2).
//
// With the caps of the table, which rise with the risk, the highest risk holds the most, and this is
// the lowest risk at which the plan holds as much as it would at the highest. It is said as "the
// most at any risk" so that it also holds on a table whose caps do not rise.
//
// The mix on its own (`aloneOf`) is the same sheet with nothing else of the person's on it. It is what
// a read-back can state before the rest is known. Where the plan takes a higher risk than that, it
// says so, and names what raised it (`limitsOf` in ./compose.ts).

/** The risk levels in order, lowest first. */
export const RISKS: readonly RiskLevel[] = ['low', 'medium', 'high'];

/**
 * The limits a plan with a mix takes: its risk. `alone` and `by` are there only where that risk is
 * above the one the mix takes on its own: that risk, and what raised it.
 */
export type Limits = { risk: RiskLevel; alone?: RiskLevel; by?: RaiserId[] };

/**
 * The lowest risk at which a plan holds the most: `held` is what it holds in stocks and crypto at each
 * risk of `RISKS`, in cents. `rounding` is a cent for each line a plan may hold: a share of the plan
 * and a cap are each rounded to the cent, part by part, so plans that close hold as much, and the
 * lower risk is taken. Null when `held` is empty.
 */
export function lowestThatHoldsMost(held: readonly number[], rounding: number): RiskLevel | null {
  const most = Math.max(...held);
  return RISKS[held.findIndex((cents) => cents + rounding >= most)] ?? null;
}

/**
 * What a person adds to a mix that can raise the risk the plan takes: each thing a sheet may carry
 * beside the mix, the portfolios, the chain and the amount. `on` says whether this sheet carries it.
 */
export const RAISERS = [
  {
    id: 'withdrawals',
    on: (sheet: PersonalSheet) => (sheet.obligations ?? []).length > 0,
  },
  {
    id: 'holdings',
    on: (sheet: PersonalSheet, context: ComposeContext) =>
      sheet.rules.useHoldings && (context.holdings ?? []).length > 0,
  },
  {
    id: 'cannotHold',
    on: (sheet: PersonalSheet) => sheet.limits?.cannotHold !== undefined,
  },
  {
    id: 'limits',
    on: (sheet: PersonalSheet) => {
      const { mustKeepUsd, mayNeedInMonths, creditTolerance } = sheet.limits ?? {};
      return [mustKeepUsd, mayNeedInMonths, creditTolerance].some((limit) => limit !== undefined);
    },
  },
  {
    id: 'date',
    on: (sheet: PersonalSheet) => sheet.rules.glide,
  },
] as const;
export type RaiserId = (typeof RAISERS)[number]['id'];

/**
 * The mix on its own: the person's goal, amount, chain, portfolios and mix, and nothing else of
 * theirs. No withdrawal, no holding counted, no date and no limit of their own. The figures the plan
 * is made with (yields, exit capacity, the table) stay as they are: they are not the person's.
 */
export function aloneOf(sheet: PersonalSheet): PersonalSheet {
  const { obligations: _obligations, limits: _limits, ...rest } = sheet;
  return { ...rest, rules: { useHoldings: false, glide: false } };
}

/** The mix on its own (`alone`) with one thing of the person's sheet put back. */
export function withOnly(alone: PersonalSheet, sheet: PersonalSheet, id: RaiserId): PersonalSheet {
  if (id === 'withdrawals')
    return { ...alone, ...(sheet.obligations ? { obligations: sheet.obligations } : {}) };
  if (id === 'holdings') return { ...alone, rules: { ...alone.rules, useHoldings: true } };
  if (id === 'date') return { ...alone, rules: { ...alone.rules, glide: true } };
  const { cannotHold, ...others } = sheet.limits ?? {};
  if (id === 'cannotHold') return { ...alone, ...(cannotHold ? { limits: { cannotHold } } : {}) };
  return { ...alone, limits: others };
}
