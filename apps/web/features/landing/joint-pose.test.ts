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
    // the tenon's tip clear of the mortise, the pin clear of the tenon, the lower member off the post
    expect(poseAt(0).rail).toBeGreaterThan(MM.tenon.len - MM.post.w);
    expect(poseAt(0).pin).toBeGreaterThan((MM.pin.len + MM.tenon.h) / 2);
    expect(poseAt(0).lower).toBeGreaterThan(0);
    expect(poseAt(1)).toEqual({ rail: 0, lower: 0, pin: 0 });
  });

  it('only ever closes: no piece backs out or passes its seat', () => {
    let last = poseAt(0);
    for (const p of steps(2000)) {
      const now = poseAt(p);
      for (const piece of ['rail', 'lower', 'pin'] as const) {
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
  it('fits: the tenon passes the mortise with a tenth of a millimetre a side, and so does the pin', () => {
    expect((MM.mortise.w - MM.tenon.w) / 2).toBeCloseTo(0.1);
    expect((MM.mortise.h - MM.tenon.h) / 2).toBeCloseTo(0.1);
    expect((MM.hole.d - MM.pin.d) / 2).toBeCloseTo(0.1);
  });

  it('is the mark’s joint (logo-directions.md A): rail 12u high, tenon 8u, a third thick, 12u proud', () => {
    const u = 5;
    expect(MM.post.w).toBe(10 * u);
    expect(MM.rail.h).toBe(12 * u);
    expect(MM.tenon.h).toBe(8 * u);
    // a shoulder above and below the tenon, and on both cheeks
    expect((MM.rail.h - MM.tenon.h) / 2).toBe(2 * u);
    expect(MM.tenon.w).toBe(MM.rail.w / 3);
    expect(MM.tenon.len - MM.post.w).toBe(12 * u);
    expect(MM.pin.d).toBe(MM.tenon.h / 2);
  });

  it('pins the tenon where it stands proud: 7u from the post, 5u from the end, wood all round', () => {
    const u = 5;
    expect(MM.pin.at - MM.post.w).toBe(7 * u);
    expect(MM.tenon.len - MM.pin.at).toBe(5 * u);
    expect((MM.tenon.h - MM.hole.d) / 2).toBeGreaterThan(9);
    // it goes right through the tenon's thickness and stands out of both cheeks
    expect(MM.pin.len).toBeGreaterThan(MM.tenon.w);
  });
});
