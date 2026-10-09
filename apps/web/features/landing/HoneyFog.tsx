'use client';
import { useEffect, useRef } from 'react';

// The honey fog behind the hero (IDENTITY-2: gradients only as light, a honey glow behind heroes).
// A slow, low-contrast cloud of the brand colour, drawn by a small fragment shader: domain-warped
// noise under a soft halo that drifts toward the upper right. It moves at a crawl (a full drift takes
// minutes), renders at half resolution since it has no edges, pauses when the tab is hidden or the
// hero is off screen, and under reduced motion draws one still frame. With no WebGL the ground shows
// alone. The colour is read from `--primary`, so it follows the theme.

const VERTEX = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_honey;
uniform float u_strength;

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
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = u_time;

  // Broad, slow swirls: large scales and a gentle warp, so it reads as fog and not as smoke.
  vec2 q = vec2(fbm(p * 0.9 + vec2(0.0, t * 0.6)), fbm(p * 0.9 + vec2(5.2, -t * 0.5)));
  vec2 r = vec2(fbm(p * 0.8 + 1.6 * q + vec2(1.7, 9.2) + t * 0.3),
                fbm(p * 0.8 + 1.6 * q + vec2(8.3, 2.8) - t * 0.25));
  float cloud = smoothstep(0.25, 0.95, fbm(p * 0.7 + 1.8 * r));

  // The halo's centre wanders slowly around the upper right of the hero.
  vec2 c = vec2(aspect * (0.70 + 0.07 * sin(t * 0.7)), 0.60 + 0.08 * cos(t * 0.5));
  float d = length((p - c) * vec2(0.8, 1.0));
  float halo = exp(-d * d * 2.0);

  float a = halo * (0.55 + 0.45 * cloud) * u_strength;
  // A whisper of dither, so the soft falloff does not band on 8-bit screens.
  a += (hash(gl_FragCoord.xy + t) - 0.5) / 255.0;
  a = clamp(a, 0.0, 1.0);
  gl_FragColor = vec4(u_honey * a, a);
}
`;

/** Seconds of wall time to one unit of shader time: the drift is meant to be barely seen. */
const PACE = 0.018;
/** The fog has no edges: half the pixels look the same and cost a quarter. */
const SCALE = 0.5;
/** How strong the fog is on each ground: low contrast, quieter still on paper. */
const STRENGTH = { dark: 0.34, light: 0.22 } as const;
const FRAME_MS = 1000 / 30;

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

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function HoneyFog({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    // A canvas of its own for each mount: the context is let go when the effect is, and a canvas whose
    // context was lost hands the same dead context back (a remount, or React's double run in dev).
    const canvas = document.createElement('canvas');
    canvas.className = 'block size-full';
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false });
    if (!gl) return;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    host.appendChild(canvas);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(program, 'u_res');
    const uTime = gl.getUniformLocation(program, 'u_time');
    const uHoney = gl.getUniformLocation(program, 'u_honey');
    const uStrength = gl.getUniformLocation(program, 'u_strength');

    const root = document.documentElement;
    const paint = () => {
      const style = getComputedStyle(canvas);
      const honey = rgbOf(style.getPropertyValue('--primary').trim() || '#F5A83A');
      if (honey) gl.uniform3f(uHoney, ...honey);
      const dark =
        root.classList.contains('dark') ||
        (root.classList.contains('tf-auto') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      gl.uniform1f(uStrength, dark ? STRENGTH.dark : STRENGTH.light);
    };
    paint();
    const themeWatch = new MutationObserver(paint);
    themeWatch.observe(root, { attributes: true, attributeFilter: ['class'] });

    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * SCALE));
      const h = Math.max(1, Math.round(canvas.clientHeight * SCALE));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uRes, w, h);
      }
    };
    // A fixed offset, so the first frame is already a formed cloud rather than the noise's origin.
    const start = performance.now() - 40_000;
    const draw = (now: number) => {
      gl.uniform1f(uTime, ((now - start) / 1000) * PACE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sized = new ResizeObserver(() => {
      resize();
      if (still) draw(performance.now());
    });
    sized.observe(canvas);
    resize();

    let frame = 0;
    let last = 0;
    let visible = true;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      last = now;
      draw(now);
    };
    const run = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (still) draw(performance.now());
      else if (visible && !document.hidden) frame = requestAnimationFrame(loop);
    };
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      run();
    });
    seen.observe(canvas);
    document.addEventListener('visibilitychange', run);
    run();

    return () => {
      cancelAnimationFrame(frame);
      themeWatch.disconnect();
      sized.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', run);
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
