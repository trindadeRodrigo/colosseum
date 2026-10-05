import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { type BasketAsset, type Reason, sleevesOf } from '@colosseum/schemas';
import { bpsOf, byName, largestFirst, split, sum, toCents, toUsd } from './money';
import type { Book, Sized } from './placement';
import { reason } from './templates';
import { reportsPools } from './types';
import { monthAfter, type Withdrawal, type World } from './world';

// Withdrawals (slice 2 of the solver; changes C5 and C6 of the research note). What the next
// `setAsideMonths` of withdrawals need is set aside before anything else is placed: in the matching
// leg for a withdrawal in its currency, in the most liquid rate legs for one in dollars, and the
// rest in cash. Then the coverage check: for each of those months, what can be sold by then, after
// the cost of selling, and the cash must pay what is owed to then. Where it cannot, money moves to
// cash, and the plan says why.
//
// Cash for the liquidity window comes first and is not here: it is the cash floor of `sizeSleeves`,
// from how soon the person may need the money.

export type SetAside = {
  /** The withdrawals of this month and the next `setAsideMonths - 1`, in order. */
  window: Withdrawal[];
  /** The first and the last month of the window. */
  from: string;
  to: string;
  /** What they come to, in cents of dollars. */
  owed: number;
  /** Their share of the plan, rounded up, held to the goal sleeve's share. */
  bps: number;
};

/** The withdrawals to set aside for, or null when there are none in the window. */
export function setAsideOf(w: World): SetAside | null {
  const months = w.P.setAsideMonths;
  if (months <= 0) return null;
  const from = w.nowMonth;
  const to = monthAfter(from, months - 1);
  const window = w.withdrawals.filter((x) => x.month <= to);
  if (window.length === 0) return null;
  const owed = sum(window.map((x) => x.cents));
  const goalBps = sum(
    sleevesOf(w.sheet)
      .filter((x) => x.kind === 'goal')
      .map((x) => x.shareBps),
  );
  return { window, from, to, owed, bps: Math.min(goalBps, bpsOf(owed, w.amount)) };
}

/** What a token can be sold for in one window at `tau`, in cents; null where nothing is measured. */
function measuredCents(w: World, asset: BasketAsset): number | null {
  const { liquidity } = w;
  if (!liquidity?.covers(asset.id)) return null;
  const read = liquidity.exitCapacity(asset.id, w.P.tau, EXIT_WINDOW_DAYS);
  return read && read.samples > 0 ? toCents(read.capacityUsd) : null;
}

/** Most liquid first: by measured capacity in one window, the unmeasured last, then by id. */
export function byLiquidity(w: World, assets: BasketAsset[]): BasketAsset[] {
  return largestFirst(
    assets,
    (a) => measuredCents(w, a) ?? -1,
    (a) => a.id,
  );
}

/**
 * Places what is set aside, `cents` of the plan, before anything else. `rateLegs` are the chain's
 * rate-only dollar-yield tokens; `readYields` puts their yields on the plan before any is ranked.
 */
export function placeSetAside(
  w: World,
  book: Book,
  cents: number,
  sa: SetAside,
  rateLegs: BasketAsset[],
  readYields: () => void,
): void {
  const { lang } = w;
  const said: Reason[] = [
    reason(
      'SET_ASIDE',
      { usd: toUsd(cents), from: sa.from, to: sa.to, months: w.P.setAsideMonths },
      lang,
    ),
    ...sa.window.map((x) =>
      reason('WITHDRAWAL', { amount: x.amount, currency: x.currency, month: x.month }, lang),
    ),
  ];
  // By currency, each its part of what is set aside (all of it, unless the goal sleeve is short).
  const currencies = [...new Set(sa.window.map((x) => x.currency))].sort();
  const parts = split(
    cents,
    currencies.map((cur) => sum(sa.window.filter((x) => x.currency === cur).map((x) => x.cents))),
  );
  const toCash = (left: number, why: Reason[]) => {
    if (left <= 0) return;
    book.cash.cents += left;
    book.cash.reasons.push(...said, ...why);
  };
  currencies.forEach((cur, at) => {
    const part = parts[at] ?? 0;
    if (part <= 0) return;
    const unit: Sized = { cents: part, reasons: said };
    if (cur !== 'USD') {
      // In the matching leg: the chain's cash token in that currency, if it lists one.
      const matching = w.matchingOf(cur);
      if (!matching) {
        w.flags.add(`no_matching_leg:${cur}`);
        toCash(part, [
          reason('NO_MATCHING_LEG', { currency: cur, usd: toUsd(part), chain: w.chain }, lang),
        ]);
        return;
      }
      const { left, why } = book.fill(unit, [matching], () => []);
      toCash(left, why);
      return;
    }
    // In dollars: the rate legs that sell most in one window first; what they cannot take is cash.
    const legs = byLiquidity(
      w,
      rateLegs.filter((a) => w.yields.has(a.id) && w.yieldCapOf(a) !== null),
    );
    if (legs.length > 0) readYields();
    const { left, why } = book.fillInOrder(unit, legs);
    if (left > 0)
      toCash(left, [...why, reason('SET_ASIDE_CASH', { usd: toUsd(left), chain: w.chain }, lang)]);
  });
}

/** A token's part in the check: what it holds, what it may sell in one window, and its cost. */
type Leg = {
  asset: BasketAsset;
  /** What the check may move to cash: the line, less what the safe-yield sleeve holds of it. */
  movable: number;
  value: number;
  /** Cents it may sell in one window. */
  perWindow: number;
  /** The cost of selling, as a fraction, for a sale of `cents` in one window. */
  costOf: (cents: number) => number;
  pool: { id: string; perWindow: number } | null;
};

/** What the check finds for a month: what is owed to then, what can be paid, and what each leg sells. */
type Reading = {
  month: string;
  owed: number;
  covered: number;
  sold: Map<string, { sold: number; proceeds: number }>;
};

/**
 * The coverage check (C6). For each month of the window, what is owed to then must be paid by the
 * cash, the matching legs (at par) and what the dollar-yield legs can sell by then, after the cost
 * of selling: one window's capacity a month (the window is `EXIT_WINDOW_DAYS`; counting one a month
 * is the cautious reading), where legs on one pool share that pool's capacity. A leg with nothing
 * measured sells up to its tier ceiling a window, at `tau`, flagged. Stocks, crypto and gold are not
 * counted: no return is assumed for them, and a withdrawal is not paid by selling them.
 *
 * Where it falls short, the part of a leg that cannot be sold in time moves to cash, the largest
 * first; then stocks, crypto and gold, the largest first. What still falls short is said and flagged.
 * `safe` is what the safe-yield sleeve holds by token: the check does not move it.
 */
export function checkCoverage(w: World, book: Book, sa: SetAside, safe: Map<string, number>): void {
  const { lang, P, liquidity } = w;
  const months = [...new Set(sa.window.map((x) => x.month))].sort();
  const windowsTo = (month: string) => {
    const [y0 = 0, m0 = 1] = w.nowMonth.split('-').map(Number);
    const [y1 = 0, m1 = 1] = month.split('-').map(Number);
    return (y1 - y0) * 12 + (m1 - m0) + 1;
  };
  const pools = liquidity && reportsPools(liquidity) ? liquidity : null;

  const legsNow = (): Leg[] =>
    byName(
      [...book.lines.values()].filter((l) => l.cents > 0 && w.sleeveOf(l.asset) === 'dollarYield'),
      (l) => l.asset.id,
    ).map((l) => {
      const measured = measuredCents(w, l.asset);
      if (measured === null) w.flags.add(`coverage_from_tier:${l.asset.id}`);
      const pool = pools?.poolOf(l.asset.id, P.tau, EXIT_WINDOW_DAYS) ?? null;
      return {
        asset: l.asset,
        value: l.cents,
        movable: Math.max(0, l.cents - (safe.get(l.asset.id) ?? 0)),
        perWindow: measured ?? w.ceilingOf(l.asset),
        costOf: (cents: number) => {
          if (measured === null || !liquidity) return P.tau;
          const cost = liquidity.exitCost(l.asset.id, toUsd(cents), EXIT_WINDOW_DAYS);
          return cost === null ? P.tau : Math.max(0, cost);
        },
        pool: pool ? { id: pool.pool, perWindow: toCents(pool.capacityUsd) } : null,
      };
    });

  const read = (legs: Leg[], month: string): Reading => {
    const k = windowsTo(month);
    const owed = sum(sa.window.filter((x) => x.month <= month).map((x) => x.cents));
    const atPar =
      book.cash.cents +
      sum([...book.lines.values()].filter((l) => l.asset.cls === 'cash').map((l) => l.cents));
    const sells = new Map(legs.map((l) => [l.asset.id, Math.min(l.value, k * l.perWindow)]));
    // Legs on one pool share what it takes: the larger sales keep their place, by id on a tie.
    const byPool = new Map<string, Leg[]>();
    for (const l of legs) if (l.pool) byPool.set(l.pool.id, [...(byPool.get(l.pool.id) ?? []), l]);
    for (const members of byPool.values()) {
      let room = k * (members[0]?.pool?.perWindow ?? 0);
      for (const l of largestFirst(
        members,
        (m) => sells.get(m.asset.id) ?? 0,
        (m) => m.asset.id,
      )) {
        const take = Math.min(sells.get(l.asset.id) ?? 0, Math.max(0, room));
        sells.set(l.asset.id, take);
        room -= take;
      }
    }
    const sold = new Map<string, { sold: number; proceeds: number }>();
    for (const l of legs) {
      const s = sells.get(l.asset.id) ?? 0;
      const cost = s > 0 ? l.costOf(Math.ceil(s / k)) : 0;
      sold.set(l.asset.id, { sold: s, proceeds: Math.floor(s * (1 - cost)) });
    }
    const covered = atPar + sum([...sold.values()].map((x) => x.proceeds));
    return { month, owed, covered, sold };
  };

  /** The month that falls shortest, the earliest on a tie; null when every month is paid. */
  const worst = (legs: Leg[]): Reading | null => {
    let found: Reading | null = null;
    for (const month of months) {
      const r = read(legs, month);
      if (r.owed > r.covered && (!found || r.owed - r.covered > found.owed - found.covered))
        found = r;
    }
    return found;
  };

  let moved = 0;
  let lastMonth = '';
  // Each pass moves at least a cent to cash, where it pays one for one, or stops.
  for (;;) {
    const legs = legsNow();
    const short = worst(legs);
    if (!short) break;
    lastMonth = short.month > lastMonth ? short.month : lastMonth;
    let need = short.owed - short.covered;
    // First, the part of a dollar-yield leg that cannot be sold in time: it pays one for one in cash.
    const unsold = largestFirst(
      legs.map((l) => ({
        l,
        cents: Math.min(l.movable, l.value - (short.sold.get(l.asset.id)?.sold ?? 0)),
      })),
      (x) => x.cents,
      (x) => x.l.asset.id,
    ).filter((x) => x.cents > 0);
    let step = 0;
    for (const { l, cents } of unsold) {
      if (need <= 0) break;
      let take = Math.min(cents, need);
      // A line is not left smaller than the least a line can be: what would be left goes too.
      if (l.value - take < w.minLine && l.movable >= l.value) take = l.value;
      const poolMembers = l.pool ? legs.filter((m) => m.pool?.id === l.pool?.id) : [l];
      const sellUsd = sum(poolMembers.map((m) => short.sold.get(m.asset.id)?.proceeds ?? 0));
      book.toCash(
        l.asset.id,
        take,
        reason(
          'COVERAGE_MOVED',
          {
            usd: toUsd(take),
            month: short.month,
            assets: poolMembers.map((m) => m.asset.symbol).join(','),
            sellUsd: toUsd(sellUsd),
          },
          lang,
        ),
      );
      need -= take;
      step += take;
    }
    // Then stocks, crypto and gold, which the check does not count.
    if (need > 0)
      for (const line of largestFirst(
        [...book.lines.values()].filter(
          (l) =>
            l.cents > 0 && (w.sleeveOf(l.asset) === 'growth' || w.sleeveOf(l.asset) === 'gold'),
        ),
        (l) => l.cents,
        (l) => l.asset.id,
      )) {
        if (need <= 0) break;
        let take = Math.min(line.cents, need);
        if (line.cents - take < w.minLine) take = line.cents;
        book.toCash(
          line.asset.id,
          take,
          reason('COVERAGE_MOVED_UNCOUNTED', { usd: toUsd(take), month: short.month }, lang),
        );
        need -= take;
        step += take;
      }
    moved += step;
    if (step === 0) break;
  }
  if (moved > 0) {
    w.flags.add('coverage_moved');
    book.cash.reasons.push(reason('COVERAGE_CASH', { usd: toUsd(moved), month: lastMonth }, lang));
  }
  const still = worst(legsNow());
  if (still) {
    w.flags.add('coverage_short');
    book.cash.reasons.push(
      reason(
        'COVERAGE_SHORT',
        { month: still.month, owedUsd: toUsd(still.owed), paidUsd: toUsd(still.covered) },
        lang,
      ),
    );
  }
}
