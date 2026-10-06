import { Color, Matrix3, MeshStandardMaterial, type Vector2, type Vector3 } from 'three';
import { MM } from './joint-geometry';

// The wood of the joint, grown rather than wrapped: each piece is cut from a log whose pith runs
// along its grain, and every point of it takes its colour from how far it lies from that pith. So the
// long faces show the rings as straight and wandering lines, the end faces show them as arcs, and at
// every chamfer the two meet as they do in a real board. Nothing is downloaded: the rings, the fibre,
// the open pores of the hardwood and the saw marks on the end grain are computed where they are seen,
// in millimetres, at his scale (hinoki rings 1–3 mm apart; imagery-style.md §2).
//
// The same shader darkens what the other pieces hide from the room (an occlusion term measured
// against the real shapes of the post, the rail and the pin, wherever they stand), so a piece reads
// as near another before it touches it, and the inside of the mortise stays in shadow.

export type Species = {
  early: string;
  late: string;
  /** Mean distance between growth rings, mm. */
  ring: number;
  /** The share of each ring that is latewood. */
  lateShare: number;
  /** How far the latewood is from the earlywood in colour, 0..1. */
  contrast: number;
  /** How strongly the fibre streaks show, 0..1. */
  fibre: number;
  /** Open pores in the earlywood (a ring-porous hardwood), 0..1. */
  pores: number;
  /** How much darker the end grain is, as a factor. */
  endShade: number;
  roughSide: number;
  roughEnd: number;
};

export const HINOKI: Species = {
  early: '#e6d2ae',
  late: '#cfb187',
  ring: 1.7,
  lateShare: 0.22,
  contrast: 0.7,
  fibre: 0.3,
  pores: 0,
  endShade: 0.8,
  roughSide: 0.44,
  roughEnd: 0.78,
};

export const HARDWOOD: Species = {
  early: '#856447',
  late: '#5f452e',
  ring: 4.2,
  lateShare: 0.5,
  contrast: 0.42,
  fibre: 1,
  pores: 1,
  endShade: 0.7,
  roughSide: 0.5,
  roughEnd: 0.8,
};

/** What every piece's shader shares: where the moving pieces stand, the light's mood, the grain. */
export type Shared = {
  uRail: { value: number };
  uPin: { value: number };
  uLower: { value: number };
  uAo: { value: number };
  uGrain: { value: number };
  uFrame: { value: number };
  uContrastCurve: { value: number };
  uSaturation: { value: number };
};

export function sharedUniforms(): Shared {
  return {
    uRail: { value: 0 },
    uPin: { value: 0 },
    uLower: { value: 0 },
    uAo: { value: 1 },
    uGrain: { value: 0.012 },
    uFrame: { value: 0 },
    uContrastCurve: { value: 0 },
    uSaturation: { value: 1 },
  };
}

type Cut = {
  /** The piece's grain axis and two axes across it, in its own coordinates. */
  grain: Vector3;
  across: [Vector3, Vector3];
  /** Where the pith of its log lies, in the across axes, mm. */
  pith: Vector2;
  /** How far the pith drifts across the piece for each mm along it. */
  runout: Vector2;
  seed: number;
  /** The piece's own origin in the assembly, mm, apart from the shared motion. */
  origin: Vector3;
  moves: 'none' | 'rail' | 'pin' | 'lower';
};

/** A number as a GLSL float literal. */
const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

const GLSL_HEAD = /* glsl */ `
uniform mat3 uBasis;
uniform vec2 uPith;
uniform vec2 uRunout;
uniform float uSeed;
uniform vec3 uEarly;
uniform vec3 uLateC;
uniform float uRing;
uniform float uLateShare;
uniform float uContrast;
uniform float uPores;
uniform float uFibre;
uniform float uEndShade;
uniform float uRoughSide;
uniform float uRoughEnd;
uniform vec3 uOrigin;
uniform float uMoves;
uniform float uRail;
uniform float uPin;
uniform float uLower;
uniform float uAo;
uniform float uGrain;
uniform float uFrame;
uniform float uContrastCurve;
uniform float uSaturation;
uniform float uWorldPerMM;
varying vec3 vLocal;
varying vec3 vLocalN;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
        mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
        mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y),
    u.z);
}

// --- the pieces as distance fields, in assembly millimetres -------------------------------------
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float sdCylY(vec3 p, float r, float h) {
  vec2 d = vec2(length(p.xz) - r, abs(p.y) - h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
float sdJoint(vec3 p) {
  float post = max(
    sdBox(p - vec3(0.0, ${f((MM.post.top + MM.post.bottom) / 2)}, 0.0),
          vec3(${f(MM.post.w / 2)}, ${f((MM.post.top - MM.post.bottom) / 2)}, ${f(MM.post.w / 2)})),
    -sdBox(p, vec3(${f(MM.post.w)}, ${f(MM.mortise.h / 2)}, ${f(MM.mortise.w / 2)})));
  float sx = ${f(-MM.post.w / 2)} - uRail;
  float body = sdBox(p - vec3(sx - ${f(MM.rail.len / 2)}, 0.0, 0.0),
                     vec3(${f(MM.rail.len / 2)}, ${f(MM.rail.h / 2)}, ${f(MM.rail.w / 2)}));
  float tenon = max(
    sdBox(p - vec3(sx + ${f(MM.tenon.len / 2)}, 0.0, 0.0),
          vec3(${f(MM.tenon.len / 2)}, ${f(MM.tenon.h / 2)}, ${f(MM.tenon.w / 2)})),
    -(length(p.xz - vec2(sx + ${f(MM.pin.at)}, 0.0)) - ${f(MM.hole.d / 2)}));
  vec3 pc = vec3(${f(-MM.post.w / 2 + MM.pin.at)} - uRail, uPin, 0.0);
  float pin = sdCylY(p - pc, ${f(MM.pin.d / 2)}, ${f(MM.pin.len / 2)});
  float lower = sdBox(
    p - vec3(0.0, ${f(MM.lower.y)}, ${f(MM.post.w / 2 + MM.lower.len / 2)} + uLower),
    vec3(${f(MM.lower.w / 2)}, ${f(MM.lower.h / 2)}, ${f(MM.lower.len / 2)}));
  return min(min(post, body), min(min(tenon, pin), lower));
}
float jointAo(vec3 p, vec3 n) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 2.0 * exp2(float(i));
    occ += w * max(0.0, h - sdJoint(p + n * h)) / h;
    w *= 0.62;
  }
  return clamp(1.0 - 0.5 * occ, 0.0, 1.0);
}
`;

// The wood itself, inlined into main() so its screen-space derivatives are taken in uniform flow.
const GLSL_WOOD = /* glsl */ `
  vec3 wq = uBasis * vLocal;               // x, y across the grain, z along it; mm
  vec3 wn = uBasis * normalize(vLocalN);
  float endness = smoothstep(0.55, 0.9, abs(wn.z));
  vec3 sd = vec3(uSeed * 17.0, uSeed * 31.0, uSeed * 7.0);
  // the rings wander slowly across and very slowly along the grain
  float warp = (vnoise(vec3(wq.xy * 0.018, wq.z * 0.0022) + sd) - 0.5) * 5.0
             + (vnoise(vec3(wq.xy * 0.07, wq.z * 0.004) + sd.zxy) - 0.5) * 0.6;
  // the log was not sawn quite true to its pith, so the rings run out of the faces in long tapers
  float r = length(wq.xy - uPith - uRunout * wq.z) + warp;
  float t = r / uRing;
  t += 2.2 * (vnoise(vec3(t * 0.13, uSeed, 0.5)) - 0.5) + 0.8 * (vnoise(vec3(t * 0.6, uSeed, 2.5)) - 0.5);   // some years grew more than others
  float year = floor(t);
  float f = fract(t);
  float yearRand = hash11(year + uSeed * 13.0);
  float share = uLateShare * (0.65 + 0.7 * yearRand);
  // earlywood darkens slowly into the latewood, which ends sharply at the next year's start
  float late = smoothstep(1.0 - share - 0.12, 1.0 - share * 0.35, f) * (1.0 - smoothstep(0.985, 1.0, f));
  float ringBlur = smoothstep(0.25, 0.9, fwidth(t));
  late = mix(late, share * 0.75, ringBlur);
  // fibre: fine streaks along the grain, faded where they would be finer than a pixel
  vec3 fq = vec3(wq.xy * 2.4, wq.z * 0.025);
  float fibreBlur = smoothstep(0.25, 0.8, length(fwidth(wq.xy)) * 2.4);
  float fibre = (vnoise(fq + sd) - 0.5) * (1.0 - fibreBlur) * uFibre;
  float fibre2 = (vnoise(vec3(wq.xy * 0.6, wq.z * 0.006) + sd.yzx) - 0.5) * uFibre;
  // open pores at the start of each year's earlywood
  float poreBand = (1.0 - smoothstep(0.0, 0.32, f)) * (1.0 - ringBlur);
  float pore = smoothstep(0.7, 0.86, vnoise(vec3(wq.xy * 1.6, wq.z * 0.11) + sd.zyx)) * poreBand * uPores;
  float mottle = vnoise(vec3(wq.xy * 0.02, wq.z * 0.004) + sd.yxz);

  vec3 woodColor = mix(uEarly, uLateC, late * uContrast);
  woodColor *= 0.9 + 0.2 * mottle;
  woodColor *= 1.0 + 0.10 * fibre + 0.08 * fibre2;
  woodColor *= 1.0 - 0.5 * pore;
  // end grain drinks the light: darker, a little richer
  woodColor = mix(woodColor, woodColor * uEndShade * vec3(1.0, 0.96, 0.92), endness);

  float woodRough = mix(uRoughSide - 0.08 * late, uRoughEnd, endness) + 0.06 * fibre;
  // height, mm: pores sink, latewood stands a hair proud of planed earlywood; end grain shows the saw
  float saw = sin(dot(wq.xy, vec2(0.83, 0.56)) * 7.0 + vnoise(vec3(wq.xy * 0.4, 1.0) + sd) * 4.0);
  float woodHeight = (-0.05 * pore + 0.0015 * fibre) * (1.0 - endness)
                   + (0.012 * saw * (1.0 - fibreBlur) + 0.01 * (vnoise(vec3(wq.xy * 3.0, 0.0) + sd) - 0.5)
                      - 0.02 * late) * endness;
`;

export function woodMaterial(species: Species, cut: Cut, shared: Shared, worldPerMM: number) {
  const material = new MeshStandardMaterial({ roughness: 0.5, metalness: 0, dithering: true });
  const basis = new Matrix3().set(
    cut.across[0].x,
    cut.across[0].y,
    cut.across[0].z,
    cut.across[1].x,
    cut.across[1].y,
    cut.across[1].z,
    cut.grain.x,
    cut.grain.y,
    cut.grain.z,
  );
  const own = {
    uBasis: { value: basis },
    uPith: { value: cut.pith },
    uRunout: { value: cut.runout },
    uSeed: { value: cut.seed },
    uEarly: { value: new Color(species.early) },
    uLateC: { value: new Color(species.late) },
    uRing: { value: species.ring },
    uLateShare: { value: species.lateShare },
    uContrast: { value: species.contrast },
    uPores: { value: species.pores },
    uFibre: { value: species.fibre },
    uEndShade: { value: species.endShade },
    uRoughSide: { value: species.roughSide },
    uRoughEnd: { value: species.roughEnd },
    uOrigin: { value: cut.origin.clone() },
    uMoves: { value: ['none', 'rail', 'pin', 'lower'].indexOf(cut.moves) },
    uWorldPerMM: { value: worldPerMM },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own, shared);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vLocal;\nvarying vec3 vLocalN;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvLocal = position;\nvLocalN = normal;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_HEAD}`)
      .replace('#include <map_fragment>', `${GLSL_WOOD}\n  diffuseColor.rgb = woodColor;`)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(woodRough, 0.2, 0.95);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
  {
    // bump from the wood's height, in view space (perturbNormalArb, Mikkelsen 2010)
    float hv = woodHeight * uWorldPerMM;
    vec3 sx = dFdx(-vViewPosition);
    vec3 sy = dFdy(-vViewPosition);
    vec3 r1 = cross(sy, normal);
    vec3 r2 = cross(normal, sx);
    float det = dot(sx, r1) * faceDirection;
    vec3 grad = sign(det) * (dFdx(hv) * r1 + dFdy(hv) * r2);
    normal = normalize(abs(det) * normal - grad);
  }`,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
  {
    vec3 at = vLocal + uOrigin
      + (uMoves == 1.0 ? vec3(-uRail, 0.0, 0.0)
        : uMoves == 2.0 ? vec3(-uRail, uPin, 0.0)
        : uMoves == 3.0 ? vec3(0.0, 0.0, uLower) : vec3(0.0));
    float ao = mix(1.0, jointAo(at, normalize(vLocalN)), uAo);
    reflectedLight.indirectDiffuse *= ao;
    reflectedLight.indirectSpecular *= ao * ao;
    reflectedLight.directDiffuse *= mix(1.0, ao, 0.45);
  }`,
      )
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, smoothstep(0.0, 1.0, gl_FragColor.rgb), uContrastCurve);
  gl_FragColor.rgb = mix(vec3(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722))), gl_FragColor.rgb, uSaturation);
  gl_FragColor.rgb += (hash13(vec3(gl_FragCoord.xy, uFrame)) - 0.5) * uGrain;`,
      );
  };
  // one program per species is enough: the cut lives in uniforms
  material.customProgramCacheKey = () => 'tf-wood';
  return { material, own };
}
