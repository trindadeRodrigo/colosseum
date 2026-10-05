/**
 * Time of week in US Eastern time (DST from the tz database via Intl; no library).
 * Regimes, first match wins: us_holiday (NYSE closed date), weekend (weekendStart → weekendEnd, ET),
 * us_market_hours (Mon–Fri rthOpen–rthClose ET, early-close days end at 13:00), us_offhours_weekday.
 * Boundaries are policy inputs (RegimeParams), stored with every output.
 */
export type Regime = 'us_holiday' | 'weekend' | 'us_market_hours' | 'us_offhours_weekday';
export const REGIMES: Regime[] = [
  'us_market_hours',
  'us_offhours_weekday',
  'weekend',
  'us_holiday',
];

export type RegimeParams = {
  holidays: Set<string>;
  earlyClose: Set<string>;
  /** Day of week (Mon=0 … Sun=6) and ET hour where the weekend regime starts and ends. */
  weekendStart: { dow: number; hour: number };
  weekendEnd: { dow: number; hour: number };
  rthOpenHour: number;
  rthCloseHour: number;
};

export function defaultRegimeParams(calendar: {
  closed: string[];
  earlyClose13ET: string[];
}): RegimeParams {
  return {
    holidays: new Set(calendar.closed),
    earlyClose: new Set(calendar.earlyClose13ET),
    weekendStart: { dow: 4, hour: 20 },
    weekendEnd: { dow: 6, hour: 20 },
    rthOpenHour: 9.5,
    rthCloseHour: 16,
  };
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export type EtParts = { date: string; dow: number; hour: number; minute: number };
export function etParts(at: Date): EtParts {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dow: DOW[p.weekday as string] as number,
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/** Hour of week in ET, Monday 00:00 = 0 … Sunday 23:00 = 167. */
export const hourOfWeek = (at: Date) => {
  const e = etParts(at);
  return e.dow * 24 + e.hour;
};

export function regimeAt(at: Date, p: RegimeParams): Regime {
  const e = etParts(at);
  if (p.holidays.has(e.date)) return 'us_holiday';
  const t = e.dow * 24 + e.hour + e.minute / 60;
  const ws = p.weekendStart.dow * 24 + p.weekendStart.hour;
  const we = p.weekendEnd.dow * 24 + p.weekendEnd.hour;
  if (t >= ws && t < we) return 'weekend';
  const h = e.hour + e.minute / 60;
  const close = p.earlyClose.has(e.date) ? 13 : p.rthCloseHour;
  if (e.dow <= 4 && h >= p.rthOpenHour && h < close) return 'us_market_hours';
  return 'us_offhours_weekday';
}

/**
 * Distinct regimes met stepping hourly through [at, at + hours] (inclusive of both ends). The walk stops once the
 * three regimes of an ordinary week are met: after that only `us_holiday` can join, and it does exactly when a
 * holiday falls between the ET dates of the first and last step, since hourly steps skip no calendar date. A year's
 * window then costs about a week of steps instead of 8,760 (PLAN-ANALYTICS item 2).
 */
export function regimesIn(at: Date, hours: number, p: RegimeParams): Regime[] {
  const seen = new Set<Regime>();
  for (let k = 0; k <= Math.ceil(hours); k++) {
    seen.add(regimeAt(new Date(at.getTime() + Math.min(k, hours) * 3_600_000), p));
    if (seen.has('weekend') && seen.has('us_market_hours') && seen.has('us_offhours_weekday')) {
      const from = etParts(at).date;
      const to = etParts(new Date(at.getTime() + hours * 3_600_000)).date;
      for (const d of p.holidays) if (d >= from && d <= to) seen.add('us_holiday');
      break;
    }
  }
  return REGIMES.filter((r) => seen.has(r));
}
