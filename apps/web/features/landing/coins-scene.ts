import {
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from 'three';
import { COINS, type CoinAt, coinsAt, labelsAt, TONE } from './coins';
import { type Ink, InkPiece } from './joint-ink';

// The closing's coins (gate CLOSING-COINS) in the hero's ink: each coin a short cylinder drawn as a
// joiner draws a piece (joint-ink.ts, the hero's own lines: the outline heavier, the rims lighter, the
// far rim dashed), filled with the ground, its ticker set on its face in the mono face of the page. No
// logo: the faces are text. Where each coin is comes from coins.ts in CSS pixels, so the scene, the
// labels and the still drawing agree; the scene eases toward the reader's progress and draws only while
// it moves and is on screen. Loaded with the closing, after the first paint, where WebGL runs.

export type CoinsScene = {
  /** Where the reader is, from 0 (loose) to 1 (one plan). */
  setProgress(p: number): void;
  resize(): void;
  setVisible(visible: boolean): void;
  dispose(): void;
};

export type CoinsOptions = {
  onReady?: () => void;
  /** Phones and small GPUs: a lower pixel ratio. */
  light?: boolean;
};

/** Read by the build's budget check, as the hero's scene is. */
const MARK = 'tf-coins-ink';
const FOV = 30;
const DISTANCE = 40;
/** A coin's thickness, as a share of its radius. */
const THICK = 0.22;

/** The ground, and the three inks of the coins: cream, the wood, stone (color-system.md). */
const INKS: Record<'dark' | 'light', Record<'member' | 'wood' | 'stone', Ink>> = {
  dark: {
    member: { line: new Color('#ECE4D6'), fill: new Color('#0D0B09') },
    wood: { line: new Color('#C9AE86'), fill: new Color('#0D0B09') },
    stone: { line: new Color('#A49A8E'), fill: new Color('#0D0B09') },
  },
  light: {
    member: { line: new Color('#1C1712'), fill: new Color('#F6F1E8') },
    wood: { line: new Color('#7A5A3A'), fill: new Color('#F6F1E8') },
    stone: { line: new Color('#6E655B'), fill: new Color('#F6F1E8') },
  },
};

const isDark = () => getComputedStyle(document.documentElement).colorScheme.includes('dark');

/** The page's mono face, as its CSS names it, for the tickers. */
const monoFace = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
  'ui-monospace, monospace';

/**
 * A line of a coin's face in the ink of its rim, as large as fits across the coin: the ticker a little
 * above the middle, its share of the plan under it (`at` is how far down the face, 0 to 1).
 */
function faceTexture(text: string, ink: Color, at: number, largest: number) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  if (!ctx) return texture;
  let px = largest;
  const face = monoFace();
  ctx.font = `500 ${px}px ${face}`;
  while (ctx.measureText(text).width > size * 0.74 && px > 16) {
    px -= 2;
    ctx.font = `500 ${px}px ${face}`;
  }
  ctx.fillStyle = `#${ink.getHexString()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size * at);
  texture.needsUpdate = true;
  return texture;
}

export function createCoinsScene(
  canvas: HTMLCanvasElement,
  options: CoinsOptions = {},
): CoinsScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  canvas.dataset.scene = MARK;
  const ratio = () => Math.min(window.devicePixelRatio || 1, options.light ? 1.5 : 2);
  renderer.setPixelRatio(ratio());

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 200);
  camera.position.set(0, 0, DISTANCE);
  camera.lookAt(0, 0, 0);

  // A unit coin, its axis toward the eye: scaled to its radius on the screen.
  const coinGeometry = () => {
    const g = new CylinderGeometry(1, 1, THICK, 64, 1).toNonIndexed();
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g.rotateX(Math.PI / 2);
    return g;
  };
  const faceGeometry = new CircleGeometry(0.86, 48);
  const coins = COINS.map((coin) => {
    const group = new Group();
    const piece = new InkPiece(coinGeometry());
    group.add(piece.object);
    const material = new MeshBasicMaterial({ transparent: true, depthWrite: false });
    const face = new Mesh(faceGeometry, material);
    face.position.z = THICK / 2 + 0.002;
    group.add(face);
    // its share of the plan, under the ticker: it comes in once the plan is whole
    const weight = new MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0 });
    const share = new Mesh(faceGeometry, weight);
    share.position.z = THICK / 2 + 0.003;
    group.add(share);
    scene.add(group);
    return { coin, group, piece, material, weight };
  });

  let dark = isDark();
  const size = new Vector2();
  const ink = () => {
    const set = INKS[dark ? 'dark' : 'light'];
    renderer.getDrawingBufferSize(size);
    for (const c of coins) {
      const tone = set[TONE[c.coin.kind]];
      c.piece.setInk(tone, ratio(), size);
      c.material.map?.dispose();
      c.material.map = faceTexture(c.coin.ticker, tone.line, 0.44, 72);
      c.material.needsUpdate = true;
      c.weight.map?.dispose();
      c.weight.map = faceTexture(`${c.coin.weightBps / 100}%`, tone.line, 0.7, 40);
      c.weight.needsUpdate = true;
    }
  };

  let w = 0;
  let h = 0;
  /** World units for one CSS pixel on the plane the coins move in. */
  let unit = 1;
  const place = (p: number) => {
    if (w === 0 || h === 0) return;
    const at: CoinAt[] = coinsAt(p, w, h);
    const labels = labelsAt(p);
    coins.forEach((c, i) => {
      const a = at[i] as CoinAt;
      c.group.position.set((a.x - w / 2) * unit, -(a.y - h / 2) * unit, 0);
      c.group.scale.setScalar(Math.max(a.r, 0.5) * unit);
      c.group.rotation.set(a.tilt * 0.8, a.tilt, 0);
      c.weight.opacity = labels;
      c.group.updateMatrixWorld(true);
      c.piece.update(camera.position);
    });
  };

  let ready = false;
  const draw = () => {
    renderer.render(scene, camera);
    if (!ready) {
      ready = true;
      options.onReady?.();
    }
  };

  const resize = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setPixelRatio(ratio());
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    unit = (2 * DISTANCE * Math.tan((FOV * Math.PI) / 360)) / h;
    ink();
    place(current);
    draw();
  };

  // The damped follow of the hero (joint-stage.md: current += (p − current) × 0.08 a frame at 60 fps).
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
    if (Math.abs(target - current) < 0.0004) current = target;
    place(current);
    draw();
    if (current !== target && visible) frame = requestAnimationFrame(step);
    else last = 0;
  };
  const wake = () => {
    if (frame === 0 && visible) frame = requestAnimationFrame(step);
  };

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

  resize();
  return {
    setProgress(p) {
      const next = Math.max(0, Math.min(1, p));
      if (next === target && current === target) return;
      target = next;
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
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      watch.disconnect();
      system.removeEventListener('change', relight);
      for (const c of coins) {
        c.piece.dispose();
        c.material.map?.dispose();
        c.material.dispose();
        c.weight.map?.dispose();
        c.weight.dispose();
      }
      faceGeometry.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
