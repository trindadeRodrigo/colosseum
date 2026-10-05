/// <reference path="../types/javascript-lp-solver.d.ts" />
import type {
  Asset,
  ConstraintSheet,
  LiquidityProvider,
  PlanLeg,
  YieldObservation,
} from '@colosseum/schemas';
import solver from 'javascript-lp-solver';
import { isEligible } from '../assets/eligibility';
import { currentMonth, obligationsBrl, sumUsd } from './obligations';

export * from './obligations';

export const SOLVER_VERSION = 'rules+lp-0.1';

/** Policy parameters of the allocation rules. Not yields. */
export const SOLVER_PARAMS = {
  /** Months of BRL withdrawals the BRL leg covers under the hedge stance. */
  nearTermMonths: 6,
  /** Early-redemption reserve held in the BRL leg, by liquidity window (days → share of capital). */
  brlReserveByWindow: [
    [7, 0.05],
    [30, 0.03],
    [90, 0.015],
    [Number.POSITIVE_INFINITY, 0.005],
  ] as Array<[number, number]>,
  cashFloor: 0.02,
  cashMax: 0.2,
  equityShareByRisk: { low: 0, medium: 0.2, high: 0.35 } as Record<
    ConstraintSheet['riskBudget'],
    number
  >,
  creditShareByTolerance: { none: 0, limited: 0.25, accept: 0.5 } as Record<
    ConstraintSheet['creditTolerance'],
    number
  >,
  /** Liquidity hook (used only when a LiquidityProvider is passed): max exit cost, in percent. */
  impactTolerancePct: 1,
  /** Share of measured exit capacity a plan may count on. */
  shareOfDepth: 0.25,
};

export type SolveInput = {
  sheet: ConstraintSheet;
  capitalUsd: number;
  assets: Asset[];
  yields: Map<string, YieldObservation>;
  fxUsdBrl: number;
  nowMonth?: string;
  /** Optional measured exit liquidity. Absent: stock caps are the registry caps only (behaviour unchanged). */
  liquidity?: LiquidityProvider;
};

export type SolveResult = {
  legs: PlanLeg[];
  bindingConstraints: string[];
  method: 'lp' | 'waterfall';
  notes: string[];
};

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Deterministic allocation: rules for cash, BRL leg and equity budget; LP over USD yield legs; waterfall fallback. */
export function solve(input: SolveInput): SolveResult {
  const { sheet, capitalUsd, fxUsdBrl } = input;
  const nowMonth = input.nowMonth ?? currentMonth();
  const binding: string[] = [];
  const notes: string[] = [];
  const eligible = input.assets.filter((a) => isEligible(a, sheet.profile) && a.id !== 'usdt');
  const byId = new Map(eligible.map((a) => [a.id, a]));
  const cash = byId.get('usdc');
  const brl = eligible.find((a) => a.kind === 'brl_stable');
  const legs: PlanLeg[] = [];

  // 1. Cash buffer: withdrawals due inside the liquidity window, plus a floor.
  const windowMonths = Math.max(1, Math.ceil(sheet.liquidityWindowDays / 30));
  const windowUsd = sumUsd(obligationsBrl(sheet, windowMonths, nowMonth), fxUsdBrl);
  let cashW = Math.min(
    SOLVER_PARAMS.cashMax,
    Math.max(SOLVER_PARAMS.cashFloor, windowUsd / capitalUsd + SOLVER_PARAMS.cashFloor),
  );
  if (cashW === SOLVER_PARAMS.cashMax) binding.push('cash buffer capped at max');
  if (!cash) cashW = 0;

  // 2. BRL leg: near-term withdrawals (hedge stance) plus an early-redemption reserve, capped.
  let brlW = 0;
  if (brl) {
    const reserve =
      SOLVER_PARAMS.brlReserveByWindow.find(([days]) => sheet.liquidityWindowDays <= days)?.[1] ??
      0;
    const nearUsd =
      sheet.fxStance === 'hedge_near_term'
        ? sumUsd(obligationsBrl(sheet, SOLVER_PARAMS.nearTermMonths, nowMonth), fxUsdBrl)
        : 0;
    const wanted = Math.max(0, nearUsd / capitalUsd - cashW) + reserve;
    brlW = Math.min(brl.capWeight, wanted);
    if (wanted > brl.capWeight)
      binding.push(`BRL leg capped at ${brl.capWeight} (wanted ${r4(wanted)})`);
  }

  // 3. Equity budget (high-risk profiles only), split equally across eligible stocks within caps.
  const equities = eligible.filter((a) => a.kind === 'equity');
  let equityW =
    sheet.profile === 'high_risk' && equities.length
      ? SOLVER_PARAMS.equityShareByRisk[sheet.riskBudget]
      : 0;
  const equityLegs: Array<[Asset, number]> = [];
  if (equityW > 0 && !input.liquidity) {
    const each = Math.min(equityW / equities.length, ...equities.map((e) => e.capWeight));
    for (const e of equities) equityLegs.push([e, each]);
    const placed = each * equities.length;
    if (placed < equityW - 1e-9)
      binding.push(`equity budget ${equityW} limited by per-stock caps to ${r4(placed)}`);
    equityW = placed;
  } else if (equityW > 0 && input.liquidity) {
    // effective cap = min(registry cap, shareOfDepth × worst-regime exit capacity at tau / capital)
    const tau = SOLVER_PARAMS.impactTolerancePct / 100;
    const target = equityW / equities.length;
    let placed = 0;
    for (const e of equities) {
      const cap = input.liquidity.exitCapacity(e.id, tau, sheet.liquidityWindowDays);
      const liqCap = cap ? (SOLVER_PARAMS.shareOfDepth * cap.capacityUsd) / capitalUsd : 0;
      const w = Math.min(target, e.capWeight, liqCap);
      if (liqCap < Math.min(target, e.capWeight) - 1e-9)
        binding.push(
          cap
            ? `${e.id} capped at ${r4(w)} by ${cap.regime} exit capacity $${Math.round(cap.capacityUsd).toLocaleString('en-US')} at ≤${SOLVER_PARAMS.impactTolerancePct}% cost (share ${SOLVER_PARAMS.shareOfDepth}; ${cap.samples} samples, ${cap.dataFrom?.slice(0, 10) ?? '?'} → ${cap.dataTo?.slice(0, 10) ?? '?'}; ${input.liquidity.methodVersion})`
            : `${e.id} excluded: no measured exit capacity (${input.liquidity.methodVersion})`,
        );
      if (w > 1e-9) equityLegs.push([e, w]);
      placed += w;
    }
    if (placed < equityW - 1e-9)
      binding.push(
        `equity budget ${equityW} limited to ${r4(placed)} by caps and measured exit capacity`,
      );
    equityW = placed;
  }

  // 4. USD yield legs: LP maximising haircut yield within caps and the credit budget.
  const remainder = Math.max(0, 1 - cashW - brlW - equityW);
  const yieldLegs = eligible.filter((a) => a.kind === 'usd_yield');
  const creditMax = SOLVER_PARAMS.creditShareByTolerance[sheet.creditTolerance];
  const y = (a: Asset) => input.yields.get(a.id)?.haircutYield ?? 0;
  const weights = new Map<string, number>();
  let method: SolveResult['method'] = 'lp';
  const constraints: Record<string, { max?: number; equal?: number }> = {
    total: { equal: remainder },
    credit: { max: creditMax },
  };
  const variables: Record<string, Record<string, number>> = {};
  for (const a of yieldLegs) {
    constraints[`cap_${a.id}`] = { max: a.capWeight };
    variables[a.id] = {
      y: y(a),
      total: 1,
      [`cap_${a.id}`]: 1,
      credit: a.metadata.creditLeg ? 1 : 0,
    };
  }
  const lp = yieldLegs.length
    ? solver.Solve({ optimize: 'y', opType: 'max', constraints, variables })
    : { feasible: false, bounded: true, result: 0 };
  if (lp.feasible) {
    for (const a of yieldLegs) weights.set(a.id, Number(lp[a.id] ?? 0));
    const creditUsed = yieldLegs
      .filter((a) => a.metadata.creditLeg)
      .reduce((s, a) => s + (weights.get(a.id) ?? 0), 0);
    if (creditUsed >= creditMax - 1e-9 && creditMax > 0)
      binding.push(`credit budget ${creditMax} fully used`);
    if (creditMax === 0) binding.push('credit legs excluded (credit tolerance: none)');
    for (const a of yieldLegs)
      if ((weights.get(a.id) ?? 0) >= a.capWeight - 1e-9)
        binding.push(`${a.id} at cap ${a.capWeight}`);
  } else {
    method = 'waterfall';
    notes.push(
      'LP infeasible (caps cannot absorb the remainder); greedy fill by haircut yield, leftover to cash',
    );
    let left = remainder;
    let creditLeft = creditMax;
    for (const a of [...yieldLegs].sort((p, q) => y(q) - y(p))) {
      const room = Math.min(a.capWeight, left, a.metadata.creditLeg ? creditLeft : left);
      if (room <= 0) continue;
      weights.set(a.id, room);
      left -= room;
      if (a.metadata.creditLeg) creditLeft -= room;
    }
    if (left > 1e-9) {
      cashW += left;
      binding.push(`unallocated ${r4(left)} parked in cash`);
    }
  }

  // 5. Assemble legs with reasoning.
  const fmt = (w: number) => `${(w * 100).toFixed(1)}%`;
  if (cash && cashW > 0)
    legs.push(
      leg(
        cash,
        cashW,
        capitalUsd,
        `Liquidity buffer: covers withdrawals inside the ${sheet.liquidityWindowDays}-day window (${windowMonths} month${windowMonths > 1 ? 's' : ''}) plus a ${fmt(SOLVER_PARAMS.cashFloor)} floor`,
      ),
    );
  if (brl && brlW > 0)
    legs.push(
      leg(
        brl,
        brlW,
        capitalUsd,
        sheet.fxStance === 'hedge_near_term'
          ? `Near-term BRL obligations (${SOLVER_PARAMS.nearTermMonths} months) and an early-redemption reserve held in reais: no FX risk against the goal, no yield`
          : 'Early-redemption reserve in reais (FX stance: accept)',
      ),
    );
  for (const [e, w] of equityLegs)
    legs.push(
      leg(
        e,
        w,
        capitalUsd,
        `Risk budget (${sheet.riskBudget}) allocated to tokenized stocks for a ${sheet.profile} goal; pays no income`,
      ),
    );
  for (const a of yieldLegs) {
    const w = weights.get(a.id) ?? 0;
    if (w <= 1e-9) continue;
    const obs = input.yields.get(a.id);
    legs.push(
      leg(
        a,
        w,
        capitalUsd,
        `${a.metadata.creditLeg ? 'Credit leg within the credit budget; ' : ''}selected by haircut yield${obs ? ` (${obs.method}, rule ${obs.haircutRule}, ${obs.fetchedAt.slice(0, 10)})` : ''}`,
        obs,
      ),
    );
  }
  return { legs, bindingConstraints: binding, method, notes };
}

function leg(
  a: Asset,
  w: number,
  capitalUsd: number,
  reasoning: string,
  obs?: YieldObservation,
): PlanLeg {
  return {
    assetId: a.id,
    weight: r4(w),
    amountUsd: Math.round(w * capitalUsd * 100) / 100,
    reasoning,
    yieldObservation: obs,
  };
}
