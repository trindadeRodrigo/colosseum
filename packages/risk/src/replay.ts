import type { PoolEvent } from './events/logs';
import type { ClState, InitTick } from './pools/cl-math';

// Step 5b — exact concentrated-liquidity replay over decoded history.
// The liquidity layout (each initialised tick's net and gross liquidity) changes only through position
// events; swaps move price, current tick and active liquidity but never the layout. So the layout at an
// earlier slot is a later exact snapshot with the intervening liquidity events undone, and the price
// state at any slot is the post-state of the last event at or before it.

export type TickMap = Map<number, { net: bigint; gross: bigint }>;

export type ClSnapshot = {
  slot: number;
  sqrtPriceX64: bigint;
  tick: number;
  liquidity: bigint;
  ticks: TickMap;
};

/** A history row's position in time: slot, then the walk sequence (newest = 0) inside the slot. */
export type Ordered<T> = T & { slot: number; seq: number };

export type LiquidityChange = { tickLower: number; tickUpper: number; delta: bigint };

export function tickMapOf(ticks: readonly InitTick[]): TickMap {
  const m: TickMap = new Map();
  for (const t of ticks) {
    if (t.net === undefined || t.gross === undefined)
      throw new Error('tick without exact liquidity');
    if (t.net !== 0n || t.gross !== 0n) m.set(t.tick, { net: t.net, gross: t.gross });
  }
  return m;
}

const bump = (m: TickMap, tick: number, dNet: bigint, dGross: bigint) => {
  const cur = m.get(tick) ?? { net: 0n, gross: 0n };
  const next = { net: cur.net + dNet, gross: cur.gross + dGross };
  if (next.net === 0n && next.gross === 0n) m.delete(tick);
  else m.set(tick, next);
};

/** Apply (sign 1) or undo (sign -1) one position change. Gross moves by the signed delta at both ends. */
export function applyLiquidity(m: TickMap, c: LiquidityChange, sign: 1 | -1 = 1) {
  const d = c.delta * BigInt(sign);
  bump(m, c.tickLower, d, d);
  bump(m, c.tickUpper, -d, d);
}

/** Liquidity changes in a decoded row (CL venues), in emission order. */
export function liquidityChanges(events: readonly PoolEvent[]): LiquidityChange[] {
  const out: LiquidityChange[] = [];
  for (const e of events)
    if (
      e.kind === 'liquidity' &&
      e.tickLower !== undefined &&
      e.tickUpper !== undefined &&
      e.liquidityDelta !== undefined &&
      e.liquidityDelta !== '0'
    )
      out.push({ tickLower: e.tickLower, tickUpper: e.tickUpper, delta: BigInt(e.liquidityDelta) });
  return out;
}

/** Order rows oldest → newest: slot ascending, then walk sequence descending (the walk is newest first). */
export const chronological = <T extends { slot: number; seq: number }>(a: T, b: T) =>
  a.slot - b.slot || b.seq - a.seq;

/** Layout at `targetSlot`: undo every change with targetSlot < slot ≤ from.slot, newest first. */
export function rewind(
  from: TickMap,
  fromSlot: number,
  rows: ReadonlyArray<Ordered<{ events: readonly PoolEvent[] }>>,
  targetSlot: number,
): TickMap {
  const m: TickMap = new Map([...from].map(([k, v]) => [k, { ...v }]));
  const inWindow = rows
    .filter((r) => r.slot > targetSlot && r.slot <= fromSlot)
    .sort(chronological)
    .reverse();
  for (const r of inWindow)
    for (const c of liquidityChanges(r.events).reverse()) applyLiquidity(m, c, -1);
  return m;
}

export type TickMismatch = {
  tick: number;
  expected?: { net: bigint; gross: bigint };
  got?: { net: bigint; gross: bigint };
};

export function compareTickMaps(expected: TickMap, got: TickMap): TickMismatch[] {
  const out: TickMismatch[] = [];
  for (const t of new Set([...expected.keys(), ...got.keys()])) {
    const a = expected.get(t);
    const b = got.get(t);
    if (a?.net !== b?.net || a?.gross !== b?.gross) out.push({ tick: t, expected: a, got: b });
  }
  return out.sort((x, y) => x.tick - y.tick);
}

/** Active liquidity implied by a layout at `tick`: the sum of net liquidity of ticks ≤ tick. */
export function activeLiquidity(m: TickMap, tick: number): bigint {
  let l = 0n;
  for (const [t, v] of m) if (t <= tick) l += v.net;
  return l;
}

/** Post-trade state carried by an event, when it has one. */
export function postState(
  e: PoolEvent,
): { liquidity: bigint; tick: number; sqrtPriceX64?: bigint } | null {
  if (e.kind === 'swap' && e.liquidity !== undefined && e.tick !== undefined)
    return {
      liquidity: BigInt(e.liquidity),
      tick: e.tick,
      ...(e.sqrtPriceX64 ? { sqrtPriceX64: BigInt(e.sqrtPriceX64) } : {}),
    };
  if (e.kind === 'liquidity' && e.poolLiquidityAfter !== undefined && e.tick !== undefined)
    return { liquidity: BigInt(e.poolLiquidityAfter), tick: e.tick };
  return null;
}

export type ChainBreak = {
  slot: number;
  seq: number;
  signature?: string;
  expected: bigint;
  got: bigint;
};

/** Continuity of active liquidity along the event chain: each liquidity event's "before" must equal
 *  the previous event's post-state liquidity. A break means a missing or misdecoded event in between
 *  (a missing swap only shows if it crossed an initialised tick). */
export function chainBreaks(
  rows: ReadonlyArray<Ordered<{ events: readonly PoolEvent[]; signature?: string }>>,
): ChainBreak[] {
  const out: ChainBreak[] = [];
  let prev: bigint | undefined;
  for (const r of [...rows].sort(chronological))
    for (const e of r.events) {
      if (e.kind === 'liquidity' && e.poolLiquidityBefore !== undefined && prev !== undefined) {
        const before = BigInt(e.poolLiquidityBefore);
        if (before !== prev)
          out.push({
            slot: r.slot,
            seq: r.seq,
            signature: r.signature,
            expected: prev,
            got: before,
          });
      }
      const s = postState(e);
      if (s) prev = s.liquidity;
    }
  return out;
}

/** Tick index whose price is at or below a Q64.64 sqrt price (for venues whose events report price only). */
export function tickAtSqrtPriceX64(sqrtPriceX64: bigint): number {
  const p = (Number(sqrtPriceX64) / 2 ** 64) ** 2;
  let t = Math.floor(Math.log(p) / Math.log(1.0001));
  // correct float error at the boundary
  while (1.0001 ** (t + 1) <= p) t++;
  while (1.0001 ** t > p) t--;
  return t;
}

/** A simulator-ready state from an exact layout and a price point. Active liquidity comes from the layout. */
export function clStateFromLayout(
  layout: TickMap,
  price: { sqrtPriceX64: bigint; tick: number },
  feeRate: number,
): ClState {
  return {
    sqrtPrice: Number(price.sqrtPriceX64) / 2 ** 64,
    tickCurrent: price.tick,
    liquidity: Number(activeLiquidity(layout, price.tick)),
    feeRate,
    ticks: [...layout]
      .filter(([, v]) => v.net !== 0n)
      .map(([tick, v]) => ({ tick, liquidityNet: Number(v.net) }))
      .sort((a, b) => a.tick - b.tick),
  };
}

/** Moves a layout along a chronological list of liquidity rows: `to` is the number of rows applied. */
export class LayoutCursor {
  readonly layout: TickMap;
  constructor(
    anchor: TickMap,
    private readonly rows: ReadonlyArray<{ changes: LiquidityChange[] }>,
    private at: number,
  ) {
    this.layout = new Map([...anchor].map(([k, v]) => [k, { ...v }]));
  }
  moveTo(to: number) {
    while (this.at > to) {
      this.at--;
      for (const c of [...(this.rows[this.at]?.changes ?? [])].reverse())
        applyLiquidity(this.layout, c, -1);
    }
    while (this.at < to) {
      for (const c of this.rows[this.at]?.changes ?? []) applyLiquidity(this.layout, c, 1);
      this.at++;
    }
    return this.layout;
  }
}
