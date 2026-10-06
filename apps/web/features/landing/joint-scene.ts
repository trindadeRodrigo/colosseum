import {
  Color,
  Group,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MM, pinGeometry, postGeometry, railGeometry, thirdGeometry } from './joint-geometry';
import { type Ink, InkPiece } from './joint-ink';
import { DRAW, poseAt } from './joint-pose';

// The pinned through-tenon of his hero (joint-stage.md), drawn as a joiner's drawing in his ink (gate
// JOINT-3D): the post, the rail whose tenon goes through it, and the pin that locks it, each filled
// with the ground and outlined, with every hidden edge dashed, so the tenon shows inside the mortise
// and the pin inside the tenon. Cream ink on black, dark ink on paper. His camera, his placing and his
// three steps; the pose is a function of the reader's progress and nothing else, and a frame is drawn
// only while it moves. Loaded only when the stage is near, motion is allowed and WebGL is there
// (JointStage.tsx). Nothing is fetched but this module.

export type JointScene = {
  /** Where the reader is, from 0 (apart) to 1 (seated and pinned). */
  setProgress(p: number): void;
  resize(): void;
  /** Stops drawing while the stage is out of sight or the tab is hidden. */
  setVisible(visible: boolean): void;
  dispose(): void;
  /** What the drawing is made of, for the SVG stills (joint-svg.ts, made under `next dev` only). */
  inspect(): Drawing;
};

export type Drawing = {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  pieces: { piece: InkPiece; color: string }[];
};

export type SceneOptions = {
  /** Called once the first frame is on the canvas. */
  onReady?: () => void;
  /** Phones and small GPUs: a lower pixel ratio. */
  light?: boolean;
  /** The joint alone, whole in a square frame: how the stills of the fallbacks are made. */
  still?: boolean;
  /** A second rail into the post's front face, with its own through-tenon. */
  third?: boolean;
};

/** Read by the build's budget check (scripts/check-build.mjs, STAGE_MARKERS). */
const MARK = 'tf-joint-ink';

/**
 * His prototype's world (hero-3d.html, `initScene`): one unit is 15 mm, the camera at (14, 17, 24) with
 * a 30° lens looking at the origin, and the joint turned (0.12, −0.62, 0) and set to the right of the
 * copy, or above it on a phone.
 */
const S = 1 / 15;
const CAMERA = new Vector3(14, 17, 24);
const FOV = 30;
const TURN = { x: 0.12, y: -0.62 };
const PLACE = {
  wide: { x: 4.6, y: -0.55, z: -2.76, scale: 1 },
  narrow: { x: 1.1, y: 4.55, z: 0, scale: 0.31 },
  still: { x: 1.9, y: -0.5, z: 0, scale: 0.72 },
};

/** His tokens: washi and hinoki-deep on black; ink and hardwood on paper (color-system.md). */
const INKS: Record<'dark' | 'light', { member: Ink; rail: Ink }> = {
  dark: {
    member: { line: new Color('#ECE4D6'), fill: new Color('#0D0B09') },
    rail: { line: new Color('#C9AE86'), fill: new Color('#0D0B09') },
  },
  light: {
    member: { line: new Color('#1C1712'), fill: new Color('#F6F1E8') },
    rail: { line: new Color('#7A5A3A'), fill: new Color('#F6F1E8') },
  },
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function isDark() {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark');
}

export function createJointScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions = {},
): JointScene {
  // Clear, so the page's own ground shows through; the fills are the same colour as the ground.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  canvas.dataset.scene = MARK;
  const ratio = () => Math.min(window.devicePixelRatio || 1, options.light ? 1.5 : 2);
  renderer.setPixelRatio(ratio());

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 200);
  camera.position.copy(CAMERA);
  camera.lookAt(0, 0, 0);

  const assembly = new Group();
  assembly.rotation.set(TURN.x, TURN.y, 0);
  scene.add(assembly);
  const post = new InkPiece(postGeometry(options.third));
  const rail = new InkPiece(railGeometry());
  const pin = new InkPiece(pinGeometry());
  const third = options.third ? new InkPiece(thirdGeometry()) : null;
  const pieces = [post, rail, pin, ...(third ? [third] : [])];
  for (const piece of pieces) assembly.add(piece.object);

  const railOrigin = -MM.post.w / 2;
  const pinOrigin = railOrigin + MM.pin.at;
  const place = (p: number) => {
    const pose = poseAt(p);
    rail.object.position.set(railOrigin - pose.rail, 0, 0);
    // the pin waits behind the place its hole will come to, on the side away from the copy, and goes
    // in once the rail is all but home (the last of the draw is the pin's)
    pin.object.position.set(pinOrigin - Math.min(pose.rail, DRAW), 0, -pose.pin);
    third?.object.position.set(0, 0, pose.lower);
    for (const piece of pieces) piece.update(camera.position);
  };

  let dark = isDark();
  const size = new Vector2();
  const ink = () => {
    const set = INKS[dark ? 'dark' : 'light'];
    renderer.getDrawingBufferSize(size);
    for (const piece of pieces) piece.setInk(piece === rail ? set.rail : set.member, ratio(), size);
  };

  // --- the frame ----------------------------------------------------------------------------------
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const at = options.still ? PLACE.still : w < 820 ? PLACE.narrow : PLACE.wide;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    assembly.position.set(at.x, at.y, at.z);
    assembly.scale.setScalar(S * at.scale);
    for (const piece of pieces) piece.update(camera.position);
    ink();
    draw();
  };

  let ready = false;
  const draw = () => {
    renderer.render(scene, camera);
    if (!ready) {
      ready = true;
      options.onReady?.();
    }
  };

  // A damped follow of the reader's progress (joint-stage.md: current += (p − current) × 0.08 a
  // frame at 60 fps), drawn only while it is still moving.
  let target = 0;
  let current = 0;
  let frame = 0;
  let last = 0;
  let visible = true;
  const step = (now: number) => {
    frame = 0;
    const dt = last === 0 ? 1 / 60 : Math.min((now - last) / 1000, 0.1);
    last = now;
    current += (target - current) * (1 - (1 - 0.08) ** (dt * 60));
    if (Math.abs(target - current) < 0.0004 || options.still) current = target;
    place(current);
    draw();
    if (current !== target && visible) frame = requestAnimationFrame(step);
    else last = 0;
  };
  const wake = () => {
    if (frame === 0 && visible) frame = requestAnimationFrame(step);
  };

  // The theme can change under the stage: the page's switch, or the system's.
  const relight = () => {
    const next = isDark();
    if (next === dark) return;
    dark = next;
    ink();
    draw();
  };
  const watch = new MutationObserver(relight);
  watch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  system.addEventListener('change', relight);

  place(0);
  resize();
  return {
    setProgress(p) {
      target = clamp(p, 0, 1);
      wake();
    },
    resize,
    setVisible(next) {
      visible = next;
      if (next) wake();
      else if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
      }
    },
    inspect() {
      const set = INKS[dark ? 'dark' : 'light'];
      return {
        renderer,
        scene,
        camera,
        pieces: pieces.map((piece) => ({
          piece,
          color: `#${(piece === rail ? set.rail : set.member).line.getHexString()}`,
        })),
      };
    },
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      watch.disconnect();
      system.removeEventListener('change', relight);
      for (const piece of pieces) piece.dispose();
      renderer.dispose();
    },
  };
}
