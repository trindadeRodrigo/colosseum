import type { CSSProperties } from 'react';

// The partner's skin (embed-shell.md; token-mapping.md section 8): the colours, face and radius the
// host app hands the embed. The embed is a page in a frame, and a frame does not inherit its host's
// CSS, so the host names them in the frame's address (`?fg=…&bg=…`). Each value is taken only in a
// form that can be nothing but what it says: an opaque `#rrggbb` colour, a length (or `pill`), a list
// of font names. Anything else is dropped, and the system's own colours stand in.
//
// Anyone can write that address, on our origin, so the colours are held to a floor: the disclaimer,
// the pins and MOCK must stay readable (binding rules 2 and 3). The ground is taken only with a text
// colour at 4.5:1 or more on it, and neither without the other; the muted colour and the accent (the
// button's ground, under text in the partner's ground) are each taken only at 4.5:1 on the ground,
// and the muted colour is the text colour when none is taken. A colour that cannot be measured
// against a ground the partner named is not taken.

export type PartnerTheme = {
  fg?: string;
  bg?: string;
  muted?: string;
  border?: string;
  accent?: string;
  font?: string;
  mono?: string;
  radius?: string;
  /** The radius of the partner's buttons, when rounder than their boxes; `pill` for a pill. */
  button?: string;
  /** The host's colour scheme, for the system colours when it sets none of its own. */
  scheme?: 'light' | 'dark';
};

const COLOR = /^#[0-9a-f]{6}$/i;
/** WCAG AA for body text: what the disclaimer, the pins and MOCK are drawn at, at least. */
export const FLOOR = 4.5;
const LENGTH = /^(0|\d{1,2}(\.\d{1,2})?(px|rem|em))$/;
const FONT = /^[A-Za-z0-9 ,"'-]{1,80}$/;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();

/** The partner's skin from the frame's address, each value checked. */
export function partnerTheme(params: Record<string, string | string[] | undefined>): PartnerTheme {
  const theme: PartnerTheme = {};
  const color = (key: string) => {
    const v = one(params[key]);
    return v && COLOR.test(v) ? v : undefined;
  };
  const [fg, bg] = [color('fg'), color('bg')];
  if (fg && bg && (contrast(fg, bg) ?? 0) >= FLOOR) {
    theme.fg = fg;
    theme.bg = bg;
    for (const key of ['muted', 'accent'] as const) {
      const v = color(key);
      if (v && (contrast(v, bg) ?? 0) >= FLOOR) theme[key] = v;
    }
    theme.border = color('border');
    if (!theme.border) delete theme.border;
  }
  for (const key of ['font', 'mono'] as const) {
    const v = one(params[key]);
    if (v && FONT.test(v)) theme[key] = v;
  }
  const radius = one(params.radius);
  if (radius && LENGTH.test(radius)) theme.radius = radius;
  const button = one(params.button);
  if (button === 'pill') theme.button = '999px';
  else if (button && LENGTH.test(button)) theme.button = button;
  const scheme = one(params.scheme);
  if (scheme === 'light' || scheme === 'dark') theme.scheme = scheme;
  return theme;
}

/** The skin as the shell's variables (`tf-embed` in globals.css reads them). */
export function themeStyle(theme: PartnerTheme): CSSProperties {
  const vars: Record<string, string> = {};
  if (theme.fg) vars['--embed-fg'] = theme.fg;
  if (theme.bg) vars['--embed-bg'] = theme.bg;
  if (theme.muted ?? theme.fg) vars['--embed-muted'] = theme.muted ?? (theme.fg as string);
  if (theme.border) vars['--embed-border'] = theme.border;
  if (theme.accent) vars['--embed-accent'] = theme.accent;
  if (theme.font) vars['--embed-font'] = theme.font;
  if (theme.mono) vars['--embed-mono'] = theme.mono;
  if (theme.radius) vars['--embed-radius'] = theme.radius;
  if (theme.button) vars['--embed-button-radius'] = theme.button;
  if (theme.scheme) vars.colorScheme = theme.scheme;
  return vars as CSSProperties;
}

/** sRGB relative luminance of a `#rgb` or `#rrggbb` colour; null for any other form. */
function luminance(color: string): number | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast of two colours, or null when either is not a plain hex colour. */
export function contrast(a: string, b: string): number | null {
  const [la, lb] = [luminance(a), luminance(b)];
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
