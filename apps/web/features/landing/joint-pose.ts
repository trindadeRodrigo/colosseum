// Where each piece is for a given reading progress p (0 at the hero, 1 at step 03), in millimetres
// along its own axis: the rail only moves along x, the pin only along z (imagery-style.md §2,
// "single axis, one piece at a time"). Each step of the copy has a stretch where nothing moves, so
// the picture is still while the reader reads; between them a piece slides on `--ease-seat`, slowest
// in its last millimetres, and seats. Nothing overshoots.
//
// p of each step's centre comes from the page's geometry (JointStage.tsx): the hero is 100svh and each
// step 80vh, so step 01 is centred at p ≈ 0.36, step 02 at ≈ 0.68, step 03 at 1.

export type Pose = {
  /** How far the rail's shoulder stands back from the post, in mm (0 = seated). */
  rail: number;
  /** How far the pin stands out in front of its hole, in mm (0 = driven home). */
  pin: number;
};

/** The held stretches, each centred on a step: the hero, steps 01, 02 and 03. */
export const HOLDS = [
  { from: 0, to: 0.1, pose: { rail: 165, pin: 55 } },
  { from: 0.3, to: 0.42, pose: { rail: 110, pin: 55 } },
  { from: 0.62, to: 0.74, pose: { rail: 34, pin: 55 } },
  { from: 0.97, to: 1, pose: { rail: 0, pin: 0 } },
] as const;

/** Before the pin goes in, the shoulder stands this far off; the pin draws it home (a draw-bore). */
const DRAW = 0.8;

// cubic-bezier(0.2, 0, 0, 1), the brand's --ease-seat, solved for y at x.
const bezier = (a: number, b: number, t: number) =>
  3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
export function easeSeat(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bezier(0.2, 0, mid) < x) lo = mid;
    else hi = mid;
  }
  return bezier(0, 1, (lo + hi) / 2);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const span = (p: number, a: number, b: number) => Math.max(0, Math.min(1, (p - a) / (b - a)));

export function poseAt(p: number): Pose {
  const [hero, one, two, three] = HOLDS;
  if (p <= one.from) {
    const t = easeSeat(span(p, hero.to, one.from));
    return { rail: lerp(hero.pose.rail, one.pose.rail, t), pin: hero.pose.pin };
  }
  if (p <= two.from) {
    const t = easeSeat(span(p, one.to, two.from));
    return { rail: lerp(one.pose.rail, two.pose.rail, t), pin: one.pose.pin };
  }
  // From step 02 to 03 the rail seats to within the draw, then the pin goes in and pulls it home.
  const seatAt = lerp(two.to, three.from, 0.55);
  if (p <= seatAt) {
    const t = easeSeat(span(p, two.to, seatAt));
    return { rail: lerp(two.pose.rail, DRAW, t), pin: two.pose.pin };
  }
  const t = easeSeat(span(p, seatAt + 0.02, three.from));
  return { rail: lerp(DRAW, 0, Math.max(0, (t - 0.6) / 0.4)), pin: lerp(two.pose.pin, 0, t) };
}
