import { type Regime, type RegimeParams, regimeAt } from '../time';

/**
 * Step 11 — a clock of the hours a stock oracle's price moves in, so the age of its price can be counted in
 * session time. Measured in Step 11 item 2:
 *  - Kamino's Scope prices move while the US market is open and hold the last price while it is closed
 *    (`us_market_hours`);
 *  - Jupiter Lend's oracle moves around the clock on weekdays and holds over weekends and holidays
 *    (`us_weekdays`).
 * An observation made after the session ends is still the oracle's price until it reopens, and one made at
 * 10:00 is out of date by 13:00.
 */
export type PriceSession = 'us_market_hours' | 'us_weekdays';
export const SESSION_REGIMES: Record<PriceSession, readonly Regime[]> = {
  us_market_hours: ['us_market_hours'],
  us_weekdays: ['us_market_hours', 'us_offhours_weekday'],
};

export type SessionClock = {
  session: PriceSession;
  from: number;
  to: number;
  /** The session's open hours as [start, end) in Unix seconds, in order. */
  open: Array<[number, number]>;
  /** Open seconds before each interval's start. */
  before: number[];
};

/** Sessions open and close on five-minute marks, so a 300 s step finds them exactly. */
export function buildSessionClock(
  from: number,
  to: number,
  rp: RegimeParams,
  session: PriceSession = 'us_market_hours',
  stepSec = 300,
): SessionClock {
  const regimes = SESSION_REGIMES[session];
  const open: Array<[number, number]> = [];
  const start = Math.floor(from / stepSec) * stepSec;
  let since: number | null = null;
  for (let t = start; t <= to + stepSec; t += stepSec) {
    const isOpen = regimes.includes(regimeAt(new Date(t * 1000), rp));
    if (isOpen && since === null) since = t;
    else if (!isOpen && since !== null) {
      open.push([since, t]);
      since = null;
    }
  }
  if (since !== null) open.push([since, to + stepSec]);
  const before: number[] = [];
  let s = 0;
  for (const [a, b] of open) {
    before.push(s);
    s += b - a;
  }
  return { session, from: start, to, open, before };
}

/** Open seconds from the start of the clock up to `t`. */
function openUntil(c: SessionClock, t: number): number {
  let lo = 0;
  let hi = c.open.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((c.open[m] as [number, number])[0] <= t) lo = m + 1;
    else hi = m;
  }
  if (lo === 0) return 0;
  const [a, b] = c.open[lo - 1] as [number, number];
  return (c.before[lo - 1] as number) + Math.min(t, b) - a;
}

/** Seconds of the session between `a` and `b` (`a` ≤ `b`), both inside the clock's range. */
export function openSecondsBetween(c: SessionClock, a: number, b: number): number {
  if (a < c.from || b > c.to + 1)
    throw new Error(`session clock covers ${c.from}–${c.to}, asked ${a}–${b}`);
  return openUntil(c, b) - openUntil(c, a);
}

/** Whether the session opens between `a` and `b`: a start `s` with `a` < `s` ≤ `b`. */
export function sessionStartsBetween(c: SessionClock, a: number, b: number): boolean {
  let lo = 0;
  let hi = c.open.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((c.open[m] as [number, number])[0] <= a) lo = m + 1;
    else hi = m;
  }
  return lo < c.open.length && (c.open[lo] as [number, number])[0] <= b;
}
