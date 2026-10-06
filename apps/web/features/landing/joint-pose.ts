// Where each piece is for a given reading progress p (0 at the hero, 1 at step 03), in millimetres
// along its own axis, and how far the joint has turned: the rail only moves along x, the pin only
// along y (imagery-style.md §2, "single axis, one piece at a time"), and the whole joint turns about
// its post, about 30° over the three steps, a third at each move and never while a step is read. The stations follow his steps: apart at the hero, the
// tenon right through the mortise at step 01, the rail home with the pin still up at step 02, the pin
// driven at step 03. Each step of the copy has a stretch where nothing moves, so the picture is still
// while the reader reads; between them a piece slides on `--ease-seat`, slowest in its last
// millimetres, and settles. Nothing overshoots.
//
// p of each step's centre comes from the page's geometry (JointStage.tsx): the hero is 100svh and each
// step 80vh, so step 01 is centred at p ≈ 0.36, step 02 at ≈ 0.68, step 03 at 1.

export type Pose = {
  /** How far the rail's shoulder stands back from the post, in mm (0 = seated). */
  rail: number;
  /** How far the pin stands above its seat, in mm (0 = driven home). */
  pin: number;
  /** How far the joint has turned about its post, in radians. */
  turn: number;
};

/** Before the pin goes in, the shoulder stands this far off; the pin draws it home (a draw-bore). */
export const DRAW = 0.8;
/** The turn over the whole scroll: about 30°. */
export const TURN = 0.52;

/** The held stretches, each centred on a step: the hero, steps 01, 02 and 03. */
export const HOLDS = [
  { from: 0, to: 0.1, pose: { rail: 125, pin: 70, turn: 0 } },
  { from: 0.3, to: 0.42, pose: { rail: 45, pin: 70, turn: TURN / 3 } },
  { from: 0.62, to: 0.76, pose: { rail: DRAW, pin: 70, turn: (2 * TURN) / 3 } },
  { from: 0.97, to: 1, pose: { rail: 0, pin: 0, turn: TURN } },
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
    const t = easeSeat(span(p, hero.to, one.from));
    return {
      rail: lerp(hero.pose.rail, one.pose.rail, t),
      pin: hero.pose.pin,
      turn: lerp(hero.pose.turn, one.pose.turn, t),
    };
  }
  if (p <= two.from) {
    const t = easeSeat(span(p, one.to, two.from));
    return {
      rail: lerp(one.pose.rail, two.pose.rail, t),
      pin: one.pose.pin,
      turn: lerp(one.pose.turn, two.pose.turn, t),
    };
  }
  // From step 02 to 03 the pin goes in, and in its last stretch draws the shoulder home.
  const t = easeSeat(span(p, two.to, three.from));
  return {
    rail: lerp(DRAW, 0, Math.max(0, (t - 0.6) / 0.4)),
    pin: lerp(two.pose.pin, 0, t),
    turn: lerp(two.pose.turn, three.pose.turn, t),
  };
}
