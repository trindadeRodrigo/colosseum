import {
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Path,
  Shape,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// The pinned through-tenon of the tenonfi mark (logo-directions.md, direction A), modelled once in
// millimetres and drawn as a joiner would (gate JOINT-3D): a post with a through-mortise; a rail whose
// tenon passes right through it and stands proud of the far face, with a shoulder on all four sides
// where the rail meets the post; and a round pin across the tenon's nose that locks it. The mark's
// construction sets the proportions: rail : tenon heights 12 : 8 (a 2u shoulder top and bottom), the
// tenon a third of the rail's thickness, 12u of it proud of the post, and a pin half the tenon's height
// across, its centre 7u from the post and 5u from the end grain (u = 5 mm). The mortise and the pin hole
// are cut with 0.1 mm a side, so the seated joint closes with no gap.
//
// Axes of the assembly: y up the post, x along the rail (it comes in from -x and its tenon leaves the
// post at +x), z across the rail's thickness, the pin's axis.
//
// With `third`, a second rail joins the post from its front face, lower down, with its own through-
// tenon along z: the variant that keeps his three-piece composition.

const U = 5;

export const MM = {
  post: { w: 10 * U, top: 105, bottom: -105, bottomWithThird: -165 },
  mortise: { w: 15.2, h: 8 * U + 0.2 },
  rail: { w: 45, h: 12 * U, len: 140 },
  /** From the rail's shoulder: through the post (10u) and 12u proud of its far face. */
  tenon: { w: 15, h: 8 * U, len: 22 * U },
  /** Its centre from the shoulder: 7u past the post, so 5u from the end grain. Its axis is z. */
  pin: { d: 4 * U, len: 15 + 2 * 12, at: 17 * U },
  hole: { d: 4 * U + 0.2 },
  /** The second rail: along z from the post's front face, its axis this far below the first's. */
  third: { w: 45, h: 12 * U, len: 150, y: -105, tenonLen: 10 * U + 30 },
} as const;

/** The geometry as a plain list of triangles, which is what the drawing reads. */
const flat = (g: BufferGeometry) => (g.index ? g.toNonIndexed() : g);

const rect = (x0: number, x1: number, y0: number, y1: number) => {
  const s = new Shape();
  s.moveTo(x0, y0);
  s.lineTo(x1, y0);
  s.lineTo(x1, y1);
  s.lineTo(x0, y1);
  s.closePath();
  return s;
};
const hole = (x0: number, x1: number, y0: number, y1: number) => {
  const p = new Path();
  p.moveTo(x0, y0);
  p.lineTo(x1, y0);
  p.lineTo(x1, y1);
  p.lineTo(x0, y1);
  p.closePath();
  return p;
};
/** A shape pushed `depth` along z, centred on z = 0, square-edged as a drawing is. */
const extrude = (shape: Shape, depth: number) => {
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 48 });
  g.translate(0, 0, -depth / 2);
  return g;
};

/**
 * Drops the triangles that lie in a plane and inside a box: the inner faces where two blocks of one
 * piece meet. What is left of their edges is drawn where it shows (a shoulder), and nothing else is.
 */
function drop(geo: BufferGeometry, axis: 0 | 1 | 2, at: number, inside: (v: number[]) => boolean) {
  const pos = geo.getAttribute('position');
  const keep: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const tri = [0, 1, 2].map((k) => [pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)]);
    const gone = tri.every((v) => Math.abs((v[axis] ?? 0) - at) < 1e-4 && inside(v));
    if (!gone) for (const v of tri) keep.push(...v);
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(keep, 3));
  return out;
}
const everywhere = () => true;

/** The post, standing on y, with the through-mortise for the rail along x (and, with `third`, one along z). */
export function postGeometry(third = false): BufferGeometry {
  const { w, top } = MM.post;
  const m = MM.mortise;
  if (!third) {
    const s = rect(-w / 2, w / 2, MM.post.bottom, top);
    s.holes.push(hole(-m.w / 2, m.w / 2, -m.h / 2, m.h / 2));
    const g = extrude(s, w);
    g.rotateY(Math.PI / 2);
    return flat(g);
  }
  // Three blocks of one post, stacked on y, their touching faces taken out: the upper one cut along
  // x for the rail, the middle one along z for the second rail, the foot plain.
  const t = MM.third;
  const seamA = t.y + t.h / 2 + 10;
  const seamB = t.y - t.h / 2 - 10;
  const upper = rect(-w / 2, w / 2, seamA, top);
  upper.holes.push(hole(-m.w / 2, m.w / 2, -m.h / 2, m.h / 2));
  const a = extrude(upper, w);
  a.rotateY(Math.PI / 2);
  const middle = rect(-w / 2, w / 2, seamB, seamA);
  middle.holes.push(hole(-m.w / 2, m.w / 2, t.y - m.h / 2, t.y + m.h / 2));
  const b = extrude(middle, w);
  const c = extrude(rect(-w / 2, w / 2, MM.post.bottomWithThird, seamB), w);
  const all = [a, b, c].map((g) => {
    const n = flat(g);
    n.deleteAttribute('normal');
    n.deleteAttribute('uv');
    return n;
  });
  const merged = mergeGeometries(all);
  return drop(drop(merged, 1, seamA, everywhere), 1, seamB, everywhere);
}

/** The rail and its tenon as one piece, the shoulder at x = 0, the pin's hole across the tenon. */
export function railGeometry(): BufferGeometry {
  const { w, h, len } = MM.rail;
  const body = extrude(rect(-len, 0, -h / 2, h / 2), w);
  const t = MM.tenon;
  const ts = rect(0, t.len, -t.h / 2, t.h / 2);
  const p = new Path();
  p.absarc(MM.pin.at, 0, MM.hole.d / 2, 0, Math.PI * 2, true);
  ts.holes.push(p);
  const tenon = extrude(ts, t.w);
  // the tenon's root face lies inside the rail's end: out, so the shoulder's lines are the tenon's
  const within = (v: number[]) =>
    Math.abs(v[1] ?? 0) <= t.h / 2 + 1e-4 && Math.abs(v[2] ?? 0) <= t.w / 2 + 1e-4;
  return drop(solid([body, tenon]), 0, 0, within);
}

/** The pin, a round dowel along z. */
export function pinGeometry(): BufferGeometry {
  const r = MM.pin.d / 2;
  const g = new CylinderGeometry(r, r, MM.pin.len, 48, 1);
  g.rotateX(Math.PI / 2);
  return flat(g);
}

/** The second rail: from the post's front face toward the camera, its tenon through the post along -z. */
export function thirdGeometry(): BufferGeometry {
  const t = MM.third;
  const body = extrude(rect(-t.w / 2, t.w / 2, t.y - t.h / 2, t.y + t.h / 2), t.len);
  body.translate(0, 0, MM.post.w / 2 + t.len / 2);
  const tenon = extrude(
    rect(-MM.tenon.w / 2, MM.tenon.w / 2, t.y - MM.tenon.h / 2, t.y + MM.tenon.h / 2),
    t.tenonLen,
  );
  tenon.translate(0, 0, MM.post.w / 2 - t.tenonLen / 2);
  const within = (v: number[]) =>
    Math.abs(v[0] ?? 0) <= MM.tenon.w / 2 + 1e-4 &&
    Math.abs((v[1] ?? 0) - t.y) <= MM.tenon.h / 2 + 1e-4;
  return drop(solid([body, tenon]), 2, MM.post.w / 2, within);
}

function solid(parts: BufferGeometry[]) {
  return mergeGeometries(
    parts.map((g) => {
      const n = flat(g);
      n.deleteAttribute('normal');
      n.deleteAttribute('uv');
      return n;
    }),
  );
}
