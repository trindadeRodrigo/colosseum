import { type Lang, LOCALE } from '../../i18n';

// How the rebalancing and exposure pages write two things the monitor's formatters
// (features/portfolio/figures.ts) have no word for: a cost in basis points, and an instant in the
// reader's own time zone. Each formats what it is handed and works nothing out.

const MINUS = '−';

/**
 * Basis points as the number alone, to two places at most, with a true minus: `7.25`, `4`, `−3.1`.
 * The page's dictionary puts the unit after it.
 */
export const basisPoints = (lang: Lang, bps: number): string =>
  new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 2 })
    .format(bps)
    .replace(/-/g, MINUS);

/**
 * An instant in the reader's own time zone, and saying which: `Oct 5, 2026, 06:29 GMT-3`,
 * `5 de out. de 2026, 06:29 BRT`. The zone is the browser's; `timeZone` names another, for a test.
 * It is drawn only once an answer was read in the browser, so no server ever writes one.
 */
export const localTime = (lang: Lang, when: string, timeZone?: string): string =>
  new Intl.DateTimeFormat(LOCALE[lang], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(Date.parse(when));
