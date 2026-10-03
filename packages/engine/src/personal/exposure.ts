import { apportion } from '@colosseum/basket';
import type { BasketAsset, ChainId, Reason } from '@colosseum/schemas';
import { BPS, bpsOf, shareOf, split, sum, toCents, toUsd } from './money';
import { once, type Removed, type Unit } from './placement';
import { type RuleId, reason } from './templates';
import { SLEEVES, type Sleeve } from './types';
import type { Family, World } from './world';

// Exposure: how big each sleeve is (stocks and crypto, dollar yield, gold, cash) and what is inside
// each. Sizes come from the goal and the risk, then from the date, from what the person may need
// and from what they must not lose. What is inside comes from the shared portfolios they chose.

export type SleeveSizes = Record<Sleeve, number>;
export type SleevePlan = {
  /** The row of the table for this goal and risk, in basis points; cash is what the row leaves. */
  table: SleeveSizes;
  /** The sleeves once the date, the need for cash and what must not be lost are applied. */
  sized: SleeveSizes;
  /** Why each sleeve is the size it is. Every line of a sleeve carries these. */
  reasons: Record<Sleeve, Reason[]>;
};

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
 * The size of each sleeve, in basis points adding up to 10,000.
 *
 * A nearer date never gives less cash, and never less in cash and dollar yield together: each floor
 * is taken from the steps the date has not passed, and is filled from stocks and crypto first, then
 * gold.
 */
export function sizeSleeves(w: World): SleevePlan {
  const { sheet, P, lang } = w;
  const row = P.sleeves[`${sheet.goal}:${sheet.risk}`] ?? {
    growthBps: 0,
    dollarYieldBps: 0,
    goldBps: 0,
  };
  const table: SleeveSizes = {
    growth: row.growthBps,
    dollarYield: row.dollarYieldBps,
    gold: row.goldBps,
    cash: BPS - row.growthBps - row.dollarYieldBps - row.goldBps,
  };
  const sized = { ...table };
  const reasons: SleevePlan['reasons'] = { growth: [], dollarYield: [], gold: [], cash: [] };
  for (const sleeve of SLEEVES)
    if (table[sleeve] > 0)
      reasons[sleeve].push(
        reason(
          'SLEEVE',
          { sleeveBps: table[sleeve], sleeve, goal: sheet.goal, risk: sheet.risk },
          lang,
        ),
      );

  /** Moves up to `need` into one sleeve from the others, in turn. Returns the sleeves that gave. */
  const raise = (to: Sleeve, need: number, from: Sleeve[]): Sleeve[] => {
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
  if (sheet.rules.glide) {
    const floor = floorAt(P.glideFloor, sheet.horizonMonths, (step) => step.dollarYieldBps);
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
  const dated = sheet.rules.glide ? sheet.horizonMonths : undefined;
  const soonest: { months: number; rule: RuleId } | null =
    said !== undefined && (dated === undefined || said <= dated)
      ? { months: said, rule: 'CASH_MAY_NEED' }
      : dated !== undefined
        ? { months: dated, rule: 'CASH_NEAR_DATE' }
        : null;
  if (soonest) {
    const floor = floorAt(P.cashFloor, soonest.months, (step) => step.cashBps);
    if (sized.cash < floor) {
      const gave = raise('cash', floor - sized.cash, ['growth', 'gold', 'dollarYield']);
      const why = reason(soonest.rule, { floorBps: floor, months: soonest.months }, lang);
      if (gave.length > 0) say(why, ['cash', ...gave]);
    }
  }

  // What must not be lost stays out of stocks, crypto and gold.
  const keep = sheet.limits?.mustKeepUsd ?? 0;
  if (keep > 0) {
    const floor = Math.min(BPS, bpsOf(toCents(keep), w.amount));
    const kept = sized.dollarYield + sized.cash;
    if (kept < floor) {
      const gave = raise('dollarYield', floor - kept, ['growth', 'gold']);
      const why = reason('MUST_KEEP', { floorBps: floor, keepUsd: keep }, lang);
      if (gave.length > 0) say(why, ['dollarYield', 'cash', ...gave]);
    }
  }
  return { table, sized, reasons };
}

export type Part = { asset: BasketAsset; bps: number };

/** A shared portfolio the plan starts from, with the recipe its weights are read from. */
export type Theme = {
  slug: string;
  name: string;
  /** False for the one a goal starts from when the person chose none. */
  chosen: boolean;
  family: Family;
  /** Its recipe on each chain the person funded, in their order. */
  recipes: { chain: ChainId; parts: Part[] }[];
  start: { chain: ChainId; parts: Part[] };
};

/** The tokens of one underlying in one sleeve, on the chains the person funded, in their order. */
export function tokensOf(w: World, underlying: string, sleeve: Sleeve): BasketAsset[] {
  return w.tokens
    .filter(
      (a) => a.underlying === underlying && w.sleeveOf(a) === sleeve && w.chains.includes(a.chain),
    )
    .sort((a, b) => w.chains.indexOf(a.chain) - w.chains.indexOf(b.chain));
}

/** Whether any token of this underlying can be held, and why not when none can. */
export function holdable(
  w: World,
  underlying: string,
  sleeve: Sleeve,
): { ok: boolean; why: Reason[] } {
  const tokens = tokensOf(w, underlying, sleeve);
  const blocks = tokens.map((a) => w.blockOf(a));
  if (blocks.some((b) => b === null)) return { ok: true, why: [] };
  const why = once(blocks.flatMap((b) => (b ? [b] : [])));
  return {
    ok: false,
    why: why.length > 0 ? why : [reason('NOT_ON_YOUR_CHAINS', { asset: underlying }, w.lang)],
  };
}

/** The reason a whole shared portfolio is left out, for the rule that left its parts out. */
function leftOut(w: World, rule: string, name: string): Reason {
  const { sheet, lang } = w;
  if (rule === 'NOT_FOR_GOAL')
    return reason('NOT_FOR_GOAL', { asset: name, goal: sheet.goal }, lang);
  if (rule === 'NOT_IN_COUNTRY')
    return reason('NOT_IN_COUNTRY', { asset: name, country: sheet.country }, lang);
  if (rule === 'EXCLUDED') return reason('EXCLUDED', { asset: name }, lang);
  return reason('NOT_ON_YOUR_CHAINS', { asset: name }, lang);
}

/** The shared portfolios the plan starts from. What cannot be used is listed in `removed`, with why. */
export function resolveThemes(w: World, removed: Removed[]): Theme[] {
  const { sheet, P, lang } = w;
  const chosen = [...new Set(sheet.themes)];
  const fallback = P.defaultTheme[sheet.goal];
  const slugs = chosen.length > 0 ? chosen : fallback ? [fallback] : [];
  const themes: Theme[] = [];
  for (const slug of slugs) {
    const isChosen = chosen.length > 0;
    const family = w.families.get(slug);
    if (!family) {
      if (isChosen)
        removed.push({ ref: slug, reasons: [reason('THEME_UNKNOWN', { theme: slug }, lang)] });
      continue;
    }
    const name = family.meta.name;
    const recipes = w.chains.flatMap((chain) => {
      const recipe = family.recipes.find((r) => r.chain === chain);
      if (!recipe) return [];
      const parts = recipe.components.flatMap((c): Part[] => {
        const asset = c.kind === 'asset' ? w.byId.get(c.asset) : undefined;
        return asset ? [{ asset, bps: c.weightBps }] : [];
      });
      return parts.length > 0 ? [{ chain, parts }] : [];
    });
    const [first] = recipes;
    if (!first) {
      if (isChosen)
        removed.push({
          ref: slug,
          reasons: [reason('THEME_NOT_ON_YOUR_CHAINS', { theme: name }, lang)],
        });
      continue;
    }
    // Read the weights from the first chain that can hold all of it; failing that, from the first.
    const start = recipes.find((r) => r.parts.every((p) => w.blockOf(p.asset) === null)) ?? first;

    // A portfolio none of whose parts the person can hold is left out as one, with why.
    const blocks = start.parts.map((p) => holdable(w, p.asset.underlying, w.sleeveOf(p.asset)));
    if (blocks.every((b) => !b.ok)) {
      if (isChosen) {
        const rules = [...new Set(blocks.flatMap((b) => b.why.map((r) => r.rule)))].sort();
        removed.push({ ref: slug, reasons: rules.map((rule) => leftOut(w, rule, name)) });
      }
      continue;
    }
    themes.push({ slug, name, chosen: isChosen, family, recipes, start });
  }
  return themes;
}

export const themeReason = (w: World, theme: Theme): Reason =>
  theme.chosen
    ? reason('FROM_THEME', { theme: theme.name }, w.lang)
    : reason('SLEEVE_DEFAULT', { what: theme.name, goal: w.sheet.goal }, w.lang);

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
    reasons: once(merged.get(name)?.reasons ?? []),
  }));
}

/**
 * Fills gaps and avoids doubling up. The target is set on the amount plus what the person holds,
 * what they hold of each underlying is taken off it, and the units are scaled back to what they had
 * between them. `fixed` are units no holding touches (dollar yield and cash): they are scaled too.
 * Returns the cents that no unit took.
 */
export function adjustForHoldings(
  w: World,
  units: Unit[],
  fixed: Unit[],
  removed: Removed[],
): number {
  if (w.heldTotal <= 0) return 0;
  const all = [...units, ...fixed];
  const free = sum(all.map((u) => u.cents));
  if (free <= 0) return 0;
  const wealth = BigInt(w.amount + w.heldTotal);
  const heldOf = (u: Unit) => (units.includes(u) ? (w.held.get(u.name) ?? 0) : 0);
  const buys = all.map((u) => {
    const buy = BigInt(u.cents) * wealth - BigInt(heldOf(u)) * BigInt(w.amount);
    return buy > 0n ? buy : 0n;
  });
  const scaled = apportion(buys, BigInt(free)).map(Number);
  const counts = shareOf(w.amount, w.P.holdingMinBps);
  all.forEach((u, i) => {
    const before = u.cents;
    u.cents = scaled[i] ?? 0;
    const held = heldOf(u);
    if (before <= 0 || held <= 0 || held < counts) return;
    const values = { asset: u.name, heldUsd: toUsd(held) };
    if (u.cents <= 0)
      removed.push({ ref: u.name, reasons: [reason('ALREADY_HELD_NONE', values, w.lang)] });
    else if (u.cents < before) u.reasons.push(reason('ALREADY_HELD', values, w.lang));
  });
  // When the person holds enough of everything, nothing is bought: the cents are handed back.
  return free - sum(all.map((u) => u.cents));
}

/**
 * Holds each stock and each crypto asset to the cap for the person's risk. What is over the cap goes
 * to the other units of the sleeve that have room, in proportion; what none can take is returned.
 * `already` is what a followed shared portfolio holds of each underlying.
 */
export function capSingleStocks(
  w: World,
  units: Unit[],
  capped: (unit: Unit) => boolean,
  already: Map<string, number>,
  removed: Removed[],
): number {
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
  return over;
}
