import { BPS, shareOf, toCents, toUsd } from './money';
import type {
  ComposeContext,
  PersonalParameters,
  PersonalProposal,
  PersonalSheet,
  RiskLevel,
} from './types';

// Gate EXPLICIT-MIX (Rodrigo, Oct 6): when a person states what they want held, the plan holds it and
// no risk question is asked. The limits follow the mix: the plan takes the lowest risk whose caps per
// stock and per issuer admit the mix's share in stocks and crypto, and says so.
//
// Whether a risk admits a mix is not worked out apart from placement: a plan is made at that risk, by
// the same engine, and what it holds is read. An issuer's cap counts everything the plan holds with
// that issuer (the gold and the dollar yield of the mix too), a shared portfolio keeps its weights,
// and money over the cap on one stock moves only within the sleeve: a sum of each issuer's room knows
// none of that, and took risks that left stocks out (review of Oct 6, finding 3).
//
// 1. The mix alone (`aloneOf`): the plan a mix makes with nothing in the way but the caps of one risk.
//    The lowest risk at which it holds the mix's whole share in stocks and crypto is where the plan
//    starts, and the highest when none does. It depends on the mix, the portfolios and the shelf, and
//    not on the amount, the date, the withdrawals or what the person holds: it is what a read-back
//    can state before those are known.
// 2. The plan itself (`build` in ./compose.ts): where a cap by risk still keeps stocks out of the plan
//    as it is built (what is set aside for withdrawals can sit with the issuer of the stocks), the
//    plan is made again at the next risk, until none does or the highest is reached.

/** The risk levels in order, lowest first. */
export const RISKS: readonly RiskLevel[] = ['low', 'medium', 'high'];

/** The risk after this one, or null for the highest. */
export const riskAfter = (risk: RiskLevel): RiskLevel | null =>
  RISKS[RISKS.indexOf(risk) + 1] ?? null;

/**
 * The amount the mix alone is tried at, in cents. One basis point of it is a whole 10,000 cents, so
 * no share of the plan is a fraction of a cent and a rounding cent is far from a basis point.
 */
const ALONE_CENTS = BPS * BPS;

/**
 * The plan a mix makes on its own, at one risk: the person's goal, chain, portfolios and what they
 * cannot hold, with the mix and nothing else. No date and no sum to keep (they move money out of
 * stocks whatever the risk), no withdrawal, no holding, no ceiling from the exit or a tier, no least
 * size and no count of lines: none of those is a limit of a risk. Each still applies to the plan
 * itself, where its line says so, and can only leave the plan holding less.
 *
 * `tokens` is how many tokens the chain lists: every one of them may have a line.
 */
export function aloneOf(
  sheet: PersonalSheet,
  context: ComposeContext,
  table: PersonalParameters,
  tokens: number,
  risk: RiskLevel,
): { sheet: PersonalSheet; context: ComposeContext } {
  const amountUsd = toUsd(ALONE_CENTS);
  const { cannotHold, creditTolerance } = sheet.limits ?? {};
  const limits = {
    ...(cannotHold ? { cannotHold } : {}),
    ...(creditTolerance ? { creditTolerance } : {}),
  };
  return {
    sheet: {
      basketType: sheet.basketType,
      goal: sheet.goal,
      amountUsd,
      horizonMonths: sheet.horizonMonths,
      risk,
      themes: sheet.themes,
      chains: sheet.chains,
      rules: { useHoldings: false, glide: false },
      language: sheet.language,
      ...(sheet.mix ? { mix: sheet.mix } : {}),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
    },
    context: {
      now: context.now,
      // The yields decide which dollar-yield tokens hold the mix's dollar yield, and so with whom.
      ...(context.yields ? { yields: context.yields } : {}),
      params: {
        ...table,
        tierCeilingUsd: { A: amountUsd, B: amountUsd, C: amountUsd },
        minLineBps: 0,
        minLineUsd: 0,
        maxLinesPerChain: Math.max(1, tokens),
      },
    },
  };
}

/**
 * Whether a plan holds the mix's whole share in stocks and crypto. Less than a basis point of the
 * plan short is the rounding of its parts, not a cap.
 */
export function holdsGrowth(plan: PersonalProposal): boolean {
  const amount = toCents(plan.sheet.amountUsd);
  const asked = shareOf(amount, plan.sheet.mix?.growthBps ?? 0);
  const held = toCents(plan.sleeves.find((x) => x.sleeve === 'growth')?.amountUsd ?? 0);
  return (asked - held) * BPS < amount;
}
