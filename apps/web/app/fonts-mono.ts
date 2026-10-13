import localFont from 'next/font/local';

// The mono face, in a file of its own. A layout preloads the faces of every font file it imports, so
// the pages that are not rebuilt yet (app/(structurer)) import this one alone: they use the mono face
// in a few places and no other, and their head stays as it was. It is not preloaded anywhere: it sets
// source lines and the MOCK plate, never the first thing a person reads.

/** Cites: figures in tables, the source line, hashes, the word MOCK. */
export const plexMono = localFont({
  src: [
    { path: '../assets/fonts/ibm-plex-mono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../assets/fonts/ibm-plex-mono-latin-500.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  fallback: ['IBM Plex Mono', 'IBM Plex Mono Fallback'],
  // the face keeps its own name in the stylesheet (see fonts.ts)
  declarations: [{ prop: 'font-family', value: "'IBM Plex Mono'" }],
});
