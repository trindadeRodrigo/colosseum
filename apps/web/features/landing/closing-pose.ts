import { DRAW, easeSeat, type Pose } from './joint-pose';

// The closing's joint (gate CLOSING-INK, Thom, Oct 6: the 3D close): the hero's pinned through-tenon,
// drawn by the hero's scene, coming together as the reader scrolls the closing in. The post rises
// from below, the rail slides in along its axis, and the pin drops last, one piece at a time and one
// axis each (imagery-style.md §2); scrolling back takes them apart again. The joint stands beside the
// heading on a wide screen and above it on a phone, and is whole before the heading has been read.
//
// Progress is the closing's own: 0 as its top comes up past the bottom of the screen, 1 when its
// short sticky stretch (one screen) has scrolled by. The heading is in the middle of the screen from
// p = 0.5, and the pin is home by 0.78.

export type ClosingPose = Pose & {
  /** How far the post stands below its place, in mm (0 = in place). */
  post: number;
};

/** How far each piece starts from home, in mm: the post below, the rail back, the pin above. */
export const CLOSING_APART = { post: -320, rail: 360, pin: 160 } as const;

/** The stretches of p in which each piece moves: the post, then the rail, then the pin. */
export const CLOSING_STAGES = {
  post: [0.05, 0.4],
  rail: [0.2, 0.58],
  pin: [0.58, 0.78],
} as const;

/** The joint's turn as it comes together: a little more than at rest, settling as it locks. */
const TURN_IN = -0.35;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const span = (p: number, [a, b]: readonly [number, number]) => clamp((p - a) / (b - a), 0, 1);

/**
 * The closing's progress from where its track is: 0 while its top is still below the screen, 1 once
 * the track (its sticky stretch included) has scrolled past.
 */
export function closingProgress(trackTop: number, trackHeight: number, viewport: number): number {
  if (!(trackHeight > 0) || !(viewport > 0)) return 1;
  return clamp((viewport - trackTop) / trackHeight, 0, 1);
}

/** Where each piece is at progress p: apart at 0, assembled and pinned from 0.78 on. */
export function closingPoseAt(p: number): ClosingPose {
  const post = 1 - easeSeat(span(p, CLOSING_STAGES.post));
  const rail = 1 - easeSeat(span(p, CLOSING_STAGES.rail));
  const pin = easeSeat(span(p, CLOSING_STAGES.pin));
  return {
    post: CLOSING_APART.post * post,
    // the rail stops a draw short, and the pin draws it home in the last of its drop (a draw-bore)
    rail: DRAW + (CLOSING_APART.rail - DRAW) * rail - DRAW * Math.max(0, (pin - 0.6) / 0.4),
    pin: CLOSING_APART.pin * (1 - pin),
    turn: TURN_IN * (1 - easeSeat(span(p, [0.05, 0.78]))),
  };
}

// --- where it stands on the screen ------------------------------------------------------------------

/** The hero's camera and world (joint-scene.ts): one unit is 15 mm, the camera at (14, 17, 24). */
export const WORLD = { scale: 1 / 15, camera: [14, 17, 24], fov: 30 } as const;

/** The closing's bearing: turned the other way from the hero, so the rail runs back to the right. */
export const CLOSING_BEARING = { x: 0.12, y: 2.35 } as const;

export type Place = { x: number; y: number; z: number; scale: number };
/** Beside the heading on a wide screen, above it on a phone. */
export const CLOSING_PLACE: { wide: Place; narrow: Place } = {
  wide: { x: 5.2, y: -1.4, z: -1.5, scale: 0.62 },
  narrow: { x: 0.2, y: 4.4, z: 0, scale: 0.3 },
};
/** Under this width, or on a screen not wide enough for its height, the joint stands above the heading. */
export const NARROW = 960;
const MIN_ASPECT = 1.15;

export const isNarrow = (width: number, height: number) =>
  width < NARROW || width / height < MIN_ASPECT;
export const placeFor = (width: number, height: number): Place =>
  isNarrow(width, height) ? CLOSING_PLACE.narrow : CLOSING_PLACE.wide;
