// Colour arithmetic for the tests: reading a CSS colour, its contrast against another (WCAG 2.2), and
// whether it is a blue or a violet. No library: the sums are short and the tests should not lean on
// a package the app does not ship.

export type Rgb = { r: number; g: number; b: number; a: number };
export type Oklch = { l: number; c: number; h: number };

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function fromOklab(l: number, a: number, b: number, alpha: number): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp(toGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    g: clamp(toGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    b: clamp(toGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
    a: alpha,
  };
}

function fromLab(l: number, a: number, b: number, alpha: number): Rgb {
  // CIE Lab (D50) to XYZ, adapted to D65 (Bradford), to linear sRGB.
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const x = (fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * 0.96422;
  const y = l > k * e ? fy ** 3 : l / k;
  const z = (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * 0.82521;
  const X = 0.9555766 * x - 0.0230393 * y + 0.0631636 * z;
  const Y = -0.0282895 * x + 1.0099416 * y + 0.0210077 * z;
  const Z = 0.0122982 * x - 0.020483 * y + 1.3299098 * z;
  return {
    r: clamp(toGamma(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z)),
    g: clamp(toGamma(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z)),
    b: clamp(toGamma(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z)),
    a: alpha,
  };
}

function fromHsl(h: number, s: number, l: number, alpha: number): Rgb {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0), g: f(8), b: f(4), a: alpha };
}

/** A number or a percentage, as a fraction of `whole`. */
function part(token: string, whole: number): number {
  if (token === 'none') return 0;
  return token.endsWith('%') ? (Number.parseFloat(token) / 100) * whole : Number.parseFloat(token);
}
const angle = (token: string) =>
  token.endsWith('turn')
    ? Number.parseFloat(token) * 360
    : token.endsWith('rad')
      ? (Number.parseFloat(token) * 180) / Math.PI
      : Number.parseFloat(token);

/** The CSS named colours whose hue is a blue or a violet (worked out once, with the rule below). */
export const BLUE_NAMES = new Set(
  'aliceblue blue blueviolet cornflowerblue darkblue darkmagenta darkorchid darkslateblue darkviolet deepskyblue dodgerblue fuchsia ghostwhite indigo lavender lightblue lightskyblue lightslategray lightslategrey lightsteelblue magenta mediumblue mediumorchid mediumpurple mediumslateblue midnightblue navy orchid plum powderblue purple rebeccapurple royalblue skyblue slateblue slategray slategrey steelblue thistle violet'.split(
    ' ',
  ),
);

const FUNCTION = /^(rgba?|hsla?|oklch|oklab|lab|lch)\(([^()]*)\)$/i;

/** Reads one CSS colour: hex, rgb(), hsl(), oklch(), oklab(), lab(), lch(). Null for anything else. */
export function parseColor(input: string): Rgb | null {
  const text = input.trim().toLowerCase();
  if (text === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (text === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex !== undefined) {
    if (![3, 4, 6, 8].includes(hex.length)) return null;
    const wide = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const at = (i: number) => Number.parseInt(wide.slice(i, i + 2), 16) / 255;
    return { r: at(0), g: at(2), b: at(4), a: wide.length === 8 ? at(6) : 1 };
  }
  const call = FUNCTION.exec(text);
  if (!call) return null;
  const name = call[1] as string;
  const [channels = '', slashAlpha] = (call[2] as string).split('/');
  const p = channels.split(/[\s,]+/).filter(Boolean);
  // the old comma form carries alpha as a fourth value
  const alphaPart = slashAlpha ?? (p.length === 4 ? p.pop() : undefined);
  if (p.length !== 3 || p.some((t) => !/^(none|[-+]?[\d.]+(e-?\d+)?(%|deg|rad|turn)?)$/.test(t)))
    return null;
  const [a, b, c] = p as [string, string, string];
  const alpha = alphaPart === undefined ? 1 : clamp(part(alphaPart.trim(), 1));
  if (name.startsWith('rgb'))
    return {
      r: clamp(part(a, 255) / 255),
      g: clamp(part(b, 255) / 255),
      b: clamp(part(c, 255) / 255),
      a: alpha,
    };
  if (name.startsWith('hsl'))
    return fromHsl(((angle(a) % 360) + 360) % 360, part(b, 1), part(c, 1), alpha);
  if (name === 'oklab') return fromOklab(part(a, 1), part(b, 0.4), part(c, 0.4), alpha);
  if (name === 'oklch') {
    const h = (angle(c) * Math.PI) / 180;
    const chroma = part(b, 0.4);
    return fromOklab(part(a, 1), chroma * Math.cos(h), chroma * Math.sin(h), alpha);
  }
  if (name === 'lab') return fromLab(part(a, 100), part(b, 125), part(c, 125), alpha);
  const h = (angle(c) * Math.PI) / 180;
  const chroma = part(b, 150);
  return fromLab(part(a, 100), chroma * Math.cos(h), chroma * Math.sin(h), alpha);
}

export function toHex({ r, g, b }: Rgb): string {
  const byte = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase();
}

export function toOklch({ r, g, b }: Rgb): Oklch {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(Bb, A) * 180) / Math.PI;
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.hypot(A, Bb),
    h: h < 0 ? h + 360 : h,
  };
}

/**
 * The rule for "no blue or violet" (STYLE.md, rule 6), as a number. A colour is one when its hue, in
 * OKLCH, lies between 200° and 330° (cyan-blue through blue, indigo, violet and purple to magenta)
 * and it has a tint to speak of: a chroma of 0.03 or more. The grounds of IDENTITY-2 are cool greys
 * with a trace of blue on purpose (night #0C0D12 is 0.011, line-2 #363B4B 0.029, the most), so a cool
 * grey passes and a blue does not: a pale sky blue (#CAE3F4, 0.035) is caught. Chalk (#78B4E8 /
 * #2A73B0, 0.10 to 0.12) is a blue by this rule, and is allowed only by name, as a line
 * (test/forbidden.ts, CHALK).
 */
export const BLUE = { from: 200, to: 330, chroma: 0.03 } as const;

export function isBlueOrViolet(color: Rgb): boolean {
  if (color.a === 0) return false;
  const { c, h } = toOklch(color);
  return c >= BLUE.chroma && h >= BLUE.from && h <= BLUE.to;
}

/** Every colour written in a piece of CSS or source text: hex, colour functions, and blue names. */
export function colorsIn(text: string): string[] {
  const found: string[] = [];
  const fn = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^()]*\)/gi;
  for (const m of text.matchAll(fn)) found.push(m[0]);
  for (const m of text.replace(fn, ' ').matchAll(/#[0-9a-fA-F]{3,8}\b/g))
    if ([4, 5, 7, 9].includes(m[0].length)) found.push(m[0]);
  return found;
}

const luminance = ({ r, g, b }: Rgb) =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

/** The WCAG 2.2 contrast ratio of two opaque colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
