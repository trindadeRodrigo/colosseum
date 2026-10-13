import { type Lang, LOCALE } from '../../i18n';

// How the monitor writes the API's figures, in the language of the view. Each formats what it is
// handed and works nothing out. A minus is the true minus (U+2212), as STYLE.md asks.

const MINUS = '−';
const trueMinus = (text: string) => text.replace(/-/g, MINUS);

/** Dollars, from the API's decimal string: `$12,480.00`, `US$ 12.480,00`. */
export const dollars = (lang: Lang, decimal: string): string =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(decimal));

/** A token amount as the vault holds it, to six places at most: `12.345678`. */
export const tokens = (lang: Lang, decimal: string): string =>
  new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 6 }).format(Number(decimal));

/**
 * Basis points as a share, to one decimal at most: `25%`, `24.9%`. A second decimal read as noise
 * beside a plan's round shares (the flow audit, finding 32).
 */
export const share = (lang: Lang, bps: number): string =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(bps / 10_000);

/** Basis points to two decimals, where the second one matters: the keeper's losses, `0.12%`. */
export const shareExact = (lang: Lang, bps: number): string =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(bps / 10_000);

/**
 * The shares of one whole, each to one decimal, that add up to what the whole adds up to: each is
 * cut to a tenth of a percent, and the tenths left over go to the largest remainders (63.46, 12.50
 * and 24.04 are 63.5%, 12.5% and 24.0%: 100.0, where rounding each alone can give 100.1).
 */
export const sharesOf = (lang: Lang, bps: readonly number[]): string[] =>
  shareTenths(bps).map((t) => share(lang, t * 10));

/** The same shares in tenths of a percent: what a row's difference is worked from. */
export function shareTenths(bps: readonly number[]): number[] {
  const tenths = bps.map((b) => Math.floor(b / 10));
  const whole = Math.round(bps.reduce((sum, b) => sum + b, 0) / 10);
  const order = bps
    .map((b, i) => ({ i, rest: b % 10 }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (
    let left = whole - tenths.reduce((sum, t) => sum + t, 0), k = 0;
    left > 0;
    left -= 1, k += 1
  ) {
    const at = order[k % order.length]?.i;
    if (at !== undefined) tenths[at] = (tenths[at] ?? 0) + 1;
  }
  return tenths;
}

/** A difference in basis points, signed: `+1.2%`, `−0.4%`, `0%`. */
export const drift = (lang: Lang, bps: number): string =>
  trueMinus(
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    }).format(bps / 10_000),
  );

/** An instant, in UTC and saying so: `Oct 5, 2026, 14:02 UTC`. From an ISO string or unix seconds. */
export const utc = (lang: Lang, when: string | number): string =>
  `${new Intl.DateTimeFormat(LOCALE[lang], {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
    hourCycle: 'h23',
  }).format(typeof when === 'number' ? when * 1000 : Date.parse(when))} UTC`;
