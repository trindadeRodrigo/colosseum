// The realised yield of a token that pays through its price, from the rounds of its price feed
// (scripts/feeds/refresh-models.ts reads them; this file has no I/O). SGOV on Robinhood Chain pays
// its distributions through a multiplier the Chainlink feed carries, but not at once: on an
// ex-dividend day the feed falls by the distribution (25 to 27 bps on 2026-08-03 and 2026-10-01) and
// comes back when the multiplier is raised, a day to a week later. A window with an end inside such a
// fall reads a month's yield three points a year too low or too high, so it is refused, as is a feed
// that has stopped and a history shorter than the window: an earlier reading stays the newest.

export type Round = { id: bigint; answer: bigint; updatedAt: number };

export const DAY_S = 86_400;
export const WINDOW_DAYS = 30;
/** A feed whose newest round is older than this has stopped: a weekend and a holiday fit inside it. */
export const MAX_AGE_DAYS = 4;
/** A round this far under the highest of the rounds before it sits in a distribution's fall. */
export const DIP_BPS = 10;
/** How many rounds before an end are looked at for that. */
export const LOOKBACK = 5;

export type Realised =
  | { ok: true; quoted: number; days: number; first: Round; latest: Round; rounds: number }
  | { ok: false; error: string };

const inDip = (rounds: Round[], i: number): boolean => {
  const before = rounds.slice(Math.max(0, i - LOOKBACK), i);
  if (!before.length) return false;
  const high = before.reduce((m, r) => (r.answer > m ? r.answer : m), 0n);
  return Number(rounds[i]?.answer) < Number(high) * (1 - DIP_BPS / 10_000);
};

/**
 * The yield a year, from the newest round back to the newest round at or before the start of the
 * window. `rounds` are oldest first and reach `LOOKBACK` rounds before that start where the feed has
 * them. `nowS` is the time of the read, in seconds.
 */
export function realisedFromRounds(rounds: Round[], nowS: number): Realised {
  const latest = rounds.at(-1);
  if (!latest || latest.answer <= 0n) return { ok: false, error: 'the feed gave no latest round' };
  const age = (nowS - latest.updatedAt) / DAY_S;
  if (age > MAX_AGE_DAYS)
    return {
      ok: false,
      error: `the feed's latest round is ${age.toFixed(1)} days old (more than ${MAX_AGE_DAYS}): not stored`,
    };
  const from = latest.updatedAt - WINDOW_DAYS * DAY_S;
  let at = -1;
  for (let i = rounds.length - 1; i >= 0; i--)
    if ((rounds[i] as Round).updatedAt <= from) {
      at = i;
      break;
    }
  const first = rounds[at];
  if (!first)
    return {
      ok: false,
      error: `the feed's history is shorter than the ${WINDOW_DAYS}-day window: not stored`,
    };
  if (first.answer <= 0n)
    return { ok: false, error: 'the round at the start of the window is empty' };
  if (inDip(rounds, rounds.length - 1))
    return {
      ok: false,
      error:
        'the latest round sits in a distribution fall the multiplier has not made up yet: not stored',
    };
  if (inDip(rounds, at))
    return {
      ok: false,
      error: 'the round at the start of the window sits in a distribution fall: not stored',
    };
  const days = (latest.updatedAt - first.updatedAt) / DAY_S;
  const quoted = (Number(latest.answer) / Number(first.answer)) ** (365 / days) - 1;
  return { ok: true, quoted, days, first, latest, rounds: rounds.length - at };
}
