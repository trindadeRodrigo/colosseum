import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import type { BasketAsset, LiquidityProvider, YieldObservation } from '@colosseum/schemas';
import { sleeveOfClass } from './registry';
import type { PersonalSchedule } from './types';
import { monthAfter, type Withdrawal } from './world';

// The schedule of a personal plan (slice 2; change C7 of the research note), in the goal's currency.
// The old `buildSchedule` in `../schedule` is the old engine's and is not edited.
//
// Month by month: dollar yield accrues at its yield after haircut, a twelfth a month; stocks,
// crypto, gold and cash accrue nothing. Then the month's withdrawals are paid: from the cash tokens
// (the matching legs first, then dollar cash), at par; then from the dollar-yield legs, most liquid
// first; then from stocks, crypto and gold, largest first. A leg sells no more in a month than one
// window's capacity at `tau` (its tier ceiling where nothing is measured), at its measured exit cost
// (at `tau` where nothing is measured), not at par. A month not paid in full counts its shortfall;
// nothing is borrowed from later months.
//
// `atPar` runs the same draw with every cost at zero. With a cost, a leg is sold for less and more of
// it goes, so a month paid with costs is paid at par too: months paid never rise against the par draw.

export type ScheduleInputs = {
  lines: { assetId: string; amountUsd: number }[];
  byId: Map<string, BasketAsset>;
  yields: Map<string, YieldObservation>;
  withdrawals: Withdrawal[];
  currency: string;
  /** Units of the goal's currency per dollar; 1 for dollars. */
  rate: number;
  nowMonth: string;
  months: number;
  liquidity: LiquidityProvider | undefined;
  tau: number;
  /** The most dollars a token with nothing measured may sell in a window: its tier ceiling. */
  ceilingUsdOf: (asset: BasketAsset) => number;
  atPar?: boolean;
};

const MONTHS_IN_A_YEAR = 12;
const CENTS = 100;
const round = (x: number) => Math.round(x * CENTS) / CENTS;
/** Nothing left to pay: under half a cent. */
const settled = (usd: number) => Math.round(usd * CENTS) <= 0;

/** The kinds of holding, in the order a withdrawal draws on them. */
const DRAW = ['matching', 'cash', 'dollarYield', 'rest'] as const;
type Kind = (typeof DRAW)[number];

type Held = {
  asset: BasketAsset;
  usd: number;
  kind: Kind;
  /** What it may sell in one window, in dollars; Infinity for cash. */
  perWindow: number;
  measured: boolean;
};

export function scheduleOf(input: ScheduleInputs): PersonalSchedule {
  const { liquidity, tau, rate } = input;
  const held: Held[] = [];
  for (const l of input.lines) {
    const asset = input.byId.get(l.assetId);
    if (!asset || l.amountUsd <= 0) continue;
    const sleeve = sleeveOfClass(asset.cls);
    const isCash = asset.cls === 'cash';
    const read =
      !isCash && liquidity?.covers(asset.id)
        ? liquidity.exitCapacity(asset.id, tau, EXIT_WINDOW_DAYS)
        : null;
    const measured = read !== null && read.samples > 0;
    held.push({
      asset,
      usd: l.amountUsd,
      kind: isCash
        ? (asset.currency ?? 'USD') === 'USD'
          ? 'cash'
          : 'matching'
        : sleeve === 'dollarYield'
          ? 'dollarYield'
          : 'rest',
      perWindow: isCash
        ? Number.POSITIVE_INFINITY
        : measured && read
          ? read.capacityUsd
          : input.ceilingUsdOf(asset),
      measured,
    });
  }
  // The order of the draw is fixed: by kind, then most liquid, then largest, then by id.
  const order = [...held].sort(
    (a, b) =>
      DRAW.indexOf(a.kind) - DRAW.indexOf(b.kind) ||
      (a.kind === 'dollarYield' ? b.perWindow - a.perWindow : 0) ||
      b.usd - a.usd ||
      (a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0),
  );
  const costOf = (h: Held, usd: number): number => {
    if (input.atPar || h.asset.cls === 'cash') return 0;
    if (!h.measured || !liquidity) return tau;
    const cost = liquidity.exitCost(h.asset.id, usd, EXIT_WINDOW_DAYS);
    return cost === null ? tau : Math.min(Math.max(0, cost), 1);
  };

  const owedIn = new Map<string, number>();
  for (const x of input.withdrawals)
    owedIn.set(x.month, (owedIn.get(x.month) ?? 0) + x.cents / CENTS);

  const rows: PersonalSchedule['rows'] = [];
  let monthsPaid = 0;
  let monthsWithWithdrawal = 0;
  let shortfallUsd = 0;
  for (let m = 0; m < input.months; m += 1) {
    const month = monthAfter(input.nowMonth, m);
    for (const h of order)
      if (h.kind === 'dollarYield')
        h.usd *= 1 + (input.yields.get(h.asset.id)?.haircutYield ?? 0) / MONTHS_IN_A_YEAR;
    const owed = owedIn.get(month) ?? 0;
    let need = owed;
    for (const h of order) {
      if (settled(need)) break;
      if (h.usd <= 0) continue;
      // Sold gross so that, after the cost, it pays what is left; no more than a window allows.
      const cost = costOf(h, Math.min(h.usd, h.perWindow, need));
      const gross = Math.min(h.usd, h.perWindow, need / (1 - cost));
      h.usd -= gross;
      need -= gross * (1 - cost);
    }
    const paid = settled(need);
    if (owed > 0) {
      monthsWithWithdrawal += 1;
      if (paid) monthsPaid += 1;
      else shortfallUsd += need;
    }
    const balance = order.reduce((n, h) => n + h.usd, 0);
    rows.push({
      month,
      withdrawal: round(owed * rate),
      balance: round(balance * rate),
      paid,
    });
  }
  return {
    currency: input.currency,
    rate,
    rows,
    monthsPaid,
    monthsWithWithdrawal,
    shortfall: round(shortfallUsd * rate),
  };
}
