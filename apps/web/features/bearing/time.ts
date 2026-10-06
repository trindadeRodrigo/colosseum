import { nf, type Regime } from './format';

// The time of week now, by the API's rule (packages/risk/src/time.ts), worked out in the browser so a
// page can say which regime a figure "now" belongs to. The web may not import packages/risk
// (tests/boundaries.test.ts), so the calendar is copied here; time.test.ts fails when it no longer
// matches fixtures/risk/us-market-holidays.json, the file the API reads.

export const CAL = {
  closed: [
    '2025-01-01',
    '2025-01-09',
    '2025-01-20',
    '2025-02-17',
    '2025-04-18',
    '2025-05-26',
    '2025-06-19',
    '2025-07-04',
    '2025-09-01',
    '2025-11-27',
    '2025-12-25',
    '2026-01-01',
    '2026-01-19',
    '2026-02-16',
    '2026-04-03',
    '2026-05-25',
    '2026-06-19',
    '2026-07-03',
    '2026-09-07',
    '2026-11-26',
    '2026-12-25',
    '2027-01-01',
    '2027-01-18',
    '2027-02-15',
    '2027-03-26',
    '2027-05-31',
    '2027-06-18',
    '2027-07-05',
    '2027-09-06',
    '2027-11-25',
    '2027-12-24',
  ],
  early: ['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26'],
};

const ETF = new Intl.DateTimeFormat('en-US', {
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

export type EtParts = { date: string; dow: number; hour: number; minute: number; label: string };

export function etParts(at: Date): EtParts {
  const p: Record<string, string> = {};
  for (const x of ETF.formatToParts(at)) p[x.type] = x.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dow: DOW[p.weekday ?? ''] ?? 0,
    hour: Number(p.hour),
    minute: Number(p.minute),
    label: `${p.weekday} ${p.hour}:${p.minute} ET`,
  };
}

export function regimeAt(at: Date): Regime {
  const e = etParts(at);
  if (CAL.closed.includes(e.date)) return 'us_holiday';
  const t = e.dow * 24 + e.hour + e.minute / 60;
  if (t >= 4 * 24 + 20 && t < 6 * 24 + 20) return 'weekend';
  const h = e.hour + e.minute / 60;
  const close = CAL.early.includes(e.date) ? 13 : 16;
  if (e.dow <= 4 && h >= 9.5 && h < close) return 'us_market_hours';
  return 'us_offhours_weekday';
}

const HALF_HOUR = 18e5;
const HOUR = 3600e3;

/** The next half hour in market hours, by the same rule; null when none in the next 12 days. */
export function nextOpen(from: Date): Date | null {
  let t = new Date(Math.ceil(from.getTime() / HALF_HOUR) * HALF_HOUR);
  for (let i = 0; i < 48 * 12; i++) {
    if (regimeAt(t) === 'us_market_hours') return t;
    t = new Date(t.getTime() + HALF_HOUR);
  }
  return null;
}

/** A wait in words: minutes under an hour, hours under two days, then days. */
export function wait(ms: number): string {
  const h = ms / HOUR;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${nf({ maximumFractionDigits: 1 }).format(h)} h`;
  return `${nf({ maximumFractionDigits: 1 }).format(h / 24)} days`;
}
