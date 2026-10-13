'use client';
import { useEffect, useRef } from 'react';

// The honey fog (IDENTITY-2: gradients only as light; LANDING-HERO: "animated like a chroma halo, with
// much slower pace and lower contrast"). Two layers in one WebGL2 context:
// - an ambient fog, always there: domain-warped noise under a halo that drifts round the upper right;
// - a small fluid simulation (stable fluids: advect, curl, divergence, pressure, project) that the
//   pointer stirs: moving over the area pours honey into the fluid, which swirls, drifts and fades.
//   With no pointer, an invisible cursor wanders slowly and stirs it on its own, and the visitor's
//   pointer takes over again as soon as it moves.
// On a dark ground the fluid is light smoke in honey; on paper it is ink, deeper honey that darkens
// where it gathers, so it keeps its contrast. Everything runs at a crawl, at reduced resolution,
// paused when the tab is hidden or the area is off screen. Under reduced motion it draws the ambient
// fog once and takes no pointer. With no WebGL2 the ground shows alone.

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 vUv;
void main() { vUv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
`;

const SPLAT = `${HEAD}
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec2 uPoint;
uniform vec3 uValue;
uniform float uRadius;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 add = exp(-dot(p, p) / uRadius) * uValue;
  outColor = vec4(texture(uTarget, vUv).xyz + add, 1.0);
}
`;

const ADVECT = `${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
uniform float uDissipation;
void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  outColor = texture(uSource, coord) / (1.0 + uDissipation * uDt);
}
`;

const CURL = `${HEAD}
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}
`;

const VORTICITY = `${HEAD}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uDt;
void main() {
  float l = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float c = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 0.0001;
  force *= uStrength * c;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + force * uDt;
  outColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}
`;

const DIVERGENCE = `${HEAD}
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  outColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}
`;

const PRESSURE = `${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float d = texture(uDivergence, vUv).x;
  outColor = vec4((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0);
}
`;

const GRADIENT = `${HEAD}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 v = texture(uVelocity, vUv).xy - vec2(r - l, t - b);
  outColor = vec4(v, 0.0, 1.0);
}
`;

const SCALE = `${HEAD}
uniform sampler2D uSource;
uniform float uValue;
void main() { outColor = uValue * texture(uSource, vUv); }
`;

const DISPLAY = `${HEAD}
uniform sampler2D uDye;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uHoney;
uniform vec3 uDeep;
uniform float uAmbient;
uniform float uFluid;
uniform float uInk;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  float t = uTime;
  vec2 q = vec2(fbm(p * 0.9 + vec2(0.0, t * 0.6)), fbm(p * 0.9 + vec2(5.2, -t * 0.5)));
  vec2 r = vec2(fbm(p * 0.8 + 1.6 * q + vec2(1.7, 9.2) + t * 0.3),
                fbm(p * 0.8 + 1.6 * q + vec2(8.3, 2.8) - t * 0.25));
  float cloud = smoothstep(0.25, 0.95, fbm(p * 0.7 + 1.8 * r));
  vec2 c = vec2(aspect * (0.70 + 0.07 * sin(t * 0.7)), 0.60 + 0.08 * cos(t * 0.5));
  float d = length((p - c) * vec2(0.8, 1.0));
  float halo = exp(-d * d * 2.0);
  float ambient = halo * (0.55 + 0.45 * cloud) * uAmbient;

  // The fluid's density, softened at the edges; on paper, where it gathers it goes to deep honey.
  float density = texture(uDye, vUv).x;
  float fluid = (1.0 - exp(-density * 1.1)) * uFluid;
  vec3 tone = mix(uHoney, uDeep, uInk * smoothstep(0.15, 0.9, fluid));

  float a = clamp(ambient + fluid, 0.0, 0.92);
  vec3 col = mix(uHoney, tone, fluid / max(a, 0.0001));
  a += (hash(gl_FragCoord.xy + t) - 0.5) / 255.0;
  a = clamp(a, 0.0, 1.0);
  outColor = vec4(col * a, a);
}
`;

/** Seconds of wall time to one unit of the ambient fog's time: barely seen to move. */
const PACE = 0.018;
/** The fluid runs slower than real time: a stir unfolds over seconds, not frames. */
const FLUID_PACE = 0.55;
/** How long a stir keeps moving and how long its honey lingers (per second of fluid time). */
const VELOCITY_FADE = 0.35;
const DYE_FADE = 0.9;
const CURL_STRENGTH = 14;
const PRESSURE_STEPS = 18;
/** Brush radius, and how hard a pointer pushes and how much honey it pours. */
const RADIUS = 0.0035;
const FORCE = 2.2;
const POUR = 0.09;
/** The invisible cursor: its speed, and how long the real one must rest before it takes over. */
const WANDER = 0.05;
const IDLE_MS = 1800;
/** Each ground's strength: ambient fog and fluid. On paper both are stronger, in deeper honey. */
const LOOK = {
  dark: { ambient: 0.34, fluid: 0.3, ink: 0 },
  light: { ambient: 0.6, fluid: 0.5, ink: 1 },
} as const;
const FRAME_MS = 1000 / 45;

/** The colour a CSS colour string resolves to, as 0–1 RGB, whatever syntax the token uses. */
function rgbOf(color: string): [number, number, number] | null {
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const g = probe.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#000';
  g.fillStyle = color;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  return [r / 255, gr / 255, b / 255];
}

type Program = { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
type Pair = { read: Target; write: Target; swap: () => void };

export function HoneyFog({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    // A canvas of its own for each mount: the context is let go when the effect is, and a canvas whose
    // context was lost hands the same dead context back (a remount, or React's double run in dev).
    const canvas = document.createElement('canvas');
    canvas.className = 'block size-full';
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
    });
    if (!gl) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The fluid needs float targets; without them the ambient fog runs alone.
    const fluidOk = !still && Boolean(gl.getExtension('EXT_color_buffer_float'));

    const compile = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vert = compile(gl.VERTEX_SHADER, VERT);
    const make = (source: string, names: string[]): Program | null => {
      const frag = compile(gl.FRAGMENT_SHADER, source);
      const program = gl.createProgram();
      if (!vert || !frag || !program) return null;
      gl.attachShader(program, vert);
      gl.attachShader(program, frag);
      gl.bindAttribLocation(program, 0, 'a_pos');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
      return {
        program,
        u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])),
      };
    };
    const display = make(DISPLAY, [
      'uDye',
      'uRes',
      'uTime',
      'uHoney',
      'uDeep',
      'uAmbient',
      'uFluid',
      'uInk',
    ]);
    if (!display) return;
    const splat = make(SPLAT, ['uTarget', 'uAspect', 'uPoint', 'uValue', 'uRadius']);
    const advect = make(ADVECT, ['uVelocity', 'uSource', 'uTexel', 'uDt', 'uDissipation']);
    const curl = make(CURL, ['uVelocity', 'uTexel']);
    const vorticity = make(VORTICITY, ['uVelocity', 'uCurl', 'uTexel', 'uStrength', 'uDt']);
    const divergence = make(DIVERGENCE, ['uVelocity', 'uTexel']);
    const pressure = make(PRESSURE, ['uPressure', 'uDivergence', 'uTexel']);
    const gradient = make(GRADIENT, ['uPressure', 'uVelocity', 'uTexel']);
    const scale = make(SCALE, ['uSource', 'uValue']);
    const fluid =
      fluidOk && splat && advect && curl && vorticity && divergence && pressure && gradient && scale
        ? { splat, advect, curl, vorticity, divergence, pressure, gradient, scale }
        : null;
    host.appendChild(canvas);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);

    const target = (w: number, h: number): Target | null => {
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      if (!tex || !fbo) return null;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo, w, h };
    };
    const pair = (w: number, h: number): Pair | null => {
      const a = target(w, h);
      const b = target(w, h);
      if (!a || !b) return null;
      const p: Pair = {
        read: a,
        write: b,
        swap: () => {
          [p.read, p.write] = [p.write, p.read];
        },
      };
      return p;
    };
    const free = (t?: Target | null) => {
      if (!t) return;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    };
    // An empty dye for the ambient-only case: the display always samples something.
    const blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

    let sim: {
      velocity: Pair;
      dye: Pair;
      pressure: Pair;
      curl: Target;
      divergence: Target;
    } | null = null;
    const sizeSim = () => {
      if (!fluid) return;
      const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      const dims = (base: number) =>
        aspect >= 1
          ? [Math.round(base * aspect), base]
          : [base, Math.round(base / Math.max(aspect, 0.01))];
      const [vw = 1, vh = 1] = dims(96);
      const [dw = 1, dh = 1] = dims(384);
      if (sim) {
        for (const p of [sim.velocity, sim.dye, sim.pressure]) {
          free(p.read);
          free(p.write);
        }
        free(sim.curl);
        free(sim.divergence);
      }
      const velocity = pair(vw, vh);
      const dye = pair(dw, dh);
      const press = pair(vw, vh);
      const c = target(vw, vh);
      const d = target(vw, vh);
      sim =
        velocity && dye && press && c && d
          ? { velocity, dye, pressure: press, curl: c, divergence: d }
          : null;
    };

    const bindTex = (unit: number, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      return unit;
    };
    const run = (p: Program, out: Target | null, set: () => void) => {
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
      gl.useProgram(p.program);
      set();
      if (out) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
        gl.viewport(0, 0, out.w, out.h);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    /** Pours honey and pushes the fluid at a point (0–1, from the bottom left), with a push in uv/s. */
    const stir = (x: number, y: number, dx: number, dy: number, amount: number) => {
      if (!fluid || !sim) return;
      const s = sim;
      const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      run(fluid.splat, s.velocity.write, () => {
        gl.uniform1i(fluid.splat.u.uTarget ?? null, bindTex(0, s.velocity.read.tex));
        gl.uniform1f(fluid.splat.u.uAspect ?? null, aspect);
        gl.uniform2f(fluid.splat.u.uPoint ?? null, x, y);
        gl.uniform3f(fluid.splat.u.uValue ?? null, dx, dy, 0);
        gl.uniform1f(fluid.splat.u.uRadius ?? null, RADIUS * 1.6);
      });
      s.velocity.swap();
      run(fluid.splat, s.dye.write, () => {
        gl.uniform1i(fluid.splat.u.uTarget ?? null, bindTex(0, s.dye.read.tex));
        gl.uniform1f(fluid.splat.u.uAspect ?? null, aspect);
        gl.uniform2f(fluid.splat.u.uPoint ?? null, x, y);
        gl.uniform3f(fluid.splat.u.uValue ?? null, amount, 0, 0);
        gl.uniform1f(fluid.splat.u.uRadius ?? null, RADIUS);
      });
      s.dye.swap();
    };

    const step = (dt: number) => {
      if (!fluid || !sim) return;
      const s = sim;
      const vt = [1 / s.velocity.read.w, 1 / s.velocity.read.h] as const;
      run(fluid.curl, s.curl, () => {
        gl.uniform1i(fluid.curl.u.uVelocity ?? null, bindTex(0, s.velocity.read.tex));
        gl.uniform2f(fluid.curl.u.uTexel ?? null, ...vt);
      });
      run(fluid.vorticity, s.velocity.write, () => {
        gl.uniform1i(fluid.vorticity.u.uVelocity ?? null, bindTex(0, s.velocity.read.tex));
        gl.uniform1i(fluid.vorticity.u.uCurl ?? null, bindTex(1, s.curl.tex));
        gl.uniform2f(fluid.vorticity.u.uTexel ?? null, ...vt);
        gl.uniform1f(fluid.vorticity.u.uStrength ?? null, CURL_STRENGTH);
        gl.uniform1f(fluid.vorticity.u.uDt ?? null, dt);
      });
      s.velocity.swap();
      run(fluid.divergence, s.divergence, () => {
        gl.uniform1i(fluid.divergence.u.uVelocity ?? null, bindTex(0, s.velocity.read.tex));
        gl.uniform2f(fluid.divergence.u.uTexel ?? null, ...vt);
      });
      run(fluid.scale, s.pressure.write, () => {
        gl.uniform1i(fluid.scale.u.uSource ?? null, bindTex(0, s.pressure.read.tex));
        gl.uniform1f(fluid.scale.u.uValue ?? null, 0.8);
      });
      s.pressure.swap();
      for (let i = 0; i < PRESSURE_STEPS; i++) {
        run(fluid.pressure, s.pressure.write, () => {
          gl.uniform1i(fluid.pressure.u.uPressure ?? null, bindTex(0, s.pressure.read.tex));
          gl.uniform1i(fluid.pressure.u.uDivergence ?? null, bindTex(1, s.divergence.tex));
          gl.uniform2f(fluid.pressure.u.uTexel ?? null, ...vt);
        });
        s.pressure.swap();
      }
      run(fluid.gradient, s.velocity.write, () => {
        gl.uniform1i(fluid.gradient.u.uPressure ?? null, bindTex(0, s.pressure.read.tex));
        gl.uniform1i(fluid.gradient.u.uVelocity ?? null, bindTex(1, s.velocity.read.tex));
        gl.uniform2f(fluid.gradient.u.uTexel ?? null, ...vt);
      });
      s.velocity.swap();
      run(fluid.advect, s.velocity.write, () => {
        gl.uniform1i(fluid.advect.u.uVelocity ?? null, bindTex(0, s.velocity.read.tex));
        gl.uniform1i(fluid.advect.u.uSource ?? null, bindTex(1, s.velocity.read.tex));
        gl.uniform2f(fluid.advect.u.uTexel ?? null, ...vt);
        gl.uniform1f(fluid.advect.u.uDt ?? null, dt);
        gl.uniform1f(fluid.advect.u.uDissipation ?? null, VELOCITY_FADE);
      });
      s.velocity.swap();
      run(fluid.advect, s.dye.write, () => {
        gl.uniform1i(fluid.advect.u.uVelocity ?? null, bindTex(0, s.velocity.read.tex));
        gl.uniform1i(fluid.advect.u.uSource ?? null, bindTex(1, s.dye.read.tex));
        gl.uniform2f(fluid.advect.u.uTexel ?? null, ...vt);
        gl.uniform1f(fluid.advect.u.uDt ?? null, dt);
        gl.uniform1f(fluid.advect.u.uDissipation ?? null, DYE_FADE);
      });
      s.dye.swap();
    };

    // The look of the ground: the honey, its deep tone, and the strengths for dark or paper.
    const root = document.documentElement;
    let look: (typeof LOOK)[keyof typeof LOOK] = LOOK.dark;
    let honey: [number, number, number] = [0.96, 0.66, 0.23];
    let deep: [number, number, number] = [0.85, 0.53, 0.11];
    const paint = () => {
      const style = getComputedStyle(host);
      honey = rgbOf(style.getPropertyValue('--primary').trim() || '#F5A83A') ?? honey;
      deep = rgbOf(style.getPropertyValue('--tf-honey-deep').trim() || '#D9881B') ?? deep;
      const dark =
        root.classList.contains('dark') ||
        (root.classList.contains('tf-auto') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      look = dark ? LOOK.dark : LOOK.light;
    };
    paint();
    const themeWatch = new MutationObserver(() => {
      paint();
      if (still) draw(performance.now());
    });
    themeWatch.observe(root, { attributes: true, attributeFilter: ['class'] });

    const start = performance.now() - 40_000;
    const draw = (now: number) => {
      run(display, null, () => {
        const u = display.u;
        gl.uniform1i(u.uDye ?? null, bindTex(0, sim ? sim.dye.read.tex : (blank as WebGLTexture)));
        gl.uniform2f(u.uRes ?? null, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.uniform1f(u.uTime ?? null, ((now - start) / 1000) * PACE);
        gl.uniform3f(u.uHoney ?? null, ...honey);
        gl.uniform3f(u.uDeep ?? null, ...deep);
        gl.uniform1f(u.uAmbient ?? null, look.ambient);
        gl.uniform1f(u.uFluid ?? null, sim ? look.fluid : 0);
        gl.uniform1f(u.uInk ?? null, look.ink);
      });
    };

    const resize = () => {
      const ratio = 0.5 * Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      sizeSim();
      if (still) draw(performance.now());
    };
    const sized = new ResizeObserver(resize);
    sized.observe(canvas);
    resize();

    // The pointer: it stirs only over the area. Listened for on the window, so copy and buttons above
    // the fog do not block it.
    let pointer: { x: number; y: number; at: number } | null = null;
    let lastMove = -Infinity;
    const onMove = (e: PointerEvent) => {
      if (!fluid) return;
      const box = canvas.getBoundingClientRect();
      const x = (e.clientX - box.left) / box.width;
      const y = 1 - (e.clientY - box.top) / box.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        pointer = null;
        return;
      }
      const now = performance.now();
      if (pointer) {
        const dx = (x - pointer.x) * box.width;
        const dy = (y - pointer.y) * box.height;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) stir(x, y, dx * FORCE, dy * FORCE, POUR);
      }
      pointer = { x, y, at: now };
      lastMove = now;
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    // The invisible cursor: a slow loop through the right of the area while the real one rests.
    let wander = Math.random() * 100;
    let ghost: { x: number; y: number } | null = null;
    const wanderStep = (now: number, dt: number) => {
      if (!fluid || now - lastMove < IDLE_MS) {
        ghost = null;
        return;
      }
      wander += dt * WANDER;
      const x = 0.68 + 0.2 * Math.sin(wander * 1.3) * Math.cos(wander * 0.7);
      const y = 0.55 + 0.25 * Math.sin(wander * 0.9 + 1.2);
      if (ghost) {
        const box = canvas.getBoundingClientRect();
        const dx = (x - ghost.x) * box.width;
        const dy = (y - ghost.y) * box.height;
        stir(x, y, dx * FORCE * 1.2, dy * FORCE * 1.2, POUR * 0.3);
      }
      ghost = { x, y };
    };

    let frame = 0;
    let last = 0;
    let visible = true;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 45;
      last = now;
      wanderStep(now, dt * 60);
      step(dt * FLUID_PACE);
      draw(now);
    };
    const go = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (still) draw(performance.now());
      else if (visible && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      go();
    });
    seen.observe(canvas);
    document.addEventListener('visibilitychange', go);
    go();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      themeWatch.disconnect();
      sized.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', go);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-ui="honey-fog"
      className={className ?? 'pointer-events-none absolute inset-0 size-full'}
    />
  );
}
