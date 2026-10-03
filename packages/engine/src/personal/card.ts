import { rollUp } from '@colosseum/basket';
import type { BasketCard, BasketLine } from '@colosseum/schemas';
import { BPS, shareOf, sum, toCents, toUsd } from './money';
import { text } from './templates';
import type { World } from './world';

// The card: five things every plan shows. Money needed today, expected return, total term, the
// cash-flow pattern, and when you can get out.
//
// Expected return is a range on the dollar-yield part only, from its yield after haircut to its
// quoted yield, each from an observation that carries its source. Stocks, crypto and gold assume no
// return: the card shows what a fall would cost them instead.

const PERCENT = 100;
const twoPlaces = (n: number) => Math.round(n * PERCENT) / PERCENT;

export type Carded = {
  card: BasketCard;
  /** Dollars a year the dollar-yield part pays after haircut, or null when no yield is read. */
  yearlyLowUsd: number | null;
};

export function cardOf(w: World, lines: BasketLine[]): Carded {
  const { sheet, P, lang } = w;
  const sleeveOf = (l: BasketLine) => {
    const asset = w.byId.get(l.assetId);
    return asset ? w.sleeveOf(asset) : 'cash';
  };
  const yielding = lines.filter((l) => sleeveOf(l) === 'dollarYield');
  const priced = lines.filter((l) => ['growth', 'gold'].includes(sleeveOf(l)));
  const read = yielding.filter((l) => w.yields.has(l.assetId));

  const yearly = (pick: 'haircutYield' | 'quotedYield') =>
    sum(read.map((l) => l.amountUsd * (w.yields.get(l.assetId)?.[pick] ?? 0)));
  const low = yearly('haircutYield');
  const high = Math.max(low, yearly('quotedYield'));
  const basis =
    yielding.length === 0 ? 'RETURN_NONE' : read.length === 0 ? 'RETURN_NOT_READ' : 'RETURN_BASIS';
  if (read.length < yielding.length) w.flags.add('yield_not_read');

  const exit = rollUp(
    lines.map((l) => ({ asset: l.assetId, amountUsd: l.amountUsd })),
    { shelf: w.shelf, liquidity: w.liquidity, quotes: [], now: w.now },
  );
  // The roll-up also speaks of stored quotes, which a plan that is not bought yet has none of.
  for (const flag of exit.flags)
    if ((flag.startsWith('exit_') || flag.startsWith('measured_')) && !flag.includes('quote'))
      w.flags.add(flag);
  const cost = exit.exit.measuredWorstBps;

  const yieldBps = sum(yielding.map((l) => l.weightBps));
  return {
    yearlyLowUsd: read.length === 0 ? null : low,
    card: {
      moneyTodayUsd: sheet.amountUsd,
      termMonths: sheet.horizonMonths,
      cashFlow: sheet.goal === 'income' ? 'monthly' : yieldBps >= P.atEndMinBps ? 'at_end' : 'none',
      expectedReturn: {
        lowPct: twoPlaces((PERCENT * low) / sheet.amountUsd),
        highPct: twoPlaces((PERCENT * high) / sheet.amountUsd),
        basis: text(basis, {}, lang),
        lossInFallUsd: toUsd(shareOf(sum(priced.map((l) => toCents(l.amountUsd))), P.fallBps)),
      },
      exit: {
        text:
          cost === null
            ? text('EXIT_NOT_MEASURED', {}, lang)
            : text(
                'EXIT_MEASURED',
                // A cost is never written smaller than it is: up to the next whole basis point.
                { costBps: Math.ceil(cost), shareBps: Math.min(BPS, exit.exit.measuredShareBps) },
                lang,
              ),
        costBps: cost,
      },
    },
  };
}
