import {
  AgXToneMapping,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SpotLight,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
} from 'three';
import {
  lowerGeometry,
  MM,
  pinGeometry,
  postGeometry,
  railBodyGeometry,
  tenonGeometry,
} from './joint-geometry';
import { poseAt } from './joint-pose';
import { HARDWOOD, HINOKI, sharedUniforms, woodMaterial } from './joint-wood';

// The through-tenon of his hero (joint-stage.md, imagery-style.md §2), in his composition and lit as
// he would photograph it: a pale post with a real mortise, a dark rail whose tenon slides through it
// and seats, the pale lower member set against the post, and a pale pin dropped through the tenon's
// nose last. One softbox high on the left, a fill card on the right three stops under, and his faint
// warm rim from behind. The pose is a function of
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

/**
 * His prototype's world (hero-3d.html, `initScene`): one unit is 15 mm, the camera at (14, 17, 24) with
 * a 30° lens looking at the origin, and the joint turned (0.12, −0.62, 0) and set to the right of the
 * copy. His framing is kept as he drew it, step for step; only the materials and the light are new.
 */
const S = 1 / 15;
const deg = Math.PI / 180;
const CAMERA = new Vector3(14, 17, 24);
const FOV = 30;
const TURN = { x: 0.12, y: -0.62 };
/** Where the joint stands: beside the copy on a wide screen, above it on a phone (his `layout`). */
const PLACE = {
  wide: { x: 4.6, y: -0.55, z: -2.76, scale: 1 },
  narrow: { x: 0.4, y: 2.7, z: 0, scale: 0.5 },
  still: { x: 1.9, y: 1.3, z: 0, scale: 0.64 },
};

type Mood = {
  exposure: number;
  /** The key: a softbox under a grid, high on the left, close enough that its light falls off. */
  key: { color: number; intensity: number; dir: Vector3; radius: number; angle: number };
  /** His faint warm rim from behind on the right, so the far edges part from the ground. */
  rim: { color: number; intensity: number };
  /** The softbox, the fill card and the rim strip as the room shows them in reflections. */
  box: { color: number; strength: number; w: number; h: number };
  fill: { color: number; strength: number };
  strip: number;
  room: number;
  env: number;
  ao: number;
  grain: number;
  /** A gentle S-curve after the tone map, for his medium-high contrast, and the colour AgX takes out. */
  curve: number;
  saturation: number;
};

/** The key's distance from the joint, in units: about 0.9 m, as his photograph's softbox stood. */
const KEY_DISTANCE = 60;
const toCamera = CAMERA.clone().normalize();
/** Camera right, low: where the fill card stands. */
const FILL_DIR = new Vector3()
  .crossVectors(new Vector3(0, 1, 0), toCamera)
  .negate()
  .multiplyScalar(0.9)
  .addScaledVector(toCamera, 0.45)
  .setY(0.12)
  .normalize();
const RIM_DIR = new Vector3(10, 4, -8).normalize();

// Black: a 3,400 K softbox high on the left, a neutral card on the right three stops under, his faint
// warm rim, a black room. Paper: a large 5,200 K diffuser overhead and a weak bounce, a pale room.
const MOODS: Record<'dark' | 'light', Mood> = {
  dark: {
    exposure: 1.05,
    key: {
      color: 0xffd2a6,
      intensity: 5.4 * KEY_DISTANCE ** 2,
      dir: new Vector3(-9, 14, 10).normalize(),
      radius: 5,
      angle: 22 * deg,
    },
    rim: { color: 0xffd9a8, intensity: 2.4 },
    box: { color: 0xffd2a6, strength: 7, w: 3, h: 6 },
    fill: { color: 0xfff4e8, strength: 0.2 },
    strip: 4,
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
      intensity: 6.2 * KEY_DISTANCE ** 2,
      dir: new Vector3(-5, 14, 6).normalize(),
      radius: 8,
      angle: 34 * deg,
    },
    rim: { color: 0xfff3e4, intensity: 0.5 },
    box: { color: 0xfff3e4, strength: 1.1, w: 8, h: 8 },
    fill: { color: 0xfff6ec, strength: 2 },
    strip: 0.6,
    room: 0x5a5349,
    env: 0.45,
    ao: 1,
    grain: 0.01,
    curve: 0.4,
    saturation: 1.25,
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
  // variance shadows: a soft, even penumbra with no dither pattern at the edges
  renderer.shadowMap.type = VSMShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 200);

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
      grain: Y,
      across: [X, Z],
      pith: new Vector2(-30, 24),
      runout: new Vector2(0.05, 0),
      seed: 11.3,
      origin: pinOrigin,
      moves: 'pin',
    },
    shared,
    S,
  );
  const lowerWood = woodMaterial(
    HINOKI,
    {
      grain: Z,
      across: [X, Y],
      pith: new Vector2(110, MM.lower.y - 130),
      runout: new Vector2(-0.02, 0.015),
      seed: 5.9,
      origin: new Vector3(),
      moves: 'lower',
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
  assembly.rotation.set(TURN.x, TURN.y, 0);
  scene.add(assembly);
  assembly.add(mesh(postGeometry(), post.material));
  const railGroup = new Group();
  railGroup.add(mesh(railBodyGeometry(), rail.material));
  railGroup.add(mesh(tenonGeometry(), rail.material));
  assembly.add(railGroup);
  const pin = mesh(pinGeometry(), pinWood.material);
  assembly.add(pin);
  const lower = mesh(lowerGeometry(), lowerWood.material);
  assembly.add(lower);

  const place = (p: number) => {
    const pose = poseAt(p);
    railGroup.position.set(railOrigin.x - pose.rail, 0, 0);
    // the pin waits above its hole, wherever the rail has brought it (his `pose`)
    pin.position.set(pinOrigin.x - pose.rail, pose.pin, 0);
    lower.position.set(0, 0, pose.lower);
    shared.uRail.value = pose.rail;
    shared.uPin.value = pose.pin;
    shared.uLower.value = pose.lower;
  };

  // --- the light ----------------------------------------------------------------------------------
  // The key is a spot with a soft edge standing where his softbox would: its light falls off across
  // the pieces, so the rail's far end goes quietly darker, as in his photograph.
  const key = new SpotLight();
  key.penumbra = 1;
  key.decay = 2;
  key.castShadow = true;
  key.shadow.mapSize.setScalar(lite ? 1024 : 2048);
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  key.shadow.blurSamples = 12;
  key.shadow.camera.near = KEY_DISTANCE - 25;
  key.shadow.camera.far = KEY_DISTANCE + 25;
  scene.add(key, key.target);
  const rim = new DirectionalLight();
  rim.position.copy(RIM_DIR);
  scene.add(rim);

  const pmrem = new PMREMGenerator(renderer);
  let envMap: Texture | null = null;
  let dark = isDark();

  /** The room the joint stands in, as its surfaces reflect it: the softbox, the fill, the rim strip. */
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
    };
    panel(mood.box.color, mood.box.strength, mood.box.w, mood.box.h, mood.key.dir);
    panel(mood.fill.color, mood.fill.strength, 12, 12, FILL_DIR);
    panel(mood.rim.color, mood.strip, 1.2, 9, RIM_DIR);
    return room;
  };

  const light = () => {
    const mood = MOODS[dark ? 'dark' : 'light'];
    renderer.toneMappingExposure = mood.exposure;
    key.color.setHex(mood.key.color);
    key.intensity = mood.key.intensity;
    key.angle = mood.key.angle;
    key.shadow.radius = mood.key.radius;
    rim.color.setHex(mood.rim.color);
    rim.intensity = mood.rim.intensity;
    aim();
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
  /** The key follows the joint wherever the frame puts it. */
  const aim = () => {
    const mood = MOODS[dark ? 'dark' : 'light'];
    key.target.position.copy(assembly.position);
    key.position.copy(mood.key.dir).multiplyScalar(KEY_DISTANCE).add(assembly.position);
    rim.target.position.copy(assembly.position);
    rim.position.copy(RIM_DIR).add(assembly.position);
    key.target.updateMatrixWorld();
    rim.target.updateMatrixWorld();
  };

  // --- the frame ----------------------------------------------------------------------------------
  // His camera and his placing of the joint: to the right of the copy on a wide screen, above the
  // copy's plate on a phone. Nothing reaches under the bar at the top.
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const at = options.still ? PLACE.still : w < 820 ? PLACE.narrow : PLACE.wide;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.copy(CAMERA);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    assembly.position.set(at.x, at.y, at.z);
    assembly.scale.setScalar(S * at.scale);
    aim();
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
      for (const m of [post, rail, pinWood, lowerWood]) m.material.dispose();
      envMap?.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
