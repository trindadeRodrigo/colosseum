import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Path, Shape } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// One pinned through-tenon, slender, drawn as a joiner would (gate JOINT-3D, form 3): a 30 × 30 post
// with a through-mortise; a 24 × 30 rail whose tenon, a third of its thickness and two thirds of its
// height, passes right through the post and stands 60 mm proud, with a shoulder on all four sides
// where the rail meets the post; and a flat pin (komisen) driven down through a slot in the tenon's
// nose. The mortise and the slot are cut with 0.1 mm a side, so the seated joint closes with no gap.
//
// Axes of the joint: y up the post, x along the rail (it comes in from -x and its tenon leaves the
// post at +x), z across the rail's thickness. The post stands on the origin; the rail's shoulder is
// at x = 0 of its own frame; the pin is centred on its own origin.

export const MM = {
  post: { w: 30, top: 130, bottom: -130 },
  mortise: { w: 8.2, h: 20.2 },
  rail: { w: 24, h: 30, len: 170 },
  /** From the rail's shoulder: through the post (30) and 60 proud of its far face. */
  tenon: { w: 8, h: 20, len: 90 },
  /** The slot down through the tenon, from the shoulder: 12 to 18 mm past the post, 4 mm across. */
  slot: { x0: 42, x1: 48, w: 4 },
  /** The pin: a flat bar, 0.1 mm under the slot a side, standing out above and below the tenon. */
  pin: { x: 5.8, z: 3.8, len: 48 },
} as const;

/** The geometry as a plain list of triangles, which is what the drawing reads. */
const flat = (g: BufferGeometry) => {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute('normal');
  n.deleteAttribute('uv');
  return n;
};

const rect = (x0: number, x1: number, y0: number, y1: number, holes: number[][] = []) => {
  const s = new Shape();
  s.moveTo(x0, y0);
  s.lineTo(x1, y0);
  s.lineTo(x1, y1);
  s.lineTo(x0, y1);
  s.closePath();
  for (const [a0 = 0, a1 = 0, b0 = 0, b1 = 0] of holes) {
    const p = new Path();
    p.moveTo(a0, b0);
    p.lineTo(a1, b0);
    p.lineTo(a1, b1);
    p.lineTo(a0, b1);
    p.closePath();
    s.holes.push(p);
  }
  return s;
};
/** A shape pushed `depth` along z, centred on z = 0, square-edged as a drawing is. */
const extrude = (shape: Shape, depth: number) => {
  const g = new ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return flat(g);
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

/** The post, standing on y, with the through-mortise along x. */
export function postGeometry(): BufferGeometry {
  const { w, top, bottom } = MM.post;
  const m = MM.mortise;
  // drawn in its side (z, y) and pushed along x
  const g = extrude(rect(-w / 2, w / 2, bottom, top, [[-m.w / 2, m.w / 2, -m.h / 2, m.h / 2]]), w);
  g.rotateY(Math.PI / 2);
  return g;
}

/** The rail and its tenon as one piece, the shoulder at x = 0, the pin's slot down the tenon's nose. */
export function railGeometry(): BufferGeometry {
  const { w, h, len } = MM.rail;
  const t = MM.tenon;
  const s = MM.slot;
  const body = extrude(rect(-len, 0, -h / 2, h / 2), w);
  // the tenon drawn in plan (x, z) with the slot, pushed down through its height
  const tenon = extrude(rect(0, t.len, -t.w / 2, t.w / 2, [[s.x0, s.x1, -s.w / 2, s.w / 2]]), t.h);
  tenon.rotateX(Math.PI / 2);
  // its root face lies inside the rail's end: taken out, so the shoulder's lines are the tenon's
  const within = (v: number[]) =>
    Math.abs(v[1] ?? 0) <= t.h / 2 + 1e-4 && Math.abs(v[2] ?? 0) <= t.w / 2 + 1e-4;
  return drop(mergeGeometries([body, tenon]), 0, 0, within);
}

/** The pin, a flat bar standing on y. */
export function pinGeometry(): BufferGeometry {
  const { x, z, len } = MM.pin;
  const g = extrude(rect(-x / 2, x / 2, -len / 2, len / 2), z);
  return g;
}
