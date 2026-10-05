import { IBM_Plex_Mono } from 'next/font/google';

// The mono face, in a file of its own. A layout preloads the faces of every font file it imports, so
// the pages that are not rebuilt yet (app/(structurer)) import this one alone: they use the mono face
// in a few places and no other, and their head stays as it was. It is not preloaded anywhere: it sets
// source lines and the MOCK plate, never the first thing a person reads.

/** Cites: figures in tables, the source line, hashes, the word MOCK. */
export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
  preload: false,
});
