import type { BasketAsset, Reason } from '@colosseum/schemas';
import { toUsd } from './money';
import { reason } from './templates';
import type { World } from './world';

// Placement: which token carries each exposure, on the person's chain. A plan lives on one chain, so
// there is no choice of chain here. A token takes dollars up to its ceiling (its tier on the shelf,
// and its measured exit capacity), an issuer up to its cap, and the plan up to its number of lines.
// What a token cannot take is handed back to the caller, which holds it in dollar yield, then cash.

/** A sized exposure waiting for a token: so many cents of one underlying, with why. */
export type Unit = { name: string; cents: number; reasons: Reason[] };

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

export type Fill = { left: number; placed: boolean; why: Reason[] };

/** The plan as it is being placed: lines by token, and what is used of each issuer. */
export class Book {
  readonly lines = new Map<string, PlacedLine>();
  readonly removed: Removed[] = [];
  /** What an exposure could not take, waiting to be held in dollar yield. */
  readonly overflow = { cents: 0, reasons: [] as Reason[] };
  readonly cash = { cents: 0, reasons: [] as Reason[] };
  private readonly withIssuer = new Map<string, number>();

  constructor(private readonly w: World) {}

  /** How many more cents a token takes, and the limit that stops it there. */
  room(asset: BasketAsset): { cents: number; why: Reason } {
    const { w } = this;
    const ceiling = w.ceilingOf(asset);
    const underCeiling = ceiling - (this.lines.get(asset.id)?.cents ?? 0);
    const underIssuerCap = w.issuerCap - (this.withIssuer.get(asset.issuer) ?? 0);
    if (underIssuerCap < underCeiling)
      return {
        cents: Math.max(0, underIssuerCap),
        why: reason(
          'ISSUER_CAP',
          {
            capBps: w.P.capPerIssuerBps[w.sheet.risk] ?? 0,
            risk: w.sheet.risk,
            issuer: asset.issuer,
          },
          w.lang,
        ),
      };
    return {
      cents: Math.max(0, underCeiling),
      why: reason('EXIT_CEILING', { asset: asset.symbol, maxUsd: toUsd(ceiling) }, w.lang),
    };
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
  }

  /**
   * Whether the plan can take a shared portfolio whole, each part at its own size: null when it can,
   * and the first limit in the way when it cannot.
   */
  wholeFits(name: string, parts: { asset: BasketAsset; cents: number }[]): Reason | null {
    const { w } = this;
    if (parts.length === 0) return reason('BELOW_MINIMUM', { asset: name, usd: 0 }, w.lang);
    const fresh = parts.filter((p) => !this.lines.has(p.asset.id)).length;
    if (this.lines.size + fresh > w.P.maxLinesPerChain)
      return reason('MAX_LINES', { asset: name, max: w.P.maxLinesPerChain }, w.lang);
    const asked = new Map<string, number>();
    for (const p of parts) {
      if (p.cents < w.minLine)
        return reason('BELOW_MINIMUM', { asset: p.asset.symbol, usd: toUsd(p.cents) }, w.lang);
      const room = this.room(p.asset);
      const ofIssuer = (asked.get(p.asset.issuer) ?? 0) + p.cents;
      asked.set(p.asset.issuer, ofIssuer);
      if (ofIssuer > w.issuerCap - (this.withIssuer.get(p.asset.issuer) ?? 0))
        return reason(
          'ISSUER_CAP',
          {
            capBps: w.P.capPerIssuerBps[w.sheet.risk] ?? 0,
            risk: w.sheet.risk,
            issuer: p.asset.issuer,
          },
          w.lang,
        );
      if (p.cents > room.cents) return room.why;
    }
    return null;
  }

  /**
   * Places a unit on the tokens that can take it, in the order given. A token the person cannot hold
   * is passed over. Returns what is left, whether anything was placed, and why not all of it.
   */
  fill(unit: Unit, candidates: BasketAsset[], tag: (asset: BasketAsset) => Reason[]): Fill {
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
    if (left > 0 && tooSmall)
      why.push(reason('BELOW_MINIMUM', { asset: unit.name, usd: toUsd(left) }, w.lang));
    return { left, placed, why: once(why) };
  }

  /** Places a unit of stocks, crypto or gold; what no token takes waits to be held in dollar yield. */
  place(unit: Unit, candidates: BasketAsset[]): void {
    const { w } = this;
    if (unit.cents <= 0) return;
    const { left, placed, why } = this.fill(unit, candidates, () => []);
    if (left <= 0) return;
    const notHere = reason('NOT_ON_CHAIN', { asset: unit.name, chain: w.chain }, w.lang);
    if (!placed) this.removed.push({ ref: unit.name, reasons: why.length > 0 ? why : [notHere] });
    this.spill(unit.name, left);
  }

  /** Hands cents that found no token to the dollar-yield sleeve, with what they were meant for. */
  spill(name: string, cents: number): void {
    if (cents <= 0) return;
    this.overflow.cents += cents;
    this.overflow.reasons.push(reason('OVERFLOW', { asset: name, usd: toUsd(cents) }, this.w.lang));
  }
}
