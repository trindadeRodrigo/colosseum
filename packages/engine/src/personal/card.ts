import { rollUp } from '@colosseum/basket';
import type { BasketCard, BasketLine } from '@colosseum/schemas';
import { BPS, shareOfUp, sum, toCents, toUsd } from './money';
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
  /**
   * Dollars a year the dollar-yield part pays after haircut. Nothing in dollar yield pays nothing:
   * zero. Null only when the plan holds dollar yield and no yield was read for it.
   */
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
  // A sale measured above the reference price comes as a cost under zero. The card shows zero and
  // says how, and the plan carries a flag: a negative cost is never shown as a gain.
  const measured = exit.exit.measuredWorstBps;
  if (measured !== null && measured < 0) w.flags.add('exit_cost_below_zero');
  const cost = measured === null ? null : Math.max(0, measured);
  const shareBps = Math.min(BPS, exit.exit.measuredShareBps);

  const yieldBps = sum(yielding.map((l) => l.weightBps));
  return {
    yearlyLowUsd: yielding.length > 0 && read.length === 0 ? null : low,
    card: {
      moneyTodayUsd: sheet.amountUsd,
      termMonths: sheet.horizonMonths,
      // An income plan pays monthly from its dollar yield. With none, it pays nothing.
      cashFlow:
        yieldBps <= 0
          ? 'none'
          : sheet.goal === 'income'
            ? 'monthly'
            : yieldBps >= P.atEndMinBps
              ? 'at_end'
              : 'none',
      expectedReturn: {
        lowPct: twoPlaces((PERCENT * low) / sheet.amountUsd),
        highPct: twoPlaces((PERCENT * high) / sheet.amountUsd),
        basis: text(basis, {}, lang),
        lossInFallUsd: toUsd(shareOfUp(sum(priced.map((l) => toCents(l.amountUsd))), P.fallBps)),
      },
      exit: {
        text:
          cost === null
            ? text('EXIT_NOT_MEASURED', {}, lang)
            : cost <= 0
              ? text('EXIT_MEASURED_ZERO', { shareBps }, lang)
              : // A cost is never written smaller than it is: up to the next whole basis point.
                text('EXIT_MEASURED', { costBps: Math.ceil(cost), shareBps }, lang),
        costBps: cost,
      },
    },
  };
}
