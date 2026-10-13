import localFont from 'next/font/local';
import { plexMono } from './fonts-mono';

// The three typefaces of the design system (token-mapping.md, section 5; gate IDENTITY-2), from files
// committed with the app (assets/fonts, each under the SIL Open Font License beside it):
// `next/font/local` serves them from this origin, and a build fetches nothing, so it cannot fail for
// want of Google's servers. They are the files Google Fonts serves for the Latin subset: Inter Tight
// (one variable file, weights 100 to 900; the display face, set at 600), Inter (one variable file with
// its optical-size axis; the UI face, 400 to 600) and, in fonts-mono.ts, IBM Plex Mono 400 and 500.
// Each face comes with a fallback whose metrics are adjusted to match it, so text does not move when
// the real face arrives: the fallbacks are written in globals.css with the figures next/font works out
// for these faces (capsize's average widths against Arial's).
//
// The display and the UI face are preloaded on every route whose layout imports this file: the product
// shell and the landing, where they set the first thing a person reads. The mono face lives in
// fonts-mono.ts and is not preloaded. The pages not yet rebuilt import that file only.
//
// There is no condensed face and no serif (IDENTITY-2): `--font-condensed` is Inter Tight. The Latin
// files hold no Greek, so the "τ" and "Σ" Bearing writes in its methods are drawn by the system's face.

// The loader takes its options as written values only, so each file's range of characters is written
// where it is used: the range is the one Google's stylesheet lists for the Latin files.
//
// `next/font/local` would name each face after its export (`inter`). Each is told its own name
// instead (`declarations`, `font-family`), so the stylesheet says Inter Tight, Inter and IBM Plex Mono;
// the variable the loader writes still starts with its own name, which is no face, so the real name
// and the fallback follow it (`fallback`).

/** States: headings, the goal sentence, big numbers. 600 with -0.02em tracking; nothing lighter than 400. */
export const interTight = localFont({
  src: '../assets/fonts/inter-tight-latin-wght.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-inter-tight',
  display: 'swap',
  preload: true,
  declarations: [
    { prop: 'font-family', value: "'Inter Tight'" },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
  // the fallback is written in globals.css ("the fallbacks")
  adjustFontFallback: false,
  fallback: ['Inter Tight', 'Inter Tight Fallback'],
});

/** Explains: body, labels, buttons. 400 body, 500 labels, 600 UI headings; nothing lighter. */
export const inter = localFont({
  src: '../assets/fonts/inter-latin-opsz-wght.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-inter',
  display: 'swap',
  preload: true,
  declarations: [
    { prop: 'font-family', value: "'Inter'" },
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
  adjustFontFallback: false,
  fallback: ['Inter', 'Inter Fallback'],
});

export { plexMono };

/** The class names that define the three `--font-*` variables. They go on `<html>`. */
export const fontVariables = `${inter.variable} ${interTight.variable} ${plexMono.variable}`;
