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

/** Basis points as a share, with two decimals: `25.00%`. */
export const share = (lang: Lang, bps: number): string =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(bps / 10_000);

/** A drift in basis points, signed: `+1.20%`, `−0.40%`, `0.00%`. */
export const drift = (lang: Lang, bps: number): string =>
  trueMinus(
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
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
