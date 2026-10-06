import { utcMinute } from '../../components/ui/ExecutionList';
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

/** Basis points as a share, to one decimal at most: `25%`, `24.9%`. A hundredth of a percent is noise. */
export const share = (lang: Lang, bps: number): string =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(bps / 10_000);

/** A drift in basis points, signed, to one decimal at most: `+1.2%`, `−0.4%`, `0%`. */
export const drift = (lang: Lang, bps: number): string =>
  trueMinus(
    new Intl.NumberFormat(LOCALE[lang], {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    }).format(Math.round(bps / 10) / 1000),
  );

/**
 * An instant, in UTC and saying so, the one way the app writes a time (ExecutionList's `utcMinute`):
 * `2026-10-05 14:02 UTC`. From an ISO string or unix seconds.
 */
export const utc = (_lang: Lang, when: string | number): string =>
  utcMinute(typeof when === 'number' ? new Date(when * 1000).toISOString() : when);
