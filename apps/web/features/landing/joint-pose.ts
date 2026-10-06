// Where each piece is for a given reading progress p (0 at the hero, 1 at step 03), in millimetres
// along its own axis: the rail only moves along x, the lower member only along z, the pin only along
// y, riding above its hole wherever the rail takes it (imagery-style.md §2, "single axis, one piece at
// a time"). The stations are his (hero-3d.html,
// `pose`): apart at the hero, the rail nearly home and the lower member against the post at step 01,
// the rail seated with the pin still up at step 02, the pin in at step 03. Each step of the copy has a
// stretch where nothing moves, so the picture is still while the reader reads; between them a piece
// slides on `--ease-seat`, slowest in its last millimetres, and seats. Nothing overshoots.
//
// p of each step's centre comes from the page's geometry (JointStage.tsx): the hero is 100svh and each
// step 80vh, so step 01 is centred at p ≈ 0.36, step 02 at ≈ 0.68, step 03 at 1.

export type Pose = {
  /** How far the rail's shoulder stands back from the post, in mm (0 = seated). */
  rail: number;
  /** How far the lower member stands off the post's face, in mm (0 = against it). */
  lower: number;
  /** How far the pin stands above its hole, in mm (0 = driven home). */
  pin: number;
};

/** Before the pin goes in, the shoulder stands this far off; the pin draws it home (a draw-bore). */
export const DRAW = 0.8;

/** The held stretches, each centred on a step: the hero, steps 01, 02 and 03. */
export const HOLDS = [
  { from: 0, to: 0.1, pose: { rail: 108, lower: 48, pin: 88 } },
  { from: 0.3, to: 0.42, pose: { rail: 15, lower: 0, pin: 88 } },
  { from: 0.62, to: 0.76, pose: { rail: DRAW, lower: 0, pin: 88 } },
  { from: 0.97, to: 1, pose: { rail: 0, lower: 0, pin: 0 } },
] as const;

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

const lerp = (a: number, b: number, t: number) => (t >= 1 ? b : a + (b - a) * t);
const span = (p: number, a: number, b: number) => Math.max(0, Math.min(1, (p - a) / (b - a)));

export function poseAt(p: number): Pose {
  const [hero, one, two, three] = HOLDS;
  if (p <= one.from) {
    // the lower member goes home first, then the rail comes up to the mortise
    const gap = one.from - hero.to;
    const lower = easeSeat(span(p, hero.to, hero.to + gap * 0.55));
    const rail = easeSeat(span(p, hero.to + gap * 0.3, one.from));
    return {
      rail: lerp(hero.pose.rail, one.pose.rail, rail),
      lower: lerp(hero.pose.lower, one.pose.lower, lower),
      pin: hero.pose.pin,
    };
  }
  if (p <= two.from) {
    const t = easeSeat(span(p, one.to, two.from));
    return { rail: lerp(one.pose.rail, two.pose.rail, t), lower: 0, pin: one.pose.pin };
  }
  // From step 02 to 03 the pin goes in, and in its last stretch draws the shoulder home.
  const t = easeSeat(span(p, two.to, three.from));
  return {
    rail: lerp(DRAW, 0, Math.max(0, (t - 0.6) / 0.4)),
    lower: 0,
    pin: lerp(two.pose.pin, 0, t),
  };
}
