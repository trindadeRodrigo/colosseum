import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google';

// The three typefaces of the design system (token-mapping.md, section 5). `next/font` downloads the
// files when the app is built and serves them from this origin: the browser never asks Google for
// anything. Each face comes with a fallback whose metrics are adjusted to match it, so text does not
// move when the real face arrives.
//
// Nothing is preloaded yet: until the shell is rebuilt on the design system (WEB-1) most pages do not
// use these faces, and a preload would fetch them on every route, the partner embed included. The
// layout that uses a face turns its preload on.
//
// IBM Plex Sans Condensed (Bearing tables only) is not loaded here. `--font-condensed` falls back to
// IBM Plex Sans until a Bearing screen loads it in its own layout.

/** Explains: body, labels, buttons. 400 body, 500 labels, 600 UI headings; nothing lighter. */
export const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
  preload: false,
});

/** Cites: figures in tables, the source line, hashes, the word MOCK. */
export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
  preload: false,
});

/** Answers: one sentence per screen, upright, never bold. The optical-size axis keeps the cut serifs. */
export const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal'],
  axes: ['opsz'],
  variable: '--font-newsreader',
  display: 'swap',
  preload: false,
});

/** The class names that define the three `--font-*` variables. They go on `<html>`. */
export const fontVariables = `${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`;
