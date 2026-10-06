import { EXIT_WINDOW_DAYS, sha256Hex } from '@colosseum/basket';
import {
  type BasketAsset,
  BasketSheet,
  DISCLAIMER,
  type Reason,
  type Shelf,
  sleevesOf,
} from '@colosseum/schemas';
import { cardOf } from './card';
import {
  adjustForHoldings,
  capSingleStocks,
  holdable,
  resolveThemes,
  sizeSleeves,
  type Theme,
  themeOf,
  themeReason,
  tokensOf,
  unitsOf,
} from './exposure';
import { isMatchedList, type MatchedList } from './matched-theme';
import { BPS, byName, ceilCents, shareOf, shareOfUp, split, sum, toCents, toUsd } from './money';
import { packageUp } from './packaging';
import { Book, once, type Removed, type Sized, type Unit } from './placement';
import { type ScheduleInputs, scheduleOf } from './schedule';
import { scorecardOf } from './scorecard';
import { checkCoverage, placeSetAside, setAsideOf } from './set-aside';
import { statusOf } from './status';
import { reason, text } from './templates';
import { claimHoldings, fillingList, namesOf, placeThemeSleeve } from './theme-sleeve';
import {
  type CandidateId,
  type ComposeContext,
  type PersonalProposal,
  type PersonalSchedule,
  type PersonalSheet,
  type PersonalStatus,
  type PersonalVerdict,
  reportsPools,
  SLEEVES,
  type Sleeve,
} from './types';
import { buildWorld, reportsRegimes, type World } from './world';

export const PERSONAL_ENGINE_VERSION = 'personal-0.1';

const MONTHS_IN_A_YEAR = 12;

/**
 * The smallest amount above `from`, in whole steps and within what a sheet allows, for which `meets`
 * holds; null when even the largest does not. Each candidate is tried, so the answer is one that does.
 */
function smallestThatMeets(
  from: number,
  step: number,
  meets: (amountUsd: number) => boolean,
): number | null {
  const most = BasketSheet.shape.amountUsd.maxValue ?? from;
  const top = Math.floor(most / step) * step;
  if (top <= from || !meets(top)) return null;
  // More money never pays less, so halve the range: `low` does not meet, `high` does.
  let low = Math.floor(from / step);
  let high = top / step;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (meets(middle * step)) high = middle;
    else low = middle;
  }
  return high * step;
}

/**
 * The largest share of each withdrawal, in whole steps of basis points under the whole, for which
 * `meets` holds; null when none does. The whole is taken not to meet (the caller asks because it does
 * not); the answer is one that was tried and met.
 */
function largestScaleThatMeets(step: number, meets: (bps: number) => boolean): number | null {
  // Less to withdraw never pays fewer months, so halve the range: `low` meets (or is nothing), `high` does not.
  let low = 0;
  let high = Math.ceil(BPS / step);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (meets(middle * step)) low = middle;
    else high = middle;
  }
  return low > 0 ? low * step : null;
}

/**
 * How far a run goes. The plan a person sees tries the ways to close a gap; each way is a run that
 * does not (`ways: false`). A run that asks only whether an income target is met needs no schedule
 * (`status: false`). `candidate` is the candidate the plan is made as, or null.
 */
type Run = {
  ways: boolean;
  status: boolean;
  candidate: CandidateId | null;
  /**
   * The lines kept for the goal's stocks while the themes are placed. Left out, one for each goal
   * stock that needs a new line; a run that kept a line its stock then did not use runs again with
   * fewer, so the theme gets it.
   */
  keepLines?: number;
};

/** JSON with every object's keys in order, so the same value always gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}
const hashOf = (value: unknown): string => sha256Hex(new TextEncoder().encode(canonical(value)));

type Named = { name: string; weight: number; reasons: Reason[] };

/** The parts of a shared portfolio that sit in one sleeve and that the person can hold. */
function partsIn(w: World, theme: Theme, sleeve: Sleeve, removed?: Removed[]) {
  return theme.parts.filter((part) => {
    if (w.sleeveOf(part.asset) !== sleeve) return false;
    const can = holdable(w, part.asset.underlying, sleeve);
    if (!can.ok) removed?.push({ ref: part.asset.underlying, reasons: can.why });
    return can.ok;
  });
}

/**
 * Why a sleeve starts from something the person did not choose: the true reason differs when they
 * chose a shared portfolio and it does not fill this sleeve.
 */
function startReason(w: World, what: string, sleeve: Sleeve): Reason {
  return w.sheet.themes.length > 0
    ? reason('SLEEVE_FILLED', { what, sleeve }, w.lang)
    : reason('SLEEVE_DEFAULT', { what, goal: w.sheet.goal }, w.lang);
}

/** Why a part of a shared portfolio is in the plan: the person chose it, or the goal starts from it. */
const fromTheme = (w: World, theme: Theme, sleeve: Sleeve): Reason[] => [
  theme.chosen ? themeReason(w, theme) : startReason(w, theme.name, sleeve),
];

/**
 * What fills a sleeve that no shared portfolio in the plan fills, as when none is chosen: the table's
 * portfolio for the goal, if this chain has it and it holds this sleeve, and failing that the table's
 * ticker. What neither can fill is handed to dollar yield.
 */
function fallback(
  w: World,
  book: Book,
  sleeve: 'growth' | 'gold',
  cents: number,
  themes: Theme[],
  says: Reason[],
): Named[] {
  const { P, lang } = w;
  const slug = P.defaultTheme[w.sheet.goal];
  const known = slug && !themes.some((t) => t.slug === slug) ? themeOf(w, slug, false) : null;
  const theme = known && !Array.isArray(known) ? known : null;
  const parts = theme ? partsIn(w, theme, sleeve) : [];
  if (theme && parts.length > 0) {
    const opened =
      theme.family.meta.kind === 'index' ? [reason('OPENED', { theme: theme.name }, lang)] : [];
    const each = split(
      cents,
      parts.map((p) => p.bps),
    );
    return parts.map((p, i) => ({
      name: p.asset.underlying,
      weight: each[i] ?? 0,
      reasons: [...says, startReason(w, theme.name, sleeve), ...opened],
    }));
  }
  // The table's tickers in order (gold: PAXG, then GLD): the first the person can hold here fills it.
  const tried = [P.defaultUnderlying[sleeve]].flat().map((ticker) => ({
    ticker,
    can: holdable(w, ticker, sleeve),
  }));
  const held = tried.find((t) => t.can.ok);
  if (held)
    return [
      { name: held.ticker, weight: cents, reasons: [...says, startReason(w, held.ticker, sleeve)] },
    ];
  // What this chain lists and the person cannot hold says why; failing that, that none is listed.
  const listed = tried.filter((t) => tokensOf(w, t.ticker, sleeve).length > 0);
  const out = listed.length > 0 ? listed : tried;
  for (const t of out) book.removed.push({ ref: t.ticker, reasons: t.can.why });
  const names = out.map((t) => t.ticker);
  const cause = out[0]?.can.why[0];
  if (cause) book.spill(names, cents, cause);
  return [];
}

const capped = (asset: BasketAsset) => asset.cls === 'stock' || asset.cls === 'crypto';

/**
 * Holds a shared portfolio whole, as one component that can follow its updates: every part a token
 * the person can hold, at its own size, within every ceiling and cap. Returns null when it did, and
 * otherwise the limit that was in the way, if one was.
 */
function follow(
  w: World,
  book: Book,
  theme: Theme,
  cents: number,
  base: Reason[],
  followed: Map<string, number>,
  /** What the goal counts of the person's holdings, by underlying. */
  goalHeld: Map<string, number> = w.held,
): Reason[] | null {
  const { lang } = w;
  if (theme.family.meta.kind !== 'index') return [];
  const fits = theme.parts.every(
    (p) => w.sleeveOf(p.asset) === 'growth' && w.blockOf(p.asset) === null,
  );
  if (!fits) return [];
  const shares = split(
    cents,
    theme.parts.map((p) => p.bps),
  );
  const parts = theme.parts.map((p, i) => ({ asset: p.asset, cents: shares[i] ?? 0 }));
  // What the person already holds, or a part over the single-stock cap, is cut on its own line.
  const held = parts.some((p) => goalHeld.has(p.asset.underlying));
  const overCap = parts.some(
    (p) => capped(p.asset) && (followed.get(p.asset.underlying) ?? 0) + p.cents > w.stockCap,
  );
  if (held || overCap) return [];
  const limit = book.wholeFits(theme.name, parts);
  if (limit) return [limit];
  for (const p of parts) {
    book.put(
      p.asset,
      p.cents,
      [...base, reason('FOLLOWS', { theme: theme.name }, lang)],
      theme.slug,
    );
    followed.set(p.asset.underlying, (followed.get(p.asset.underlying) ?? 0) + p.cents);
  }
  return null;
}

/** The dollar-yield tokens of the person's chain, by id: the banded fill ranks them. */
function yieldTokens(w: World): BasketAsset[] {
  return byName(
    w.tokens.filter((a) => w.sleeveOf(a) === 'dollarYield'),
    (a) => a.id,
  );
}

function build(
  sheetIn: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
  run: Run,
): PersonalProposal {
  const withWays = run.ways;
  const w = buildWorld(sheetIn, shelf, context, run.candidate);
  const { sheet, P, lang } = w;

  // ---- Exposure: how big each sleeve is. What the next withdrawals need comes off the goal first.
  const sa = setAsideOf(w);
  const sleeves = sizeSleeves(w, sa?.bps ?? 0);
  // The person's sleeves first, each its share of the amount to the cent; then the goal sleeve's own
  // parts, out of its cents, so each sleeve is its share whatever the rounding inside it.
  const [goalPart = 0, safeYield = 0, ...themeSplit] = split(w.amount, [
    sleeves.goalBps,
    sleeves.safeYieldBps,
    ...sleeves.themes.map((t) => t.shareBps),
  ]);
  // What is set aside for withdrawals is its share of the whole amount, rounded up, so the split of
  // the goal sleeve never leaves it a cent short; the rest of the goal sleeve is shared by the table.
  const setAside = Math.min(goalPart, shareOfUp(w.amount, sleeves.setAsideBps));
  const [growth = 0, dollarYield = 0, gold = 0, cash = 0] = split(
    goalPart - setAside,
    SLEEVES.map((sleeve) => sleeves.sized[sleeve]),
  );
  /** Each theme sleeve's cents, by slug. */
  const themeCents = new Map(sleeves.themes.map((t, i) => [t.slug, themeSplit[i] ?? 0]));
  // A holding counts once: the themes first, the goal what is left (gate THEME-FIRST).
  const { claimed, goal: goalHeld } = claimHoldings(
    w,
    sleeves.themes.map((t) => ({ slug: t.slug, cents: themeCents.get(t.slug) ?? 0 })),
  );
  const book = new Book(w);
  // A shared portfolio the goal follows is placed before the themes: until they are, the issuers of
  // their names keep room for them (gate THEME-FIRST), as much as the names that can be held and
  // sold can take, and no more than the theme's share.
  for (const t of sleeves.themes) {
    const list = fillingList(w, t.slug);
    if (!list) continue;
    const byIssuer = new Map<string, number>();
    for (const n of namesOf(w, list).found) {
      const most = Math.min(
        w.ceilingOf(n.asset),
        n.asset.cls === 'stock' || n.asset.cls === 'crypto' ? w.stockCap : w.ceilingOf(n.asset),
      );
      byIssuer.set(n.asset.issuer, (byIssuer.get(n.asset.issuer) ?? 0) + most);
    }
    for (const [issuer, most] of byIssuer)
      book.reserved.set(
        issuer,
        (book.reserved.get(issuer) ?? 0) + Math.min(most, themeCents.get(t.slug) ?? 0),
      );
  }
  const themes = resolveThemes(w, book.removed);

  // ---- Exposure: what is inside stocks and crypto. A shared portfolio that fits is held whole.
  const followed = new Map<string, number>();
  const growthParts: Named[] = [];
  if (growth > 0) {
    const growers = themes
      .map((theme) => ({ theme, parts: partsIn(w, theme, 'growth', book.removed) }))
      .filter((g) => g.parts.length > 0);
    const shares = split(
      growth,
      growers.map(() => 1),
    );
    growers.forEach((g, i) => {
      const cents = shares[i] ?? 0;
      const base = [...sleeves.reasons.growth, ...fromTheme(w, g.theme, 'growth')];
      const inTheWay = follow(w, book, g.theme, cents, base, followed, goalHeld.byName);
      if (inTheWay === null) return;
      const opened =
        g.theme.family.meta.kind === 'index'
          ? [reason('OPENED', { theme: g.theme.name }, lang), ...inTheWay]
          : [];
      const each = split(
        cents,
        g.parts.map((p) => p.bps),
      );
      g.parts.forEach((p, at) => {
        growthParts.push({
          name: p.asset.underlying,
          weight: each[at] ?? 0,
          reasons: [...base, ...opened],
        });
      });
    });
    if (growers.length === 0)
      growthParts.push(...fallback(w, book, 'growth', growth, themes, sleeves.reasons.growth));
  }
  const growthUnits = unitsOf(sum(growthParts.map((p) => p.weight)), growthParts);

  // ---- Exposure: what is inside gold.
  const goldParts: Named[] = [];
  if (gold > 0) {
    for (const theme of themes)
      for (const p of partsIn(w, theme, 'gold', book.removed))
        goldParts.push({
          name: p.asset.underlying,
          weight: p.bps,
          reasons: [
            ...sleeves.reasons.gold,
            ...fromTheme(w, theme, 'gold'),
            ...(theme.family.meta.kind === 'index'
              ? [reason('OPENED', { theme: theme.name }, lang)]
              : []),
          ],
        });
    if (goldParts.length === 0)
      goldParts.push(...fallback(w, book, 'gold', gold, themes, sleeves.reasons.gold));
  }
  const goldUnits = goldParts.length > 0 ? unitsOf(gold, goldParts) : [];

  // ---- Exposure: what the person already holds, then the cap on one stock.
  const yieldUnit: Sized = { cents: dollarYield, reasons: [...sleeves.reasons.dollarYield] };
  const cashUnit: Sized = { cents: cash, reasons: [...sleeves.reasons.cash] };
  const isCapped = (unit: Unit) => tokensOf(w, unit.name, 'growth').some(capped);
  // What neither leaves a unit to take is held in dollar yield, with the holding or the cap that
  // kept it out.
  for (const { names, cents, cause } of [
    ...adjustForHoldings(
      w,
      [...growthUnits, ...goldUnits],
      [yieldUnit, cashUnit],
      book.removed,
      goalHeld,
    ),
    ...capSingleStocks(w, growthUnits, isCapped, followed, book.removed),
  ])
    book.spill(names, cents, cause);
  book.cash.cents = cashUnit.cents;
  book.cash.reasons.push(...cashUnit.reasons);

  // ---- Placement: dollar yield first, then gold, then stocks and crypto, largest first.
  const yielders = yieldTokens(w);
  const canYield = yielders.some((a) => w.blockOf(a) === null);
  /** The yields the dollar-yield tokens were ranked by are on the plan, held or not. */
  const ranked = () => {
    for (const a of yielders) {
      const read = w.yields.get(a.id);
      // Only a figure the fill ranked by: a token with no leg type is left out before any ranking.
      if (!read || w.blockOf(a) !== null || w.yieldCapOf(a) === null) continue;
      const { source, method, fetchedAt, provenance } = read;
      w.observations.set(`yield ${a.id}`, {
        id: a.id,
        kind: 'yield',
        source,
        method,
        fetchedAt,
        provenance,
      });
    }
  };
  /** What dollar yield could not take and so stays in cash, in cents, by the reason it stays. */
  const stays = new Map<'NO_DOLLAR_YIELD' | 'YIELD_TOO_SMALL' | 'UNPLACED', number>();
  /** Dollar yield takes what it can; what it cannot stays in cash, with why. */
  const intoYield = (unit: Sized) => {
    if (unit.cents <= 0) return;
    ranked();
    const { left, why, tooSmall } = book.fillBanded(unit, yielders);
    if (left <= 0) return;
    const rule = !canYield ? 'NO_DOLLAR_YIELD' : tooSmall ? 'YIELD_TOO_SMALL' : 'UNPLACED';
    stays.set(rule, (stays.get(rule) ?? 0) + left);
    book.cash.cents += left;
    book.cash.reasons.push(...unit.reasons, ...why);
    w.flags.add(canYield ? 'unplaced' : 'no_dollar_yield');
  };
  // What is set aside for the next withdrawals is placed before anything else.
  if (sa && setAside > 0)
    placeSetAside(
      w,
      book,
      setAside,
      sa,
      yielders.filter((a) => w.isRateOnly(a)),
      ranked,
    );
  if (sa && setAside < sa.owed) {
    w.flags.add('set_aside_short');
    book.cash.reasons.push(
      reason(
        'SET_ASIDE_SHORT',
        {
          from: sa.from,
          to: sa.to,
          owedUsd: toUsd(sa.owed),
          goalUsd: toUsd(setAside),
          shortUsd: toUsd(sa.owed - setAside),
        },
        lang,
      ),
    );
  }
  // The safe-yield sleeve is placed before the goal's dollar yield: it can hold only rate legs, so
  // it has first call on them, and the goal's dollar yield ranks every leg type on what is left.
  // What no rate leg takes stays in cash, said in the sleeve's own sentence.
  const safe: { assetId: string; cents: number }[] = [];
  let safeCash = 0;
  if (safeYield > 0) {
    ranked();
    const unit: Sized = {
      cents: safeYield,
      reasons: [reason('SPLIT_SAFE_YIELD', { shareBps: sleeves.safeYieldBps }, lang)],
    };
    const rateOnly = yielders.filter((a) => w.isRateOnly(a));
    const before = new Map(rateOnly.map((a) => [a.id, book.lines.get(a.id)?.cents ?? 0]));
    const { left, why } = book.fillBanded(unit, rateOnly);
    for (const a of rateOnly) {
      const took = (book.lines.get(a.id)?.cents ?? 0) - (before.get(a.id) ?? 0);
      if (took > 0) safe.push({ assetId: a.id, cents: took });
    }
    if (left > 0) {
      safeCash = left;
      const none = !rateOnly.some((a) => w.blockOf(a) === null && w.yields.has(a.id));
      book.cash.cents += left;
      book.cash.reasons.push(
        ...unit.reasons,
        ...why,
        none
          ? reason('SAFE_YIELD_NO_RATE', { usd: toUsd(left), chain: w.chain }, lang)
          : reason('UNPLACED', { usd: toUsd(left) }, lang),
      );
      w.flags.add(none ? 'safe_yield_no_rate_leg' : 'unplaced');
    }
  }
  // A credit share the person stated ("only credit", gate EXPLICIT-MIX) fills credit and basis legs
  // first, up to that share and their caps; the rest of dollar yield is ranked as always.
  if ((sheet.mix?.creditBps ?? 0) > 0 && yieldUnit.cents > 0) {
    ranked();
    const first = Math.min(yieldUnit.cents, w.creditBudget.cents);
    const { left } = book.fillBanded(
      { cents: first, reasons: [...yieldUnit.reasons] },
      yielders.filter((a) => w.isCredit(a)),
    );
    yieldUnit.cents -= first - left;
  }
  intoYield(yieldUnit);
  book.placeTogether(goldUnits, (unit) => tokensOf(w, unit.name, 'gold'));
  // What the goal could not hold so far waits, apart from the themes' own.
  const goalWaiting = book.overflow();
  // ---- The theme sleeves (gates SLEEVES, THEMES, THEME-FIRST), before the goal's stocks and crypto:
  // the theme the person asked for keeps its share of an issuer's room, and the goal's stocks take
  // what is left. The lines its stocks need are kept for them. What no name of a theme takes is held
  // in dollar yield, then cash, and the sleeve records where.
  book.reserved.clear();
  // The matched themes the sheet asks for, with or without a stock: what the hash of the inputs pins.
  const matchedLists = byName(
    sleeves.themes.flatMap((t): MatchedList[] => {
      const list = w.themeListOf(t.slug);
      return list && isMatchedList(list) ? [list] : [];
    }),
    (list) => list.slug,
  );
  // The names a theme sleeve of this sheet may take a line for: those of the lists that fill one. A
  // list the sheet does not name, or one that fills nothing (proposed, or a filter with no stock
  // here), takes no line, so it keeps none from the goal's stocks and changes nothing in the plan.
  const members = new Set(
    byName(sleeves.themes, (t) => t.slug).flatMap((t) =>
      (fillingList(w, t.slug)?.members ?? []).map((m) => m.symbol),
    ),
  );
  const goalTokens = new Set(
    growthUnits
      .filter((u) => u.cents > 0)
      .flatMap((u) =>
        tokensOf(w, u.name, 'growth')
          .filter((a) => w.blockOf(a) === null)
          .slice(0, 1),
      )
      .filter((a) => !book.lines.has(a.id) && !members.has(a.symbol))
      .map((a) => a.id),
  );
  const goalLines = Math.min(goalTokens.size, run.keepLines ?? goalTokens.size);
  const themed = new Map<string, Map<string, number>>();
  /** What no name of each theme took: held in dollar yield, then cash, after the goal's stocks. */
  const themeWaiting = new Map<string, Sized>();
  let themesShort = false;
  for (const t of byName(sleeves.themes, (x) => x.slug)) {
    const { holds, short } = placeThemeSleeve(
      w,
      book,
      t.slug,
      t.shareBps,
      themeCents.get(t.slug) ?? 0,
      goalLines,
      claimed.get(t.slug),
    );
    themesShort ||= short;
    themeWaiting.set(t.slug, book.overflow());
    themed.set(t.slug, holds);
    // Where an issuer's cap then stops the goal's stocks, the reason names this theme.
    const name = w.themeListOf(t.slug)?.name[lang];
    if (name)
      for (const id of holds.keys()) {
        const asset = w.byId.get(id);
        if (asset && w.sleeveOf(asset) === 'growth')
          book.themeFirst.set(asset.issuer, [
            ...new Set([...(book.themeFirst.get(asset.issuer) ?? []), name]),
          ]);
      }
  }
  book.placeTogether(growthUnits, (unit) => tokensOf(w, unit.name, 'growth'));
  // A line kept for a goal stock that took no money goes to the themes: the plan is made again
  // keeping only the lines the goal's stocks used.
  const usedLines = [...goalTokens].filter((id) => (book.lines.get(id)?.cents ?? 0) > 0).length;
  if (themesShort && usedLines < goalLines)
    return build(sheetIn, shelf, context, { ...run, keepLines: usedLines });
  // What no name of a theme took is held in dollar yield, then cash, now that the goal's stocks have
  // their lines, and the sleeve records where.
  for (const [slug, spilled] of themeWaiting) {
    if (spilled.cents <= 0) continue;
    const holds = themed.get(slug) ?? new Map<string, number>();
    const lineCents = () => new Map([...book.lines].map(([id, l]) => [id, l.cents]));
    const before = { lines: lineCents(), cash: book.cash.cents };
    intoYield(spilled);
    for (const [id, now] of lineCents()) {
      const took = now - (before.lines.get(id) ?? 0);
      if (took > 0) holds.set(id, (holds.get(id) ?? 0) + took);
    }
    const stayed = book.cash.cents - before.cash;
    if (stayed > 0) holds.set(w.cash.id, (holds.get(w.cash.id) ?? 0) + stayed);
  }
  // What stocks, crypto and gold could not take is held in dollar yield, then in cash.
  const rest = book.overflow();
  intoYield({
    cents: goalWaiting.cents + rest.cents,
    reasons: [...goalWaiting.reasons, ...rest.reasons],
  });
  // One sentence for each reason money meant for dollar yield stays in cash, with the whole of it.
  for (const [rule, cents] of stays) {
    const usd = toUsd(cents);
    book.cash.reasons.push(
      reason(rule, rule === 'NO_DOLLAR_YIELD' ? { usd, chain: w.chain } : { usd }, lang),
    );
  }

  // ---- The coverage check: the next withdrawals can be paid in time, or money moves to cash. What
  // the safe-yield and theme sleeves hold is theirs: the goal's withdrawals do not move it.
  if (sa) {
    const held = new Map<string, number>();
    for (const h of safe) held.set(h.assetId, (held.get(h.assetId) ?? 0) + h.cents);
    for (const holds of themed.values())
      for (const [id, c] of holds) if (id !== w.cash.id) held.set(id, (held.get(id) ?? 0) + c);
    checkCoverage(w, book, sa, held);
  }

  // ---- Packaging: lines, one recipe per chain, the card.
  const { lines, recipes, sleeves: held } = packageUp(w, book);
  // A goal not in dollars is open to the rate (the flag), and has a matching leg or says it has none.
  // Each line counted in another currency than the goal's says that its value moves with the rate (the
  // open-FX line): every line but cash in dollars for a goal in reais, and only a line in another
  // currency, held for a withdrawal in it, for a goal in dollars.
  if (w.currency !== 'USD') {
    w.flags.add(`fx_open:${w.currency}`);
    if (!w.matchingOf(w.currency)) w.flags.add(`no_matching_leg:${w.currency}`);
  }
  for (const l of lines)
    if ((w.byId.get(l.assetId)?.currency ?? 'USD') !== w.currency)
      l.reasons.push(reason('FX_OPEN', { currency: w.currency }, lang));
  // With a split, what each sleeve of the person's holds, by token, before the lines are rounded.
  const goalCents = goalPart;
  const asSplit = sheet.sleeves
    ? sleevesOf(sheet).map((x) => {
        const holds =
          x.kind === 'safe_yield'
            ? [...safe, ...(safeCash > 0 ? [{ assetId: w.cash.id, cents: safeCash }] : [])]
            : x.kind === 'theme'
              ? [...(themed.get(x.theme) ?? [])].map(([assetId, cents]) => ({ assetId, cents }))
              : [];
        // A theme filled by a filter says so, with what it was matched by: never as a curated one.
        const list = x.kind === 'theme' ? w.themeListOf(x.theme) : null;
        const matched =
          list && isMatchedList(list)
            ? { by: list.matched.by, value: list.matched.value ?? list.matched.key }
            : null;
        return {
          kind: x.kind,
          ...(x.kind === 'theme' ? { theme: x.theme } : {}),
          ...(matched ? { matched } : {}),
          shareBps: x.shareBps,
          amountUsd: toUsd(
            x.kind === 'safe_yield'
              ? safeYield
              : x.kind === 'theme'
                ? (themeCents.get(x.theme) ?? 0)
                : goalCents,
          ),
          holds: byName(holds, (h) => h.assetId).map((h) => ({
            assetId: h.assetId,
            amountUsd: toUsd(h.cents),
          })),
        };
      })
    : undefined;
  const { card, yearlyLowUsd } = cardOf(w, lines);

  // The schedule, in the goal's currency, when there are withdrawals. It needs the rate for a goal
  // not in dollars; with none, there is no schedule, and the plan says so.
  let schedule: PersonalSchedule | undefined;
  let status: PersonalStatus | undefined;
  const lastWithdrawal = w.withdrawals.at(-1);
  if (run.status && lastWithdrawal) {
    const rate = w.currency === 'USD' ? 1 : (w.fxOf(w.currency)?.value ?? null);
    if (rate === null) w.flags.add(`schedule_no_fx:${w.currency}`);
    else {
      const [y0 = 0, m0 = 1] = w.nowMonth.split('-').map(Number);
      const [y1 = 0, m1 = 1] = lastWithdrawal.month.split('-').map(Number);
      const toLast = (y1 - y0) * MONTHS_IN_A_YEAR + (m1 - m0) + 1;
      const inputs: ScheduleInputs = {
        lines,
        byId: w.byId,
        yields: w.yields,
        withdrawals: w.withdrawals,
        currency: w.currency,
        rate,
        nowMonth: w.nowMonth,
        months: Math.min(
          BasketSheet.shape.horizonMonths.maxValue ?? toLast,
          Math.max(sheet.horizonMonths, toLast),
        ),
        liquidity: w.liquidity,
        tau: P.tau,
        unmeasuredCost: w.unmeasuredCost,
        ceilingUsdOf: (a) => toUsd(w.ceilingOf(a)),
        isCredit: (a) => w.isCredit(a),
      };
      schedule = scheduleOf(inputs);
      if (schedule.monthsPaid < schedule.monthsWithWithdrawal) w.flags.add('schedule_unpaid');
      // The date of the rates: the latest yield reading the plan counts.
      const read = [...w.observations.values()]
        .filter((o) => o.kind === 'yield' && o.fetchedAt !== null)
        .map((o) => String(o.fetchedAt).slice(0, 10))
        .sort();
      status = statusOf(inputs, P, sheet.amountUsd, read.at(-1) ?? null, { carry: withWays });
    }
  }

  // A status not met: the ways to close the gap, each tried by running the engine again with one
  // input changed and the rest fixed, as this plan was made (the same candidate). Listed only if the
  // plan it gives is met. A later start and a monthly contribution have no field on the sheet.
  if (status && !status.met && withWays) {
    const met = (s: PersonalSheet) =>
      build(s, shelf, context, { ways: false, status: true, candidate: run.candidate }).status
        ?.met === true;
    const enough = smallestThatMeets(sheet.amountUsd, P.wayStepUsd, (amountUsd) =>
      met({ ...sheet, amountUsd }),
    );
    if (enough === null) {
      status.noAmountCloses = text('STATUS_NO_AMOUNT_CLOSES', {}, lang);
      w.flags.add('status_no_amount_closes');
    } else
      status.ways.push({
        change: text('WAY_AMOUNT', { addUsd: enough - sheet.amountUsd, toUsd: enough }, lang),
        closesGap: true,
      });
    // Each withdrawal scaled by one share, in whole cents of its currency; one scaled to nothing goes.
    const scaled = (bps: number) =>
      (sheet.obligations ?? [])
        .map((o) => ({ ...o, amount: toUsd(shareOf(toCents(o.amount), bps)) }))
        .filter((o) => o.amount > 0);
    const scale = largestScaleThatMeets(P.wayScaleStepBps, (bps) =>
      met({ ...sheet, obligations: scaled(bps) }),
    );
    if (scale !== null)
      status.ways.push({
        change: text('WAY_WITHDRAW_LESS', { scaleBps: scale }, lang),
        closesGap: true,
      });
  }

  // Income goals: whether the target is met at today's yields after haircut, and the ways to close a
  // gap. A way is listed only if it closes the gap: each one is tried by running the engine again.
  let verdict: PersonalVerdict | undefined;
  const target = sheet.incomeTargetUsdMonthly;
  if (sheet.goal === 'income' && target !== undefined) {
    if (yearlyLowUsd === null) w.flags.add('income_not_estimated');
    else {
      const monthly = yearlyLowUsd / MONTHS_IN_A_YEAR;
      // Met means met: the plan pays the target or more. A shortfall is written up to the next
      // cent, so a target missed by a fraction of a cent has a gap and is not read as met.
      const short = Math.max(0, ceilCents(target - monthly));
      verdict = { met: short <= 0, gapUsdMonthly: toUsd(short), ways: [] };
      if (short > 0 && withWays) {
        const meets = (amountUsd: number) =>
          build({ ...sheet, amountUsd }, shelf, context, {
            ways: false,
            status: false,
            candidate: run.candidate,
          }).verdict?.met === true;
        const enough = smallestThatMeets(sheet.amountUsd, P.wayStepUsd, meets);
        if (enough === null) {
          // Not a way to close the gap, so not among the ways: said apart, and flagged.
          verdict.noAmountCloses = text('NO_AMOUNT_CLOSES', {}, lang);
          w.flags.add('income_no_amount_closes');
        } else
          verdict.ways.push({
            change: text('WAY_AMOUNT', { addUsd: enough - sheet.amountUsd, toUsd: enough }, lang),
            closesGap: true,
          });
        const within = Math.floor(monthly);
        if (within > 0)
          verdict.ways.push({
            change: text('WAY_TARGET', { toUsd: within, fromUsd: target }, lang),
            closesGap: true,
          });
      }
    }
  }

  // What was left out, each thing once, with every reason it was.
  const out = new Map<string, Reason[]>();
  for (const r of book.removed) out.set(r.ref, [...(out.get(r.ref) ?? []), ...r.reasons]);
  const removed = byName([...out.entries()], ([ref]) => ref).map(([ref, reasons]) => ({
    ref,
    reasons: once(reasons),
  }));

  // Anything that is not live says so.
  for (const l of lines) {
    const provenance = w.byId.get(l.assetId)?.provenance;
    if (provenance && provenance !== 'live') w.flags.add(`shelf_provenance:${provenance}`);
  }
  // Every figure that shaped the plan, whether or not its token ended up in it.
  const observations = byName([...w.observations.entries()], ([key]) => key).map(
    ([, observation]) => observation,
  );
  for (const o of observations)
    if (o.provenance !== 'live') w.flags.add(`${o.kind}_provenance:${o.provenance}`);

  // The hash of the inputs pins everything that shaped the plan: the sheet, the time, what the shelf
  // holds, what the person holds, every yield given, every figure the liquidity provider has for
  // this chain's tokens and for these lines, and the parameter table.
  const paramsHash = hashOf(P);
  // Only the lists the sheet's theme sleeves name: editing another list re-hashes no plan.
  const usedLists = w.themeLists.filter((t) => sleeves.themes.some((x) => x.slug === t.slug));
  const liquidity = w.liquidity;
  const inputs = {
    engine: PERSONAL_ENGINE_VERSION,
    params: paramsHash,
    now: w.now,
    sheet,
    shelf: {
      version: shelf.version,
      assets: byName(shelf.assets, (a) => a.id),
      // A shelf's content, not the order it is listed in: tokens, portfolios, recipes and parts.
      families: byName(shelf.families, (f) => f.meta.slug).map((f) => ({
        meta: f.meta,
        recipes: byName(f.recipes, (r) => r.chain).map((r) => ({
          ...r,
          components: byName(r.components, (c) => (c.kind === 'asset' ? c.asset : c.family)),
        })),
      })),
    },
    holdings: w.given.holdings,
    yields: w.given.yields,
    // Left out when none is given, so a plan with no FX reading hashes as it did before.
    fx: w.given.fx.length > 0 ? w.given.fx : undefined,
    // The theme lists the plan's theme sleeves read, the same way.
    themes: usedLists.length > 0 ? usedLists : undefined,
    // And the matched themes: what each filter matched, and the version of the attributes read. The
    // attributes are pinned by what was matched from them, not whole, so a plan with no matched
    // theme hashes as it did with none given.
    matched: matchedLists.length > 0 ? matchedLists : undefined,
    liquidity: liquidity
      ? {
          method: liquidity.methodVersion,
          provenance: liquidity.provenance,
          source: w.given.liquiditySource,
          capacity: w.tokens.map((a) => [
            a.id,
            liquidity.covers(a.id) ? liquidity.exitCapacity(a.id, P.tau, EXIT_WINDOW_DAYS) : null,
            reportsRegimes(liquidity) ? liquidity.regimes(a.id) : null,
          ]),
          // Which tokens sell into one pool, where the provider says (the coverage check reads it).
          ...(reportsPools(liquidity)
            ? {
                pools: w.tokens.map((a) => [a.id, liquidity.poolOf(a.id, P.tau, EXIT_WINDOW_DAYS)]),
              }
            : {}),
          cost: lines.map((l) => [
            l.assetId,
            l.amountUsd,
            liquidity.covers(l.assetId)
              ? liquidity.exitCost(l.assetId, l.amountUsd, EXIT_WINDOW_DAYS)
              : null,
          ]),
        }
      : null,
  };
  return {
    sheet,
    engineVersion: PERSONAL_ENGINE_VERSION,
    paramsHash,
    shelfVersion: shelf.version,
    // The plans tried on the way to a verdict are thrown away, and so not hashed.
    inputsHash: withWays ? hashOf(inputs) : paramsHash,
    lines,
    recipes,
    removed,
    card,
    ...(verdict ? { verdict } : {}),
    flags: [...w.flags].sort(),
    observations,
    disclaimer: DISCLAIMER[lang],
    sleeves: held,
    ...(asSplit ? { split: asSplit } : {}),
    ...(schedule ? { schedule } : {}),
    ...(status ? { status } : {}),
    ...(run.candidate !== null && withWays
      ? { candidate: run.candidate, scorecard: scorecardOf(w, lines, status ?? null) }
      : {}),
  };
}

/**
 * A person's goal and limits, turned into a plan made to measure: lines with a reason on each, one
 * recipe per chain, the card, and for an income goal the verdict.
 *
 * Pure: no clock, no network, no environment, nothing random. The time, the shelf, what the person
 * holds, the yields, the measured liquidity and the parameter table all come in as arguments, and
 * the same arguments always give the same plan. The sheet is validated first; a sheet that is not
 * valid throws `PersonalInputError` and nothing is computed.
 */
export function compose(
  sheet: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
): PersonalProposal {
  return build(sheet, shelf, context, { ways: true, status: true, candidate: null });
}

/**
 * The risk whose limits a plan takes. With a stated mix (gate EXPLICIT-MIX), the lowest whose caps per
 * stock and per issuer admit it, which the read-back states as an assumption; otherwise the sheet's.
 */
export function riskForMix(
  sheet: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
): PersonalSheet['risk'] {
  return buildWorld(sheet, shelf, context).sheet.risk;
}

/**
 * One plan made as a candidate of gate THREE-PLANS (`candidates` in ./candidates.ts makes all three):
 * the same engine, with the candidate's table, and its scorecard.
 */
export function composeAs(
  candidate: CandidateId,
  sheet: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
): PersonalProposal {
  return build(sheet, shelf, context, { ways: true, status: true, candidate });
}
