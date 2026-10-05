import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  type Material,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  WebGLRenderer,
} from 'three';

// The through-tenon of his hero (joint-stage.md; hero-3d.html, `initScene`): a pale post with a
// mortise, a dark rail whose tenon slides through it, a pale pin that drops in last, and a second pale
// member in front. The pose is a function of the reader's progress through the three steps, and
// nothing else: no loop runs while nothing moves. Loaded only when the stage is near the viewport,
// motion is allowed and WebGL is there (JointStage.tsx); its wood is his generated textures, served
// from this app (`public/landing/wood/`).

const WOOD = '/landing/wood/';

export type JointScene = {
  /** Where the reader is, from 0 (exploded) to 1 (seated and pinned). */
  setProgress(p: number): void;
  resize(): void;
  /** Stops drawing while the stage is out of sight or the tab is hidden. */
  setVisible(visible: boolean): void;
  dispose(): void;
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (t: number) => 1 - (1 - t) ** 3;

export function createJointScene(canvas: HTMLCanvasElement): JointScene {
  // Clear, so the page's own ground shows through: black in dark, paper in light.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 200);

  // His lighting: a raking warm key from the upper left, a faint warm rim, a very low ambient.
  scene.add(new HemisphereLight(0xfff1dc, 0x0d0b09, 0.32 * Math.PI));
  const key = new DirectionalLight(0xffe7c4, 2.2 * Math.PI);
  key.position.set(-9, 14, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
  key.shadow.bias = -0.0004;
  key.shadow.radius = 4;
  scene.add(key);
  const rim = new DirectionalLight(0xffd9a8, 0.5 * Math.PI);
  rim.position.set(10, 4, -8);
  scene.add(rim);

  const loader = new TextureLoader();
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const textures: Texture[] = [];
  const materials: Material[] = [];
  const draw = () => renderer.render(scene, camera);
  const tex = (name: string, color: boolean, rotate: boolean) => {
    const t = loader.load(`${WOOD}${name}.jpg`, draw);
    if (color) t.colorSpace = SRGBColorSpace;
    t.anisotropy = aniso;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    if (rotate) {
      t.center.set(0.5, 0.5);
      t.rotation = Math.PI / 2;
    }
    textures.push(t);
    return t;
  };
  const species = (wood: 'hardwood' | 'hinoki') => {
    const m = (face: 'side' | 'end', rotate: boolean) => {
      const material = new MeshStandardMaterial({
        map: tex(`${wood}-${face}`, true, rotate),
        bumpMap: tex(`${wood}-${face}-bump`, false, rotate),
        bumpScale: 0.025,
        roughness: 0.68,
        metalness: 0,
      });
      materials.push(material);
      return material;
    };
    return { side: m('side', false), sideRot: m('side', true), end: m('end', false) };
  };
  const HARD = species('hardwood');
  const HINO = species('hinoki');

  // A box's faces are +x, -x, +y, -y, +z, -z; the u-axis of each is z, z, x, x, x, x. A face across
  // the long axis gets end grain; a face whose u runs along it gets side grain as it is, else turned.
  const U = ['z', 'z', 'x', 'x', 'x', 'x'];
  const NORMAL = ['x', 'x', 'y', 'y', 'z', 'z'];
  const faces = (sp: ReturnType<typeof species>, axis: string) =>
    NORMAL.map((n, i) => (n === axis ? sp.end : U[i] === axis ? sp.side : sp.sideRot));
  const box = (
    w: number,
    h: number,
    d: number,
    sp: ReturnType<typeof species>,
    axis: string,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new Mesh(new BoxGeometry(w, h, d), faces(sp, axis));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  const group = new Group();
  scene.add(group);
  // the post: 3 × 14 × 3, with a through-mortise 1.6 high and 1.2 deep along x
  const post = new Group();
  post.add(box(3, 6.2, 3, HINO, 'y', 0, -3.9, 0));
  post.add(box(3, 6.2, 3, HINO, 'y', 0, 3.9, 0));
  post.add(box(3, 1.6, 0.9, HINO, 'y', 0, 0, 1.05));
  post.add(box(3, 1.6, 0.9, HINO, 'y', 0, 0, -1.05));
  group.add(post);
  // the rail: a 3 × 3 body, its tenon through the post and out to x = 3.6, the pin hole at x = 2.55
  const rail = new Group();
  rail.add(box(12, 3, 3, HARD, 'x', -7.5, 0, 0));
  rail.add(box(3.75, 1.6, 1.2, HARD, 'x', 0.375, 0, 0));
  rail.add(box(0.75, 1.6, 1.2, HARD, 'x', 3.225, 0, 0));
  rail.add(box(0.6, 1.6, 0.28, HARD, 'x', 2.55, 0, 0.46));
  rail.add(box(0.6, 1.6, 0.28, HARD, 'x', 2.55, 0, -0.46));
  group.add(rail);
  // the pin: a pale dowel, grain along its length
  const pin = new Mesh(new CylinderGeometry(0.3, 0.3, 3.4, 40), [HINO.sideRot, HINO.end, HINO.end]);
  pin.castShadow = true;
  group.add(pin);
  // a second pale member, entering from the front
  const rail2 = new Group();
  rail2.add(box(3, 3, 10, HINO, 'z', 0, -5.2, 6.6));
  group.add(rail2);
  group.rotation.set(0.12, -0.62, 0);

  const pose = (p: number) => {
    const a = ease(clamp(p / 0.75, 0, 1));
    const b = ease(clamp((p - 0.72) / 0.28, 0, 1));
    rail.position.set(-7.2 * (1 - a), 0.9 * (1 - a), 0);
    rail.rotation.set(0, 0.22 * (1 - a), -0.05 * (1 - a));
    pin.position.set(2.55 + rail.position.x, (7.5 + rail.position.y) * (1 - b), 0);
    pin.rotation.z = 0.35 * (1 - b);
    rail2.position.z = 3.2 * (1 - a);
  };

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const narrow = w < 820;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    camera.position.set(14, 17, 24);
    camera.lookAt(0, 0, 0);
    const off = narrow ? 0 : 4.6;
    group.position.set(off, narrow ? 3.5 : 0, -off * 0.6);
    group.scale.setScalar(narrow ? 0.7 : 1);
    draw();
  };

  // A damped follow of the reader's progress, drawn only while it is still moving.
  let target = 0;
  let current = 0;
  let frame = 0;
  let visible = true;
  const step = () => {
    frame = 0;
    current += (target - current) * 0.08;
    if (Math.abs(target - current) < 0.0005) current = target;
    pose(current);
    draw();
    if (current !== target && visible) frame = requestAnimationFrame(step);
  };
  const wake = () => {
    if (frame === 0 && visible) frame = requestAnimationFrame(step);
  };

  pose(0);
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
      }
    },
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      scene.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      renderer.dispose();
    },
  };
}
