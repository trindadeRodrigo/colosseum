import { describe, expect, it } from 'vitest';
import { MM } from './joint-geometry';
import { easeSeat, HOLDS, poseAt } from './joint-pose';

// The joint's motion (imagery-style.md §2 and §4): one piece at a time, each on its own axis, slowing
// into its seat on --ease-seat with no overshoot, and still wherever the copy of a step is read.

const steps = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('the pose of the joint', () => {
  it('holds still across each step the reader is reading', () => {
    for (const hold of HOLDS)
      for (const p of steps(10).map((t) => hold.from + (hold.to - hold.from) * t))
        expect(poseAt(p), `p = ${p}`).toEqual(hold.pose);
  });

  it('is apart at the hero, seated and pinned at step 03', () => {
    expect(poseAt(0).rail).toBeGreaterThan(MM.tenon.len);
    expect(poseAt(0).pin).toBeGreaterThan(MM.tenon.w);
    expect(poseAt(1)).toEqual({ rail: 0, pin: 0 });
  });

  it('only ever closes: the rail and the pin never back out or pass their seat', () => {
    let last = poseAt(0);
    for (const p of steps(2000)) {
      const now = poseAt(p);
      expect(now.rail, `p = ${p}`).toBeLessThanOrEqual(last.rail + 1e-9);
      expect(now.pin, `p = ${p}`).toBeLessThanOrEqual(last.pin + 1e-9);
      expect(now.rail).toBeGreaterThanOrEqual(0);
      expect(now.pin).toBeGreaterThanOrEqual(0);
      last = now;
    }
  });

  it('moves one piece at a time: the pin waits until the rail is in its last millimetre', () => {
    for (const p of steps(2000)) {
      const now = poseAt(p);
      if (now.pin < HOLDS[0].pose.pin) expect(now.rail, `p = ${p}`).toBeLessThan(1);
    }
  });

  it('eases on the brand’s seat curve, slowest at the end and never past it', () => {
    expect(easeSeat(0)).toBe(0);
    expect(easeSeat(1)).toBe(1);
    // cubic-bezier(0.2, 0, 0, 1): most of the travel early, the last tenth slow
    expect(easeSeat(0.5)).toBeGreaterThan(0.85);
    let last = 0;
    for (const x of steps(400)) {
      const y = easeSeat(x);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(1);
      last = y;
    }
  });
});

describe('the cut of the joint', () => {
  it('fits: the tenon passes the mortise with a tenth of a millimetre a side, and so does the pin', () => {
    expect((MM.mortise.w - MM.tenon.w) / 2).toBeCloseTo(0.1);
    expect((MM.mortise.h - MM.tenon.h) / 2).toBeCloseTo(0.1);
    expect((MM.hole.d - MM.pin.d) / 2).toBeCloseTo(0.1);
  });

  it('keeps his proportions: post 45, rail 45 × 60, the tenon a third thick and two thirds high', () => {
    expect(MM.post.w).toBe(45);
    expect([MM.rail.w, MM.rail.h]).toEqual([45, 60]);
    expect(MM.tenon.w).toBe(MM.rail.w / 3);
    expect(MM.tenon.h / MM.rail.h).toBeCloseTo(2 / 3);
  });

  it('puts the pin through the nose, nearer the end grain than the post, as the logo draws it', () => {
    const nose = MM.tenon.len - MM.post.w;
    const fromPost = MM.pin.at - MM.post.w;
    const fromEnd = MM.tenon.len - MM.pin.at;
    expect(fromPost - MM.pin.d / 2).toBeGreaterThan(0);
    expect(fromEnd - MM.pin.d / 2).toBeGreaterThan(0);
    expect(fromEnd).toBeLessThan(fromPost);
    expect(fromPost + fromEnd).toBe(nose);
  });
});
