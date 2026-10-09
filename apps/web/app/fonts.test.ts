import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The three faces are served from files committed with the app (assets/fonts), so a build fetches
// nothing: the CI build used to fail whenever it could not reach Google. The files are the ones
// Google's build shipped for the Latin subset, byte for byte, so no glyph and no width changed; the
// fallbacks keep the figures that build worked out.

const WEB = join(import.meta.dirname, '..');
const FONTS = join(WEB, 'assets', 'fonts');
const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(FONTS, file)))
    .digest('hex');

/** The Latin files of Google Fonts on 2026-10-06 (IBM Plex Sans v23, IBM Plex Mono v20, Newsreader v26). */
const FILES: Record<string, string> = {
  'ibm-plex-sans-latin-wght.woff2':
    '056e4e2459f57a0033c8c9c844ff19d6e42ac8602027803d4345823bcc939818',
  'ibm-plex-sans-greek-wght.woff2':
    'a29d4e6345cdb7e2b6daabf4961a6dcafcbc7ed1eac26186ca4a004cd32d64d8',
  'ibm-plex-mono-latin-400.woff2':
    'c36f509c0a8f9f85f29cb44bc8701d8a9e0b14c499e77a884f789ead7093a7ac',
  'ibm-plex-mono-latin-500.woff2':
    'a76f53ca6612e7b3828eec2311098675b7f9849ae4169a8bcef6302aec02a6c0',
  'newsreader-latin-opsz-wght.woff2':
    '01817351be3edfc1714fe6d60ddea6a22a169a5ebd033b50c7f9495e5d9c386a',
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(tsx?|mjs|css)$/.test(name)) out.push(path);
  }
  return out;
}

describe('the faces', () => {
  it('are the committed files, the same bytes Google served, each with its licence beside it', () => {
    const woff2 = readdirSync(FONTS).filter((f) => f.endsWith('.woff2'));
    expect(woff2.sort()).toEqual(Object.keys(FILES).sort());
    for (const [file, hash] of Object.entries(FILES)) expect(sha(file), file).toBe(hash);
    for (const licence of ['OFL-IBM-Plex.txt', 'OFL-Newsreader.txt'])
      expect(readFileSync(join(FONTS, licence), 'utf8')).toContain('SIL Open Font License');
    // only what the app uses: under 220 KB for the five
    const bytes = woff2.reduce((sum, f) => sum + statSync(join(FONTS, f)).size, 0);
    expect(bytes).toBeLessThan(220 * 1024);
  });

  it('are never fetched at build: no file imports next/font/google, or names Google’s font hosts', () => {
    const found: string[] = [];
    for (const top of ['app', 'components', 'features', 'i18n', 'lib', 'scripts']) {
      for (const path of sources(join(WEB, top))) {
        if (/\.test\.tsx?$/.test(path)) continue;
        const text = readFileSync(path, 'utf8');
        if (/from\s+['"]next\/font\/google['"]|import\(\s*['"]next\/font\/google/.test(text))
          found.push(`${path.slice(WEB.length + 1)} imports next/font/google`);
        if (/fonts\.(googleapis|gstatic)\.com/.test(text))
          found.push(`${path.slice(WEB.length + 1)} names a Google font host`);
      }
    }
    expect(found).toEqual([]);
  });

  it('keep their variables, weights, display and preload', () => {
    const fonts = readFileSync(join(WEB, 'app', 'fonts.ts'), 'utf8');
    const mono = readFileSync(join(WEB, 'app', 'fonts-mono.ts'), 'utf8');
    for (const text of [fonts, mono]) expect(text).toContain("from 'next/font/local'");
    // the sans: one variable file, 400 to 600; the serif: its variable file, as Google gave it
    expect(fonts).toMatch(
      /plexSans = localFont\(\{[^}]*weight: '400 600'[^}]*variable: '--font-plex-sans'[^}]*display: 'swap'[^}]*preload: true/s,
    );
    expect(fonts).toMatch(
      /newsreader = localFont\(\{[^}]*weight: '200 800'[^}]*variable: '--font-newsreader'[^}]*display: 'swap'[^}]*preload: true/s,
    );
    expect(mono).toMatch(
      /weight: '400'[\s\S]*weight: '500'[\s\S]*variable: '--font-plex-mono'[\s\S]*display: 'swap'[\s\S]*preload: false/,
    );
  });

  it('keep the fallbacks Google’s build worked out, by name and by figure', () => {
    const css = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8');
    const face = (name: string) =>
      css.match(new RegExp(`@font-face \\{\\s*font-family: "${name}";([^}]*)\\}`))?.[1] ?? '';
    const figures = (name: string) =>
      [...face(name).matchAll(/(ascent-override|descent-override|size-adjust): ([\d.]+)%/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      );
    expect(figures('IBM Plex Sans Fallback')).toEqual([
      'ascent-override 101.32',
      'descent-override 27.18',
      'size-adjust 101.17',
    ]);
    expect(figures('Newsreader Fallback')).toEqual([
      'ascent-override 69.68',
      'descent-override 25.12',
      'size-adjust 105.48',
    ]);
    expect(figures('IBM Plex Mono Fallback')).toEqual([
      'ascent-override 76.16',
      'descent-override 20.43',
      'size-adjust 134.59',
    ]);
    const fonts = readFileSync(join(WEB, 'app', 'fonts.ts'), 'utf8');
    const mono = readFileSync(join(WEB, 'app', 'fonts-mono.ts'), 'utf8');
    expect(fonts).toContain("fallback: ['IBM Plex Sans', 'IBM Plex Sans Fallback']");
    expect(fonts).toContain("fallback: ['Newsreader', 'Newsreader Fallback']");
    expect(mono).toContain("fallback: ['IBM Plex Mono', 'IBM Plex Mono Fallback']");
    // next/font's own guess at a fallback is switched off, so there is one fallback, the old one
    for (const text of [fonts, mono]) expect(text).toContain('adjustFontFallback: false');
  });

  /** The code points a `unicode-range` value holds. */
  const inRange = (range: string) => {
    const spans = range.split(',').map((part) => {
      const [from, to = from] = part.trim().replace(/^U\+/, '').split('-');
      return [Number.parseInt(from as string, 16), Number.parseInt(to as string, 16)] as const;
    });
    return (ch: string) => {
      const cp = ch.codePointAt(0) ?? 0;
      return spans.some(([a, b]) => cp >= a && cp <= b);
    };
  };
  const ranges = () => {
    const fonts = readFileSync(join(WEB, 'app', 'fonts.ts'), 'utf8');
    return [...fonts.matchAll(/prop: 'unicode-range',\s*value:\s*'([^']+)'/g)].map(
      (m) => m[1] as string,
    );
  };

  it('are one family of two files for the sans: Latin, and the Greek letters Bearing writes', () => {
    const fonts = readFileSync(join(WEB, 'app', 'fonts.ts'), 'utf8');
    const [latin, greek] = ranges();
    expect(latin).toContain('U+0000-00FF');
    expect(greek).toContain('U+0370-0377');
    // the Greek file joins the sans face's own family, and is fetched only where it is needed
    expect(fonts).toMatch(
      /plexSansGreek = localFont\(\{[\s\S]*?preload: false[\s\S]*?IBM Plex Sans/,
    );
    // each face keeps its own name in the stylesheet, as it had from Google
    for (const name of ['IBM Plex Sans', 'Newsreader'])
      expect(fonts).toContain(`{ prop: 'font-family', value: "'${name}'" }`);
    expect(readFileSync(join(WEB, 'app', 'fonts-mono.ts'), 'utf8')).toContain(
      `{ prop: 'font-family', value: "'IBM Plex Mono'" }`,
    );
    expect(fonts).toMatch(/fontVariables = `[^`]*plexSansGreek\.variable/);
    for (const letter of ['τ', 'Σ', 'Δ', 'σ'])
      expect(inRange(greek as string)(letter), letter).toBe(true);
  });

  it('hold every character the dictionaries and Bearing write, but the signs no face ever had', () => {
    const covered = ranges().map(inRange);
    /**
     * Arrows and comparison signs: in none of the files Google serves for these faces either, so the
     * system's face has always drawn them. A new one is added here by someone who looked.
     */
    const SYSTEM_DRAWN = new Set(['→', '↗', '≤', '≥', '≈']);
    const written = new Map<string, string>();
    for (const top of ['i18n', join('features', 'bearing')])
      for (const path of sources(join(WEB, top))) {
        if (/\.test\.tsx?$/.test(path) || /[\\/]test[\\/]/.test(path)) continue;
        for (const ch of readFileSync(path, 'utf8'))
          if (!written.has(ch)) written.set(ch, path.slice(WEB.length + 1));
      }
    const loose = [...written]
      .filter(([ch]) => !covered.some((holds) => holds(ch)) && !SYSTEM_DRAWN.has(ch))
      .map(
        ([ch, file]) =>
          `${ch} (U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}) in ${file}`,
      );
    expect(loose).toEqual([]);
    // the bite: the Greek letters are there, and it is the Greek file that holds them
    expect(written.has('τ')).toBe(true);
    expect(covered[0]?.('τ')).toBe(false);
    expect(covered[1]?.('τ')).toBe(true);
  });
});
