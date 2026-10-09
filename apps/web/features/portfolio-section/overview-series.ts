import {
  HISTORY_MAX_POINTS,
  HISTORY_STEP_SECONDS,
  type HistoryStep,
  type PersonWithdrawal,
  type Provenance,
} from '@colosseum/schemas';
import type { HistoryAnswer, HistoryQuery, PlansAnswer } from './api';
import { sameVault } from './plan-blocks';

// The overview's figures over time (/portfolio): what the person's vaults were worth together, what
// they had put in by then, and the difference, which is what the plans made or lost; and the same
// value cut into a stack by vault or by asset. Every figure here is added from the answers: the
// snapshots of GET /v1/portfolio/history, the confirmed deposits of GET /v1/portfolio/plans and the
// confirmed withdrawals of GET /v1/me/withdrawals. Nothing is estimated between two readings.
//
// A deposit is not a gain: at each time a vault counts only once it has a reading, and then as its
// value less what had gone in (deposits less withdrawals) by that time. The line is green where that
// difference is at or above zero and red where it is below.
//
// Figures of different kinds are never added: the sums hold the vaults of one provenance only (live,
// else the test network, else the mock), and the page says which.

const DAY_MS = 86_400_000;

export const PERIODS = [
  { id: '1d', line: '10m', bars: '1h' },
  { id: '7d', line: '1h', bars: '1d' },
  { id: '30d', line: '1h', bars: '1d' },
  { id: '1y', line: '1d', bars: '1d' },
  { id: 'ytd', line: '1d', bars: '1d' },
  { id: 'all', line: '1d', bars: '1d' },
] as const satisfies readonly { id: string; line: HistoryStep; bars: HistoryStep }[];

export type PeriodId = (typeof PERIODS)[number]['id'];
export const DEFAULT_PERIOD: PeriodId = '30d';

export const periodOf = (id: string): (typeof PERIODS)[number] | null =>
  PERIODS.find((period) => period.id === id) ?? null;

/**
 * The window a period asks the history route for, ending at `nowMs`, at the step the chart draws:
 * the line's, or the bars'. "All" starts on the UTC day of the person's first deposit, or a year back
 * when none is known. A window the route would refuse (more than `HISTORY_MAX_POINTS` steps) starts
 * later so it fits: the route never cuts one itself.
 */
export function periodQuery(
  id: PeriodId,
  kind: 'line' | 'bars',
  nowMs: number,
  firstMs: number | null,
): Required<Pick<HistoryQuery, 'from' | 'to' | 'step'>> | null {
  const period = periodOf(id);
  if (!period || !Number.isFinite(nowMs)) return null;
  const step = period[kind];
  const now = new Date(nowMs);
  const from =
    id === '1d'
      ? nowMs - DAY_MS
      : id === '7d'
        ? nowMs - 7 * DAY_MS
        : id === '30d'
          ? nowMs - 30 * DAY_MS
          : id === '1y'
            ? nowMs - 365 * DAY_MS
            : id === 'ytd'
              ? Date.UTC(now.getUTCFullYear(), 0, 1)
              : firstMs !== null && firstMs < nowMs
                ? Math.floor(firstMs / DAY_MS) * DAY_MS
                : nowMs - 365 * DAY_MS;
  const longest = HISTORY_MAX_POINTS * HISTORY_STEP_SECONDS[step] * 1000;
  const start = Math.max(from, nowMs - longest);
  // the route refuses a window that is not one
  if (!(start < nowMs) || start <= 0) return null;
  return { from: new Date(start).toISOString(), to: now.toISOString(), step };
}

/** Money into (+) or out of (−) a vault, at the time the server learned it confirmed. */
export type Flow = { chain: string; address: string; at: number; usd: number };

/**
 * Every confirmed deposit and withdrawal of the person's vaults. A withdrawal step with a token that
 * had no price when it was ordered cannot be counted in dollars: those are counted in `unvalued`, so
 * the page can say its figures leave them out.
 */
export function flowsOf(
  plans: PlansAnswer,
  withdrawals: readonly PersonWithdrawal[],
): { flows: Flow[]; unvalued: number } {
  const flows: Flow[] = [];
  let unvalued = 0;
  for (const entry of plans.chains)
    for (const plan of entry.plans)
      for (const deposit of plan.putIn?.deposits ?? [])
        flows.push({
          chain: entry.chain,
          address: plan.address,
          at: Date.parse(deposit.at),
          usd: Number(deposit.usd),
        });
  for (const withdrawal of withdrawals)
    for (const step of withdrawal.steps) {
      if (step.status !== 'confirmed') continue;
      let usd = 0;
      for (const out of step.withdrawals) {
        if (out.valued) usd += Number(out.valued.usd);
        else unvalued += 1;
      }
      if (usd > 0)
        flows.push({
          chain: withdrawal.chain,
          address: withdrawal.vault,
          at: Date.parse(step.at),
          usd: -usd,
        });
    }
  return { flows: flows.filter((flow) => Number.isFinite(flow.at)), unvalued };
}

const ORDER: Record<Provenance, number> = {
  live: 0,
  sandbox: 1,
  mock: 2,
  fixture: 3,
  prior_dataset: 4,
};

/** The provenance the sums hold: the most live one among the chains that hold a plan. */
export function provenanceOf(plans: PlansAnswer): Provenance | null {
  const held = plans.chains.filter((entry) => entry.plans.length > 0);
  if (held.length === 0) return null;
  return held.map((entry) => entry.provenance).sort((a, b) => ORDER[a] - ORDER[b])[0] ?? null;
}

/** The chains whose figures the sums hold. */
export const chainsOf = (plans: PlansAnswer, provenance: Provenance | null): Set<string> =>
  new Set(
    plans.chains
      .filter((entry) => entry.provenance === provenance && entry.plans.length > 0)
      .map((entry) => entry.chain),
  );

type Series = {
  chain: string;
  address: string;
  name: string | null;
  points: { at: number; valueUsd: number; parts: Map<string, number> }[];
};

function seriesOf(history: HistoryAnswer, chains: Set<string>): Series[] {
  return history.chains
    .filter((entry) => chains.has(entry.chain))
    .flatMap((entry) =>
      entry.vaults.map((series) => ({
        chain: entry.chain,
        address: series.address,
        name: series.name,
        points: series.points
          .map((point) => {
            const parts = new Map<string, number>();
            const cash = Number(point.cashUsd);
            if (cash > 0) parts.set('cash', cash);
            for (const position of point.positions)
              if (position.valueUsd !== null && Number(position.valueUsd) > 0)
                parts.set(
                  position.asset,
                  (parts.get(position.asset) ?? 0) + Number(position.valueUsd),
                );
            return { at: Date.parse(point.observedAt), valueUsd: Number(point.valueUsd), parts };
          })
          .filter((point) => Number.isFinite(point.at))
          .sort((a, b) => a.at - b.at),
      })),
    )
    .filter((series) => series.points.length > 0);
}

/** A vault's reading at or before a time, carried forward from the last one taken. */
function atOrBefore(series: Series, at: number): Series['points'][number] | null {
  let found: Series['points'][number] | null = null;
  for (const point of series.points) {
    if (point.at > at) break;
    found = point;
  }
  return found;
}

const netOf = (flows: readonly Flow[], series: Series, at: number): number =>
  flows
    .filter(
      (flow) =>
        flow.chain === series.chain && sameVault(flow.address, series.address) && flow.at <= at,
    )
    .reduce((sum, flow) => sum + flow.usd, 0);

const timesOf = (all: readonly Series[]): number[] =>
  [...new Set(all.flatMap((series) => series.points.map((point) => point.at)))].sort(
    (a, b) => a - b,
  );

export type TotalPoint = {
  at: number;
  /** What the vaults that had a reading by then were worth together. */
  valueUsd: number;
  /** What had gone into those vaults by then: deposits less withdrawals. */
  netUsd: number;
  /** `valueUsd − netUsd`: made (≥ 0) or lost (< 0). */
  pnlUsd: number;
};

/** The vaults' value over time, one point at each time any of them was read. */
export function totalLine(
  history: HistoryAnswer,
  flows: readonly Flow[],
  chains: Set<string>,
): TotalPoint[] {
  const all = seriesOf(history, chains);
  return timesOf(all).map((at) => {
    let valueUsd = 0;
    let netUsd = 0;
    for (const series of all) {
      const point = atOrBefore(series, at);
      if (!point) continue;
      valueUsd += point.valueUsd;
      netUsd += netOf(flows, series, at);
    }
    return { at, valueUsd, netUsd, pnlUsd: valueUsd - netUsd };
  });
}

/** What one vault made or lost over the window, and what was at work in it. */
export type VaultPeriod = { chain: string; address: string; pnlUsd: number; baseUsd: number };

/**
 * What each vault made or lost over the window: its difference at its last reading less its
 * difference at its first. What was at work is its value at its first reading plus what was
 * deposited into it after.
 */
export function vaultPeriods(
  history: HistoryAnswer,
  flows: readonly Flow[],
  chains: Set<string>,
): VaultPeriod[] {
  return seriesOf(history, chains).flatMap((series) => {
    const first = series.points[0];
    const last = series.points[series.points.length - 1];
    if (!first || !last) return [];
    const before = first.valueUsd - netOf(flows, series, first.at);
    const after = last.valueUsd - netOf(flows, series, last.at);
    const added = flows
      .filter(
        (flow) =>
          flow.chain === series.chain &&
          sameVault(flow.address, series.address) &&
          flow.at > first.at &&
          flow.at <= last.at &&
          flow.usd > 0,
      )
      .reduce((sum, flow) => sum + flow.usd, 0);
    return [
      {
        chain: series.chain,
        address: series.address,
        pnlUsd: after - before,
        baseUsd: first.valueUsd + added,
      },
    ];
  });
}

/** The share a gain or loss is of what was at work, or null where nothing was. */
export const shareOf = (pnlUsd: number, baseUsd: number): number | null =>
  baseUsd > 0 ? pnlUsd / baseUsd : null;

/** What the vaults made or lost over the window together, and its share of what was at work. */
export function periodPnl(
  history: HistoryAnswer,
  flows: readonly Flow[],
  chains: Set<string>,
): { pnlUsd: number; share: number | null } | null {
  const each = vaultPeriods(history, flows, chains);
  if (each.length === 0) return null;
  const pnlUsd = each.reduce((sum, v) => sum + v.pnlUsd, 0);
  return {
    pnlUsd,
    share: shareOf(
      pnlUsd,
      each.reduce((sum, v) => sum + v.baseUsd, 0),
    ),
  };
}

/**
 * The line cut where it crosses what was put in: runs of points on one side, each with the side it
 * is on. A run ends on the crossing, worked out on the straight line between the two readings, and the
 * next starts there, so the two colours meet.
 */
export function signRuns(
  line: readonly TotalPoint[],
): { up: boolean; points: { at: number; valueUsd: number }[] }[] {
  const runs: { up: boolean; points: { at: number; valueUsd: number }[] }[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const point = line[i] as TotalPoint;
    const up = point.pnlUsd >= 0;
    const run = runs[runs.length - 1];
    if (!run) {
      runs.push({ up, points: [{ at: point.at, valueUsd: point.valueUsd }] });
      continue;
    }
    if (run.up === up) {
      run.points.push({ at: point.at, valueUsd: point.valueUsd });
      continue;
    }
    const prev = line[i - 1] as TotalPoint;
    const f = prev.pnlUsd / (prev.pnlUsd - point.pnlUsd || 1);
    const cross = {
      at: prev.at + (point.at - prev.at) * f,
      valueUsd: prev.valueUsd + (point.valueUsd - prev.valueUsd) * f,
    };
    run.points.push(cross);
    runs.push({ up, points: [cross, { at: point.at, valueUsd: point.valueUsd }] });
  }
  return runs;
}

export type StackPart = { key: string; usd: number };
export type Stack = { at: number; parts: StackPart[] };

/**
 * The value at each step cut by vault (`chain:address`) or by asset (an asset id, or `cash`), with
 * the parts in the same order at every step: the largest overall first.
 */
export function stacks(
  history: HistoryAnswer,
  by: 'vault' | 'asset',
  chains: Set<string>,
): Stack[] {
  const all = seriesOf(history, chains);
  const rows = timesOf(all).map((at) => {
    const parts = new Map<string, number>();
    for (const series of all) {
      const point = atOrBefore(series, at);
      if (!point) continue;
      if (by === 'vault') {
        const key = `${series.chain}:${series.address}`;
        parts.set(key, (parts.get(key) ?? 0) + point.valueUsd);
      } else for (const [key, usd] of point.parts) parts.set(key, (parts.get(key) ?? 0) + usd);
    }
    return { at, parts };
  });
  const totals = new Map<string, number>();
  for (const row of rows)
    for (const [key, usd] of row.parts) totals.set(key, (totals.get(key) ?? 0) + usd);
  const keys = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  return rows.map((row) => ({
    at: row.at,
    parts: keys.map((key) => ({ key, usd: row.parts.get(key) ?? 0 })),
  }));
}
