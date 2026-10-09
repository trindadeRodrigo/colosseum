import { HISTORY_MAX_POINTS, HISTORY_STEP_SECONDS, type HistoryStep } from '@colosseum/schemas';
import type { HistoryQuery } from './api';

// How far back a plan's page looks: the choices a person has, each a span of time and the step its
// points are asked at. GET /v1/portfolio/history refuses a window that spans more than
// `HISTORY_MAX_POINTS` steps, or whose start is not before its end; it never cuts one. So every choice
// here is one the route serves, `served` says so of any window, and a window it would refuse is not
// asked at all (plan-window.test.ts holds the list to that).
//
// A day is asked by the ten minutes, which is every reading the worker took; a week and a month by the
// hour; ninety days by the day.

export type PlanWindow = { id: string; seconds: number; step: HistoryStep };

const DAY = 86_400;

export const WINDOWS = [
  { id: 'day', seconds: DAY, step: '10m' },
  { id: 'week', seconds: 7 * DAY, step: '1h' },
  { id: 'month', seconds: 30 * DAY, step: '1h' },
  { id: 'quarter', seconds: 90 * DAY, step: '1d' },
] as const satisfies readonly PlanWindow[];

export type WindowId = (typeof WINDOWS)[number]['id'];

/** The window a plan's page opens on. */
export const DEFAULT_WINDOW: WindowId = 'week';

/** How many steps a window spans. */
export const stepsOf = (window: Pick<PlanWindow, 'seconds' | 'step'>): number =>
  window.seconds / HISTORY_STEP_SECONDS[window.step];

/** Whether the route serves the window: its start before its end, and no more steps than it serves. */
export const served = (window: Pick<PlanWindow, 'seconds' | 'step'>): boolean =>
  Number.isFinite(window.seconds) && window.seconds > 0 && stepsOf(window) <= HISTORY_MAX_POINTS;

/** The choice an id names, or null. */
export const windowOf = (id: string): (typeof WINDOWS)[number] | null =>
  WINDOWS.find((window) => window.id === id) ?? null;

/**
 * The window as the route is asked for it, ending at `nowMs`. Both ends are sent, from the one clock,
 * so the span is the choice's own whatever that clock says: a clock that is wrong moves the window,
 * and never makes it one the route refuses. Null for a window the route would refuse, and for a clock
 * that gives no time: nothing is asked then.
 */
export function windowQuery(
  window: Pick<PlanWindow, 'seconds' | 'step'>,
  nowMs: number,
): Required<Pick<HistoryQuery, 'from' | 'to' | 'step'>> | null {
  if (!served(window) || !Number.isFinite(nowMs)) return null;
  const from = nowMs - window.seconds * 1000;
  // the route refuses a window that starts before the year 1; a real clock is far from it
  if (from <= 0) return null;
  return {
    from: new Date(from).toISOString(),
    to: new Date(nowMs).toISOString(),
    step: window.step,
  };
}
