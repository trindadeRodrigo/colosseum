import type { CSSProperties } from 'react';

// The partner's skin (embed-shell.md; token-mapping.md section 8): the colours, face and radius the
// host app hands the embed. The embed is a page in a frame, and a frame does not inherit its host's
// CSS, so the host names them in the frame's address (`?fg=…&bg=…`). Each value is taken only in a
// form that can be nothing but what it says: a colour, a length, a list of font names. Anything else
// is dropped, and the system's own colours stand in (`Canvas`, `CanvasText`, `GrayText`).

export type PartnerTheme = {
  fg?: string;
  bg?: string;
  muted?: string;
  border?: string;
  accent?: string;
  font?: string;
  mono?: string;
  radius?: string;
  /** The host's colour scheme, for the system colours when it sets none of its own. */
  scheme?: 'light' | 'dark';
};

const COLOR =
  /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/+-]{1,60}\))$/i;
const LENGTH = /^(0|\d{1,2}(\.\d{1,2})?(px|rem|em))$/;
const FONT = /^[A-Za-z0-9 ,"'-]{1,80}$/;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();

/** The partner's skin from the frame's address, each value checked. */
export function partnerTheme(params: Record<string, string | string[] | undefined>): PartnerTheme {
  const theme: PartnerTheme = {};
  for (const key of ['fg', 'bg', 'muted', 'border', 'accent'] as const) {
    const v = one(params[key]);
    if (v && COLOR.test(v)) theme[key] = v;
  }
  for (const key of ['font', 'mono'] as const) {
    const v = one(params[key]);
    if (v && FONT.test(v)) theme[key] = v;
  }
  const radius = one(params.radius);
  if (radius && LENGTH.test(radius)) theme.radius = radius;
  const scheme = one(params.scheme);
  if (scheme === 'light' || scheme === 'dark') theme.scheme = scheme;
  return theme;
}

/** The skin as the shell's variables (`tf-embed` in globals.css reads them). */
export function themeStyle(theme: PartnerTheme): CSSProperties {
  const vars: Record<string, string> = {};
  if (theme.fg) vars['--embed-fg'] = theme.fg;
  if (theme.bg) vars['--embed-bg'] = theme.bg;
  if (theme.muted) vars['--embed-muted'] = theme.muted;
  if (theme.border) vars['--embed-border'] = theme.border;
  if (theme.accent) vars['--embed-accent'] = theme.accent;
  if (theme.font) vars['--embed-font'] = theme.font;
  if (theme.mono) vars['--embed-mono'] = theme.mono;
  if (theme.radius) vars['--embed-radius'] = theme.radius;
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

/**
 * The partner's muted colour is too faint on their ground for the hatch (under 4.5:1): the hatch is
 * not drawn and the word MOCK stays (embed-shell.md, "Low-contrast partner muted").
 */
export const hatchTooFaint = (theme: PartnerTheme): boolean => {
  if (!theme.muted || !theme.bg) return false;
  const ratio = contrast(theme.muted, theme.bg);
  return ratio !== null && ratio < 4.5;
};
