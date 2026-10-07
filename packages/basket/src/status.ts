import {
  TRACK_RULE,
  type TrackLine,
  type TrackSnapshot,
  type TrackStatus,
  type TrackVerdict,
  type TrackWord,
} from '@colosseum/schemas';
import { BasketInputError, parseRaw } from './amounts';

// The status of a plan held in a vault, first version (gate ON-TRACK-V1): "On track", "Watch" or "Off
// track", with the line of the rule that gave it. Pure: the snapshot, the clock and the time the chain
// last answered come in as arguments, and the same inputs give the same status.
//
// The rule estimates nothing. It reads what a snapshot keeps: what the vault held, each position's
// drift, the loss used, and the chain's own band and loss budget at the read.
//
// Drift is read as the snapshot keeps it, in whole bps, the way `view()` rounds each weight: within one
// basis point of the exact share. The planner tests the band on exact values (`rebalancePlan`), so at
// the very edge of the band the two can differ by under one basis point. Where everything has a price,
// what this rule calls outside the band the planner calls outside too. But a position, or the cash,
// that is past the band by under one basis point can read here as exactly at it, and so inside, while
// the keeper trades it. That is left as it is.

/** A snapshot older than this is stale: an hour. Exactly an hour is not. */
const STALE_SECONDS = 3600;
/** A chain that last answered this long ago is silent: a day, to the second. */
const SILENT_SECONDS = 24 * 3600;

type Position = TrackSnapshot['positions'][number];

/** The zone an instant ends with. A time with none would be read in the machine's own zone. */
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO instant in milliseconds. One with no zone is refused, so nothing but the argument is read. */
function instant(iso: string, what: string): number {
  const at = ZONED.test(iso) ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at))
    throw new BasketInputError('BadTime', `${what} is not an ISO instant with its zone`);
  return at;
}

/** Raw units above zero. They can pass 2^53, so they are compared as bigints. */
const holds = (raw: string) => parseRaw(raw) > 0n;

/** Whole bps as a person reads a share: 120 is '1.2%'. A figure to show, so a float is fine. */
const percent = (bps: number) => `${bps / 100}%`;

/**
 * The status of a plan from the newest snapshot of its vault: the answer of the first line that holds,
 * in this order.
 *
 * - `verdict`: a verdict was handed in. It wins over every line below, and the answer carries its
 *   rule in place of this one. Not covered now is Off track; covered now but not under stress is
 *   Watch; covered now, under stress or with no stress run, is On track.
 * - `never_read`, no status: there is no snapshot.
 * - `empty`, no status: the vault holds no cash and no position. A deposit counts once the chain
 *   shows the vault holding it. This comes before the loss lines because an empty vault on Solana
 *   with a loss counter left over reads its loss used as 10,000.
 * - `chain_silent`, Off track: a day or more since the chain last answered. That is the later of
 *   `chainAnsweredAt` and the snapshot's own time, since a snapshot is itself an answer of the chain.
 * - `loss_half`, Off track: the loss used is at or past half the chain's loss budget. This is the
 *   line the keeper alerts on, in the same integers, so the two never disagree about it.
 * - `unpriced`, Watch: a position that is held and is a target has no price, so the plan cannot be
 *   weighed. It is the planner's `weighed: false`. A target with no price and none of it held is not
 *   this line: nothing of unknown worth is held. It reads as its whole target under and is held to
 *   the band like any position, though the planner leaves its share in cash.
 * - `no_band`, no status: the chain stated no band, so there is nothing to hold the positions to.
 * - `outside_band`, Watch: a position is further from its target than the band. Exactly at the band
 *   is inside, as the planner counts it. The answer names the position furthest out.
 * - `cash_over`, Watch: the cash is over its share by more than the band. Weights add up to exactly
 *   10,000, so what the cash is over is what the positions together are under. Cash under its share
 *   is not this line: the planner trades the one side only.
 * - `loss_quarter`, Watch: the loss used is at or past a quarter of the budget.
 * - `stale`, Watch: the snapshot is more than an hour old.
 * - `inside`, On track, on a chain with a loss budget. `inside_no_budget`, On track, on a chain that
 *   keeps none (a budget of null or of zero), where the two loss lines are skipped.
 *
 * `rule` is `TRACK_RULE` on every line but `verdict`. `observedAt` is the snapshot's time, null with
 * no snapshot. `text` is the line as one English sentence and `params` are the figures it names; the
 * web words its own sentence from `line` and `params`.
 *
 * A time ahead of `now` (two clocks that disagree) gives a negative age, which is under every line:
 * never stale, never silent. A vault whose every holding has no price is not empty and goes on down
 * the lines. On Solana its loss used then reads 10,000, the keeper's own figure, and the answer is
 * `loss_half`.
 *
 * It never throws on input the contract allows. A time that is not an ISO instant with its zone is
 * refused with `BasketInputError` (`BadTime`) whatever line would answer, and an amount that is not
 * raw units (`BadAmount`) where it is read.
 */
export function statusOf(input: {
  snapshot: TrackSnapshot | null;
  now: string;
  chainAnsweredAt: string | null;
  verdict?: TrackVerdict;
}): TrackStatus {
  const { snapshot, verdict } = input;
  const now = instant(input.now, 'now');
  const answered =
    input.chainAnsweredAt === null ? null : instant(input.chainAnsweredAt, 'chainAnsweredAt');
  const read = snapshot === null ? null : instant(snapshot.observedAt, 'the time of the snapshot');
  const answer = (
    status: TrackWord | null,
    line: TrackLine,
    params: TrackStatus['params'],
    text: string,
    rule: string = TRACK_RULE,
  ): TrackStatus => ({
    status,
    rule,
    line,
    params,
    text,
    observedAt: snapshot?.observedAt ?? null,
  });

  if (verdict) {
    const { rule, observedOn, coveredNow, coveredUnderStress: underStress } = verdict;
    const [status, found]: [TrackWord, string] = !coveredNow
      ? ['off_track', 'is not covered now']
      : underStress === false
        ? ['watch', 'is covered now but not under stress']
        : underStress === null
          ? ['on_track', 'is covered now, with no stress run']
          : ['on_track', 'is covered now and under stress'];
    const when = observedOn === null ? '' : `, as observed on ${observedOn}`;
    return answer(
      status,
      'verdict',
      {
        coveredNow: coveredNow ? 1 : 0,
        ...(underStress === null ? {} : { coveredUnderStress: underStress ? 1 : 0 }),
        ...(observedOn === null ? {} : { observedOn }),
      },
      `${rule} says the goal ${found}${when}.`,
      rule,
    );
  }

  if (snapshot === null || read === null)
    return answer(null, 'never_read', {}, 'No status yet: this vault has not been read yet.');

  if (!holds(snapshot.cash.raw) && !snapshot.positions.some((p) => holds(p.raw)))
    return answer(null, 'empty', {}, 'No status yet: the vault holds nothing.');

  const silent = now - Math.max(read, answered ?? read);
  if (silent >= SILENT_SECONDS * 1000) {
    const hours = Math.floor(silent / 3_600_000);
    return answer(
      'off_track',
      'chain_silent',
      { hours },
      `The plan's chain has not been read for ${hours} hours, a day or more.`,
    );
  }

  const { lossUsedBps, bandBps } = snapshot;
  const lossCapBps = snapshot.lossCapBps ?? 0;
  const loss =
    lossCapBps > 0
      ? { lossUsedBps, lossCapBps, usedPct: Math.floor((lossUsedBps * 100) / lossCapBps) }
      : null;
  // The keeper's own test, sign for sign (apps/keeper/src/round.ts): past half the loss budget, its
  // every line for the vault is an alert.
  if (loss && lossUsedBps * 2 >= lossCapBps)
    return answer(
      'off_track',
      'loss_half',
      loss,
      `Loss used ${loss.usedPct}% of the budget, half or more.`,
    );

  const unpriced = snapshot.positions.filter(
    (p) => holds(p.raw) && p.targetBps > 0 && p.valueUsd === null,
  );
  const [first] = unpriced;
  if (first) {
    const { asset } = first;
    const count = unpriced.length;
    const which =
      count === 1
        ? `1 held position has no price (${asset})`
        : `${count} held positions have no price (${asset} first)`;
    return answer(
      'watch',
      'unpriced',
      { asset, count },
      `${which}, so the plan cannot be weighed.`,
    );
  }

  if (bandBps === null)
    return answer(
      null,
      'no_band',
      {},
      'No status yet: this network states no band to hold the positions to.',
    );

  // The position furthest from its target, and the first of them on a tie.
  const furthest = snapshot.positions.reduce<Position | null>(
    (far, p) => (far === null || Math.abs(p.driftBps) > Math.abs(far.driftBps) ? p : far),
    null,
  );
  if (furthest && Math.abs(furthest.driftBps) > bandBps) {
    const { asset, driftBps } = furthest;
    const off = `${percent(Math.abs(driftBps))} ${driftBps > 0 ? 'over' : 'under'}`;
    return answer(
      'watch',
      'outside_band',
      { asset, driftBps, bandBps },
      `${asset} is ${off} its target, outside the band of ${percent(bandBps)}.`,
    );
  }

  const overBps = snapshot.positions.reduce((n, p) => n - p.driftBps, 0);
  if (overBps > bandBps)
    return answer(
      'watch',
      'cash_over',
      { overBps, bandBps },
      `The cash is ${percent(overBps)} over its share, more than the band of ${percent(bandBps)}.`,
    );

  if (loss && lossUsedBps * 4 >= lossCapBps)
    return answer(
      'watch',
      'loss_quarter',
      loss,
      `Loss used ${loss.usedPct}% of the budget, a quarter or more.`,
    );

  const age = now - read;
  if (age > STALE_SECONDS * 1000) {
    const minutes = Math.floor(age / 60_000);
    return answer(
      'watch',
      'stale',
      { minutes },
      `The vault was last read ${minutes} minutes ago, more than an hour.`,
    );
  }

  return loss
    ? answer(
        'on_track',
        'inside',
        { bandBps, ...loss },
        `Every position inside the band; loss used ${loss.usedPct}% of the budget.`,
      )
    : answer(
        'on_track',
        'inside_no_budget',
        { bandBps },
        'Every position inside the band; this network keeps no loss budget.',
      );
}
