import { IBM_Plex_Sans, Newsreader } from 'next/font/google';
import { plexMono } from './fonts-mono';

// The three typefaces of the design system (token-mapping.md, section 5). `next/font` downloads the
// files when the app is built and serves them from this origin: the browser never asks Google for
// anything. Each face comes with a fallback whose metrics are adjusted to match it, so text does not
// move when the real face arrives.
//
// The sans and the serif are preloaded on every route whose layout imports this file: the product
// shell (app/(app)/layout.tsx), where they set the first thing a person reads. The mono face lives in
// fonts-mono.ts and is not preloaded. The pages not yet rebuilt import that file only.
//
// IBM Plex Sans Condensed (Bearing tables only) is not loaded here. `--font-condensed` falls back to
// IBM Plex Sans until a Bearing screen loads it in its own layout.

/** Explains: body, labels, buttons. 400 body, 500 labels, 600 UI headings; nothing lighter. */
export const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
  preload: true,
});

export { plexMono };

/** Answers: one sentence per screen, upright, never bold. The optical-size axis keeps the cut serifs. */
export const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal'],
  axes: ['opsz'],
  variable: '--font-newsreader',
  display: 'swap',
  preload: true,
});

/** The class names that define the three `--font-*` variables. They go on `<html>`. */
export const fontVariables = `${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`;
