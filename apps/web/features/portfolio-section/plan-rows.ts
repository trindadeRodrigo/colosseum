import type { PlanNewest } from '@colosseum/schemas';

// The rows of a plan's table: what its vault held at its newest snapshot, cash included, so the
// shares add up to the whole, as the monitor's table has them (features/portfolio/portfolio.ts,
// `holdingsOf`): the positions as the answer gave them, then the cash as a row like any other, whose
// share is what the positions leave of the vault and whose planned share is what their targets leave.
//
// Whether a row is outside the band is read the way the status rule reads it (packages/basket,
// `statusOf`), from the band and the drift the snapshot itself carries, so a row here and the plan's
// status never disagree: a position is outside when it is further from its target than the band,
// either way, and exactly at the band is inside; the cash only when it is over its share by more than
// the band. Where a part that is held has no price the plan cannot be weighed, and no row is held to
// the band at all, as the rule holds none.

export type PlanRow = {
  asset: string;
  /** The row is the vault's cash. */
  cash: boolean;
  /** Whether the vault holds any of it. */
  held: boolean;
  /** Null for a position with no price: it has no value and weighs nothing. */
  valueUsd: string | null;
  weightBps: number;
  targetBps: number;
  driftBps: number;
};

/** Raw units above zero. They can pass 2^53, so they are read as a bigint. */
function holds(raw: string): boolean {
  try {
    return BigInt(raw) > 0n;
  } catch {
    return false;
  }
}

export function rowsOf(newest: Pick<PlanNewest, 'positions' | 'cash' | 'valueUsd'>): PlanRow[] {
  const positions = newest.positions.map((position) => ({
    asset: position.asset,
    cash: position.asset === newest.cash.asset,
    held: holds(position.raw),
    valueUsd: position.valueUsd,
    weightBps: position.weightBps,
    targetBps: position.targetBps,
    driftBps: position.driftBps,
  }));
  if (positions.some((row) => row.cash)) return positions;
  const held = positions.reduce((sum, row) => sum + row.weightBps, 0);
  const targeted = positions.reduce((sum, row) => sum + row.targetBps, 0);
  const weightBps = Number(newest.valueUsd) > 0 ? Math.max(0, 10_000 - held) : 0;
  const targetBps = Math.max(0, 10_000 - targeted);
  return [
    ...positions,
    {
      asset: newest.cash.asset,
      cash: true,
      held: holds(newest.cash.raw),
      // cash at one dollar each, as the vault's own value counts it
      valueUsd: newest.cash.display,
      weightBps,
      targetBps,
      driftBps: weightBps - targetBps,
    },
  ];
}

/** A part that is held and has no price: the plan cannot be weighed. */
export const unweighed = (rows: readonly PlanRow[]): boolean =>
  rows.some((row) => row.held && row.valueUsd === null);

/** Whether the vault holds nothing at all: no position and no cash. */
export const holdsNothing = (rows: readonly PlanRow[]): boolean => rows.every((row) => !row.held);

/** Whether a row is outside the band, as the status rule counts it. Never with no band. */
export function outside(row: PlanRow, bandBps: number | null): boolean {
  if (bandBps === null) return false;
  return row.cash ? row.driftBps > bandBps : Math.abs(row.driftBps) > bandBps;
}
