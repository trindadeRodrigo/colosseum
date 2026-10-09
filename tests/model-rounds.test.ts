import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAY_S, type Round, realisedFromRounds } from '../scripts/feeds/model-rounds';

// The realised yield of SGOV from its Chainlink feed on Robinhood Chain (`pnpm feeds:refresh-models`),
// on every round of the feed as it was read on 2026-10-06 (fixtures/risk/sgov-feed-rounds.json). The
// feed pays the fund's distributions through a multiplier with a lag: it fell 27 bps on 2026-08-03 and
// came back a week later, and 25 bps on 2026-10-01 and came back the next day.

const file = JSON.parse(readFileSync('fixtures/risk/sgov-feed-rounds.json', 'utf8')) as {
  rounds: Array<{ id: string; answer: string; updatedAt: number }>;
};
const ROUNDS: Round[] = file.rounds.map((r) => ({
  id: BigInt(r.id),
  answer: BigInt(r.answer),
  updatedAt: r.updatedAt,
}));
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** The feed as it stood when its newest round was the one of `day`. */
const upTo = (day: string) => ROUNDS.filter((r) => r.updatedAt <= at(`${day}T23:59:59Z`));
const nowAfter = (rounds: Round[]) => (rounds.at(-1) as Round).updatedAt + DAY_S / 2;

describe('the realised yield from a price feed’s rounds', () => {
  it('is the newest round over the newest one at or before the start of the window, a year', () => {
    const got = realisedFromRounds(ROUNDS, at('2026-10-06T12:00:00Z'));
    if (!got.ok) throw new Error(got.error);
    // by hand: round 75 (2026-10-06, 101.18690641) over round 51 (2026-09-04, 100.97754932), 32 days
    expect(Number(got.latest.id & 0xffffn)).toBe(75);
    expect(Number(got.first.id & 0xffffn)).toBe(51);
    expect(got.days).toBeCloseTo(32, 1);
    expect(got.quoted).toBeCloseTo((101.18690641 / 100.97754932) ** (365 / got.days) - 1, 12);
    expect(got.quoted).toBeGreaterThan(0.02);
    expect(got.quoted).toBeLessThan(0.03);
    // a window never shorter than asked: the start is at or before it
    expect(got.days).toBeGreaterThanOrEqual(30);
  });

  it('is refused when the newest round sits in a distribution’s fall', () => {
    const rounds = upTo('2026-10-01');
    const got = realisedFromRounds(rounds, nowAfter(rounds));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.error).toContain('latest round sits in a distribution fall');
    // the same end read plainly would have said about three points a year less
    const first = rounds
      .filter((r) => r.updatedAt <= (rounds.at(-1) as Round).updatedAt - 30 * DAY_S)
      .at(-1) as Round;
    const naive =
      (Number((rounds.at(-1) as Round).answer) / Number(first.answer)) ** (365 / 30) - 1;
    expect(naive).toBeLessThan(0);
  });

  it('is refused when the start of the window sits in one', () => {
    // 30 days before 2026-09-04 is 2026-08-05, inside the fall of 2026-08-03 to 08-07
    const rounds = upTo('2026-09-04');
    const got = realisedFromRounds(rounds, nowAfter(rounds));
    expect(!got.ok && got.error).toContain('start of the window sits in a distribution fall');
  });

  it('is refused when the feed has stopped: its newest round is days old', () => {
    const got = realisedFromRounds(ROUNDS, at('2026-10-06T00:00:58Z') + 5 * DAY_S);
    expect(!got.ok && got.error).toContain('days old');
    // a weekend is not a stop
    expect(realisedFromRounds(ROUNDS, at('2026-10-06T00:00:58Z') + 3 * DAY_S).ok).toBe(true);
  });

  it('is refused when the history is shorter than the window: never a shorter month', () => {
    const got = realisedFromRounds(ROUNDS.slice(-12), at('2026-10-06T12:00:00Z'));
    expect(!got.ok && got.error).toContain('shorter than the 30-day window');
    expect(realisedFromRounds([], 0).ok).toBe(false);
  });
});
