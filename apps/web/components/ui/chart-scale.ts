// Scales for the Bearing charts (TimeChart, DistChart): round ticks on a value axis, and time ticks that
// step by an hour, a day, a week or a month as the span asks. Plain functions, so they are tested alone.

export type Nice = { lo: number; hi: number; ticks: number[] };

/** Round bounds and about `n` ticks between them, at 1, 2 or 5 times a power of ten. */
export function nice(d0: number, d1: number, n: number): Nice {
  const top = d1 === d0 ? d0 + (Math.abs(d0) || 1) : d1;
  const span = top - d0;
  let step = 10 ** Math.floor(Math.log10(span / n));
  const err = span / n / step;
  step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const lo = Math.floor(d0 / step) * step;
  const hi = Math.ceil(top / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(12));
  return { lo, hi, ticks };
}

export const HOUR_MS = 3600e3;
export const DAY_MS = 864e5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Ticks on a time axis, at most `maxN`, in UTC, with the format that suits their step. */
export function timeTicks(t0: number, t1: number, maxN: number) {
  const span = t1 - t0;
  const steps = [1, 3, 6, 12, 24, 48, 168, 336]
    .map((h) => h * HOUR_MS)
    .concat([30.44, 91.3, 182.6, 365.25].map((d) => d * DAY_MS));
  const step = steps.find((s) => span / s <= maxN) ?? 365.25 * DAY_MS;
  const ticks: number[] = [];
  if (step >= 30 * DAY_MS) {
    const m = Math.round(step / (30.44 * DAY_MS));
    const d0 = new Date(t0);
    for (let d = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1); d <= t1; ) {
      ticks.push(d);
      const at = new Date(d);
      d = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + m, 1);
    }
  } else for (let v = Math.ceil(t0 / step) * step; v <= t1; v += step) ticks.push(v);
  const fmt = (v: number) => {
    const d = new Date(v);
    if (step < DAY_MS) return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
    if (step < 30 * DAY_MS) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    return d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : (MONTHS[d.getUTCMonth()] as string);
  };
  return { ticks, fmt };
}

/** A time as the readout prints it: `2026-10-03 15:00 UTC`, or the date alone for daily points. */
export function fullDate(t: number, hourly: boolean): string {
  const s = new Date(t).toISOString();
  return hourly ? `${s.slice(0, 16).replace('T', ' ')} UTC` : s.slice(0, 10);
}

/** The width of an axis tag for its text, in the 11px mono face. */
export const tagWidth = (text: string) => text.length * 6.7 + 10;
