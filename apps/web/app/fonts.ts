import localFont from 'next/font/local';
import { plexMono } from './fonts-mono';

// The three typefaces of the design system (token-mapping.md, section 5), from files committed with the
// app (assets/fonts, each under the SIL Open Font License beside it): `next/font/local` serves them
// from this origin, and a build fetches nothing, so it cannot fail for want of Google's servers. They
// are the files Google Fonts serves for the Latin subset: IBM Plex Sans (one variable file, weights
// 400 to 600 used), Newsreader (one variable file with its optical-size axis) and, in fonts-mono.ts,
// IBM Plex Mono 400 and 500. Each face comes with a fallback whose metrics are adjusted to match it,
// so text does not move when the real face arrives: the three fallbacks are written in globals.css
// with the figures the Google build worked out, so they are what they were.
//
// The sans and the serif are preloaded on every route whose layout imports this file: the product
// shell (app/(app)/layout.tsx), where they set the first thing a person reads. The mono face lives in
// fonts-mono.ts and is not preloaded. The pages not yet rebuilt import that file only.
//
// IBM Plex Sans Condensed (Bearing tables only) is not loaded here. `--font-condensed` falls back to
// IBM Plex Sans until a Bearing screen loads it in its own layout.

/** Explains: body, labels, buttons. 400 body, 500 labels, 600 UI headings; nothing lighter. */
export const plexSans = localFont({
  src: '../assets/fonts/ibm-plex-sans-latin-wght.woff2',
  weight: '400 600',
  style: 'normal',
  variable: '--font-plex-sans',
  display: 'swap',
  preload: true,
  // the fallback is the one Google's build made, kept as it was (globals.css, "the fallbacks")
  adjustFontFallback: false,
  fallback: ['IBM Plex Sans Fallback'],
});

export { plexMono };

/** Answers: one sentence per screen, upright, never bold. The optical-size axis keeps the cut serifs. */
export const newsreader = localFont({
  src: '../assets/fonts/newsreader-latin-opsz-wght.woff2',
  weight: '200 800',
  style: 'normal',
  variable: '--font-newsreader',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  fallback: ['Newsreader Fallback'],
});

/** The class names that define the three `--font-*` variables. They go on `<html>`. */
export const fontVariables = `${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`;
