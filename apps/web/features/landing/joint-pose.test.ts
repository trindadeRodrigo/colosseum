import { describe, expect, it } from 'vitest';
import { MM } from './joint-geometry';
import { easeSeat, HOLDS, poseAt, TURN } from './joint-pose';

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
    // the tenon's tip clear of the mortise, the pin clear of the tenon, the lower member off the post
    expect(poseAt(0).rail).toBeGreaterThan(MM.tenon.len);
    expect(poseAt(0).pin).toBeGreaterThan((MM.pin.len + MM.tenon.h) / 2);
    expect(poseAt(1)).toEqual({ rail: 0, pin: 0, turn: TURN });
  });

  it('only ever closes: no piece backs out or passes its seat', () => {
    let last = poseAt(0);
    for (const p of steps(2000)) {
      const now = poseAt(p);
      for (const piece of ['rail', 'pin'] as const) {
        expect(now[piece], `${piece} at p = ${p}`).toBeLessThanOrEqual(last[piece] + 1e-9);
        expect(now[piece]).toBeGreaterThanOrEqual(0);
      }
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
  it('fits: the tenon passes the mortise and the pin its slot with a tenth of a millimetre a side', () => {
    expect((MM.mortise.w - MM.tenon.w) / 2).toBeCloseTo(0.1);
    expect((MM.mortise.h - MM.tenon.h) / 2).toBeCloseTo(0.1);
    expect((MM.slot.x1 - MM.slot.x0 - MM.pin.x) / 2).toBeCloseTo(0.1);
    expect((MM.slot.w - MM.pin.z) / 2).toBeCloseTo(0.1);
  });

  it('is slender and in proportion: the tenon a third thick and two thirds high, shoulders all round', () => {
    expect(MM.post.w).toBe(30);
    expect([MM.rail.w, MM.rail.h]).toEqual([24, 30]);
    expect(MM.tenon.w).toBe(MM.rail.w / 3);
    expect(MM.tenon.h / MM.rail.h).toBeCloseTo(2 / 3);
    expect((MM.rail.h - MM.tenon.h) / 2).toBeGreaterThan(0);
    expect(MM.tenon.len - MM.post.w).toBe(60);
  });

  it('pins the tenon where it stands proud, with wood on every side of the slot', () => {
    expect(MM.slot.x0).toBeGreaterThan(MM.post.w);
    expect(MM.tenon.len - MM.slot.x1).toBeGreaterThan(30);
    expect((MM.tenon.w - MM.slot.w) / 2).toBeGreaterThan(1.5);
    // it goes right down through the tenon and stands out above and below it
    expect(MM.pin.len).toBeGreaterThan(MM.tenon.h);
  });

  it('starts fully apart: the tenon clear of the post and the pin clear of the tenon', () => {
    expect(HOLDS[0].pose.rail).toBeGreaterThan(MM.tenon.len);
    expect(HOLDS[0].pose.pin - MM.pin.len / 2).toBeGreaterThan(MM.rail.h / 2);
  });

  it('turns about 30° over the three steps, a third at each move', () => {
    expect((TURN * 180) / Math.PI).toBeCloseTo(30, 0);
    expect(HOLDS.map((h) => h.pose.turn)).toEqual([0, TURN / 3, (2 * TURN) / 3, TURN]);
  });
});
