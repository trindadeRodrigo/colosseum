import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import {
  COINS,
  closingProgress,
  clusterFrame,
  coinsAt,
  GATHER,
  gathered,
  isNarrow,
  LABELS,
  LINE,
  labelOf,
  labelsAt,
  lineAt,
  ORDER,
  PACKED,
} from './coins';

// The closing's coins (gate CLOSING-COINS, Oct 6): the sample plan they make, how the scroll gathers
// them, and where the plan stands against the words, worked out as the scene and the still draw it.

describe('the sample plan', () => {
  it('adds up to the whole: stocks 45%, treasuries 25%, credit 20%, gold 10%', () => {
    expect(COINS.reduce((s, c) => s + c.weightBps, 0)).toBe(10_000);
    const by = (k: string) =>
      COINS.filter((c) => c.kind === k).reduce((s, c) => s + c.weightBps, 0);
    expect([by('stocks'), by('treasuries'), by('credit'), by('gold')]).toEqual([
      4500, 2500, 2000, 1000,
    ]);
    expect(COINS).toHaveLength(10);
  });

  it('names each coin by its ticker alone, and says the count it shows', () => {
    for (const c of COINS) expect(c.ticker).toMatch(/^[A-Za-z]{3,10}$/);
    expect(new Set(COINS.map((c) => c.ticker)).size).toBe(COINS.length);
    expect(dictionary('en').landing.closing.coins.line).toBe('One plan, ten pieces, one vault.');
    expect(dictionary('pt').landing.closing.coins.line).toBe('Um plano, dez peças, um cofre.');
    expect(labelOf(COINS[0] as (typeof COINS)[number], (b) => `${b / 100}%`)).toBe('SPY · 15%');
  });

  it('packs the coins into one round cluster, none touching another, each as large as its share', () => {
    for (let i = 0; i < PACKED.length; i++) {
      const a = PACKED[i] as { x: number; y: number; r: number };
      expect(Math.hypot(a.x, a.y) + a.r).toBeLessThanOrEqual(1 + 1e-9);
      for (let j = i + 1; j < PACKED.length; j++) {
        const b = PACKED[j] as { x: number; y: number; r: number };
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
      }
    }
    // area is weight: SPY (15%) has three times the area of TSLA (5%)
    const r = (t: string) => PACKED[COINS.findIndex((c) => c.ticker === t)]?.r ?? 0;
    expect((r('SPY') / r('TSLA')) ** 2).toBeCloseTo(3, 6);
  });
});

describe('the scroll, mapped to the plan', () => {
  it('runs from 0 as the section comes up to 1 once its sticky screen has gone', () => {
    expect(closingProgress(900, 1600, 800)).toBe(0);
    expect(closingProgress(0, 1600, 800)).toBe(0.5);
    expect(closingProgress(-800, 1600, 800)).toBe(1);
    expect(closingProgress(0, 0, 800)).toBe(1);
  });

  it('starts with every coin loose and ends with every coin home, the labels and the line last', () => {
    for (let i = 0; i < COINS.length; i++) {
      expect(gathered(i, 0)).toBe(0);
      expect(gathered(i, GATHER.to)).toBeCloseTo(1, 9);
    }
    expect(labelsAt(LABELS.from)).toBe(0);
    expect(labelsAt(LABELS.to)).toBe(1);
    expect(lineAt(LINE.from - 0.01)).toBe(0);
    expect(lineAt(1)).toBe(1);
    // the labels wait for the whole plan; the line waits for the labels
    expect(LABELS.from).toBeGreaterThanOrEqual(GATHER.to);
    expect(LINE.from).toBeGreaterThanOrEqual(LABELS.to);
  });

  it('gathers the coins one by one, the largest first, each moving only forward', () => {
    expect(ORDER[0]).toBe(0);
    // the first is home before the last has moved far
    const first = ORDER[0] as number;
    const last = ORDER[ORDER.length - 1] as number;
    const p = GATHER.from + 0.22;
    expect(gathered(first, p)).toBeCloseTo(1, 6);
    expect(gathered(last, p)).toBe(0);
    for (let i = 0; i < COINS.length; i++) {
      let was = 0;
      for (let k = 0; k <= 100; k++) {
        const now = gathered(i, k / 100);
        expect(now).toBeGreaterThanOrEqual(was - 1e-12);
        was = now;
      }
    }
    // in the middle of the gathering, an earlier coin is further home than a later one
    const mid = (GATHER.from + GATHER.to) / 2;
    expect(gathered(ORDER[1] as number, mid)).toBeGreaterThanOrEqual(
      gathered(ORDER[8] as number, mid),
    );
  });

  it('is a function of the scroll alone: scrolling back sets them loose the same way', () => {
    for (const p of [0.1, 0.3, 0.5, 0.9])
      expect(coinsAt(p, 1440, 900)).toEqual(coinsAt(p, 1440, 900));
    const home = coinsAt(1, 1440, 900);
    for (const c of home) {
      expect(c.home).toBeCloseTo(1, 9);
      expect(c.tilt).toBeCloseTo(0, 9);
    }
    expect(coinsAt(0, 1440, 900).every((c) => c.home === 0 && c.tilt !== 0)).toBe(true);
  });
});

describe('where the plan stands', () => {
  const words = (w: number) => {
    const gutter = Math.min(56, Math.max(16, 0.04 * w));
    const page = Math.min(w, 1280);
    const left = (w - page) / 2 + gutter;
    return { right: left + Math.min(544, (page - 2 * gutter) / 2) };
  };
  /** The line under the plan: about 50px tall, 14px under it. */
  const lineBottom = (w: number, h: number) => {
    const f = clusterFrame(w, h);
    return f.cy + f.radius + 14 + 50;
  };

  it.each([
    [1440, 900],
    [1280, 720],
    [1100, 900],
    [1024, 768],
  ])('stands beside the words, on screen, with its line, at %i × %i', (w, h) => {
    expect(isNarrow(w, h)).toBe(false);
    for (const c of coinsAt(1, w, h)) {
      expect(c.x - c.r).toBeGreaterThan(words(w).right);
      expect(c.x + c.r).toBeLessThanOrEqual(w);
      expect(c.y - c.r).toBeGreaterThanOrEqual(0);
      expect(c.y + c.r).toBeLessThanOrEqual(h);
    }
    expect(lineBottom(w, h)).toBeLessThanOrEqual(h);
  });

  it.each([
    [390, 844],
    [360, 740],
    [820, 1000],
    [960, 1100],
  ])('stands above the words on a phone or a tall screen, with its line, at %i × %i', (w, h) => {
    expect(isNarrow(w, h)).toBe(true);
    const wordsTop = h - 0.1 * h - 330;
    for (const c of coinsAt(1, w, h)) {
      expect(c.x - c.r).toBeGreaterThanOrEqual(0);
      expect(c.x + c.r).toBeLessThanOrEqual(w);
      expect(c.y - c.r).toBeGreaterThanOrEqual(0);
    }
    expect(lineBottom(w, h)).toBeLessThan(wordsTop);
  });
});

describe('the faces', () => {
  it('are text: no logo, no picture, nothing fetched', () => {
    for (const file of ['coins-scene.ts', 'CoinsStill.tsx', 'coins.ts']) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(text, file).not.toMatch(/TextureLoader|ImageLoader|<image|\.png|\.svg'|\.jpg|fetch\(/);
    }
  });
});
