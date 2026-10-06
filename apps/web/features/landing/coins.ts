// The closing's coins (gate CLOSING-COINS, Thom, Oct 6): the assets a plan is made of, as round coins
// with their tickers, drifting loose around the heading and gathering, one by one, into one plan as the
// reader scrolls the section in. Everything here is worked out on the screen, in CSS pixels, from the
// reader's progress alone: the 3D scene (coins-scene.ts), the labels and the still drawing all draw
// from it, so they agree, and the tests read it without a GPU.
//
// The plan is a sample, not a recommendation: its weights are said to be sample on the page.

export type CoinKind = 'stocks' | 'treasuries' | 'credit' | 'gold';

export type Coin = {
  ticker: string;
  /** Its share of the sample plan, in basis points. */
  weightBps: number;
  kind: CoinKind;
};

/** The sample plan: stocks 45%, treasuries 25%, credit 20%, gold 10%. Tickers only: no logo. */
export const COINS: readonly Coin[] = [
  { ticker: 'SPY', weightBps: 1500, kind: 'stocks' },
  { ticker: 'USDY', weightBps: 1500, kind: 'treasuries' },
  { ticker: 'syrupUSDC', weightBps: 1200, kind: 'credit' },
  { ticker: 'QQQ', weightBps: 1000, kind: 'stocks' },
  { ticker: 'PAXG', weightBps: 1000, kind: 'gold' },
  { ticker: 'OUSG', weightBps: 1000, kind: 'treasuries' },
  { ticker: 'USDC', weightBps: 800, kind: 'credit' },
  { ticker: 'NVDA', weightBps: 800, kind: 'stocks' },
  { ticker: 'AAPL', weightBps: 700, kind: 'stocks' },
  { ticker: 'TSLA', weightBps: 500, kind: 'stocks' },
];

/** The ink of a coin's rim and ticker, by what it is: cream, the wood, or stone. */
export const TONE: Record<CoinKind, 'member' | 'wood' | 'stone'> = {
  stocks: 'member',
  treasuries: 'stone',
  credit: 'stone',
  gold: 'wood',
};

// --- the plan, packed ------------------------------------------------------------------------------

type Disc = { x: number; y: number; r: number };

/** A coin's radius in the packing's own units: its area is its weight. */
const radiusOf = (c: Coin) => Math.sqrt(c.weightBps / 10_000);
/** The gap between two coins of the packing, in its units. */
const GAP = 0.035;

/**
 * The coins packed into one round cluster about the origin, largest first, each placed as near the
 * middle as it can go without touching another. In the packing's units, then scaled to a radius of 1.
 */
export const PACKED: readonly Disc[] = (() => {
  const order = COINS.map((c, i) => ({ c, i })).sort((a, b) => radiusOf(b.c) - radiusOf(a.c));
  const placed: (Disc & { i: number })[] = [];
  for (const { c, i } of order) {
    const r = radiusOf(c);
    if (placed.length === 0) {
      placed.push({ x: 0, y: 0, r, i });
      continue;
    }
    let best: Disc | null = null;
    // touching each coin placed so far, all the way round: the spot nearest the middle that is free
    for (const p of placed)
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        const d = p.r + r + GAP;
        const x = p.x + Math.cos(a) * d;
        const y = p.y + Math.sin(a) * d;
        if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + r + GAP - 1e-9)) continue;
        if (!best || Math.hypot(x, y) < Math.hypot(best.x, best.y)) best = { x, y, r };
      }
    placed.push({ ...(best as Disc), i });
  }
  // centre the cluster on its own middle and scale it to a radius of 1
  const cx = placed.reduce((s, d) => s + d.x, 0) / placed.length;
  const cy = placed.reduce((s, d) => s + d.y, 0) / placed.length;
  const outer = Math.max(...placed.map((d) => Math.hypot(d.x - cx, d.y - cy) + d.r));
  const out: Disc[] = [];
  for (const d of placed)
    out[d.i] = { x: (d.x - cx) / outer, y: (d.y - cy) / outer, r: d.r / outer };
  return out;
})();

// --- the screen ------------------------------------------------------------------------------------

/** Under this width, or on a screen not wide enough for its height, the cluster stands above the words. */
export const NARROW = 960;
const MIN_ASPECT = 1.15;
export const isNarrow = (w: number, h: number) => w < NARROW || w / h < MIN_ASPECT;

/** Where the assembled cluster stands and how big it is, in CSS pixels. */
export function clusterFrame(w: number, h: number) {
  if (isNarrow(w, h)) {
    const radius = Math.min(w * 0.3, h * 0.16);
    return { cx: w / 2, cy: h * 0.06 + radius + 8, radius };
  }
  const radius = Math.min(w * 0.17, h * 0.3);
  return { cx: w * 0.73, cy: h * 0.5, radius };
}

/** Where each coin starts, loose: a spot on the screen as a share of it, a depth and a turn. */
const LOOSE: readonly { x: number; y: number; depth: number; turn: number }[] = [
  { x: 0.08, y: 0.16, depth: 0.85, turn: 0.4 },
  { x: 0.9, y: 0.12, depth: 1.1, turn: -0.6 },
  { x: 0.18, y: 0.84, depth: 0.7, turn: 0.9 },
  { x: 0.62, y: 0.08, depth: 0.9, turn: -0.3 },
  { x: 0.95, y: 0.6, depth: 0.75, turn: 0.7 },
  { x: 0.4, y: 0.92, depth: 1.05, turn: -0.8 },
  { x: 0.03, y: 0.5, depth: 0.8, turn: 0.5 },
  { x: 0.78, y: 0.9, depth: 0.95, turn: -0.45 },
  { x: 0.52, y: 0.04, depth: 0.65, turn: 0.65 },
  { x: 0.98, y: 0.34, depth: 0.88, turn: -0.7 },
];

/** The stretch of the reader's progress in which the coins gather, one after another. */
export const GATHER = { from: 0.12, to: 0.72 } as const;
/** Each coin's own stretch is this share of the gathering; they overlap a little. */
const EACH = 0.22;
/** The labels come once the plan is whole; the line under it last. */
export const LABELS = { from: 0.74, to: 0.82 } as const;
export const LINE = { from: 0.82, to: 0.92 } as const;

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
/** The brand's --ease-seat, cubic-bezier(0.2, 0, 0, 1), close enough: fast out, slow into place. */
const seat = (t: number) => 1 - (1 - t) ** 3;

/** The order the coins gather in: the plan's largest parts first. */
export const ORDER: readonly number[] = COINS.map((c, i) => ({ c, i }))
  .sort((a, b) => b.c.weightBps - a.c.weightBps || a.i - b.i)
  .map(({ i }) => i);

/** How far coin `i` has come home at progress p: 0 loose, 1 in its place in the plan. */
export function gathered(i: number, p: number): number {
  const slot = ORDER.indexOf(i);
  const step = (GATHER.to - GATHER.from - EACH) / Math.max(1, COINS.length - 1);
  const from = GATHER.from + slot * step;
  return seat(span(p, from, from + EACH));
}

export type CoinAt = {
  /** Its centre on the screen, in CSS pixels. */
  x: number;
  y: number;
  /** Its radius on the screen, in CSS pixels. */
  r: number;
  /** How far it leans away from facing the reader: 0 flat to the screen, its turn when loose. */
  tilt: number;
  /** 0 loose, 1 home. */
  home: number;
};

/** Every coin on a screen of w × h at progress p, from loose around the words to packed beside them. */
export function coinsAt(p: number, w: number, h: number): CoinAt[] {
  const f = clusterFrame(w, h);
  const looseR = Math.min(w, h) * 0.045;
  return COINS.map((_, i) => {
    const d = PACKED[i] as Disc;
    const l = LOOSE[i] as (typeof LOOSE)[number];
    const t = gathered(i, p);
    // loose, each drifts a little as the reader scrolls, and turns slowly
    const drift = (1 - t) * p * 0.06;
    const lx = (l.x + Math.sin(i * 1.7) * drift) * w;
    const ly = (l.y - drift) * h;
    const hx = f.cx + d.x * f.radius;
    const hy = f.cy + d.y * f.radius;
    const homeR = d.r * f.radius;
    return {
      x: lx + (hx - lx) * t,
      y: ly + (hy - ly) * t,
      r: looseR * l.depth + (homeR - looseR * l.depth) * t,
      tilt: (1 - t) * (l.turn + p * 1.2 * (l.turn < 0 ? -1 : 1)),
      home: t,
    };
  });
}

/** How far the labels and the line under the plan have come in, 0 to 1. */
export const labelsAt = (p: number) => span(p, LABELS.from, LABELS.to);
export const lineAt = (p: number) => span(p, LINE.from, LINE.to);

/** "SPY · 15%": a coin's label once the plan is whole. */
export const labelOf = (c: Coin, pct: (bps: number) => string) =>
  `${c.ticker} · ${pct(c.weightBps)}`;

/** The closing's progress from where its track is: 0 as it comes up, 1 once its sticky screen has gone. */
export function closingProgress(trackTop: number, trackHeight: number, viewport: number): number {
  if (!(trackHeight > 0) || !(viewport > 0)) return 1;
  return clamp((viewport - trackTop) / trackHeight);
}
