import { rollUp } from '@colosseum/basket';
import type { BasketLine } from '@colosseum/schemas';
import { BPS, sum, toCents, toUsd } from './money';
import type { PersonalStatus, Scorecard } from './types';
import type { World } from './world';

// The scorecard of a candidate (slice 3; C11, section 2.4 of the research note): the numbers the
// three candidates are compared on, every one read from the plan and the figures it was made with.
// Nothing here ranks them, and nothing is a projection: months paid are at the rates observed and
// under the named stresses of the status.

/**
 * Months of withdrawals that cash and the matching legs pay at par, from this month on, in order: a
 * month counts when everything owed in it and before it is paid from them.
 */
function monthsCoveredOf(w: World, lines: BasketLine[]): number | null {
  if (w.withdrawals.length === 0) return null;
  const cash = sum(
    lines.filter((l) => w.byId.get(l.assetId)?.cls === 'cash').map((l) => toCents(l.amountUsd)),
  );
  const byMonth = new Map<string, number>();
  for (const x of w.withdrawals) byMonth.set(x.month, (byMonth.get(x.month) ?? 0) + x.cents);
  let left = cash;
  let months = 0;
  for (const month of [...byMonth.keys()].sort()) {
    const owed = byMonth.get(month) ?? 0;
    if (owed > left) break;
    left -= owed;
    months += 1;
  }
  return months;
}

export function scorecardOf(
  w: World,
  lines: BasketLine[],
  status: PersonalStatus | null,
): Scorecard {
  const asset = (l: BasketLine) => w.byId.get(l.assetId);
  const carry = sum(
    lines.map((l) => {
      const a = asset(l);
      if (!a || w.sleeveOf(a) !== 'dollarYield') return 0;
      return l.amountUsd * (w.yields.get(a.id)?.haircutYield ?? 0);
    }),
  );
  const rolled = rollUp(
    lines.map((l) => ({ asset: l.assetId, amountUsd: l.amountUsd })),
    { shelf: w.shelf, liquidity: w.liquidity, quotes: [], now: w.now },
  );
  // As on the card: a cost measured under zero is shown as zero, never as a gain.
  const measured = rolled.exit.measuredWorstBps;
  const card: Scorecard = {
    monthsCovered: monthsCoveredOf(w, lines),
    base: status ? { ...status.base } : null,
    stresses: (status?.stresses ?? []).map(({ id, monthsPaid, shortfall }) => ({
      id,
      monthsPaid,
      shortfall,
    })),
    carryObservedBps: w.sheet.amountUsd > 0 ? Math.floor((carry / w.sheet.amountUsd) * BPS) : 0,
    exit: {
      costBps: measured === null ? null : Math.max(0, measured),
      measuredShareBps: Math.min(BPS, rolled.exit.measuredShareBps),
    },
    concentration: {
      byIssuer: rolled.byIssuer,
      byClass: rolled.byClass,
      largestIssuerBps: rolled.byIssuer[0]?.bps ?? 0,
      issuers: rolled.byIssuer.length,
    },
    creditBasisBps: sum(
      lines
        .filter((l) => {
          const a = asset(l);
          return a !== undefined && w.isCredit(a);
        })
        .map((l) => l.weightBps),
    ),
  };
  // Open FX: for each currency other than dollars, what is owed in it beyond what its matching leg
  // holds. Present for a goal not in dollars, and for one in dollars with a withdrawal in another
  // currency; left out otherwise (C19).
  const currencies = new Set(w.withdrawals.map((x) => x.currency).filter((c) => c !== 'USD'));
  if (w.currency !== 'USD') currencies.add(w.currency);
  if (currencies.size > 0)
    card.openFxUsd = toUsd(
      sum(
        [...currencies].map((cur) => {
          const owed = sum(w.withdrawals.filter((x) => x.currency === cur).map((x) => x.cents));
          const matching = w.matchingOf(cur);
          const held = sum(
            lines.filter((l) => l.assetId === matching?.id).map((l) => toCents(l.amountUsd)),
          );
          return Math.max(0, owed - held);
        }),
      ),
    );
  return card;
}
