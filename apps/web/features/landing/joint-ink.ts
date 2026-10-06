import {
  type BufferGeometry,
  type Color,
  GreaterDepth,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type Vector2,
  Vector3,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

// A piece of the joint drawn as a joiner draws it (gate JOINT-3D): its faces filled with the ground, so
// it hides what is behind it; its outline against what lies beyond it in a heavier line; its other
// edges in a lighter one; and every edge it hides, its own and the other pieces', dashed. The lines
// are found from the solid itself: an edge is drawn where its two faces meet at an angle (a crease),
// and is the outline where one of its faces turns toward the eye and the other away. The outline is
// worked out again only when a piece has moved, from where the eye is, so a round piece would keep its
// sides.

/** Line weights in CSS pixels: the outline, the edges inside it, and the hidden edges. */
export const WEIGHT = { outline: 1.5, edge: 0.85, hidden: 0.75 } as const;
/** The dash of a hidden edge, in millimetres of the piece at its widest placing (see `dashScale`). */
const DASH = { size: 3.2, gap: 2.4 } as const;
const CREASE = Math.cos((20 * Math.PI) / 180);

type Edge = { a: Vector3; b: Vector3; normals: Vector3[]; crease: boolean };

/** Every edge of a non-indexed solid, welded by position, with the normals of the faces beside it. */
export function edgesOf(geo: BufferGeometry): Edge[] {
  const pos = geo.getAttribute('position');
  const key = (v: Vector3) =>
    `${Math.round(v.x * 1e3)},${Math.round(v.y * 1e3)},${Math.round(v.z * 1e3)}`;
  const map = new Map<string, Edge>();
  const v = [new Vector3(), new Vector3(), new Vector3()];
  const e1 = new Vector3();
  const e2 = new Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) v[k]?.fromBufferAttribute(pos, i + k);
    const [p0, p1, p2] = v as [Vector3, Vector3, Vector3];
    const n = e1.subVectors(p1, p0).cross(e2.subVectors(p2, p0));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    for (const [a, b] of [
      [p0, p1],
      [p1, p2],
      [p2, p0],
    ] as const) {
      const ka = key(a);
      const kb = key(b);
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      let edge = map.get(id);
      if (!edge) {
        edge = { a: a.clone(), b: b.clone(), normals: [], crease: false };
        map.set(id, edge);
      }
      edge.normals.push(n.clone());
    }
  }
  const edges = [...map.values()];
  for (const e of edges) {
    const [n1, n2] = e.normals;
    // an edge with one face is where a face of one block meets another (a shoulder): a line
    e.crease = !n1 || !n2 || e.normals.length > 2 || n1.dot(n2) < CREASE;
  }
  return edges.filter((e) => e.crease || e.normals.length === 2);
}

export type Ink = { line: Color; fill: Color };

/** One piece: its fill and its three sets of lines, which follow it wherever it is moved. */
export class InkPiece {
  readonly group = new Group();
  private readonly edges: Edge[];
  private readonly fill: MeshBasicMaterial;
  private readonly outline: LineSegments2;
  private readonly inner: LineSegments2;
  private readonly hidden: LineSegments2;
  private last = '';
  private readonly eye = new Vector3();
  /** The edges as last sorted, in the piece's own millimetres: what the SVG stills are drawn from. */
  segments: { outline: number[]; inner: number[]; hidden: number[] } = {
    outline: [],
    inner: [],
    hidden: [],
  };

  constructor(geometry: BufferGeometry) {
    this.edges = edgesOf(geometry);
    this.fill = new MeshBasicMaterial({
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.group.add(new Mesh(geometry, this.fill));
    const line = (weight: number, hidden = false) => {
      const m = new LineMaterial({
        linewidth: weight,
        dashed: hidden,
        dashSize: DASH.size,
        gapSize: DASH.gap,
        transparent: hidden,
        opacity: hidden ? 0.42 : 1,
        alphaToCoverage: !hidden,
      });
      if (hidden) {
        // drawn only where something stands in front of it
        m.depthFunc = GreaterDepth;
        m.depthWrite = false;
      }
      const l = new LineSegments2(new LineSegmentsGeometry(), m);
      l.frustumCulled = false;
      this.group.add(l);
      return l;
    };
    this.inner = line(WEIGHT.edge);
    this.outline = line(WEIGHT.outline);
    this.hidden = line(WEIGHT.hidden, true);
  }

  get object(): Object3D {
    return this.group;
  }

  /** The ink, the pixel ratio and the canvas size; `dashScale` stretches the dashes on a small placing. */
  setInk(ink: Ink, pixelRatio: number, size: Vector2, dashScale = 1) {
    this.fill.color.copy(ink.fill);
    (this.hidden.material as LineMaterial).dashScale = 1 / dashScale;
    for (const [l, w] of [
      [this.outline, WEIGHT.outline],
      [this.inner, WEIGHT.edge],
      [this.hidden, WEIGHT.hidden],
    ] as const) {
      const m = l.material as LineMaterial;
      m.color.copy(ink.line);
      m.linewidth = w * pixelRatio;
      m.resolution.copy(size);
    }
  }

  /** Sorts the edges again for an eye at `camera` (world), if the piece has moved since. */
  update(camera: Vector3) {
    this.group.updateWorldMatrix(true, false);
    this.eye.copy(camera);
    this.group.worldToLocal(this.eye);
    const outline: number[] = [];
    const inner: number[] = [];
    const hidden: number[] = [];
    let sign = '';
    const mid = new Vector3();
    const toEye = new Vector3();
    for (const e of this.edges) {
      let silhouette = false;
      const [n1, n2] = e.normals;
      if (n1 && n2 && e.normals.length === 2) {
        toEye.subVectors(this.eye, mid.addVectors(e.a, e.b).multiplyScalar(0.5));
        silhouette = n1.dot(toEye) > 0 !== n2.dot(toEye) > 0;
      }
      sign += silhouette ? '1' : '0';
      if (!silhouette && !e.crease) continue;
      const seg = [e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z];
      (silhouette ? outline : inner).push(...seg);
      hidden.push(...seg);
    }
    if (sign === this.last) return;
    this.last = sign;
    this.segments = { outline, inner, hidden };
    for (const [l, arr] of [
      [this.outline, outline],
      [this.inner, inner],
      [this.hidden, hidden],
    ] as const) {
      (l.geometry as LineSegmentsGeometry).setPositions(arr);
      l.computeLineDistances();
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments2) {
        o.geometry.dispose();
        (o.material as MeshBasicMaterial | LineMaterial).dispose();
      }
    });
  }
}
