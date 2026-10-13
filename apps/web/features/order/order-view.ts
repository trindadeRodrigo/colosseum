import type { ChainId, Leg, OrderDetail } from '@colosseum/schemas';
import type { Dictionary } from '../../i18n';
import type { RunOutcome } from './run-order';

// What the order screen says about where an order stands, worked out from what the executor answered.
// One sentence, and at most one thing to do next: the screen's one primary button. Pure, so each answer
// of the executor is tested here with its sentence.

/** What the person can do after an answer. */
export type NextStep =
  /** Run the same order again: the executor picks up where the API says it is. */
  | { kind: 'run' }
  /** Approve the step again after `needs_review`: good for one more signature of that step. */
  | { kind: 'approve-again'; legId: string; signedTimes: number; step: number }
  /** Nothing more can happen in this order: a new one is made from the plan. */
  | { kind: 'new-order' }
  /** EVM: another order of this wallet holds a transaction that can still land. */
  | { kind: 'other-order'; orderId: string }
  | { kind: 'none' };

export type OutcomeView = {
  sentence: string;
  /** For a guard refusal: the check that failed, for the person to quote. */
  check?: string;
  /** The guard's own words, for the team. */
  detail?: string;
  next: NextStep;
  /** The answer says something went wrong, not that the order is on its way. */
  alarm: boolean;
};

export const legsInOrder = (order: Pick<OrderDetail, 'legs'>): Leg[] =>
  [...order.legs].sort((a, b) => a.seq - b.seq);

/** A step's number as the screen shows it, from 1. */
export function stepOf(order: Pick<OrderDetail, 'legs'>, legId: string | null): number {
  const at = legsInOrder(order).findIndex((l) => l.id === legId);
  return at < 0 ? 1 : at + 1;
}

/** Which sentence a guard refusal gets, by the check that failed. */
export function refusalKind(code: string): 'moved' | 'mismatch' | 'setup' | 'order' {
  if (code === 'minimum' || code === 'preview') return 'moved';
  if (code === 'deployment' || code === 'unsupported' || code === 'network') return 'setup';
  if (code === 'order') return 'order';
  return 'mismatch';
}

export function outcomeView(outcome: RunOutcome, t: Dictionary, chain: ChainId): OutcomeView {
  const o = t.order.outcome;
  const chainName = t.chain.names[chain];
  switch (outcome.status) {
    case 'done':
      return { sentence: o.done(chainName), next: { kind: 'none' }, alarm: false };
    case 'refused': {
      const kind = refusalKind(outcome.refusal.code);
      const head =
        kind === 'order' || outcome.legId === null
          ? o.refusedOrder
          : o.refused(stepOf(outcome.order, outcome.legId));
      return {
        sentence: kind === 'order' ? head : `${head} ${o.refusedWhy[kind]}`,
        check: o.check(outcome.refusal.code),
        detail: outcome.refusal.message,
        next: kind === 'setup' ? { kind: 'none' } : { kind: 'new-order' },
        alarm: true,
      };
    }
    case 'cancelled':
      return {
        sentence: o.cancelled(stepOf(outcome.order, outcome.legId)),
        next: { kind: 'run' },
        alarm: true,
      };
    case 'failed':
      return {
        sentence: o.failed(stepOf(outcome.order, outcome.legId)),
        next: { kind: 'new-order' },
        alarm: true,
      };
    case 'expired':
      return { sentence: o.expired, next: { kind: 'new-order' }, alarm: true };
    case 'blocked':
      return {
        sentence: o.blocked,
        next: { kind: 'other-order', orderId: outcome.blocking.orderId },
        alarm: true,
      };
    case 'needs_review': {
      const step = stepOf(outcome.order, outcome.legId);
      return {
        sentence: o.needsReview(step, outcome.signedTimes),
        next: {
          kind: 'approve-again',
          legId: outcome.legId,
          signedTimes: outcome.signedTimes,
          step,
        },
        alarm: true,
      };
    }
    case 'waiting':
      return {
        sentence: o.waiting[outcome.why],
        next: { kind: 'run' },
        alarm: false,
      };
    case 'error':
      // A plan that is gone cannot be bought by trying again: it is made again from the goal.
      if (outcome.error.body?.code === 'PLAN_GONE')
        return { sentence: o.planGone, next: { kind: 'none' }, alarm: true };
      return { sentence: o.error, next: { kind: 'run' }, alarm: true };
    case 'elsewhere':
      return { sentence: o.elsewhere, next: { kind: 'none' }, alarm: false };
    case 'not-runnable':
      return {
        sentence:
          outcome.why === 'no-deployment'
            ? o.notRunnable['no-deployment'](chainName)
            : o.notRunnable[outcome.why],
        next: outcome.why === 'plan-mismatch' ? { kind: 'new-order' } : { kind: 'none' },
        alarm: true,
      };
    case 'crashed':
      return { sentence: o.crashed, detail: outcome.message, next: { kind: 'run' }, alarm: true };
  }
}
