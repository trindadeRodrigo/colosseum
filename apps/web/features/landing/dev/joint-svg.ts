import {
  FloatType,
  type Object3D,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { WEIGHT } from '../joint-ink';
import type { Drawing } from '../joint-scene';

// The joint's drawing as SVG, for the stills of the fallbacks (scripts/joint-stills.mjs, under
// `next dev` only): the same edges the stage draws, each cut where the solid in front of it starts and
// stops hiding it, so a still and the stage always agree. The depth of the solids is read back from the
// GPU once; every edge is walked a pixel at a time against it. Visible edges are solid in their weight,
// hidden ones dashed.

const EPS = 4e-5;
/** Said by the file to whoever opens it alone; on the page the image's alt text says it. */
const TITLE =
  'A post, a rail whose tenon passes through it, and the pin that locks it: a drawing of the tenonfi joint';

export function drawingToSvg({ renderer, scene, camera, pieces }: Drawing): string {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const css = new Vector2();
  renderer.getSize(css);
  const W = size.x;
  const H = size.y;
  const scale = css.x / W;

  // the depth of the solids, pushed back as the stage's fills are, so an edge on a face counts as seen
  const target = new WebGLRenderTarget(W, H, { type: FloatType });
  const depth = new ShaderMaterial({
    vertexShader:
      'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }',
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  const lines: Object3D[] = [];
  scene.traverse((o) => {
    if (o instanceof LineSegments2 && o.visible) lines.push(o);
  });
  for (const l of lines) l.visible = false;
  const clear = renderer.getClearAlpha();
  scene.overrideMaterial = depth;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear();
  renderer.render(scene, camera);
  const buffer = new Float32Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, buffer);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, clear);
  scene.overrideMaterial = null;
  for (const l of lines) l.visible = true;
  target.dispose();
  depth.dispose();
  // the farthest solid around the point: an edge is hidden only where the whole of its pixel's
  // neighbourhood stands in front of it, so an outline on a face seen edge-on still counts as seen
  const at = (x: number, y: number) => {
    let far = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const ix = Math.min(W - 1, Math.max(0, Math.round(x) + dx));
        const iy = Math.min(H - 1, Math.max(0, Math.round(H - 1 - y) + dy));
        far = Math.max(far, buffer[(iy * W + ix) * 4] ?? 1);
      }
    return far;
  };

  const paths: string[] = [];
  const p = new Vector3();
  const a = new Vector3();
  const b = new Vector3();
  const project = (v: Vector3) => {
    p.copy(v).project(camera);
    return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H, z: p.z * 0.5 + 0.5 };
  };
  const f = (n: number) => (n * scale).toFixed(1);
  for (const { piece, color } of pieces) {
    const world = piece.object.matrixWorld;
    const runs = { outline: [] as string[], inner: [] as string[], hidden: [] as string[] };
    for (const kind of ['outline', 'inner'] as const) {
      const seg = piece.segments[kind];
      for (let i = 0; i < seg.length; i += 6) {
        a.set(seg[i] ?? 0, seg[i + 1] ?? 0, seg[i + 2] ?? 0).applyMatrix4(world);
        b.set(seg[i + 3] ?? 0, seg[i + 4] ?? 0, seg[i + 5] ?? 0).applyMatrix4(world);
        const pa = project(a);
        const pb = project(b);
        const n = Math.max(2, Math.ceil(Math.hypot(pb.x - pa.x, pb.y - pa.y) / 1.5));
        // walk the edge; each sample is seen or hidden, and a run of either is one stroke
        let state: boolean | null = null;
        let start = pa;
        let prev = pa;
        const flush = (end: { x: number; y: number }) => {
          if (state === null || (start.x === end.x && start.y === end.y)) return;
          (state ? runs[kind] : runs.hidden).push(
            `M${f(start.x)} ${f(start.y)}L${f(end.x)} ${f(end.y)}`,
          );
        };
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const s = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t, z: 0 };
          s.z = project(new Vector3().lerpVectors(a, b, t)).z;
          const seen = s.z <= at(s.x, s.y) + EPS;
          if (seen !== state) {
            flush(prev);
            state = seen;
            start = prev;
          }
          prev = s;
        }
        flush(pb);
      }
    }
    const stroke = (d: string[], width: number, extra = '') =>
      d.length
        ? `<path d="${d.join('')}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round"${extra}/>`
        : '';
    paths.push(
      stroke(runs.hidden, WEIGHT.hidden, ' stroke-dasharray="3.5 2.6" opacity="0.42"'),
      stroke(runs.inner, WEIGHT.edge),
      stroke(runs.outline, WEIGHT.outline),
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${css.x} ${css.y}" width="${css.x}" height="${css.y}"><title>${TITLE}</title>${paths.join('')}</svg>`;
}
