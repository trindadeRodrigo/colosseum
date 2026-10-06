import {
  AgXToneMapping,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SpotLight,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MM, pinGeometry, postGeometry, railBodyGeometry, tenonGeometry } from './joint-geometry';
import { poseAt } from './joint-pose';
import { HARDWOOD, HINOKI, sharedUniforms, woodMaterial } from './joint-wood';

// The through-tenon of his hero (joint-stage.md, imagery-style.md §2), set up as he would photograph
// it: a pale post with a real mortise, a dark rail whose tenon slides through it and seats, and a pale
// pin driven across the tenon's nose last. One small softbox high on the left with a grid, a fill card
// on the right three stops under, no rim; a long lens from about 30° above. The pose is a function of
// the reader's progress through the three steps and nothing else, and a frame is drawn only while it
// moves. Loaded only when the stage is near, motion is allowed and WebGL is there (JointStage.tsx).
// Nothing is downloaded but this module: the wood and the room are computed.

export type JointScene = {
  /** Where the reader is, from 0 (apart) to 1 (seated and pinned). */
  setProgress(p: number): void;
  resize(): void;
  /** Stops drawing while the stage is out of sight or the tab is hidden. */
  setVisible(visible: boolean): void;
  dispose(): void;
};

export type SceneOptions = {
  /** Called once the first frame is on the canvas. */
  onReady?: () => void;
  /** Phones and small GPUs: a lower pixel ratio and a smaller shadow map. */
  light?: boolean;
  /** The joint alone, centred in a square: how the still pictures of the fallbacks are made. */
  still?: boolean;
};

/** World units per millimetre: the joint is modelled in mm and drawn at a tenth of a metre a unit. */
const S = 0.01;
const deg = Math.PI / 180;

/**
 * The camera's bearing: 35° round from the rail's axis toward the pin's, 30° above, on a long lens
 * (imagery-style.md). The rail runs back to the upper left as the logo draws it, the tenon comes
 * through toward the camera, and the face the pin goes into is the one the key lights.
 */
const VIEW = { azimuth: 35 * deg, elevation: 30 * deg, fov: 15 };
/** Which way along z the pin stands off before it is driven: away from the camera. */
const FAR = VIEW.azimuth > 0 ? -1 : 1;

type Mood = {
  exposure: number;
  key: {
    color: number;
    intensity: number;
    azimuth: number;
    elevation: number;
    radius: number;
    /** How far the softbox is from the joint, in world units (a tenth of a metre). */
    distance: number;
  };
  /** The softbox, the fill card and the room as the environment sees them. */
  box: { color: number; strength: number; w: number; h: number };
  fill: { color: number; strength: number; azimuth: number };
  room: number;
  env: number;
  ao: number;
  grain: number;
  /** A gentle S-curve after the tone map, for his medium-high contrast, and the colour AgX takes out. */
  curve: number;
  saturation: number;
};

// Black: a 3,400 K softbox high on the left, a neutral card on the right three stops under, no rim, a
// black room. Paper: a large 5,200 K diffuser overhead and a weak bounce, a pale room.
const MOODS: Record<'dark' | 'light', Mood> = {
  dark: {
    exposure: 1.05,
    key: {
      color: 0xffd2a6,
      intensity: 420,
      azimuth: 45 * deg,
      elevation: 50 * deg,
      radius: 10,
      distance: 9,
    },
    box: { color: 0xffd2a6, strength: 7, w: 3, h: 6 },
    fill: { color: 0xfff4e8, strength: 0.18, azimuth: -70 * deg },
    room: 0x050403,
    env: 0.45,
    ao: 1,
    grain: 0.014,
    curve: 0.3,
    saturation: 1.05,
  },
  light: {
    exposure: 0.8,
    key: {
      color: 0xfff3e4,
      intensity: 1900,
      azimuth: 42 * deg,
      elevation: 62 * deg,
      radius: 14,
      distance: 14,
    },
    box: { color: 0xfff3e4, strength: 1.1, w: 8, h: 8 },
    fill: { color: 0xfff6ec, strength: 1.1, azimuth: -70 * deg },
    room: 0x4a443c,
    env: 0.3,
    ao: 1,
    grain: 0.01,
    curve: 0.4,
    saturation: 1.25,
  },
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** A direction at a bearing from the camera's own (positive turns to the camera's left). */
function bearing(azimuthFromCamera: number, elevation: number) {
  const a = VIEW.azimuth + azimuthFromCamera;
  return new Vector3(
    Math.cos(a) * Math.cos(elevation),
    Math.sin(elevation),
    Math.sin(a) * Math.cos(elevation),
  );
}

function isDark() {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark');
}

export function createJointScene(
  canvas: HTMLCanvasElement,
  options: SceneOptions = {},
): JointScene {
  const lite = options.light === true;
  // Clear, so the page's own ground shows through: black in dark, paper in light.
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(VIEW.fov, 1, 1, 60);

  // --- the pieces ---------------------------------------------------------------------------------
  const shared = sharedUniforms();
  const X = new Vector3(1, 0, 0);
  const Y = new Vector3(0, 1, 0);
  const Z = new Vector3(0, 0, 1);
  const post = woodMaterial(
    HINOKI,
    {
      grain: Y,
      across: [X, Z],
      pith: new Vector2(-95, 160),
      runout: new Vector2(0.018, -0.01),
      seed: 3.1,
      origin: new Vector3(),
      moves: 'none',
    },
    shared,
    S,
  );
  const railOrigin = new Vector3(-MM.post.w / 2, 0, 0);
  const rail = woodMaterial(
    HARDWOOD,
    {
      grain: X,
      across: [Y, Z],
      pith: new Vector2(-150, 70),
      runout: new Vector2(0.03, 0.012),
      seed: 7.7,
      origin: railOrigin,
      moves: 'rail',
    },
    shared,
    S,
  );
  const pinOrigin = new Vector3(-MM.post.w / 2 + MM.pin.at, 0, 0);
  const pinWood = woodMaterial(
    HINOKI,
    {
      grain: Z,
      across: [X, Y],
      pith: new Vector2(-38, 26),
      runout: new Vector2(0.05, 0),
      seed: 11.3,
      origin: pinOrigin,
      moves: 'pin',
    },
    shared,
    S,
  );

  const mesh = (geometry: Mesh['geometry'], material: Mesh['material']) => {
    const m = new Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const assembly = new Group();
  assembly.scale.setScalar(S);
  scene.add(assembly);
  // A still is a specimen, whole within its frame; the stage crops a longer post and rail at its edges.
  assembly.add(mesh(postGeometry(options.still ? -230 : undefined), post.material));
  const railGroup = new Group();
  railGroup.add(mesh(railBodyGeometry(options.still ? 190 : undefined), rail.material));
  railGroup.add(mesh(tenonGeometry(), rail.material));
  assembly.add(railGroup);
  const pin = mesh(pinGeometry(), pinWood.material);
  assembly.add(pin);

  const place = (p: number) => {
    const pose = poseAt(p);
    railGroup.position.set(railOrigin.x - pose.rail, 0, 0);
    pin.position.set(pinOrigin.x, 0, FAR * pose.pin);
    shared.uRail.value = pose.rail;
    shared.uPin.value = FAR * pose.pin;
  };

  // --- the light ----------------------------------------------------------------------------------
  // The key is a softbox under a 40° grid, close to the joint: its light falls off across the
  // pieces, so the rail's far end and the foot of the post go quietly dark, as in his photograph.
  const key = new SpotLight();
  key.angle = 24 * deg;
  key.penumbra = 1;
  key.decay = 2;
  key.castShadow = true;
  key.shadow.mapSize.setScalar(lite ? 1024 : 2048);
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.004;
  key.shadow.camera.near = 3;
  key.shadow.camera.far = 20;
  const focus = new Vector3(0.05, 0.05, 0);
  key.target.position.copy(focus);
  scene.add(key, key.target);

  const pmrem = new PMREMGenerator(renderer);
  let envMap: Texture | null = null;
  let dark = isDark();

  /** The room the joint stands in, as its surfaces reflect it: the softbox, the fill card, the walls. */
  const roomFor = (mood: Mood) => {
    const room = new Scene();
    room.background = new Color(mood.room);
    const panel = (color: number, strength: number, w: number, h: number, dir: Vector3) => {
      const m = new Mesh(
        new PlaneGeometry(w, h),
        new MeshBasicMaterial({ color: new Color(color).multiplyScalar(strength) }),
      );
      m.position.copy(dir).multiplyScalar(9);
      m.lookAt(0, 0, 0);
      room.add(m);
      return m;
    };
    const keyDir = bearing(mood.key.azimuth, mood.key.elevation);
    panel(mood.box.color, mood.box.strength, mood.box.w, mood.box.h, keyDir);
    panel(mood.fill.color, mood.fill.strength, 12, 12, bearing(mood.fill.azimuth, 5 * deg));
    return room;
  };

  const light = () => {
    const mood = MOODS[dark ? 'dark' : 'light'];
    renderer.toneMappingExposure = mood.exposure;
    key.color.setHex(mood.key.color);
    key.intensity = mood.key.intensity;
    key.shadow.radius = mood.key.radius;
    key.position.copy(
      bearing(mood.key.azimuth, mood.key.elevation).multiplyScalar(mood.key.distance).add(focus),
    );
    key.angle = (dark ? 24 : 40) * deg;
    const room = roomFor(mood);
    envMap?.dispose();
    envMap = pmrem.fromScene(room, 0.03).texture;
    room.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (o.material as MeshBasicMaterial).dispose();
      }
    });
    scene.environment = envMap;
    scene.environmentIntensity = mood.env;
    shared.uAo.value = mood.ao;
    shared.uGrain.value = mood.grain;
    shared.uContrastCurve.value = mood.curve;
    shared.uSaturation.value = mood.saturation;
  };

  // --- the frame ----------------------------------------------------------------------------------
  // The joint sits in the right part of the page's column, clear of the copy; on a phone it sits
  // above the copy's plate. A shift of the lens, not a turn of the camera, puts it there.
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const narrow = w < 820 && !options.still;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // how many millimetres of the scene the height of the frame holds: on a wide screen the joint
    // keeps its share of the height; on a phone it keeps its share of the width
    const span = options.still ? 520 : narrow ? clamp((270 * h) / w, 400, 640) : 300;
    const distance = (span * S) / (2 * Math.tan((VIEW.fov * deg) / 2));
    camera.position.copy(bearing(0, VIEW.elevation).multiplyScalar(distance).add(focus));
    camera.lookAt(focus);
    const column = Math.min(w, 1280);
    const left = (w - column) / 2;
    const cx = options.still ? w * 0.56 : narrow ? w * 0.48 : left + column * 0.8;
    const cy = narrow ? h * 0.29 : options.still ? h * 0.5 : h * 0.56;
    camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h);
    camera.updateProjectionMatrix();
    draw();
  };

  let frameNo = 0;
  let ready = false;
  const draw = () => {
    shared.uFrame.value = frameNo++ % 64;
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
    light();
    draw();
  };
  const watch = new MutationObserver(relight);
  watch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  system.addEventListener('change', relight);

  light();
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
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      watch.disconnect();
      system.removeEventListener('change', relight);
      scene.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      for (const m of [post, rail, pinWood]) m.material.dispose();
      envMap?.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
