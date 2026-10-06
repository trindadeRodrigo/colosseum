import type { BasketAsset, Reason } from '@colosseum/schemas';
import { bandedFill, rank } from './fill';
import { largestFirst, split, sum, toUsd } from './money';
import { type RuleId, reason } from './templates';
import type { World } from './world';

// Placement: which token carries each exposure, on the person's chain. A plan lives on one chain, so
// there is no choice of chain here. A token takes dollars up to its ceiling (from its measured exit
// capacity, or from its tier where none is measured), an issuer up to its cap, and the plan up to its
// number of lines.
// What a token cannot take is handed back to the caller, which holds it in dollar yield, then cash.
//
// Where an issuer has no room for all that is asked of its tokens, each exposure gives in proportion,
// so a shared portfolio keeps its shape. The order things are tried in is fixed: the largest share
// first as the sleeves gave it, before any holding or cap moved it, and ties by name. So neither the
// order a shelf lists a portfolio in, nor a small holding, decides which names are held.

/** Cents waiting for a token, with why they are there. */
export type Sized = { cents: number; reasons: Reason[] };
/**
 * A sized exposure waiting for a token: so many cents of one underlying, by its ticker. `asked` is
 * what the sleeve gave it before holdings and caps moved it: the order units are tried in.
 */
export type Unit = Sized & { name: string; asked: number };

export type PlacedLine = {
  asset: BasketAsset;
  cents: number;
  reasons: Reason[];
  /** Of `cents`, what is held as a followed shared portfolio publishes it, by slug. */
  via: Map<string, number>;
};

export type Removed = { ref: string; reasons: Reason[] };

/** One of each reason: the same rule with the same values is said once. */
export function once(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.rule} ${JSON.stringify(r.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What a fill left over: how much, whether any was placed, the limits met, and whether what is left is too small for a line of its own. */
export type Fill = { left: number; placed: boolean; why: Reason[]; tooSmall: boolean };

/** The sentence for money held elsewhere, by the rule that kept it out of where it was meant to go. */
const OVERFLOW_FOR: Partial<Record<string, RuleId>> = {
  EXIT_CEILING: 'OVERFLOW_CEILING',
  TIER_CEILING: 'OVERFLOW_CEILING',
  ISSUER_CAP: 'OVERFLOW_ISSUER',
  ISSUER_CAP_PLAN: 'OVERFLOW_ISSUER_PLAN',
  MAX_LINES: 'OVERFLOW_MAX_LINES',
  BELOW_MINIMUM: 'OVERFLOW_TOO_SMALL',
  NOT_ON_CHAIN: 'OVERFLOW_NOT_ON_CHAIN',
  EXCLUDED: 'OVERFLOW_EXCLUDED',
  NOT_FOR_GOAL: 'OVERFLOW_NOT_FOR_GOAL',
  SINGLE_STOCK_CAP: 'OVERFLOW_STOCK_CAP',
  ALREADY_HELD_NONE: 'OVERFLOW_HELD',
};

/** Basis points in one whole: a yield band of 0.005 is 50. */
const BPS_OF_ONE = 10_000;

const keyOf = (r: Reason) => `${r.rule} ${JSON.stringify(r.params)}`;

/** The plan as it is being placed: lines by token, and what is used of each issuer. */
export class Book {
  readonly lines = new Map<string, PlacedLine>();
  readonly removed: Removed[] = [];
  /** What an exposure could not take, waiting to be held in dollar yield: by what kept it out. */
  private readonly spilled = new Map<
    string,
    { cents: number; names: Set<string>; cause: Reason }
  >();
  readonly cash = { cents: 0, reasons: [] as Reason[] };
  private readonly withIssuer = new Map<string, number>();
  /** The same, counting dollar yield, gold and cash only: what the plan's issuer cap reads (Rodrigo, Oct 5). */
  private readonly withIssuerOutsideGrowth = new Map<string, number>();

  /** What is already with this token's issuer, as the cap for its sleeve counts it. */
  private usedOf(asset: BasketAsset): number {
    const counted =
      this.w.sleeveOf(asset) === 'growth' ? this.withIssuer : this.withIssuerOutsideGrowth;
    return counted.get(asset.issuer) ?? 0;
  }

  constructor(private readonly w: World) {}

  /** How many more cents a token takes, and the limit that stops it there. */
  room(asset: BasketAsset): { cents: number; why: Reason } {
    const { w } = this;
    const ceiling = w.ceilingOf(asset);
    const underCeiling = ceiling - (this.lines.get(asset.id)?.cents ?? 0);
    const underIssuerCap = w.issuerCapOf(asset) - this.usedOf(asset);
    if (underIssuerCap < underCeiling)
      return { cents: Math.max(0, underIssuerCap), why: this.issuerWhy(asset) };
    return { cents: Math.max(0, underCeiling), why: w.ceilingWhy(asset) };
  }

  /** Why an issuer takes no more: the most of a plan one issuer may hold, at the person's risk. */
  private issuerWhy(asset: BasketAsset): Reason {
    return this.w.issuerWhy(asset);
  }

  /** The reason a token gets no line of its own when the plan is full, or null when it may. */
  private noLineLeft(asset: BasketAsset): Reason | null {
    const { w } = this;
    if (this.lines.has(asset.id) || this.lines.size < w.P.maxLinesPerChain) return null;
    return reason('MAX_LINES', { asset: asset.symbol, max: w.P.maxLinesPerChain }, w.lang);
  }

  put(asset: BasketAsset, cents: number, reasons: Reason[], via?: string): void {
    const line: PlacedLine = this.lines.get(asset.id) ?? {
      asset,
      cents: 0,
      reasons: [],
      via: new Map(),
    };
    line.cents += cents;
    line.reasons.push(...reasons);
    if (via !== undefined) line.via.set(via, (line.via.get(via) ?? 0) + cents);
    this.lines.set(asset.id, line);
    this.withIssuer.set(asset.issuer, (this.withIssuer.get(asset.issuer) ?? 0) + cents);
    if (this.w.sleeveOf(asset) !== 'growth')
      this.withIssuerOutsideGrowth.set(
        asset.issuer,
        (this.withIssuerOutsideGrowth.get(asset.issuer) ?? 0) + cents,
      );
    if (this.w.sleeveOf(asset) === 'dollarYield' && this.w.isCredit(asset))
      this.creditUsed += cents;
  }

  /** Cents placed in credit and basis legs so far. */
  private creditUsed = 0;
  /** Dollar-yield tokens already listed in `removed`, so a second fill does not list them again. */
  private readonly yieldRemoved = new Set<string>();

  /**
   * Places a unit on dollar-yield tokens by the banded fill (gate SOLVER): ranked by yield after
   * haircut, yields within the band share equally, each token up to its own cap, its issuer's and
   * the credit budget. A token with no yield reading, or whose kind of yield is not listed, is left
   * out with why. Returns what is left, as `fill` does.
   */
  fillBanded(unit: Sized, candidates: BasketAsset[]): Fill {
    const { w } = this;
    const why: Reason[] = [];
    const leave = (asset: BasketAsset, because: Reason) => {
      if (this.yieldRemoved.has(asset.id)) return;
      this.yieldRemoved.add(asset.id);
      this.removed.push({ ref: asset.symbol, reasons: [because] });
    };
    const able: { asset: BasketAsset; yield: number; cap: { cents: number; why: Reason } }[] = [];
    for (const asset of [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const blocked = w.blockOf(asset);
      if (blocked) {
        why.push(blocked);
        continue;
      }
      const cap = w.yieldCapOf(asset);
      if (!cap) {
        leave(asset, reason('NO_LEG_TYPE', { asset: asset.symbol }, w.lang));
        continue;
      }
      const read = w.yields.get(asset.id);
      if (!read) {
        leave(asset, reason('NO_YIELD', { asset: asset.symbol }, w.lang));
        continue;
      }
      able.push({ asset, yield: read.haircutYield, cap });
    }
    const ranked = rank(able.map((a) => ({ ...a, id: a.asset.id })));
    type Able = (typeof ranked)[number];
    const held = (a: BasketAsset) => this.lines.get(a.id)?.cents ?? 0;
    const issuerKey = (a: BasketAsset) => `issuer:${a.issuer}`;
    const creditWhy = (a: BasketAsset) =>
      reason(
        w.creditBudget.byPlan
          ? 'CREDIT_BUDGET_PLAN'
          : w.creditBudget.fromMix
            ? 'CREDIT_BUDGET_MIX'
            : w.creditBudget.stated
              ? 'CREDIT_BUDGET'
              : 'CREDIT_BUDGET_UNSAID',
        { capBps: w.creditBudget.bps },
        w.lang,
      );
    /** The limit that leaves a token no room at all, or null when it can take something. */
    const full = (a: Able): Reason | null => {
      if (a.cap.cents - held(a.asset) <= 0) return a.cap.why;
      if (w.issuerCapOf(a.asset) - this.usedOf(a.asset) <= 0) return this.issuerWhy(a.asset);
      if (w.isCredit(a.asset) && w.creditBudget.cents - this.creditUsed <= 0)
        return w.creditBudget.bps === 0 && w.creditBudget.byPlan
          ? reason('CREDIT_NONE_PLAN', { asset: a.asset.symbol }, w.lang)
          : w.creditBudget.bps === 0 && w.creditBudget.fromMix
            ? reason('CREDIT_NONE_MIX', { asset: a.asset.symbol }, w.lang)
            : w.creditBudget.bps === 0 && w.creditBudget.stated
              ? reason('CREDIT_NONE', { asset: a.asset.symbol }, w.lang)
              : creditWhy(a.asset);
      return null;
    };
    // A token with no room takes no line, and the limit that stops it is said.
    const open = ranked.filter((a) => {
      const stop = full(a);
      if (!stop) return true;
      why.push(stop);
      if (
        stop.rule === 'CREDIT_NONE' ||
        stop.rule === 'CREDIT_NONE_PLAN' ||
        stop.rule === 'CREDIT_NONE_MIX'
      )
        leave(a.asset, stop);
      return false;
    });
    const dropped = new Set<string>();
    const droppedSmall = new Set<string>();
    for (;;) {
      // Lines: a token already in the plan keeps its line; new ones take the lines left, in rank order.
      let free = w.P.maxLinesPerChain - this.lines.size;
      const noLine: Reason[] = [];
      const live = open.filter((a) => {
        if (dropped.has(a.id)) return false;
        if (this.lines.has(a.id)) return true;
        if (free > 0) {
          free -= 1;
          return true;
        }
        noLine.push(
          reason('MAX_LINES', { asset: a.asset.symbol, max: w.P.maxLinesPerChain }, w.lang),
        );
        return false;
      });
      const groupRoom: Record<string, number> = { credit: w.creditBudget.cents - this.creditUsed };
      for (const a of live)
        groupRoom[issuerKey(a.asset)] = w.issuerCapOf(a.asset) - this.usedOf(a.asset);
      const result = bandedFill({
        amount: unit.cents,
        band: w.P.yieldBand,
        groupRoom,
        items: live.map((a) => ({
          id: a.id,
          yield: a.yield,
          room: a.cap.cents - held(a.asset),
          groups: [issuerKey(a.asset), ...(w.isCredit(a.asset) ? ['credit'] : [])],
        })),
      });
      // A new line has a least size: the lowest-ranked one short of it is left out, its line goes
      // to the next token, and the rest fill again.
      const short = live.filter((a) => {
        const take = result.take.get(a.id) ?? 0;
        return !this.lines.has(a.id) && take > 0 && take < w.minLine;
      });
      const last = short.at(-1);
      if (last) {
        dropped.add(last.id);
        droppedSmall.add(last.id);
        continue;
      }
      // A new line that took nothing (a higher token used up its issuer or the credit budget) is
      // handed to a token left without one.
      const idle = noLine.length
        ? live.filter((a) => !this.lines.has(a.id) && (result.take.get(a.id) ?? 0) === 0).at(-1)
        : undefined;
      if (idle) {
        dropped.add(idle.id);
        continue;
      }
      why.push(...noLine);
      const whyBound = (a: (typeof live)[number]): Reason | null => {
        const b = result.bound.get(a.id);
        if (!b) return null;
        if (b.by === 'own') return a.cap.why;
        if (b.group === 'credit') return creditWhy(a.asset);
        return this.issuerWhy(a.asset);
      };
      const byYield = reason('BY_YIELD', { chain: w.chain }, w.lang);
      const takers = live.filter((a) => (result.take.get(a.id) ?? 0) > 0);
      for (const band of result.bands) {
        const inBand = takers.filter((a) => band.includes(a.id));
        const assets = inBand.map((a) => a.asset.symbol).join(',');
        // Spread puts every token in one band: the plan shares evenly by choice, not by yield.
        const shared =
          inBand.length > 1
            ? [
                w.candidate === 'spread' && w.P.candidates.spread.equalFill
                  ? reason('SHARED_EVENLY', { assets }, w.lang)
                  : reason(
                      'SHARED_IN_BAND',
                      { bandBps: Math.round(w.P.yieldBand * BPS_OF_ONE), assets },
                      w.lang,
                    ),
              ]
            : [];
        for (const a of inBand) {
          const bound = whyBound(a);
          // Shared evenly, a token is not there by its yield: that reason is left off.
          const ranks =
            w.candidate === 'spread' && w.P.candidates.spread.equalFill && shared.length > 0
              ? []
              : [byYield];
          const reasons = [...unit.reasons, ...ranks, ...shared, ...(bound ? [bound] : [])];
          this.put(a.asset, result.take.get(a.id) ?? 0, reasons);
        }
      }
      if (result.left > 0)
        for (const a of live) {
          const bound = whyBound(a);
          if (bound) why.push(bound);
        }
      return {
        left: result.left,
        placed: takers.length > 0,
        why: once(why),
        // Too small only when nothing but the least line size kept the money out.
        tooSmall: result.left > 0 && droppedSmall.size > 0 && live.length === 0,
      };
    }
  }

  /**
   * Places a unit on dollar-yield tokens in the order given, each up to the least of its cap in the
   * plan, its exit ceiling and its issuer's room: what is set aside for withdrawals goes to the most
   * liquid first. A token with no leg type or no yield reading is passed over; the banded fill that
   * comes after says why.
   */
  fillInOrder(unit: Sized, candidates: BasketAsset[]): Fill {
    const { w } = this;
    let left = unit.cents;
    let placed = false;
    const why: Reason[] = [];
    for (const asset of candidates) {
      if (left <= 0) break;
      const blocked = w.blockOf(asset) ?? this.noLineLeft(asset);
      if (blocked) {
        why.push(blocked);
        continue;
      }
      const cap = w.yieldCapOf(asset);
      if (!cap || !w.yields.has(asset.id)) continue;
      const room = this.room(asset);
      const own = cap.cents - (this.lines.get(asset.id)?.cents ?? 0);
      const limit = own < room.cents ? { cents: Math.max(0, own), why: cap.why } : room;
      const take = Math.min(left, limit.cents);
      // A new line has a least size; a line already there takes any amount.
      const least = this.lines.has(asset.id) ? 1 : w.minLine;
      // Too small for a line: it takes nothing, and its limit is not what kept the money out.
      if (take < least) continue;
      const reasons = [...unit.reasons];
      if (take < left) {
        reasons.push(limit.why);
        why.push(limit.why);
      }
      this.put(asset, take, reasons);
      left -= take;
      placed = true;
    }
    return { left, placed, why: once(why), tooSmall: false };
  }

  /**
   * Moves cents of a line to cash, as the coverage check does: the line keeps its reasons and gains
   * `because`. What its issuer and the credit budget count goes down with it.
   */
  toCash(assetId: string, cents: number, because: Reason): void {
    const line = this.lines.get(assetId);
    if (!line || cents <= 0) return;
    const moved = Math.min(cents, line.cents);
    line.cents -= moved;
    line.reasons.push(because);
    // A line held through a shared portfolio gives from what is through it last.
    // What is through a portfolio is never more than the line it is part of.
    let owed = Math.max(0, sum([...line.via.values()]) - line.cents);
    for (const [slug, through] of [...line.via.entries()].sort(([a], [b]) => (a < b ? 1 : -1))) {
      if (owed <= 0) break;
      const cut = Math.min(through, owed);
      line.via.set(slug, through - cut);
      owed -= cut;
    }
    const { asset } = line;
    this.withIssuer.set(asset.issuer, (this.withIssuer.get(asset.issuer) ?? 0) - moved);
    if (this.w.sleeveOf(asset) !== 'growth')
      this.withIssuerOutsideGrowth.set(
        asset.issuer,
        (this.withIssuerOutsideGrowth.get(asset.issuer) ?? 0) - moved,
      );
    if (this.w.sleeveOf(asset) === 'dollarYield' && this.w.isCredit(asset))
      this.creditUsed -= moved;
    this.cash.cents += moved;
  }

  /**
   * Whether the plan can take a shared portfolio whole, each part at its own size: null when it can,
   * and the first limit in the way when it cannot, as a fact about the portfolio.
   */
  wholeFits(theme: string, parts: { asset: BasketAsset; cents: number }[]): Reason | null {
    const { w } = this;
    const max = w.P.maxLinesPerChain;
    const would = this.lines.size + parts.filter((p) => !this.lines.has(p.asset.id)).length;
    if (would > max) return reason('NOT_WHOLE_PARTS', { theme, max, would }, w.lang);
    const asked = new Map<string, number>();
    for (const p of parts) {
      const asset = p.asset.symbol;
      if (p.cents < w.minLine)
        return reason('NOT_WHOLE_SMALL', { theme, asset, usd: toUsd(p.cents) }, w.lang);
      const ofIssuer = (asked.get(p.asset.issuer) ?? 0) + p.cents;
      asked.set(p.asset.issuer, ofIssuer);
      if (ofIssuer > w.issuerCapOf(p.asset) - this.usedOf(p.asset))
        return w.sleeveOf(p.asset) === 'growth'
          ? reason(
              'NOT_WHOLE_ISSUER',
              {
                theme,
                capBps: w.P.capPerIssuerBps[w.sheet.risk] ?? 0,
                risk: w.sheet.risk,
                issuer: p.asset.issuer,
              },
              w.lang,
            )
          : reason(
              'NOT_WHOLE_ISSUER_PLAN',
              { theme, capBps: w.P.issuerCapBps, issuer: p.asset.issuer },
              w.lang,
            );
      const ceiling = w.ceilingOf(p.asset);
      if (p.cents > ceiling - (this.lines.get(p.asset.id)?.cents ?? 0))
        return reason('NOT_WHOLE_CEILING', { theme, asset, maxUsd: toUsd(ceiling) }, w.lang);
    }
    return null;
  }

  /**
   * Places a unit on the tokens that can take it, in the order given. A token the person cannot hold
   * is passed over. Returns what is left, whether anything was placed, and why not all of it.
   */
  fill(unit: Sized, candidates: BasketAsset[], tag: (asset: BasketAsset) => Reason[]): Fill {
    const { w } = this;
    let left = unit.cents;
    let placed = false;
    let tooSmall = false;
    const why: Reason[] = [];
    for (const asset of candidates) {
      if (left <= 0) break;
      const blocked = w.blockOf(asset) ?? this.noLineLeft(asset);
      if (blocked) {
        why.push(blocked);
        continue;
      }
      const room = this.room(asset);
      const take = Math.min(left, room.cents);
      // A new line has a least size; a line already there takes any amount.
      const least = this.lines.has(asset.id) ? 1 : w.minLine;
      if (take < least) {
        if (room.cents < left) why.push(room.why);
        else tooSmall = true;
        continue;
      }
      const reasons = [...unit.reasons, ...why, ...tag(asset)];
      if (take < left) {
        reasons.push(room.why);
        why.push(room.why);
      }
      this.put(asset, take, reasons);
      left -= take;
      placed = true;
    }
    return { left, placed, why: once(why), tooSmall: left > 0 && tooSmall };
  }

  /**
   * Places the units of one sleeve (gold, or stocks and crypto) together. Each goes to the first
   * token of its underlying the person can hold. What a unit does not get waits to be held in dollar
   * yield, with what kept it out.
   *
   * 1. Lines: in the fixed order, a unit whose token has no line yet takes one of the lines left.
   * 2. Each unit asks for its cents, up to the room under its token's own ceiling.
   * 3. Where an issuer has no room for all its units ask, each gets its share in proportion.
   * 4. A unit left with less than the least a line can be is left out, the last in the order first,
   *    and the rest share again.
   */
  placeTogether(units: Unit[], candidatesOf: (unit: Unit) => BasketAsset[]): void {
    const { w } = this;
    const ordered = largestFirst(
      units.filter((u) => u.cents > 0),
      (u) => u.asked,
      (u) => u.name,
    );
    const tokens = new Map<Unit, BasketAsset>();
    for (const u of ordered) {
      const candidates = candidatesOf(u);
      const token = candidates.find((a) => w.blockOf(a) === null);
      if (token) {
        tokens.set(u, token);
        continue;
      }
      // No token of this underlying can be held: left out, with why.
      const blocks = once(candidates.flatMap((a) => w.blockOf(a) ?? []));
      const notHere = reason('NOT_ON_CHAIN', { asset: u.name, chain: w.chain }, w.lang);
      const why = blocks.length > 0 ? blocks : [notHere];
      this.removed.push({ ref: u.name, reasons: why });
      this.spill([u.name], u.cents, why[0] ?? notHere);
    }
    const able = ordered.filter((u) => tokens.has(u));
    const tokenOf = (u: Unit) => tokens.get(u) as BasketAsset;
    const hasLine = (u: Unit) => this.lines.has(tokenOf(u).id);
    const askOf = (u: Unit) =>
      Math.min(
        u.cents,
        Math.max(0, w.ceilingOf(tokenOf(u)) - (this.lines.get(tokenOf(u).id)?.cents ?? 0)),
      );

    const tooSmall = new Map<Unit, Reason>();
    let noLine = new Set<Unit>();
    let takes = new Map<Unit, number>();
    for (;;) {
      // 1. Lines.
      noLine = new Set();
      let free = w.P.maxLinesPerChain - this.lines.size;
      const live = able.filter((u) => {
        if (tooSmall.has(u)) return false;
        if (hasLine(u)) return true;
        free -= 1;
        if (free < 0) noLine.add(u);
        return free >= 0;
      });
      // 2 and 3. What each asks, and its share where its issuer is short of room.
      takes = new Map();
      const issuers = [...new Set(live.map((u) => tokenOf(u).issuer))];
      for (const issuer of issuers) {
        const group = live.filter((u) => tokenOf(u).issuer === issuer);
        const asks = group.map(askOf);
        const first = group[0];
        const room = first
          ? Math.max(0, w.issuerCapOf(tokenOf(first)) - this.usedOf(tokenOf(first)))
          : 0;
        const shares = sum(asks) > room ? split(room, asks) : asks;
        group.forEach((u, i) => {
          takes.set(u, shares[i] ?? 0);
        });
      }
      // 4. The least a new line can be.
      const short = live.filter((u) => !hasLine(u) && (takes.get(u) ?? 0) < w.minLine);
      const last = short.at(-1);
      if (!last) break;
      const token = tokenOf(last);
      tooSmall.set(
        last,
        last.cents < w.minLine
          ? reason('BELOW_MINIMUM', { asset: last.name, usd: toUsd(last.cents) }, w.lang)
          : askOf(last) < w.minLine
            ? w.ceilingWhy(token)
            : this.issuerWhy(token),
      );
    }

    const over: { unit: Unit; cents: number }[] = [];
    for (const u of able) {
      const token = tokenOf(u);
      const small = tooSmall.get(u);
      const out = small ?? (noLine.has(u) ? this.noLineLeft(token) : null);
      if (out) {
        this.removed.push({ ref: u.name, reasons: [out] });
        this.spill([u.name], u.cents, out);
        continue;
      }
      const ask = askOf(u);
      const take = takes.get(u) ?? 0;
      const reasons = [...u.reasons];
      if (ask < u.cents) reasons.push(w.ceilingWhy(token));
      if (take < ask) reasons.push(this.issuerWhy(token));
      if (take > 0) this.put(token, take, reasons);
      this.spill([u.name], ask - take, this.issuerWhy(token));
      if (u.cents > ask) over.push({ unit: u, cents: u.cents - ask });
    }
    // What is over a token's own ceiling may go to another token of the same underlying.
    for (const { unit, cents } of over) {
      const token = tokenOf(unit);
      const others = candidatesOf(unit).filter((a) => a.id !== token.id);
      const { left } = this.fill({ cents, reasons: unit.reasons }, others, () => []);
      this.spill([unit.name], left, w.ceilingWhy(token));
    }
  }

  /** Hands cents that found no token to the dollar-yield sleeve, with what kept them out. */
  spill(names: string[], cents: number, cause: Reason): void {
    if (cents <= 0) return;
    const entry = this.spilled.get(keyOf(cause)) ?? { cents: 0, names: new Set(), cause };
    entry.cents += cents;
    for (const name of names) entry.names.add(name);
    this.spilled.set(keyOf(cause), entry);
  }

  /**
   * What is waiting to be held in dollar yield, with one reason for each thing that kept money out of
   * where it was meant to go: how much, meant for what, and the real cause.
   */
  overflow(): Sized {
    const { w } = this;
    const entries = [...this.spilled.values()];
    return {
      cents: sum(entries.map((e) => e.cents)),
      reasons: entries.map(({ cents, names, cause }) => {
        const rule = OVERFLOW_FOR[cause.rule];
        if (!rule) throw new Error(`no sentence for money kept out by ${cause.rule}`);
        const assets = [...names].sort().join(',');
        return reason(rule, { ...cause.params, usd: toUsd(cents), assets }, w.lang);
      }),
    };
  }
}
