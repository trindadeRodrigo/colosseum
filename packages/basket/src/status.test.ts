import {
  TRACK_RULE,
  TrackLine,
  TrackSnapshot,
  TrackStatus,
  type TrackVerdict,
  type TrackWord,
  type VaultState,
} from '@colosseum/schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BasketInputError } from './amounts';
import { statusOf as exported } from './index';
import { rebalancePlan } from './plan-rebalance';
import { statusOf } from './status';
import { asset, price, vault } from './testing';
import { measureVault, view } from './view';

// Each line of ON-TRACK-V1 on a made-up snapshot, each of its edges from both sides, and the order the
// lines are tried in. The clock is an argument, so every time here is counted back from one instant.

const NOW = '2026-10-07T12:00:00.000Z';
const DAY = 86_400;
/** The instant so many milliseconds before NOW, or after it when the figure is negative. */
const msAgo = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const ago = (seconds: number) => msAgo(seconds * 1000);

type Input = Parameters<typeof statusOf>[0];
type Position = TrackSnapshot['positions'][number];

/** A position that is held, has a price and is a quarter of the plan, `driftBps` off its target. */
const position = (asset: string, driftBps = 0, over: Partial<Position> = {}): Position => ({
  asset,
  raw: '250000000',
  targetBps: 2500,
  valueUsd: '250',
  driftBps,
  ...over,
});
const NAMES = ['spy', 'nvda', 'gold'];
/** Positions this far off their targets, in order: spy, nvda, gold. */
const drifting = (...drifts: number[]) =>
  drifts.map((driftBps, i) => position(`solana:${NAMES[i] ?? `asset-${i}`}`, driftBps));

/**
 * A vault read five minutes ago with nothing to remark on: cash and three positions on their targets,
 * a band of 50 bps, and 3 bps used of a loss budget of 100.
 */
const snapshot = (over: Partial<TrackSnapshot> = {}): TrackSnapshot => ({
  observedAt: ago(300),
  cash: { raw: '250000000' },
  positions: drifting(0, 0, 0),
  lossUsedBps: 3,
  bandBps: 50,
  lossCapBps: 100,
  ...over,
});

/** What a sentence a person reads never has: a second sentence, a shout, a dash, odds or a promise. */
const NOT_PLAIN = /\.\s|[!—–]|\bodds\b|probab|chance|likely|guarantee|\breturn/i;

/**
 * The rule's answer for the vault above, a minute after its chain last answered, with `over` laid on
 * top. Every made-up vault goes through here, so each snapshot is one the contract allows and each
 * answer is held to the contract too.
 */
function said(over: Partial<Input> = {}): TrackStatus {
  const input = { snapshot: snapshot(), now: NOW, chainAnsweredAt: ago(60), ...over };
  if (input.snapshot) expect(TrackSnapshot.parse(input.snapshot)).toEqual(input.snapshot);
  const answer = statusOf(input);
  expect(TrackStatus.parse(answer)).toEqual(answer);
  expect(answer.text).toMatch(/^\S.*\.$/);
  expect(answer.text).not.toMatch(NOT_PLAIN);
  return answer;
}
const lineOf = (over: Partial<Input> = {}) => said(over).line;
/** The answer for a vault whose loss used and loss budget are these. */
const lossAt = (lossUsedBps: number, lossCapBps: number) =>
  said({ snapshot: snapshot({ lossUsedBps, lossCapBps }) });

describe('statusOf, each line of ON-TRACK-V1', () => {
  it('never_read: no status for a vault that has no snapshot', () => {
    expect(said({ snapshot: null })).toEqual({
      status: null,
      rule: TRACK_RULE,
      line: 'never_read',
      params: {},
      text: 'No status yet: this vault has not been read yet.',
      observedAt: null,
    });
    // Whatever its chain has done since.
    expect(lineOf({ snapshot: null, chainAnsweredAt: null })).toBe('never_read');
    expect(lineOf({ snapshot: null, chainAnsweredAt: ago(3 * DAY) })).toBe('never_read');
  });

  it('empty: no status for a vault that holds nothing', () => {
    // As `view()` leaves an empty vault: nothing to weigh, so every drift is minus the target.
    const nothing = snapshot({
      cash: { raw: '0' },
      positions: drifting(-2500, -2500, -2500).map((p) => ({ ...p, raw: '0', valueUsd: '0' })),
    });
    expect(said({ snapshot: nothing })).toEqual({
      status: null,
      rule: TRACK_RULE,
      line: 'empty',
      params: {},
      text: 'No status yet: the vault holds nothing.',
      observedAt: nothing.observedAt,
    });
    expect(lineOf({ snapshot: snapshot({ cash: { raw: '0' }, positions: [] }) })).toBe('empty');
  });

  it('empty: a vault holds something from its first raw unit, in cash or in a position', () => {
    const none = position('solana:spy', 0, { raw: '0' });
    const bare = { cash: { raw: '0' }, positions: [none, { ...none, asset: 'solana:nvda' }] };
    expect(lineOf({ snapshot: snapshot(bare) })).toBe('empty');
    expect(lineOf({ snapshot: snapshot({ ...bare, cash: { raw: '1' } }) })).toBe('inside');
    // The last position of the list, and amounts past 2^53: they are compared as bigints.
    for (const raw of ['1', '9007199254740993', '9'.repeat(78)]) {
      const positions = [none, position('solana:nvda', 0, { raw })];
      expect(lineOf({ snapshot: snapshot({ ...bare, positions }) }), raw).toBe('inside');
    }
  });

  it('empty: a vault whose every holding has no price is not empty, and goes on down the lines', () => {
    const blind = {
      cash: { raw: '0' },
      positions: drifting(-2500, -2500, -2500).map((p) => ({ ...p, valueUsd: null })),
    };
    // On Solana its loss used then reads 10,000, the keeper's own figure.
    expect(said({ snapshot: snapshot({ ...blind, lossUsedBps: 10_000 }) })).toMatchObject({
      status: 'off_track',
      line: 'loss_half',
      params: { lossUsedBps: 10_000, lossCapBps: 100, usedPct: 10_000 },
    });
    expect(lineOf({ snapshot: snapshot({ ...blind, lossCapBps: null }) })).toBe('unpriced');
  });

  it('chain_silent: Off track a day after the chain last answered', () => {
    // A second short of 27 hours: the hours are whole, and cut.
    const old = snapshot({ observedAt: ago(26 * 3600 + 3599) });
    expect(said({ snapshot: old, chainAnsweredAt: old.observedAt })).toEqual({
      status: 'off_track',
      rule: TRACK_RULE,
      line: 'chain_silent',
      params: { hours: 26 },
      text: "The plan's chain has not been read for 26 hours, a day or more.",
      observedAt: old.observedAt,
    });
  });

  it('chain_silent: a day to the second is silent, and anything less is not', () => {
    const silentFor = (ms: number) =>
      said({ snapshot: snapshot({ observedAt: msAgo(ms) }), chainAnsweredAt: msAgo(ms) });
    expect(silentFor(86_400_000)).toMatchObject({ line: 'chain_silent', params: { hours: 24 } });
    expect(silentFor(86_399_000)).toMatchObject({ line: 'stale', params: { minutes: 1439 } });
    expect(silentFor(86_399_999).line).toBe('stale');
  });

  it('chain_silent: the silence runs from the later of the chain’s answer and the snapshot', () => {
    const old = snapshot({ observedAt: ago(2 * DAY) });
    // A pass went through a minute ago: the chain answers, and only the snapshot is old.
    expect(said({ snapshot: old, chainAnsweredAt: ago(60) })).toMatchObject({
      status: 'watch',
      line: 'stale',
      params: { minutes: 2880 },
    });
    // The hours are counted from that answer, not from the snapshot.
    expect(said({ snapshot: old, chainAnsweredAt: ago(DAY) })).toMatchObject({
      line: 'chain_silent',
      params: { hours: 24 },
    });
    // No pass has gone through at all: the snapshot's own time stands in.
    expect(lineOf({ chainAnsweredAt: null })).toBe('inside');
    expect(
      said({ snapshot: snapshot({ observedAt: ago(DAY) }), chainAnsweredAt: null }),
    ).toMatchObject({ line: 'chain_silent', params: { hours: 24 } });
    expect(
      lineOf({ snapshot: snapshot({ observedAt: ago(DAY - 1) }), chainAnsweredAt: null }),
    ).toBe('stale');
    // A snapshot newer than the last pass that went through is itself an answer of the chain.
    expect(lineOf({ chainAnsweredAt: ago(3 * DAY) })).toBe('inside');
  });

  it('counts a time ahead of the clock as no age at all: never stale, never silent', () => {
    const ahead = snapshot({ observedAt: ago(-2 * DAY) });
    expect(lineOf({ snapshot: ahead, chainAnsweredAt: null })).toBe('inside');
    expect(lineOf({ snapshot: ahead, chainAnsweredAt: ago(3 * DAY) })).toBe('inside');
    // The chain's answer is stamped ahead and the snapshot is two days old: not silent, and stale.
    const old = snapshot({ observedAt: ago(2 * DAY) });
    expect(lineOf({ snapshot: old, chainAnsweredAt: ago(-2 * DAY) })).toBe('stale');
  });

  it('loss_half: Off track at half the loss budget, the line the keeper alerts on', () => {
    const lossy = snapshot({ lossUsedBps: 62 });
    expect(said({ snapshot: lossy })).toEqual({
      status: 'off_track',
      rule: TRACK_RULE,
      line: 'loss_half',
      params: { lossUsedBps: 62, lossCapBps: 100, usedPct: 62 },
      text: 'Loss used 62% of the budget, half or more.',
      observedAt: lossy.observedAt,
    });
  });

  it('loss_half: exactly half is past the line and one bp less is not, in whole numbers', () => {
    expect(lossAt(50, 100)).toMatchObject({ line: 'loss_half', params: { usedPct: 50 } });
    expect(lossAt(49, 100)).toMatchObject({ line: 'loss_quarter', params: { usedPct: 49 } });
    // A budget that does not halve evenly: 50 of 101 is under half, 51 is past it.
    expect(lossAt(50, 101)).toMatchObject({ line: 'loss_quarter', params: { usedPct: 49 } });
    expect(lossAt(51, 101)).toMatchObject({ line: 'loss_half', params: { usedPct: 50 } });
    // The share of the budget is cut, never rounded up: 2 of 3 is 66%.
    expect(lossAt(2, 3)).toMatchObject({
      line: 'loss_half',
      params: { lossUsedBps: 2, lossCapBps: 3, usedPct: 66 },
    });
  });

  it('unpriced: Watch when a position that is held and is a target has no price', () => {
    const blind = snapshot({
      positions: [
        position('solana:spy'),
        position('solana:nvda', -2500, { valueUsd: null }),
        position('solana:gold', -2500, { valueUsd: null }),
      ],
    });
    expect(said({ snapshot: blind })).toEqual({
      status: 'watch',
      rule: TRACK_RULE,
      line: 'unpriced',
      params: { asset: 'solana:nvda', count: 2 },
      text: '2 held positions have no price (solana:nvda first), so the plan cannot be weighed.',
      observedAt: blind.observedAt,
    });
    const one = [position('solana:spy'), position('solana:gold', -2500, { valueUsd: null })];
    expect(said({ snapshot: snapshot({ positions: one }) })).toMatchObject({
      line: 'unpriced',
      params: { asset: 'solana:gold', count: 1 },
      text: '1 held position has no price (solana:gold), so the plan cannot be weighed.',
    });
  });

  it('unpriced: only a position both held and a target counts, as the planner weighs', () => {
    const second = (driftBps: number, over: Partial<Position>) =>
      said({
        snapshot: snapshot({
          positions: [position('solana:spy'), position('solana:nvda', driftBps, over)],
        }),
      });
    // A target with no price and none of it held: its share is in cash, and its drift is a fact.
    expect(second(-2500, { valueUsd: null, raw: '0' })).toMatchObject({
      line: 'outside_band',
      params: { asset: 'solana:nvda', driftBps: -2500 },
    });
    // Held with no price, and not a target: the rest is weighed without it.
    expect(second(0, { valueUsd: null, targetBps: 0 }).line).toBe('inside');
    // Held and a target, with a price that makes it worth nothing: it has a price.
    expect(second(0, { valueUsd: '0' }).line).toBe('inside');
  });

  it('no_band: no status where the chain stated no band', () => {
    const loose = snapshot({ bandBps: null });
    expect(said({ snapshot: loose })).toEqual({
      status: null,
      rule: TRACK_RULE,
      line: 'no_band',
      params: {},
      text: 'No status yet: this network states no band to hold the positions to.',
      observedAt: loose.observedAt,
    });
    // A band of zero is a band: on the target is inside it, and one bp off is not.
    expect(said({ snapshot: snapshot({ bandBps: 0 }) })).toMatchObject({
      line: 'inside',
      params: { bandBps: 0 },
    });
    const off = snapshot({ bandBps: 0, positions: drifting(1, -1, 0) });
    expect(lineOf({ snapshot: off })).toBe('outside_band');
  });

  it('outside_band: Watch when a position is further from its target than the band', () => {
    const over = snapshot({ positions: drifting(51, -25, -26) });
    expect(said({ snapshot: over })).toEqual({
      status: 'watch',
      rule: TRACK_RULE,
      line: 'outside_band',
      params: { asset: 'solana:spy', driftBps: 51, bandBps: 50 },
      text: 'solana:spy is 0.51% over its target, outside the band of 0.5%.',
      observedAt: over.observedAt,
    });
    expect(said({ snapshot: snapshot({ positions: drifting(25, -51, 26) }) })).toMatchObject({
      status: 'watch',
      line: 'outside_band',
      params: { asset: 'solana:nvda', driftBps: -51, bandBps: 50 },
      text: 'solana:nvda is 0.51% under its target, outside the band of 0.5%.',
    });
  });

  it('outside_band: exactly at the band is inside, above the target and below it', () => {
    const lineAt = (...drifts: number[]) =>
      lineOf({ snapshot: snapshot({ positions: drifting(...drifts) }) });
    expect(lineAt(50, -25, -25)).toBe('inside');
    expect(lineAt(51, -25, -26)).toBe('outside_band');
    expect(lineAt(-50, 25, 25)).toBe('inside');
    expect(lineAt(-51, 25, 26)).toBe('outside_band');
  });

  it('outside_band: names the position furthest from its target, the first of them on a tie', () => {
    const named = (...drifts: number[]) =>
      said({ snapshot: snapshot({ positions: drifting(...drifts) }) }).params;
    expect(named(60, -120, 60)).toEqual({ asset: 'solana:nvda', driftBps: -120, bandBps: 50 });
    expect(named(60, 60, -120)).toEqual({ asset: 'solana:gold', driftBps: -120, bandBps: 50 });
    expect(named(120, -120, 0)).toEqual({ asset: 'solana:spy', driftBps: 120, bandBps: 50 });
    expect(named(-120, 120, 0)).toEqual({ asset: 'solana:spy', driftBps: -120, bandBps: 50 });
  });

  it('cash_over: Watch when the cash is over its share by more than the band', () => {
    // Each position is 17 bps under its target, inside the band, and the 51 they leave are in cash.
    const idle = snapshot({ positions: drifting(-17, -17, -17) });
    expect(said({ snapshot: idle })).toEqual({
      status: 'watch',
      rule: TRACK_RULE,
      line: 'cash_over',
      params: { overBps: 51, bandBps: 50 },
      text: 'The cash is 0.51% over its share, more than the band of 0.5%.',
      observedAt: idle.observedAt,
    });
    // Over by exactly the band is inside.
    expect(lineOf({ snapshot: snapshot({ positions: drifting(-17, -17, -16) }) })).toBe('inside');
    // One side only, as the planner trades it: cash under its share by more than the band is inside.
    expect(lineOf({ snapshot: snapshot({ positions: drifting(17, 17, 17) }) })).toBe('inside');
  });

  it('loss_quarter: Watch at a quarter of the loss budget', () => {
    const worn = snapshot({ lossUsedBps: 30 });
    expect(said({ snapshot: worn })).toEqual({
      status: 'watch',
      rule: TRACK_RULE,
      line: 'loss_quarter',
      params: { lossUsedBps: 30, lossCapBps: 100, usedPct: 30 },
      text: 'Loss used 30% of the budget, a quarter or more.',
      observedAt: worn.observedAt,
    });
  });

  it('loss_quarter: exactly a quarter is past the line and one bp less is not', () => {
    expect(lossAt(25, 100)).toMatchObject({ line: 'loss_quarter', params: { usedPct: 25 } });
    expect(lossAt(24, 100)).toMatchObject({ line: 'inside', params: { usedPct: 24 } });
    // A budget that does not quarter evenly: 25 of 101 is under a quarter, 26 is past it.
    expect(lossAt(25, 101)).toMatchObject({ line: 'inside', params: { usedPct: 24 } });
    expect(lossAt(26, 101)).toMatchObject({ line: 'loss_quarter', params: { usedPct: 25 } });
    expect(lossAt(1, 3)).toMatchObject({ line: 'loss_quarter', params: { usedPct: 33 } });
  });

  it('stale: Watch when the snapshot is more than an hour old', () => {
    // A second short of 76 minutes: the minutes are whole, and cut.
    const old = snapshot({ observedAt: ago(75 * 60 + 59) });
    expect(said({ snapshot: old })).toEqual({
      status: 'watch',
      rule: TRACK_RULE,
      line: 'stale',
      params: { minutes: 75 },
      text: 'The vault was last read 75 minutes ago, more than an hour.',
      observedAt: old.observedAt,
    });
  });

  it('stale: exactly an hour is not stale, and anything more is', () => {
    const aged = (ms: number) => said({ snapshot: snapshot({ observedAt: msAgo(ms) }) });
    expect(aged(3_600_000).line).toBe('inside');
    expect(aged(3_601_000)).toMatchObject({ line: 'stale', params: { minutes: 60 } });
    expect(aged(3_600_001).line).toBe('stale');
  });

  it('inside: On track, with the loss used as a share of the budget', () => {
    const fine = snapshot();
    expect(said({ snapshot: fine })).toEqual({
      status: 'on_track',
      rule: TRACK_RULE,
      line: 'inside',
      params: { bandBps: 50, lossUsedBps: 3, lossCapBps: 100, usedPct: 3 },
      text: 'Every position inside the band; loss used 3% of the budget.',
      observedAt: fine.observedAt,
    });
  });

  it.each([null, 0])(
    'inside_no_budget: On track where the loss budget is %s, and says so',
    (lossCapBps) => {
      // Whatever the loss used reads, there is no budget to hold it to: both loss lines are skipped.
      const free = snapshot({ lossCapBps, lossUsedBps: 10_000 });
      expect(said({ snapshot: free })).toEqual({
        status: 'on_track',
        rule: TRACK_RULE,
        line: 'inside_no_budget',
        params: { bandBps: 50 },
        text: 'Every position inside the band; this network keeps no loss budget.',
        observedAt: free.observedAt,
      });
    },
  );
});

describe('statusOf, the order of the lines', () => {
  // Each vault here satisfies two lines at once and the earlier one answers. The second vault is the
  // first with the earlier line taken away, to show the later line was there to be answered.
  const silent = { observedAt: ago(2 * DAY) };
  const unpriced = [position('solana:spy'), position('solana:nvda', -2500, { valueUsd: null })];
  const priced = [position('solana:spy'), position('solana:nvda', -2500)];
  const pairs: [TrackLine, TrackLine, Partial<Input>, Partial<Input>][] = [
    [
      'empty',
      'chain_silent',
      {
        snapshot: snapshot({ ...silent, cash: { raw: '0' }, positions: [] }),
        chainAnsweredAt: null,
      },
      { snapshot: snapshot(silent), chainAnsweredAt: null },
    ],
    [
      // An empty vault on Solana with a loss counter left over reads its loss used as 10,000.
      'empty',
      'loss_half',
      { snapshot: snapshot({ cash: { raw: '0' }, positions: [], lossUsedBps: 10_000 }) },
      { snapshot: snapshot({ lossUsedBps: 10_000 }) },
    ],
    [
      'chain_silent',
      'loss_half',
      { snapshot: snapshot({ ...silent, lossUsedBps: 62 }), chainAnsweredAt: null },
      { snapshot: snapshot({ ...silent, lossUsedBps: 62 }) },
    ],
    [
      'loss_half',
      'unpriced',
      { snapshot: snapshot({ positions: unpriced, lossUsedBps: 62 }) },
      { snapshot: snapshot({ positions: unpriced }) },
    ],
    [
      'unpriced',
      'no_band',
      { snapshot: snapshot({ positions: unpriced, bandBps: null }) },
      { snapshot: snapshot({ positions: priced, bandBps: null }) },
    ],
    [
      // A position with no price reads as its whole target under, far outside the band.
      'unpriced',
      'outside_band',
      { snapshot: snapshot({ positions: unpriced }) },
      { snapshot: snapshot({ positions: priced }) },
    ],
    [
      'no_band',
      'outside_band',
      { snapshot: snapshot({ positions: drifting(-60, -10, -10), bandBps: null }) },
      { snapshot: snapshot({ positions: drifting(-60, -10, -10) }) },
    ],
    [
      'no_band',
      'cash_over',
      { snapshot: snapshot({ positions: drifting(-17, -17, -17), bandBps: null }) },
      { snapshot: snapshot({ positions: drifting(-17, -17, -17) }) },
    ],
    [
      'no_band',
      'loss_quarter',
      { snapshot: snapshot({ lossUsedBps: 30, bandBps: null }) },
      { snapshot: snapshot({ lossUsedBps: 30 }) },
    ],
    [
      'no_band',
      'stale',
      { snapshot: snapshot({ observedAt: ago(7200), bandBps: null }) },
      { snapshot: snapshot({ observedAt: ago(7200) }) },
    ],
    [
      // 80 bps short in the positions, so 80 over in cash: with one of them outside, and with none.
      'outside_band',
      'cash_over',
      { snapshot: snapshot({ positions: drifting(-60, -10, -10) }) },
      { snapshot: snapshot({ positions: drifting(-30, -25, -25) }) },
    ],
    [
      'cash_over',
      'loss_quarter',
      { snapshot: snapshot({ positions: drifting(-17, -17, -17), lossUsedBps: 30 }) },
      { snapshot: snapshot({ lossUsedBps: 30 }) },
    ],
    [
      'loss_quarter',
      'stale',
      { snapshot: snapshot({ observedAt: ago(7200), lossUsedBps: 30 }) },
      { snapshot: snapshot({ observedAt: ago(7200) }) },
    ],
    ['stale', 'inside', { snapshot: snapshot({ observedAt: ago(7200) }) }, {}],
    [
      'stale',
      'inside_no_budget',
      { snapshot: snapshot({ observedAt: ago(7200), lossCapBps: null }) },
      { snapshot: snapshot({ lossCapBps: null }) },
    ],
  ];

  it.each(pairs)('%s comes before %s', (earlier, later, both, without) => {
    expect(lineOf(both)).toBe(earlier);
    expect(lineOf(without)).toBe(later);
  });
});

describe('statusOf, a verdict handed in', () => {
  const verdict = (over: Partial<TrackVerdict> = {}): TrackVerdict => ({
    rule: 'ENG-3',
    observedOn: '2026-10-01',
    coveredNow: true,
    coveredUnderStress: true,
    ...over,
  });

  it('wins over a vault the rule calls Off track, and the answer names its rule', () => {
    const lossy = snapshot({ lossUsedBps: 62 });
    expect(said({ snapshot: lossy })).toMatchObject({ status: 'off_track', rule: TRACK_RULE });
    expect(said({ snapshot: lossy, verdict: verdict() })).toEqual({
      status: 'on_track',
      rule: 'ENG-3',
      line: 'verdict',
      params: { coveredNow: 1, coveredUnderStress: 1, observedOn: '2026-10-01' },
      text: 'ENG-3 says the goal is covered now and under stress, as observed on 2026-10-01.',
      observedAt: lossy.observedAt,
    });
  });

  it('wins where the rule has no status to give: no snapshot, nothing held, no band', () => {
    const given = { status: 'on_track', rule: 'ENG-3', line: 'verdict' };
    expect(said({ snapshot: null, verdict: verdict() })).toMatchObject({
      ...given,
      observedAt: null,
    });
    const nothing = snapshot({ cash: { raw: '0' }, positions: [] });
    expect(said({ snapshot: nothing, verdict: verdict() })).toMatchObject(given);
    expect(said({ snapshot: snapshot({ bandBps: null }), verdict: verdict() })).toMatchObject(
      given,
    );
  });

  it('is Off track when the goal is not covered now, whatever a stress says', () => {
    expect(said({ verdict: verdict({ coveredNow: false, coveredUnderStress: false }) })).toEqual({
      status: 'off_track',
      rule: 'ENG-3',
      line: 'verdict',
      params: { coveredNow: 0, coveredUnderStress: 0, observedOn: '2026-10-01' },
      text: 'ENG-3 says the goal is not covered now, as observed on 2026-10-01.',
      observedAt: snapshot().observedAt,
    });
    for (const coveredUnderStress of [true, null])
      expect(said({ verdict: verdict({ coveredNow: false, coveredUnderStress }) }).status).toBe(
        'off_track',
      );
  });

  it('is Watch when the goal is covered now but not under stress', () => {
    expect(said({ verdict: verdict({ coveredUnderStress: false }) })).toMatchObject({
      status: 'watch',
      params: { coveredNow: 1, coveredUnderStress: 0, observedOn: '2026-10-01' },
      text: 'ENG-3 says the goal is covered now but not under stress, as observed on 2026-10-01.',
    });
  });

  it('is On track when covered now with no stress run, and leaves out what it was not told', () => {
    const bare = verdict({ rule: 'income-v1', coveredUnderStress: null, observedOn: null });
    const answer = said({ verdict: bare });
    expect(answer).toEqual({
      status: 'on_track',
      rule: 'income-v1',
      line: 'verdict',
      params: { coveredNow: 1 },
      text: 'income-v1 says the goal is covered now, with no stress run.',
      observedAt: snapshot().observedAt,
    });
    expect(Object.keys(answer.params)).toEqual(['coveredNow']);
  });

  it('is the only thing that changes the rule’s name: with none handed in, the rule answers', () => {
    expect(said({ verdict: undefined })).toMatchObject({ line: 'inside', rule: TRACK_RULE });
  });
});

describe('statusOf, what it is handed', () => {
  const input: Input = { snapshot: snapshot(), now: NOW, chainAnsweredAt: null };
  const code = (work: () => unknown) => {
    try {
      work();
    } catch (e) {
      return e instanceof BasketInputError ? e.code : `not a BasketInputError: ${e}`;
    }
    return 'did not throw';
  };

  const refused = (over: Partial<Input>) => code(() => statusOf({ ...input, ...over }));

  it('refuses a time it cannot read, and one with no zone, whatever line would answer', () => {
    const given = { rule: 'ENG-3', observedOn: null, coveredNow: true, coveredUnderStress: null };
    // The fourth has no zone: read as it stands, it would be a time in the zone of the machine.
    for (const bad of ['', 'yesterday', '2026-10-07', '2026-10-07T12:00:00', '1791374400000']) {
      expect(refused({ now: bad }), `now "${bad}"`).toBe('BadTime');
      expect(refused({ chainAnsweredAt: bad }), `answered "${bad}"`).toBe('BadTime');
      const stamped = snapshot({ observedAt: bad });
      expect(refused({ snapshot: stamped }), `observed "${bad}"`).toBe('BadTime');
      // The lines that read no time refuse it all the same.
      expect(refused({ now: bad, snapshot: null }), `never read, "${bad}"`).toBe('BadTime');
      expect(refused({ now: bad, verdict: given }), `a verdict, "${bad}"`).toBe('BadTime');
    }
    // An instant whose zone is written as an offset is the same instant.
    expect(statusOf({ ...input, now: '2026-10-07T09:00:00-03:00' })).toEqual(statusOf(input));
    expect(statusOf({ ...input, now: '2026-10-07T13:00:00+01:00' })).toEqual(statusOf(input));
  });

  it('refuses an amount that is not raw units', () => {
    for (const bad of ['', '1e3', '-1', '0x10', ' 5', '1.5', '007']) {
      const cash = snapshot({ cash: { raw: bad } });
      expect(refused({ snapshot: cash }), `cash "${bad}"`).toBe('BadAmount');
      const held = snapshot({ positions: [position('solana:spy', 0, { raw: bad })] });
      expect(refused({ snapshot: held }), `held "${bad}"`).toBe('BadAmount');
    }
  });

  it('is exported from the package', () => {
    expect(exported).toBe(statusOf);
  });

  it('changes nothing it is handed, and gives the same answer for the same input', () => {
    const frozen = <T>(value: T): T => {
      if (value !== null && typeof value === 'object') {
        for (const inner of Object.values(value)) frozen(inner);
        Object.freeze(value);
      }
      return value;
    };
    const vaults: Partial<Input>[] = [
      {},
      { snapshot: null },
      { snapshot: snapshot({ positions: drifting(60, -120, 60) }) },
      { snapshot: snapshot({ lossUsedBps: 62 }) },
      { verdict: { rule: 'ENG-3', observedOn: null, coveredNow: true, coveredUnderStress: null } },
    ];
    for (const over of vaults) {
      const handed = frozen({ ...input, ...over });
      const before = JSON.stringify(handed);
      expect(statusOf(handed)).toEqual(statusOf(handed));
      expect(JSON.stringify(handed)).toBe(before);
    }
  });
});

describe('statusOf, beside the planner', () => {
  // A snapshot keeps `view()` of a vault, and the keeper plans from the same vault with
  // `rebalancePlan`. These hold the rule's two band lines to the planner's own test of the band.
  const ASSETS = [
    asset('solana:usdc', { decimals: 6, cls: 'cash' }),
    asset('solana:spy', { decimals: 8 }),
    asset('solana:nvda', { decimals: 8 }),
  ];
  const PRICES = [price('solana:spy', '100'), price('solana:nvda', '50')];
  /** A vault of cash, SPY and NVDA from raw balances, with these two targets. */
  const holding = (cashRaw: bigint, spyRaw: bigint, nvdaRaw: bigint, targets: number[]) =>
    vault(cashRaw.toString(), {
      'solana:spy': [spyRaw.toString(), targets[0] ?? 0],
      'solana:nvda': [nvdaRaw.toString(), targets[1] ?? 0],
    });
  /** The snapshot of a vault read five minutes ago, on a chain with this band and no loss budget. */
  const kept = (v: VaultState, bandBps: number): TrackSnapshot => ({
    observedAt: ago(300),
    cash: { raw: v.cash.raw },
    positions: view(v, PRICES, ASSETS).positions.map((p) => ({
      asset: p.asset,
      raw: p.raw,
      targetBps: p.targetBps,
      valueUsd: p.valueUsd,
      driftBps: p.driftBps,
    })),
    lossUsedBps: 0,
    bandBps,
    lossCapBps: null,
  });

  it('calls inside a position the keeper trades, when it is past the band by under a bp', () => {
    // $100,000: $39,500 of cash; SPY worth $30,504 against a target of 30%, so 50.4 bps over; NVDA
    // worth $29,996, 0.4 bps under its 30%. In whole bps SPY reads 50 over: exactly at a band of 50.
    const v = holding(39_500_000_000n, 30_504_000_000n, 59_992_000_000n, [3000, 3000]);
    const snap = kept(v, 50);
    expect(snap.positions.map((p) => p.driftBps)).toEqual([50, 0]);
    expect(lineOf({ snapshot: snap })).toBe('inside_no_budget');
    const targets = v.positions.map((p) => ({ asset: p.asset, weightBps: p.targetBps }));
    const plan = rebalancePlan(v, targets, PRICES, { bandBps: 50, minTradeUsd: 1 }, ASSETS);
    expect(plan.trades[0]).toMatchObject({ sell: 'solana:spy', buy: 'solana:usdc' });
  });

  it('never calls outside what the planner calls inside, and misses its line by under a bp', () => {
    const worlds = fc.record({
      // $1,000 to $100,000 of cash, and up to $100,000 of each position.
      cashRaw: fc.bigInt({ min: 10n ** 9n, max: 10n ** 11n }),
      spyRaw: fc.bigInt({ min: 10n ** 8n, max: 10n ** 11n }),
      nvdaRaw: fc.bigInt({ min: 10n ** 8n, max: 2n * 10n ** 11n }),
      // How far each target is set from where its position stands, in whole bps: around the band.
      off: fc.tuple(fc.integer({ min: -53, max: 53 }), fc.integer({ min: -53, max: 53 })),
      bandBps: fc.constantFrom(0, 25, 50),
    });
    const tally = { outside: 0, inside: 0 };
    fc.assert(
      fc.property(worlds, ({ cashRaw, spyRaw, nvdaRaw, off, bandBps }) => {
        const targets = view(holding(cashRaw, spyRaw, nvdaRaw, []), PRICES, ASSETS).positions.map(
          (p, i) => p.weightBps - (off[i] ?? 0),
        );
        fc.pre(targets.every((t) => t >= 0) && targets.reduce((n, t) => n + t, 0) <= 10_000);
        const v = holding(cashRaw, spyRaw, nvdaRaw, targets);
        const line = lineOf({ snapshot: kept(v, bandBps), chainAnsweredAt: null });
        const outside = line === 'outside_band' || line === 'cash_over';
        if (!outside) expect(line).toBe('inside_no_budget');

        // The planner's test of the band, as `rebalancePlan` writes it, on exact values.
        const { cash, positions, total } = measureVault(v, PRICES, ASSETS);
        const shares = targets.map(BigInt);
        const cashShare = 10_000n - shares.reduce((n, t) => n + t, 0n);
        const abs = (n: bigint) => (n < 0n ? -n : n);
        const past = (band: bigint) =>
          positions.some(
            (m, i) => abs((m.value ?? 0n) * 10_000n - (shares[i] ?? 0n) * total) > band * total,
          ) || (cash.value ?? 0n) * 10_000n - cashShare * total > band * total;

        // Outside here is outside for the planner. Past the band by a whole bp or more is outside
        // here too: what is left between them is under one bp, as in the vault of the test above.
        if (outside) expect(past(BigInt(bandBps))).toBe(true);
        if (past(BigInt(bandBps) + 1n)) expect(outside).toBe(true);
        tally[outside ? 'outside' : 'inside'] += 1;
      }),
      { numRuns: 2000 },
    );
    // About two vaults in three come out outside the band, and one in three inside it.
    expect(tally.outside).toBeGreaterThan(500);
    expect(tally.inside).toBeGreaterThan(250);
  });
});

describe('statusOf, on generated vaults', () => {
  /** The word each line of the rule carries. A verdict carries its own. */
  const WORD: Record<Exclude<TrackLine, 'verdict'>, TrackWord | null> = {
    never_read: null,
    empty: null,
    chain_silent: 'off_track',
    loss_half: 'off_track',
    unpriced: 'watch',
    no_band: null,
    outside_band: 'watch',
    cash_over: 'watch',
    loss_quarter: 'watch',
    stale: 'watch',
    inside: 'on_track',
    inside_no_budget: 'on_track',
  };
  // The weights lean each field to the unremarkable, so the vaults reach the lines far down the order
  // as well as the first ones. Measured over 3,000 runs of the property below: the rarest line,
  // `cash_over`, answered 27 times a run on average and never fewer than 9.
  const often = <T>(weight: number, arbitrary: fc.Arbitrary<T>) => ({ weight, arbitrary });
  const bps = fc.integer({ min: 0, max: 10_000 });
  const raw = fc.oneof(
    often(1, fc.constant('0')),
    often(4, fc.bigInt({ min: 1n, max: 10n ** 30n }).map(String)),
  );
  // Seconds back from NOW: fresh, over an hour, over a day, and ahead of the clock.
  const when = fc
    .oneof(
      often(6, fc.integer({ min: 0, max: 3600 })),
      often(2, fc.integer({ min: 3601, max: DAY - 1 })),
      often(1, fc.integer({ min: DAY, max: 3 * DAY })),
      often(1, fc.integer({ min: -DAY, max: -1 })),
    )
    .map(ago);
  const held = fc.record({
    asset: fc.constantFrom('solana:spy', 'solana:nvda', 'robinhood:gold'),
    raw,
    targetBps: fc.oneof(often(1, fc.constant(0)), often(4, bps)),
    valueUsd: fc.oneof(
      often(1, fc.constant(null)),
      often(9, fc.constantFrom('0', '0.000001', '250')),
    ),
    driftBps: fc.oneof(
      often(8, fc.integer({ min: -40, max: 40 })),
      often(1, fc.integer({ min: -10_000, max: 10_000 })),
    ),
  });
  const vaults = fc.record({
    observedAt: when,
    cash: fc.record({ raw }),
    positions: fc.array(held, { maxLength: 4 }),
    lossUsedBps: fc.oneof(often(4, fc.integer({ min: 0, max: 60 })), often(1, bps)),
    bandBps: fc.oneof(
      often(1, fc.constant(null)),
      often(7, fc.constantFrom(0, 50, 50, 100)),
      often(1, bps),
    ),
    lossCapBps: fc.oneof(
      often(2, fc.constantFrom(null, 0)),
      often(4, fc.constant(100)),
      often(1, bps),
    ),
  });
  const verdicts = fc.record({
    rule: fc.constantFrom('ENG-3', 'income-v1'),
    observedOn: fc.constantFrom(null, '2026-10-01'),
    coveredNow: fc.boolean(),
    coveredUnderStress: fc.constantFrom(null, true, false),
  });
  const inputs = fc.record({
    snapshot: fc.oneof(often(1, fc.constant(null)), often(19, vaults)),
    now: fc.constant(NOW),
    chainAnsweredAt: fc.oneof(often(1, fc.constant(null)), often(3, when)),
    verdict: fc.oneof(often(9, fc.constant(undefined)), often(1, verdicts)),
  });

  it('answers every input the contract allows, with the word its line carries', () => {
    const lines = new Set<TrackLine>();
    fc.assert(
      fc.property(inputs, (handed) => {
        if (handed.snapshot) expect(TrackSnapshot.parse(handed.snapshot)).toEqual(handed.snapshot);
        const answer = statusOf(handed);
        expect(TrackStatus.parse(answer)).toEqual(answer);
        expect(answer.text).not.toMatch(NOT_PLAIN);
        expect(answer.observedAt).toBe(handed.snapshot?.observedAt ?? null);
        if (answer.line === 'verdict') expect(answer.rule).toBe(handed.verdict?.rule);
        else {
          expect(handed.verdict).toBeUndefined();
          expect(answer.rule).toBe(TRACK_RULE);
          expect(answer.status).toBe(WORD[answer.line]);
        }
        lines.add(answer.line);
      }),
      { numRuns: 3000 },
    );
    // The vaults generated reach every line of the rule.
    expect([...lines].sort()).toEqual([...TrackLine.options].sort());
  });
});
