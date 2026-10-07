import { apportion } from '@colosseum/basket';
import { type BasketAsset, type Reason, sleevesOf } from '@colosseum/schemas';
import { BPS, bpsOf, byName, shareOf, split, sum, toCents, toUsd } from './money';
import { once, type Removed, type Sized, type Unit } from './placement';
import { eligibleForGoal } from './registry';
import { type RuleId, reason } from './templates';
import { type PersonalMix, SLEEVES, type Sleeve } from './types';
import type { Family, World } from './world';

// Exposure: how big each sleeve is (stocks and crypto, dollar yield, gold, cash) and what is inside
// each. Sizes come from the goal and the risk, then from the date, from what the person may need
// and from what they must not lose. What is inside comes from the shared portfolios they chose.

export type SleeveSizes = Record<Sleeve, number>;
export type SleevePlan = {
  /**
   * The row of the table for this goal and risk, in basis points of the whole plan, scaled to the
   * goal sleeve's share; cash is what the row leaves of that share.
   */
  table: SleeveSizes;
  /** The sleeves once the date, the need for cash and what must not be lost are applied. */
  sized: SleeveSizes;
  /**
   * The person's split (gate SLEEVES): the goal sleeve's share and the safe-yield sleeve's, in basis
   * points of the whole plan. With no split, the goal sleeve is the whole plan. `sized` adds up to
   * `goalBps`; `safeYieldBps` is placed apart, in rate legs only.
   */
  goalBps: number;
  safeYieldBps: number;
  /** Each theme sleeve (gate SLEEVES), in the sheet's order: its slug and its share of the whole plan. */
  themes: { slug: string; shareBps: number }[];
  /**
   * Of the goal sleeve, what is set aside for the next withdrawals (slice 2): taken off before the
   * row is scaled, so `sized` adds up to `goalBps - setAsideBps`. Placed apart, before anything else.
   */
  setAsideBps: number;
  /**
   * The floor on cash the plan states (`CASH_NEAR_DATE`, `CASH_MAY_NEED`), in basis points of the
   * whole plan; 0 where it states none. The cash is held to it to the cent, whatever the rounding of
   * the parts placed before it (`build` in ./compose.ts).
   */
  cashFloorBps: number;
  /** Why each sleeve is the size it is. Every line of a sleeve carries these. */
  reasons: Record<Sleeve, Reason[]>;
  /**
   * With a mix, what each class of it gave to what is set aside (gate EXPLICIT-MIX): said on the
   * lines that hold what is set aside, as on the lines of the class that gave.
   */
  asideSays: Reason[];
};

/**
 * What is set aside for withdrawals, as a plan with a mix sizes its sleeves by it: the first and last
 * month it pays for, and how much of it is held as dollar yield (in rate legs), in basis points of the
 * plan. The rest of it is held as cash.
 */
export type AsideOfMix = { from: string; to: string; inYieldBps: number };

/**
 * A mix once what is set aside for withdrawals is taken out of it (gate EXPLICIT-MIX). Withdrawals
 * keep their rule with a mix as without: what the next months owe is set aside first, in full. It is
 * held in rate legs, which are dollar yield, and in cash, so each part counts first as the dollar
 * yield or the cash the person asked for. Where that class of the mix is smaller than the part held
 * as it, the other of the two gives; only then stocks and crypto, and then gold, the order the
 * date's floors take them in.
 *
 * `table` is what is left of each class to place. `gave` is what each class gave to money held as
 * another class: what the plan then holds less of than the mix, and says so.
 */
function mixLessAside(
  mix: PersonalMix,
  setAsideBps: number,
  inYieldBps: number,
): { asked: SleeveSizes; table: SleeveSizes; gave: SleeveSizes } {
  const asked: SleeveSizes = {
    growth: mix.growthBps,
    dollarYield: mix.dollarYieldBps,
    gold: mix.goldBps,
    cash: mix.cashBps,
  };
  const table = { ...asked };
  const gave: SleeveSizes = { growth: 0, dollarYield: 0, gold: 0, cash: 0 };
  let left = setAsideBps;
  const take = (sleeve: Sleeve, most: number, itsOwn: boolean) => {
    const bps = Math.min(table[sleeve], most, left);
    table[sleeve] -= bps;
    left -= bps;
    if (!itsOwn) gave[sleeve] += bps;
  };
  const asYield = Math.min(setAsideBps, Math.max(0, inYieldBps));
  take('dollarYield', asYield, true);
  take('cash', setAsideBps - asYield, true);
  for (const sleeve of ['cash', 'dollarYield', 'growth', 'gold'] as const)
    take(sleeve, left, false);
  return { asked, table, gave };
}

/** The sleeves a floor on cash is filled from, in the order they give. */
export const CASH_FLOOR_FROM: readonly Exclude<Sleeve, 'cash'>[] = [
  'growth',
  'gold',
  'dollarYield',
];

/** The largest floor among the steps whose month count has not passed. Never rises as months grow. */
function floorAt<T extends { monthsLeft: number }>(
  steps: T[],
  months: number,
  of: (step: T) => number,
): number {
  return steps
    .filter((step) => months <= step.monthsLeft)
    .reduce((most, step) => Math.max(most, of(step)), 0);
}

/**
 * The size of each sleeve, in basis points of the whole plan. With no split they add up to 10,000;
 * with one, the goal sleeve's sizes add up to its share, and the safe-yield sleeve and each theme
 * sleeve hold their own (gate SLEEVES).
 *
 * A nearer date never gives less cash, and never less in cash and dollar yield together: each floor
 * is taken from the steps the date has not passed, and is filled from stocks and crypto first, then
 * gold. Within a split, the table's shares and the floors of the date are the goal sleeve's, scaled
 * to its share; what must not be lost is a sum of money, and the safe-yield sleeve counts toward it.
 */
export function sizeSleeves(w: World, setAside = 0, aside?: AsideOfMix): SleevePlan {
  const { sheet, P, lang } = w;
  const split = sleevesOf(sheet);
  const goalBps = sum(split.filter((x) => x.kind === 'goal').map((x) => x.shareBps));
  const safeYieldBps = sum(split.filter((x) => x.kind === 'safe_yield').map((x) => x.shareBps));
  const themes = split.flatMap((x) =>
    x.kind === 'theme' ? [{ slug: x.theme, shareBps: x.shareBps }] : [],
  );
  // What is set aside for withdrawals comes off the goal sleeve first, with a mix as without; the
  // table shares the rest, and a mix is held on the rest as `mixLessAside` says.
  const mix = sheet.mix;
  const setAsideBps = Math.min(goalBps, Math.max(0, setAside));
  const restBps = goalBps - setAsideBps;
  /** A share of the goal sleeve, as basis points of the whole plan: rounded down, or up for a floor. */
  const ofGoal = (bps: number, up = false) =>
    up ? Math.ceil((bps * restBps) / BPS) : Math.floor((bps * restBps) / BPS);
  const less = mix ? mixLessAside(mix, setAsideBps, aside?.inYieldBps ?? 0) : null;
  let table: SleeveSizes;
  if (less) {
    table = less.table;
  } else {
    const row = P.sleeves[`${sheet.goal}:${sheet.risk}`] ?? {
      growthBps: 0,
      dollarYieldBps: 0,
      goldBps: 0,
    };
    const growth = ofGoal(row.growthBps);
    const dollarYield = ofGoal(row.dollarYieldBps);
    const gold = ofGoal(row.goldBps);
    table = { growth, dollarYield, gold, cash: restBps - growth - dollarYield - gold };
  }
  const sized = { ...table };
  const reasons: SleevePlan['reasons'] = { growth: [], dollarYield: [], gold: [], cash: [] };
  const goalPart =
    goalBps < BPS ? [reason('SPLIT_GOAL', { shareBps: goalBps, goal: sheet.goal }, lang)] : [];
  const asked: Record<Sleeve, number> = less ? less.asked : table;
  for (const sleeve of SLEEVES)
    if (table[sleeve] > 0)
      reasons[sleeve].push(
        ...goalPart,
        mix
          ? asked[sleeve] >= BPS
            ? reason('MIX_ALL', { sleeve }, lang)
            : reason('MIX', { sleeveBps: asked[sleeve], sleeve }, lang)
          : reason(
              'SLEEVE',
              { sleeveBps: table[sleeve], sleeve, goal: sheet.goal, risk: sheet.risk },
              lang,
            ),
      );
  // Where what is set aside keeps the plan from the mix, the class that gave says how much, and
  // what that leaves it: a cap says the same where it is the cap that does.
  const asideSays: Reason[] = [];
  if (less && aside)
    for (const sleeve of SLEEVES) {
      if (less.gave[sleeve] <= 0) continue;
      const says = reason(
        'MIX_SET_ASIDE',
        {
          usd: toUsd(shareOf(w.amount, less.gave[sleeve])),
          sleeve,
          askedBps: less.asked[sleeve],
          leftBps: less.asked[sleeve] - less.gave[sleeve],
          from: aside.from,
          to: aside.to,
        },
        lang,
      );
      reasons[sleeve].push(says);
      asideSays.push(says);
    }
  // The limits the plan takes for the mix's stocks and crypto are said once on that sleeve, here in
  // the order of its reasons. The share they are taken for is the one the plan sets out to hold, known
  // once what is set aside and the floors below have had theirs: the sentence is written then.
  const limitsAt = mix && table.growth > 0 ? reasons.growth.length : null;

  /** Moves up to `need` into one sleeve from the others, in turn. Returns the sleeves that gave. */
  const raise = (to: Sleeve, need: number, from: readonly Sleeve[]): Sleeve[] => {
    let left = need;
    return from.filter((sleeve) => {
      const take = Math.min(sized[sleeve], left);
      sized[sleeve] -= take;
      sized[to] += take;
      left -= take;
      return take > 0;
    });
  };
  const say = (why: Reason, sleeves: Sleeve[]) => {
    for (const sleeve of new Set(sleeves)) reasons[sleeve].push(why);
  };

  // The date: a floor on dollar yield that rises as it nears. The person can switch this off.
  if (sheet.rules.glide && !sheet.horizonOpen && w.goalMonth !== null) {
    const floor = ofGoal(
      floorAt(P.glideFloor, sheet.horizonMonths, (step) => step.dollarYieldBps),
      true,
    );
    if (sized.dollarYield < floor) {
      const gave = raise('dollarYield', floor - sized.dollarYield, ['growth', 'gold']);
      const why = reason(
        'GLIDE',
        { floorBps: floor, months: sheet.horizonMonths, by: w.goalMonth },
        lang,
      );
      if (gave.length > 0) say(why, ['dollarYield', ...gave]);
    }
  }

  // How soon the money may be needed: a floor on cash. The sooner of the date and what they said.
  const said = sheet.limits?.mayNeedInMonths;
  const dated = sheet.rules.glide && !sheet.horizonOpen ? sheet.horizonMonths : undefined;
  const soonest: { months: number; rule: RuleId } | null =
    said !== undefined && (dated === undefined || said <= dated)
      ? { months: said, rule: 'CASH_MAY_NEED' }
      : dated !== undefined
        ? { months: dated, rule: 'CASH_NEAR_DATE' }
        : null;
  let cashFloorBps = 0;
  if (soonest) {
    const floor = ofGoal(
      floorAt(P.cashFloor, soonest.months, (step) => step.cashBps),
      true,
    );
    if (sized.cash < floor) {
      const gave = raise('cash', floor - sized.cash, CASH_FLOOR_FROM);
      const why = reason(soonest.rule, { floorBps: floor, months: soonest.months }, lang);
      if (gave.length > 0) {
        say(why, ['cash', ...gave]);
        cashFloorBps = floor;
      }
    }
  }

  // What must not be lost stays out of stocks, crypto and gold.
  const keep = sheet.limits?.mustKeepUsd ?? 0;
  if (keep > 0) {
    const floor = Math.min(BPS, bpsOf(toCents(keep), w.amount));
    const kept = sized.dollarYield + sized.cash + safeYieldBps + setAsideBps;
    if (kept < floor) {
      const gave = raise('dollarYield', floor - kept, ['growth', 'gold']);
      const why = reason('MUST_KEEP', { floorBps: floor, keepUsd: keep }, lang);
      if (gave.length > 0) say(why, ['dollarYield', 'cash', ...gave]);
    }
  }
  if (limitsAt !== null)
    reasons.growth.splice(
      limitsAt,
      0,
      reason(
        'MIX_LIMITS',
        {
          sleeveBps: sized.growth,
          risk: sheet.risk,
          stockCapBps: P.capPerStockBps[sheet.risk] ?? 0,
          issuerCapBps: P.capPerIssuerBps[sheet.risk] ?? 0,
        },
        lang,
      ),
    );
  return {
    table,
    sized,
    goalBps,
    safeYieldBps,
    themes,
    setAsideBps,
    cashFloorBps,
    reasons,
    asideSays,
  };
}

export type Part = { asset: BasketAsset; bps: number };

/** A shared portfolio the plan starts from: its recipe on the person's chain. */
export type Theme = {
  slug: string;
  name: string;
  /** False for the one a goal starts from when the person chose none. */
  chosen: boolean;
  family: Family;
  parts: Part[];
};

/** The tokens of one underlying in one sleeve, on the person's chain. */
export function tokensOf(w: World, underlying: string, sleeve: Sleeve): BasketAsset[] {
  return w.tokens.filter((a) => a.underlying === underlying && w.sleeveOf(a) === sleeve);
}

/** Whether any token of this underlying can be held, and why not when none can. */
export function holdable(
  w: World,
  underlying: string,
  sleeve: Sleeve,
): { ok: boolean; why: Reason[] } {
  const blocks = tokensOf(w, underlying, sleeve).map((a) => w.blockOf(a));
  if (blocks.some((b) => b === null)) return { ok: true, why: [] };
  const why = once(blocks.flatMap((b) => (b ? [b] : [])));
  const notHere = reason('NOT_ON_CHAIN', { asset: underlying, chain: w.chain }, w.lang);
  return { ok: false, why: why.length > 0 ? why : [notHere] };
}

/** The reason a whole shared portfolio is left out, for the rule that left its parts out. */
function leftOut(w: World, rule: string, name: string): Reason {
  const { sheet, lang } = w;
  if (rule === 'NOT_FOR_GOAL')
    return reason('NOT_FOR_GOAL', { asset: name, goal: sheet.goal }, lang);
  if (rule === 'EXCLUDED') return reason('EXCLUDED', { asset: name }, lang);
  return reason('NOT_ON_CHAIN', { asset: name, chain: w.chain }, lang);
}

/**
 * A shared portfolio as the plan can use it: its recipe on the person's chain. When it cannot be
 * used, the reasons why: no such portfolio, no version on this chain, a part the goal does not allow,
 * or no part the person can hold.
 */
export function themeOf(w: World, slug: string, chosen: boolean): Theme | Reason[] {
  const { lang } = w;
  const family = w.families.get(slug);
  if (!family) return [reason('THEME_UNKNOWN', { theme: slug }, lang)];
  const name = family.meta.name;
  const recipe = family.recipes.find((r) => r.chain === w.chain);
  // In the order of their ids: the order a shelf lists a portfolio's parts in decides nothing.
  const parts = byName(
    (recipe?.components ?? []).flatMap((c): Part[] => {
      const asset = c.kind === 'asset' ? w.byId.get(c.asset) : undefined;
      return asset ? [{ asset, bps: c.weightBps }] : [];
    }),
    (part) => part.asset.id,
  );
  if (parts.length === 0)
    return [reason('THEME_NOT_ON_CHAIN', { theme: name, chain: w.chain }, lang)];
  // A portfolio that holds a token the goal does not allow is left out whole: a plan to protect
  // neither follows nor opens one that holds stocks. The reason names the first such token.
  const [refused] = byName(
    parts.filter((p) => !eligibleForGoal(p.asset, w.sheet.goal)),
    (p) => p.asset.underlying,
  );
  if (refused)
    return [
      reason(
        'THEME_NOT_FOR_GOAL',
        { theme: name, asset: refused.asset.underlying, goal: w.sheet.goal },
        lang,
      ),
    ];
  const blocks = parts.map((p) => holdable(w, p.asset.underlying, w.sleeveOf(p.asset)));
  if (blocks.every((b) => !b.ok)) {
    const rules = [...new Set(blocks.flatMap((b) => b.why.map((r) => r.rule)))].sort();
    return rules.map((rule) => leftOut(w, rule, name));
  }
  return { slug, name, chosen, family, parts };
}

/**
 * The shared portfolios the plan starts from. A chosen one that cannot be used is listed in
 * `removed`, with why. When none is chosen, or none of the chosen can be used, the plan starts where
 * the goal starts: the table's portfolio for it, if this chain has it.
 */
export function resolveThemes(w: World, removed: Removed[]): Theme[] {
  const themes: Theme[] = [];
  for (const slug of new Set(w.sheet.themes)) {
    const theme = themeOf(w, slug, true);
    if (Array.isArray(theme)) removed.push({ ref: slug, reasons: theme });
    else themes.push(theme);
  }
  if (themes.length > 0) return themes;
  const fallback = w.P.defaultTheme[w.sheet.goal];
  const start = fallback ? themeOf(w, fallback, false) : [];
  return Array.isArray(start) ? [] : [start];
}

/** Why a part of a shared portfolio the person chose is in the plan. */
export const themeReason = (w: World, theme: Theme): Reason =>
  reason('FROM_THEME', { theme: theme.name, chain: w.chain }, w.lang);

/** Splits a sleeve's cents among underlyings by weight, merging the same underlying. */
export function unitsOf(
  cents: number,
  parts: { name: string; weight: number; reasons: Reason[] }[],
): Unit[] {
  const merged = new Map<string, { weight: number; reasons: Reason[] }>();
  for (const p of parts) {
    const unit = merged.get(p.name) ?? { weight: 0, reasons: [] };
    unit.weight += p.weight;
    unit.reasons.push(...p.reasons);
    merged.set(p.name, unit);
  }
  const names = [...merged.keys()].sort();
  const shares = split(
    cents,
    names.map((name) => merged.get(name)?.weight ?? 0),
  );
  return names.map((name, i) => ({
    name,
    cents: shares[i] ?? 0,
    asked: shares[i] ?? 0,
    reasons: once(merged.get(name)?.reasons ?? []),
  }));
}

/**
 * A sentence about what the person holds of an underlying. It always says the whole holding, as
 * `w.held` has it; where a theme counted part of it first (gate THEME-FIRST) and `counted` is the
 * rest, it says both: "of the $3,000 you hold, $2,167 counts here".
 */
export function heldReason(
  w: World,
  rule: 'ALREADY_HELD' | 'ALREADY_HELD_NONE' | 'MORE_BECAUSE_HELD',
  asset: string,
  counted: number,
): Reason {
  const whole = w.held.get(asset) ?? counted;
  if (whole <= counted) return reason(rule, { asset, heldUsd: toUsd(whole) }, w.lang);
  return reason(`${rule}_PART`, { asset, totalUsd: toUsd(whole), heldUsd: toUsd(counted) }, w.lang);
}

/** What the goal sleeve counts of the person's holdings: all of them, or what the themes left. */
export type GoalHeld = { byName: Map<string, number>; total: number };

/** Cents that no unit took, with the name they were meant for and what kept them out. */
export type Unbought = { names: string[]; cents: number; cause: Reason };

/**
 * Fills gaps and avoids doubling up. The target is set on the amount plus what the person holds,
 * what they hold of each underlying is taken off it, and the units are scaled back to what they had
 * between them. `fixed` are units no holding touches (dollar yield and cash): they are scaled too.
 *
 * Every unit a holding moved says so: the one that is cut, and each one that grew in its place.
 * Returns the cents that no unit took: when the person holds enough of everything, nothing is bought.
 */
export function adjustForHoldings(
  w: World,
  units: Unit[],
  fixed: Sized[],
  removed: Removed[],
  goalHeld: GoalHeld = { byName: w.held, total: w.heldTotal },
): Unbought[] {
  if (goalHeld.total <= 0) return [];
  const all: Sized[] = [...units, ...fixed];
  const free = sum(all.map((u) => u.cents));
  if (free <= 0) return [];
  const wealth = BigInt(w.amount + goalHeld.total);
  const heldOf = (at: number) => goalHeld.byName.get(units[at]?.name ?? '') ?? 0;
  const buys = all.map((u, at) => {
    const buy = BigInt(u.cents) * wealth - BigInt(heldOf(at)) * BigInt(w.amount);
    return buy > 0n ? buy : 0n;
  });
  const scaled = apportion(buys, BigInt(free)).map(Number);

  // The units that are cut, and why each other unit is larger for it.
  const larger: Reason[] = [];
  const none = new Map<Unit, Reason>();
  units.forEach((u, at) => {
    const held = heldOf(at);
    const now = scaled[at] ?? 0;
    if (u.cents <= 0 || held <= 0 || now >= u.cents) return;
    larger.push(heldReason(w, 'MORE_BECAUSE_HELD', u.name, held));
    if (now <= 0) {
      const why = heldReason(w, 'ALREADY_HELD_NONE', u.name, held);
      none.set(u, why);
      removed.push({ ref: u.name, reasons: [why] });
    } else u.reasons.push(heldReason(w, 'ALREADY_HELD', u.name, held));
  });
  // When the person holds enough of everything, nothing is bought, and no unit grew: each unit's
  // cents are handed back, with the holding that kept them out.
  const nothingBought = sum(scaled) <= 0;
  const back: Unbought[] = [];
  all.forEach((u, at) => {
    const now = scaled[at] ?? 0;
    const why = none.get(u as Unit);
    if (nothingBought && why) back.push({ names: [(u as Unit).name], cents: u.cents, cause: why });
    if (now > u.cents) u.reasons.push(...larger);
    u.cents = now;
  });
  return back;
}

/**
 * Holds each stock and each crypto asset to the cap for the person's risk. What is over the cap goes
 * to the other units of the sleeve that have room, in proportion; what none can take is returned,
 * with the units that are at the cap. `already` is what a followed shared portfolio holds of each
 * underlying.
 */
export function capSingleStocks(
  w: World,
  units: Unit[],
  capped: (unit: Unit) => boolean,
  already: Map<string, number>,
  removed: Removed[],
): Unbought[] {
  const roomOf = (u: Unit) =>
    capped(u) ? Math.max(0, w.stockCap - (already.get(u.name) ?? 0)) : Number.POSITIVE_INFINITY;
  const atCap = new Set<Unit>();
  let over = 0;
  for (let pass = 0; pass <= units.length; pass += 1) {
    for (const u of units) {
      const room = roomOf(u);
      if (u.cents <= room) continue;
      over += u.cents - room;
      u.cents = room;
      if (!atCap.has(u))
        u.reasons.push(
          reason(
            'SINGLE_STOCK_CAP',
            { asset: u.name, capBps: w.P.capPerStockBps[w.sheet.risk] ?? 0, risk: w.sheet.risk },
            w.lang,
          ),
        );
      atCap.add(u);
    }
    const open = units.filter((u) => !atCap.has(u) && u.cents > 0);
    if (over <= 0 || open.length === 0) break;
    const more = split(
      over,
      open.map((u) => u.cents),
    );
    open.forEach((u, i) => {
      u.cents += more[i] ?? 0;
    });
    over = 0;
  }
  for (const u of units)
    if (u.cents <= 0 && atCap.has(u)) removed.push({ ref: u.name, reasons: once(u.reasons) });
  const [first] = byName([...atCap], (u) => u.name);
  const cause = first?.reasons.find((r) => r.rule === 'SINGLE_STOCK_CAP');
  if (over <= 0 || !cause) return [];
  return [{ names: [...atCap].map((u) => u.name), cents: over, cause }];
}
