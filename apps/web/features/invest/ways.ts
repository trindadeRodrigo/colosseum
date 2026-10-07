import type { BasketSheet } from '@colosseum/schemas';
import type { Lang } from '../../i18n';
import { parseNumber } from '../goal/sheet';
import type { Fact } from './conversation';

// A way to close a gap is the engine's own sentence, with its own figures ("You can add $83,100, for
// $163,100 in all.", "You can aim for $147 a month instead of $300."). Pressed, it changes one fact of
// the goal. Which fact, and to what, is read from the figures the engine wrote, never worked out here:
// the one figure above the plan's amount is the new amount; failing that, the one under the income
// asked is the new income. A sentence that names neither changes nothing, and is not a button.

/** Every dollar figure of a sentence, as the language of the plan writes them. */
function figures(text: string, lang: Lang): number[] {
  return [...text.matchAll(/(?:US)?\$\s?(\d[\d.,]*\d|\d)/g)]
    .map((m) => parseNumber(m[1] ?? '', lang))
    .filter((n): n is number => n !== null && !Number.isNaN(n));
}

export function wayChange(
  way: string,
  sheet: Pick<BasketSheet, 'amountUsd' | 'incomeTargetUsdMonthly' | 'language'>,
): { fact: Fact; value: string } | null {
  const found = figures(way, sheet.language);
  const more = found.filter((n) => n > sheet.amountUsd);
  if (more.length > 0) return { fact: 'amount', value: String(Math.max(...more)) };
  const target = sheet.incomeTargetUsdMonthly;
  const less = target === undefined ? [] : found.filter((n) => n > 0 && n < target);
  if (less.length > 0) return { fact: 'income', value: String(Math.min(...less)) };
  return null;
}
