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

// The loader takes its options as written values only, so each file's range of characters is written
// where it is used: the ranges are the ones Google's stylesheet lists for the two files.

/** Explains: body, labels, buttons. 400 body, 500 labels, 600 UI headings; nothing lighter. */
export const plexSans = localFont({
  src: '../assets/fonts/ibm-plex-sans-latin-wght.woff2',
  weight: '400 600',
  style: 'normal',
  variable: '--font-plex-sans',
  display: 'swap',
  preload: true,
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
  // the fallback is the one Google's build made, kept as it was (globals.css, "the fallbacks")
  adjustFontFallback: false,
  fallback: ['IBM Plex Sans Fallback'],
});

/**
 * The Greek letters of the same face (Bearing writes "τ" and "Σ" in its methods): a second file of the
 * one family, as Google's own stylesheet has it, fetched by the browser only where a Greek letter is
 * set. `next/font/local` names a face after its export, so this one is told the sans face's name: the
 * two files are then one family, each with the range of characters it holds.
 */
export const plexSansGreek = localFont({
  src: '../assets/fonts/ibm-plex-sans-greek-wght.woff2',
  weight: '400 600',
  style: 'normal',
  variable: '--font-plex-sans-greek',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'plexSans' },
    {
      prop: 'unicode-range',
      value: 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF',
    },
  ],
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
export const fontVariables = `${plexSans.variable} ${plexSansGreek.variable} ${plexMono.variable} ${newsreader.variable}`;
