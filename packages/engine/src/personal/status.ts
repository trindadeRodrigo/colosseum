import { sleeveOfClass } from './registry';
import { type ScheduleInputs, type Stress, scheduleOf } from './schedule';
import type { PersonalParameters, PersonalStatus } from './types';

// The status of a plan with withdrawals (slice 3; section 2.5 of the research note, change C12). No
// odds and no projected return: months paid at the rates observed on a stated date, the same under
// each named stress, and the carry the withdrawals need beside the carry observed. "Met" means every
// month is paid in the base case and under every stress that applies.

const BPS = 10_000;
/** The search for the carry needed stops within a hundredth of a basis point. */
const PRECISION = 1 / (BPS * 100);

/** The stresses that apply to a plan: each only where the plan holds what it moves. */
export function stressesFor(input: ScheduleInputs, P: PersonalParameters): Stress[] {
  const assets = input.lines.flatMap((l) => {
    const a = input.byId.get(l.assetId);
    return a && l.amountUsd > 0 ? [a] : [];
  });
  const s = P.stress;
  const out: Stress[] = [];
  if (assets.some((a) => sleeveOfClass(a.cls) === 'dollarYield'))
    out.push({ id: 'yields_fall', fallBps: s.yieldsFallBps });
  if (assets.some((a) => input.isCredit?.(a) ?? false))
    out.push({ id: 'credit_gate', months: s.creditGateMonths });
  if (assets.some((a) => ['growth', 'gold'].includes(sleeveOfClass(a.cls))))
    out.push({ id: 'equity_fall', fallBps: P.fallBps });
  // A goal in dollars has no FX stress (C19).
  if (input.currency !== 'USD')
    for (const id of ['fx_goal_up', 'fx_goal_down'] as const)
      out.push({ id, moveBps: s.fxMoveBps, months: s.fxMoveMonths });
  return out;
}

const counted = (input: ScheduleInputs, stress?: Stress) => {
  const { monthsPaid, monthsWithWithdrawal, shortfall } = scheduleOf({
    ...input,
    ...(stress ? { stress } : {}),
  });
  return { monthsPaid, monthsWithWithdrawal, shortfall };
};
const paysAll = (c: { monthsPaid: number; monthsWithWithdrawal: number }) =>
  c.monthsPaid === c.monthsWithWithdrawal;

/**
 * The status, from the same inputs as the schedule. `observedOn` is the date of the latest yield
 * reading the plan counts, or null when it counts none.
 */
export function statusOf(
  input: ScheduleInputs,
  P: PersonalParameters,
  amountUsd: number,
  observedOn: string | null,
): PersonalStatus {
  const base = counted(input);
  const stresses = stressesFor(input, P).map((stress) => {
    const { id, ...params } = stress;
    return { id, params, ...counted(input, stress) };
  });
  // The carry observed: the dollar-yield lines at their yield after haircut, over the whole plan.
  const carry = input.lines.reduce((n, l) => {
    const a = input.byId.get(l.assetId);
    if (!a || sleeveOfClass(a.cls) !== 'dollarYield') return n;
    return n + l.amountUsd * (input.yields.get(a.id)?.haircutYield ?? 0);
  }, 0);
  // The carry needed: the least flat yearly rate on every dollar-yield line at which every month is
  // paid. Zero when the withdrawals are paid with no yield; null when no rate up to 100% pays them.
  const at = (yearly: number) => paysAll(counted(input, { id: 'flat_carry', yearly }));
  let needed: number | null = null;
  if (at(0)) needed = 0;
  else if (at(1)) {
    let low = 0;
    let high = 1;
    while (high - low > PRECISION) {
      const middle = (low + high) / 2;
      if (at(middle)) high = middle;
      else low = middle;
    }
    needed = Math.ceil(high * BPS);
  }
  return {
    observedOn,
    base,
    stresses,
    carryObservedBps: amountUsd > 0 ? Math.floor((carry / amountUsd) * BPS) : 0,
    carryNeededBps: needed,
    met: paysAll(base) && stresses.every(paysAll),
  };
}
