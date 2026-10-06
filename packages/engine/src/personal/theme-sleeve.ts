import type { BasketAsset, Reason } from '@colosseum/schemas';
import { byName, split, sum, toUsd } from './money';
import type { Book, Removed } from './placement';
import { reason } from './templates';
import type { World } from './world';

// A theme sleeve (gates SLEEVES and THEMES): a share of the plan held in equal parts of the names on
// a curated list, on the person's chain.
//
// Placed before the goal sleeve's stocks and crypto (gate THEME-FIRST): the theme keeps its share of
// an issuer's room, and the goal's stocks take what is left.
//
// - Eligible: the list, with the token the chain lists under each symbol (the first by id the person
//   can hold, where two share one), that the person can hold
//   (their country, what they cannot hold, what the goal allows: a plan to protect or for income
//   holds no stock, gate PROTECT-NO-STOCKS), and that can take a line at this size within `tau` (its
//   measured exit, or its tier where nothing is measured, said as such: gate EXIT-SOURCE).
// - Weights: equal, less for a name the person already holds (as the goal's holdings rule), each name
//   up to its exit ceiling and the cap on one stock; where one name stops, the others take more. An
//   issuer's cap, read per name, scales its names down together.
// - Lines: a name already in the plan keeps its line; a new one takes one of the lines left. When
//   the names outnumber the lines left, the easiest to sell take them: measured names first, by
//   measured capacity, then those on a tier, by its ceiling; ties by id.
// - What no name can take is handed back, with what kept it out: the caller holds it in dollar yield,
//   then cash, and says so on those lines.

type Name = {
  asset: BasketAsset;
  member: { symbol: string; reason: { en: string; pt: string } };
  measured: number | null;
  /** Its part of the sleeve, before caps: equal, less where the person already holds it. */
  weight: number;
};

/**
 * Equal parts of `total`, each up to its cap: where a part stops at its cap, what it leaves is shared
 * equally by the others. What none can take is left over. Whole cents; a remainder cent goes to the
 * earlier part, so the order given decides only that cent. With `weights`, parts in those
 * proportions instead of equal (what the person already holds makes them unequal).
 */
export function equalCapped(
  total: number,
  caps: readonly number[],
  weights: readonly number[] = caps.map(() => 1),
): number[] {
  const out = caps.map(() => 0);
  let left = Math.max(0, total);
  let open = caps.map((_, i) => i).filter((i) => (caps[i] ?? 0) > 0 && (weights[i] ?? 0) > 0);
  while (left > 0 && open.length > 0) {
    const shares = split(
      left,
      open.map((i) => weights[i] ?? 0),
    );
    const full = open.filter((i, k) => (shares[k] ?? 0) >= (caps[i] ?? 0) - (out[i] ?? 0));
    if (full.length === 0) {
      open.forEach((i, k) => {
        out[i] = (out[i] ?? 0) + (shares[k] ?? 0);
      });
      return out;
    }
    for (const i of full) {
      left -= (caps[i] ?? 0) - (out[i] ?? 0);
      out[i] = caps[i] ?? 0;
    }
    open = open.filter((i) => !full.includes(i));
  }
  return out;
}

const capped = (a: BasketAsset) => a.cls === 'stock' || a.cls === 'crypto';

/** Easiest to sell first: measured before a tier, then the larger capacity or ceiling, then by id. */
function easiestFirst(w: World, names: Name[]): Name[] {
  return [...names].sort((a, b) => {
    if ((a.measured === null) !== (b.measured === null)) return a.measured === null ? 1 : -1;
    const size = (n: Name) => n.measured ?? w.ceilingOf(n.asset);
    return size(b) - size(a) || (a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0);
  });
}

/**
 * Places one theme sleeve of `cents`, and returns what it holds by token. What it cannot place is
 * handed to `book.spill`, with its cause, for the caller to hold in dollar yield, then cash.
 * `reserve` is the lines kept for the goal sleeve's stocks, which come next (THEME-FIRST).
 */
export function placeThemeSleeve(
  w: World,
  book: Book,
  slug: string,
  shareBps: number,
  cents: number,
  reserve = 0,
): Map<string, number> {
  const { lang, P } = w;
  const held = new Map<string, number>();
  if (cents <= 0) return held;
  const list = w.themeListOf(slug);
  if (!list || list.status !== 'confirmed') {
    const theme = list ? list.name[lang] : slug;
    const why = reason(
      list ? 'THEME_NOT_CONFIRMED' : 'THEME_NO_LIST',
      { theme, chain: w.chain },
      lang,
    );
    w.flags.add(`theme_${list ? 'not_confirmed' : 'no_list'}:${slug}`);
    book.removed.push({ ref: slug, reasons: [why] });
    book.spill([theme], cents, why);
    return held;
  }
  const theme = list.name[lang];
  const out: Removed[] = [];
  /** Why each name the plan cannot hold is out, in the list's order by symbol. */
  const causes: Reason[] = [];
  const leave = (ref: string, why: Reason[], cause: Reason) => {
    out.push({ ref, reasons: why });
    causes.push(cause);
  };

  // ---- Eligible: on the chain, holdable, and able to take a line at this size.
  const found: Omit<Name, 'weight'>[] = [];
  for (const member of byName(list.members, (m) => m.symbol)) {
    // A theme holds stocks, crypto and gold: a dollar-yield or cash token is not one of its names.
    // Two tokens under one symbol are tried by id: the first the person can hold is the name's.
    const tokens = byName(
      w.tokens.filter((a) => a.symbol === member.symbol && w.sleeveOf(a) !== 'dollarYield'),
      (a) => a.id,
    );
    const asset = tokens.find((a) => w.blockOf(a) === null);
    if (!asset) {
      const first = tokens[0];
      const why =
        (first && w.blockOf(first)) ??
        reason('NOT_ON_CHAIN', { asset: member.symbol, chain: w.chain }, lang);
      leave(member.symbol, [why], why);
      continue;
    }
    if (w.ceilingOf(asset) < w.minLine) {
      const thin = reason(
        'THEME_TOO_THIN',
        { asset: member.symbol, theme, minUsd: toUsd(w.minLine) },
        lang,
      );
      leave(member.symbol, [thin, w.ceilingWhy(asset)], w.ceilingWhy(asset));
      continue;
    }
    found.push({ asset, member, measured: w.measuredUsdOf(asset) });
  }

  // ---- What the person already holds (DESIGN-VAULT section 7, as for the goal sleeve): each name's
  // target is its equal part of the sleeve grown by the plan's amount plus what is held, less what
  // is held of it. A name held in full takes nothing; the others take more for it.
  const base = Math.floor((cents * (w.amount + w.heldTotal)) / w.amount);
  const heldOf = (n: Omit<Name, 'weight'>) => w.held.get(n.asset.underlying) ?? 0;
  const touched = found.some((n) => heldOf(n) > 0);
  const able: Name[] = [];
  const heldSaid: Reason[] = [];
  const cut = new Map<string, Reason>();
  for (const n of found) {
    const h = heldOf(n);
    const weight = touched ? base - found.length * h : 1;
    const values = { asset: n.asset.underlying, heldUsd: toUsd(h) };
    if (h > 0) heldSaid.push(reason('MORE_BECAUSE_HELD', values, lang));
    if (weight <= 0) {
      const why = reason('ALREADY_HELD_NONE', values, lang);
      leave(n.member.symbol, [why], why);
      continue;
    }
    if (h > 0) cut.set(n.asset.id, reason('ALREADY_HELD', values, lang));
    able.push({ ...n, weight });
  }
  const ranked = easiestFirst(w, able);

  // ---- Lines, equal parts within each cap, an issuer's cap, and the least a new line can be.
  const lineOf = (a: BasketAsset) => book.lines.get(a.id)?.cents ?? 0;
  const ofUnderlying = (u: string) =>
    sum(
      [...book.lines.values()]
        .filter((l) => capped(l.asset) && l.asset.underlying === u)
        .map((l) => l.cents),
    );
  const capOf = (a: BasketAsset): { cents: number; why: Reason } => {
    const ceiling = { cents: w.ceilingOf(a) - lineOf(a), why: w.ceilingWhy(a) };
    if (!capped(a)) return ceiling;
    const stock = {
      cents: w.stockCap - ofUnderlying(a.underlying),
      why: reason(
        'SINGLE_STOCK_CAP',
        { asset: a.underlying, capBps: P.capPerStockBps[w.sheet.risk] ?? 0, risk: w.sheet.risk },
        lang,
      ),
    };
    return stock.cents < ceiling.cents ? stock : ceiling;
  };
  const dropped = new Map<string, Reason>();
  let chosen: Name[] = [];
  let noLine: Name[] = [];
  let takes: number[] = [];
  let limits: number[] = [];
  let whys: Reason[] = [];
  for (;;) {
    let free = P.maxLinesPerChain - book.lines.size - reserve;
    chosen = [];
    noLine = [];
    for (const n of ranked) {
      if (dropped.has(n.asset.id)) continue;
      if (book.lines.has(n.asset.id)) chosen.push(n);
      else if (free > 0) {
        free -= 1;
        chosen.push(n);
      } else noLine.push(n);
    }
    const caps = chosen.map((n) => capOf(n.asset));
    // A new line whose own limit (its exit ceiling, the cap on one stock) is under the least a line
    // can be is left out for that limit, before an issuer is read, and its line goes to the next.
    const cannot = chosen.filter(
      (n, i) => !book.lines.has(n.asset.id) && (caps[i]?.cents ?? 0) < w.minLine,
    );
    if (cannot.length > 0) {
      for (const n of cannot) dropped.set(n.asset.id, caps[chosen.indexOf(n)]?.why as Reason);
      continue;
    }
    limits = caps.map((c) => Math.max(0, c.cents));
    whys = caps.map((c) => c.why);
    // Equal parts within each name's own cap; then each issuer within its room, its names scaled
    // down together and held there while the others share again. The room is read per name: the cap
    // on stocks and crypto counts every sleeve of an issuer, the plan's cap only gold and the rest,
    // so an issuer with names of both kinds is two limits.
    const weights = chosen.map((n) => n.weight);
    const limitsOn = chosen.flatMap((n) => {
      const growth = w.sleeveOf(n.asset) === 'growth';
      return [
        {
          key: `${n.asset.issuer} all`,
          of: (m: Name) => m.asset.issuer === n.asset.issuer,
          when: growth,
        },
        {
          key: `${n.asset.issuer} outside`,
          of: (m: Name) => m.asset.issuer === n.asset.issuer && w.sleeveOf(m.asset) !== 'growth',
          when: !growth,
        },
      ]
        .filter((c) => c.when)
        .map((c) => ({ ...c, room: book.issuerRoom(n.asset), why: w.issuerWhy(n.asset) }));
    });
    const byKey = new Map(byName(limitsOn, (c) => c.key).map((c) => [c.key, c]));
    const fixed = new Set<string>();
    for (;;) {
      takes = equalCapped(cents, limits, weights);
      let scaled = false;
      for (const [key, c] of byKey) {
        if (fixed.has(key)) continue;
        const at = chosen.flatMap((n, i) => (c.of(n) ? [i] : []));
        const asked = at.map((i) => takes[i] ?? 0);
        if (sum(asked) <= c.room) continue;
        const shares = split(c.room, asked);
        at.forEach((i, k) => {
          limits[i] = Math.min(limits[i] ?? 0, shares[k] ?? 0);
          whys[i] = c.why;
        });
        fixed.add(key);
        scaled = true;
      }
      if (!scaled) break;
    }
    // A new line too small to be one: the last in the order is left out, and the rest share again.
    const short = chosen.filter(
      (n, i) => !book.lines.has(n.asset.id) && (takes[i] ?? 0) < w.minLine,
    );
    const last = short.at(-1);
    if (!last) break;
    const i = chosen.indexOf(last);
    const take = takes[i] ?? 0;
    dropped.set(
      last.asset.id,
      (limits[i] ?? 0) < w.minLine && (limits[i] ?? 0) <= take
        ? (whys[i] as Reason)
        : reason('BELOW_MINIMUM', { asset: last.asset.symbol, usd: toUsd(take) }, lang),
    );
  }

  // ---- What is left out, and why.
  for (const n of noLine) {
    const why = reason('MAX_LINES', { asset: n.asset.symbol, max: P.maxLinesPerChain }, lang);
    out.push({ ref: n.asset.symbol, reasons: [why] });
  }
  for (const n of ranked) {
    const why = dropped.get(n.asset.id);
    if (why) out.push({ ref: n.asset.symbol, reasons: [why] });
  }
  book.removed.push(...out);

  // ---- The lines.
  const placed = sum(takes);
  const top = Math.max(0, ...takes);
  const easiest =
    noLine.length > 0 ? [reason('THEME_EASIEST', { theme, count: chosen.length }, lang)] : [];
  const said = reason('THEME_SLEEVE', { shareBps, theme, chain: w.chain }, lang);
  let bound: Reason | null = null;
  chosen.forEach((n, i) => {
    const take = takes[i] ?? 0;
    // A name at its own limit, holding less than the others or leaving money over, says which.
    const atLimit = take >= (limits[i] ?? 0) && (take < top || placed < cents);
    if (atLimit && bound === null) bound = whys[i] ?? null;
    if (take <= 0) return;
    const member = reason(
      'THEME_MEMBER',
      {
        asset: n.asset.symbol,
        theme,
        chain: w.chain,
        version: list.version,
        curator: list.curator,
        why: n.member.reason[lang],
      },
      lang,
    );
    const less = cut.get(n.asset.id);
    const more = less ? [less] : heldSaid;
    book.put(n.asset, take, [
      said,
      member,
      ...easiest,
      ...more,
      ...(atLimit ? [whys[i] as Reason] : []),
    ]);
    held.set(n.asset.id, take);
  });

  // ---- What no name could take: handed back with the limit that kept it out.
  const left = cents - placed;
  if (left > 0) {
    const cause =
      bound ??
      (noLine[0]
        ? reason('MAX_LINES', { asset: noLine[0].asset.symbol, max: P.maxLinesPerChain }, lang)
        : (ranked.map((n) => dropped.get(n.asset.id)).find((r) => r !== undefined) ??
          causes[0] ??
          null));
    const names =
      chosen.length > 0 ? chosen.map((n) => n.asset.symbol) : list.members.map((m) => m.symbol);
    if (!cause) throw new Error(`the theme ${slug} left money over with no cause`);
    book.spill(names, left, cause);
  }
  if (held.size === 0) w.flags.add(`theme_empty:${slug}`);
  return held;
}
