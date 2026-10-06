import { type BufferGeometry, ExtrudeGeometry, Path, Shape } from 'three';

// The pinned through-tenon (J1 in imagery-style.md), modelled once in millimetres with his
// proportions: a 45 × 45 hinoki post, a 45 × 60 hardwood rail whose tenon is a third of the rail's
// thickness and two thirds of its height (logo-directions.md, 7 : 3 : 2), through the post and 60 mm
// out the far side, and a hinoki pin across the tenon's nose, offset toward the end grain as the logo
// draws it. Every outside edge carries a small chamfer; the mortise and the pin hole are real
// cavities, cut with 0.1 mm of clearance a side so the seated joint shows no gap.
//
// Axes of the assembly: y up the post, x along the rail (the rail comes in from -x and its tenon
// leaves the post at +x), z along the pin.

export const MM = {
  post: { w: 45, top: 170, bottom: -900 },
  mortise: { w: 15.2, h: 40.2 },
  rail: { w: 45, h: 60, len: 380 },
  /** Measured from the rail's shoulder: 45 through the post, 60 out the far face. */
  tenon: { w: 15, h: 40, len: 105 },
  /** `at` is the pin's centre, from the shoulder: 35 mm past the post, 25 from the end grain. */
  pin: { d: 14, len: 38, at: 80 },
  hole: { d: 14.2 },
  chamfer: 0.8,
} as const;

type Corners = [boolean, boolean, boolean, boolean];

/** A rectangle in the plane with its corners cut at 45°: bottom-left, bottom-right, top-right, top-left. */
function rect(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  cut: Corners,
  c: number = MM.chamfer,
) {
  const s = new Shape();
  const at = (x: number, y: number, first = false) => (first ? s.moveTo(x, y) : s.lineTo(x, y));
  if (cut[0]) {
    at(x0, y0 + c, true);
    at(x0 + c, y0);
  } else at(x0, y0, true);
  if (cut[1]) {
    at(x1 - c, y0);
    at(x1, y0 + c);
  } else at(x1, y0);
  if (cut[2]) {
    at(x1, y1 - c);
    at(x1 - c, y1);
  } else at(x1, y1);
  if (cut[3]) {
    at(x0 + c, y1);
    at(x0, y1 - c);
  } else at(x0, y1);
  s.closePath();
  return s;
}

/** The shape pushed `depth` along z, centred on z = 0, its cap edges chamfered like its corners. */
function prism(shape: Shape, depth: number, c: number = MM.chamfer) {
  const geo = new ExtrudeGeometry(shape, {
    depth: depth - 2 * c,
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelSegments: 1,
    curveSegments: 56,
  });
  geo.translate(0, 0, c - depth / 2);
  return geo;
}

/** Round walls get round normals: every vertex on the circle (cx, cy, r) whose face is a wall. */
function smoothRound(geo: BufferGeometry, cx: number, cy: number, r: number) {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx;
    const dy = pos.getY(i) - cy;
    const d = Math.hypot(dx, dy);
    if (Math.abs(d - r) > 0.02 || Math.abs(nor.getZ(i)) > 0.5) continue;
    const out = nor.getX(i) * dx + nor.getY(i) * dy < 0 ? -1 : 1;
    nor.setXYZ(i, (out * dx) / d, (out * dy) / d, 0);
  }
  nor.needsUpdate = true;
}

const ALL: Corners = [true, true, true, true];

/** The post, standing on y, with its through-mortise along x. */
export function postGeometry(bottom: number = MM.post.bottom) {
  const { w, top } = MM.post;
  const s = rect(-w / 2, w / 2, bottom, top, ALL);
  const m = MM.mortise;
  const hole = new Path();
  hole.moveTo(-m.w / 2, -m.h / 2);
  hole.lineTo(m.w / 2, -m.h / 2);
  hole.lineTo(m.w / 2, m.h / 2);
  hole.lineTo(-m.w / 2, m.h / 2);
  hole.closePath();
  s.holes.push(hole);
  // drawn in the z-y plane and pushed along x
  const geo = prism(s, w);
  geo.rotateY(Math.PI / 2);
  return geo;
}

/** The rail's body, its shoulder at x = 0, running back to -len. */
export function railBodyGeometry(len: number = MM.rail.len) {
  const { w, h } = MM.rail;
  return prism(rect(-len, 0, -h / 2, h / 2, ALL), w);
}

/** The tenon from just inside the shoulder to its end grain, with the pin's hole across it. */
export function tenonGeometry() {
  const { w, h, len } = MM.tenon;
  const s = rect(-2, len, -h / 2, h / 2, [false, true, true, false]);
  const hole = new Path();
  hole.absarc(MM.pin.at, 0, MM.hole.d / 2, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const geo = prism(s, w);
  smoothRound(geo, MM.pin.at, 0, MM.hole.d / 2);
  return geo;
}

/** The pin, a round dowel lying along z, chamfered at both ends. */
export function pinGeometry() {
  const r = MM.pin.d / 2;
  const s = new Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  const geo = prism(s, MM.pin.len, 1);
  smoothRound(geo, 0, 0, r);
  return geo;
}
