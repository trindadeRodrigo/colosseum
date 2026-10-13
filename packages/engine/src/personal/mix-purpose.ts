import type { AssetClass } from '@colosseum/schemas';
import { RISKS } from './mix';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal, sleeveOfClass } from './registry';
import type { GoalKind, PersonalParameters, RiskLevel } from './types';

/**
 * The goal and the risk a mix the person chose stands for, where they did not say them (gate
 * DEPOSIT-DERIVE, Rodrigo, Oct 9). Worked out from the lines alone, by the engine's own caps, so the
 * same mix always gives the same answer and nothing the mix holds is turned away by it:
 *
 * - the goal: `protect` when a plan to protect may hold every line (dollar yield, gold and cash),
 *   else `grow`, the goal that may hold every class;
 * - the risk: the lowest whose caps hold the mix, its stocks and crypto together within that risk's
 *   cap per issuer (the estimate of gate EXPLICIT-MIX, `riskForMixEstimate`) and each of them within
 *   its cap on one stock or crypto asset (`capPerStockBps`); a mix past the highest is `high`. A mix
 *   with no stocks or crypto takes the lowest.
 *
 * Cash counts toward neither: it is what the lines leave.
 */
export function purposeOfMix(
  lines: readonly { cls: AssetClass; weightBps: number }[],
  params: Pick<PersonalParameters, 'capPerIssuerBps' | 'capPerStockBps'> = PERSONAL_PARAMS,
): { goal: GoalKind; risk: RiskLevel } {
  const goal: GoalKind = lines.every((line) => eligibleForGoal(line, 'protect'))
    ? 'protect'
    : 'grow';
  const growth = lines.filter((line) => sleeveOfClass(line.cls) === 'growth');
  const share = growth.reduce((sum, line) => sum + line.weightBps, 0);
  const largest = growth.reduce((most, line) => Math.max(most, line.weightBps), 0);
  const risk =
    RISKS.find(
      (level) =>
        share <= (params.capPerIssuerBps[level] ?? Number.NEGATIVE_INFINITY) &&
        largest <= (params.capPerStockBps[level] ?? Number.NEGATIVE_INFINITY),
    ) ?? 'high';
  return { goal, risk };
}
