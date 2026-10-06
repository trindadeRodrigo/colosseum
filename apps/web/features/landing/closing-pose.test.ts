import { describe, expect, it } from 'vitest';
import { screenBounds } from './closing-bounds';
import {
  CLOSING_APART,
  CLOSING_STAGES,
  closingPoseAt,
  closingProgress,
  isNarrow,
} from './closing-pose';

// The closing's joint (gate CLOSING-INK, Oct 6): how the scroll maps to the assembly, and where the
// assembled joint stands against the words, worked out as the scene draws it.

describe('the scroll, mapped to the assembly', () => {
  it('runs from 0 as the section comes up to 1 once its sticky screen has scrolled by', () => {
    const vh = 800;
    const track = 2 * vh;
    expect(closingProgress(vh + 50, track, vh)).toBe(0);
    expect(closingProgress(vh, track, vh)).toBe(0);
    // its top at the top of the screen: the heading is in the middle, the hold begins
    expect(closingProgress(0, track, vh)).toBe(0.5);
    expect(closingProgress(-vh, track, vh)).toBe(1);
    expect(closingProgress(-5 * vh, track, vh)).toBe(1);
    // nothing to measure: shown whole
    expect(closingProgress(0, 0, vh)).toBe(1);
  });

  it('is apart at 0 and whole, pinned and square once the pin is home', () => {
    expect(closingPoseAt(0)).toEqual({
      post: CLOSING_APART.post,
      rail: CLOSING_APART.rail,
      pin: CLOSING_APART.pin,
      turn: expect.any(Number),
    });
    for (const p of [CLOSING_STAGES.pin[1], 0.9, 1]) {
      const pose = closingPoseAt(p);
      expect(pose.post).toBeCloseTo(0, 6);
      expect(pose.rail).toBeCloseTo(0, 6);
      expect(pose.pin).toBeCloseTo(0, 6);
      expect(pose.turn).toBeCloseTo(0, 6);
    }
  });

  it('brings the pieces in one at a time, the pin last, and never overshoots', () => {
    let last = closingPoseAt(0);
    for (let i = 1; i <= 200; i += 1) {
      const pose = closingPoseAt(i / 200);
      expect(pose.post).toBeGreaterThanOrEqual(last.post - 1e-9);
      expect(pose.rail).toBeLessThanOrEqual(last.rail + 1e-9);
      expect(pose.pin).toBeLessThanOrEqual(last.pin + 1e-9);
      expect(pose.post).toBeLessThanOrEqual(0);
      expect(pose.rail).toBeGreaterThanOrEqual(-1e-9);
      last = pose;
    }
    // the pin waits until the rail is all but home
    const before = closingPoseAt(CLOSING_STAGES.pin[0]);
    expect(before.pin).toBe(CLOSING_APART.pin);
    expect(before.rail).toBeLessThan(1);
    // the post is up before the pin moves
    expect(before.post).toBeCloseTo(0, 6);
  });

  it('is a function of the scroll alone: scrolling back takes it apart the same way', () => {
    for (const p of [0.1, 0.3, 0.6, 0.7]) expect(closingPoseAt(p)).toEqual(closingPoseAt(p));
    expect(closingPoseAt(0.3).rail).toBeGreaterThan(closingPoseAt(0.5).rail);
  });
});

describe('where the assembled joint stands', () => {
  // the words' column on a wide screen: from the gutter, at most 34rem or half the page
  const words = (w: number) => {
    const gutter = Math.min(56, Math.max(16, 0.04 * w));
    const page = Math.min(w, 1280);
    const left = (w - page) / 2 + gutter;
    return { left, right: left + Math.min(544, (page - 2 * gutter) / 2) };
  };

  it.each([
    [1440, 900],
    [1280, 720],
    [1100, 900],
    [1024, 768],
  ])('stands beside the words, on screen, at %i × %i', (w, h) => {
    expect(isNarrow(w, h)).toBe(false);
    const b = screenBounds(w, h, 1);
    expect(b.left).toBeGreaterThan(words(w).right);
    expect(b.right).toBeLessThanOrEqual(w);
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.bottom).toBeLessThanOrEqual(h);
  });

  it.each([
    [390, 844],
    [360, 740],
    [820, 1000],
    [960, 1100],
  ])('stands above the words on a phone or a tall screen, at %i × %i', (w, h) => {
    expect(isNarrow(w, h)).toBe(true);
    const b = screenBounds(w, h, 1);
    // the words sit at the foot: 10% of the screen under them, about 330px of them
    const wordsTop = h - 0.1 * h - 330;
    expect(b.bottom).toBeLessThan(wordsTop);
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(w);
    expect(b.top).toBeGreaterThanOrEqual(0);
  });

  it('comes in from the edge: the rail starts off to the side of the words', () => {
    const start = screenBounds(1440, 900, 0);
    expect(start.right).toBeGreaterThan(1440);
  });
});
