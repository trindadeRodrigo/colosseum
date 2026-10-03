import { sha256Hex } from '@colosseum/basket';
import {
  type BasketAsset,
  BasketSheet,
  DISCLAIMER,
  type Reason,
  type Shelf,
  type Verdict,
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
import { byName, largestFirst, split, sum, toCents, toUsd } from './money';
import { packageUp } from './packaging';
import { Book, once, type Removed, type Sized, type Unit } from './placement';
import { reason, text } from './templates';
import {
  type ComposeContext,
  type PersonalProposal,
  type PersonalSheet,
  SLEEVES,
  type Sleeve,
} from './types';
import { buildWorld, type World } from './world';

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
  const ticker = P.defaultUnderlying[sleeve];
  const can = holdable(w, ticker, sleeve);
  if (can.ok)
    return [{ name: ticker, weight: cents, reasons: [...says, startReason(w, ticker, sleeve)] }];
  book.removed.push({ ref: ticker, reasons: can.why });
  book.spill(ticker, cents);
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
  const held = parts.some((p) => w.held.has(p.asset.underlying));
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

/** The dollar-yield tokens of the person's chain: best yield after haircut first. */
function yieldTokens(w: World): BasketAsset[] {
  const rate = (a: BasketAsset) => w.yields.get(a.id)?.haircutYield ?? -1;
  return w.tokens.filter((a) => w.sleeveOf(a) === 'dollarYield').sort((a, b) => rate(b) - rate(a));
}

function build(
  sheetIn: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
  withWays: boolean,
): PersonalProposal {
  const w = buildWorld(sheetIn, shelf, context);
  const { sheet, P, lang } = w;

  // ---- Exposure: how big each sleeve is.
  const sleeves = sizeSleeves(w);
  const [growth = 0, dollarYield = 0, gold = 0, cash = 0] = split(
    w.amount,
    SLEEVES.map((sleeve) => sleeves.sized[sleeve]),
  );
  const book = new Book(w);
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
      const inTheWay = follow(w, book, g.theme, cents, base, followed);
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
  const heldAlready = adjustForHoldings(
    w,
    [...growthUnits, ...goldUnits],
    [yieldUnit, cashUnit],
    book.removed,
  );
  book.spill(growthUnits[0]?.name ?? goldUnits[0]?.name ?? P.defaultUnderlying.growth, heldAlready);
  const isCapped = (unit: Unit) => tokensOf(w, unit.name, 'growth').some(capped);
  const overCap = capSingleStocks(w, growthUnits, isCapped, followed, book.removed);
  const [firstCapped] = byName(growthUnits.filter(isCapped), (u) => u.name);
  if (overCap > 0) book.spill(firstCapped?.name ?? P.defaultUnderlying.growth, overCap);
  book.cash.cents = cashUnit.cents;
  book.cash.reasons.push(...cashUnit.reasons);

  // ---- Placement: dollar yield first, then gold, then stocks and crypto, largest first.
  const yielders = yieldTokens(w);
  const canYield = yielders.some((a) => w.blockOf(a) === null);
  const byYield = (a: BasketAsset): Reason[] => [
    w.yields.has(a.id)
      ? reason('BY_YIELD', { chain: w.chain }, lang)
      : reason('YIELD_NOT_READ', {}, lang),
  ];
  /** The yields the dollar-yield tokens were ranked by are on the plan, held or not. */
  const ranked = () => {
    for (const a of yielders) {
      const read = w.yields.get(a.id);
      if (!read || w.blockOf(a) !== null) continue;
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
  /** Dollar yield takes what it can; what it cannot stays in cash, with why. */
  const intoYield = (unit: Sized) => {
    if (unit.cents <= 0) return;
    ranked();
    const { left, why, tooSmall } = book.fill(unit, yielders, byYield);
    if (left <= 0) return;
    const usd = toUsd(left);
    const stays = !canYield
      ? reason('NO_DOLLAR_YIELD', { usd, chain: w.chain }, lang)
      : tooSmall
        ? reason('YIELD_TOO_SMALL', { usd }, lang)
        : reason('UNPLACED', { usd }, lang);
    book.cash.cents += left;
    book.cash.reasons.push(...unit.reasons, ...why, stays);
    w.flags.add(canYield ? 'unplaced' : 'no_dollar_yield');
  };
  intoYield(yieldUnit);
  for (const unit of largestFirst(
    goldUnits,
    (u) => u.cents,
    (u) => u.name,
  ))
    book.place(unit, tokensOf(w, unit.name, 'gold'));
  for (const unit of largestFirst(
    growthUnits,
    (u) => u.cents,
    (u) => u.name,
  ))
    book.place(unit, tokensOf(w, unit.name, 'growth'));
  // What stocks, crypto and gold could not take is held in dollar yield, then in cash.
  intoYield({ cents: book.overflow.cents, reasons: once(book.overflow.reasons) });

  // ---- Packaging: lines, one recipe per chain, the card.
  const { lines, recipes, sleeves: held } = packageUp(w, book);
  const { card, yearlyLowUsd } = cardOf(w, lines);

  // Income goals: whether the target is met at today's yields after haircut, and the ways to close a
  // gap. A way is listed only if it closes the gap: each one is tried by running the engine again.
  let verdict: Verdict | undefined;
  const target = sheet.incomeTargetUsdMonthly;
  if (sheet.goal === 'income' && target !== undefined) {
    if (yearlyLowUsd === null) w.flags.add('income_not_estimated');
    else {
      const monthly = yearlyLowUsd / MONTHS_IN_A_YEAR;
      const gap = toUsd(Math.max(0, toCents(target) - toCents(monthly)));
      const ways: Verdict['ways'] = [];
      if (gap > 0 && withWays) {
        const meets = (amountUsd: number) =>
          build({ ...sheet, amountUsd }, shelf, context, false).verdict?.met === true;
        const enough = smallestThatMeets(sheet.amountUsd, P.wayStepUsd, meets);
        ways.push(
          enough === null
            ? { change: text('NO_AMOUNT_CLOSES', {}, lang), closesGap: false }
            : {
                change: text(
                  'WAY_AMOUNT',
                  { addUsd: enough - sheet.amountUsd, toUsd: enough },
                  lang,
                ),
                closesGap: true,
              },
        );
        const within = Math.floor(monthly);
        if (within > 0)
          ways.push({
            change: text('WAY_TARGET', { toUsd: within, fromUsd: target }, lang),
            closesGap: true,
          });
      }
      verdict = { met: gap <= 0, gapUsdMonthly: gap, ways };
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

  const paramsHash = hashOf(P);
  return {
    sheet,
    engineVersion: PERSONAL_ENGINE_VERSION,
    paramsHash,
    shelfVersion: shelf.version,
    inputsHash: hashOf({
      engine: PERSONAL_ENGINE_VERSION,
      params: paramsHash,
      shelf: shelf.version,
      sheet,
      now: w.now,
      holdings: byName(context.holdings ?? [], (h) => canonical(h)),
      yields: byName([...w.yields.values()], (y) => y.assetId),
      liquidity: w.liquidity
        ? { method: w.liquidity.methodVersion, provenance: w.liquidity.provenance }
        : null,
    }),
    lines,
    recipes,
    removed,
    card,
    ...(verdict ? { verdict } : {}),
    flags: [...w.flags].sort(),
    observations,
    disclaimer: DISCLAIMER[lang],
    sleeves: held,
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
  return build(sheet, shelf, context, true);
}
