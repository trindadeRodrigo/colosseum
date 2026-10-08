import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The three faces are served from files committed with the app (assets/fonts), so a build fetches
// nothing: the CI build used to fail whenever it could not reach Google. The files are the ones
// Google serves for the Latin subset, byte for byte; the fallbacks carry the figures next/font works
// out for these faces. Since IDENTITY-2 (Oct 8) the faces are Inter Tight, Inter and IBM Plex Mono:
// no serif, no Plex Sans.

const WEB = join(import.meta.dirname, '..');
const FONTS = join(WEB, 'assets', 'fonts');
const sha = (file: string) =>
  createHash('sha256')
    .update(readFileSync(join(FONTS, file)))
    .digest('hex');

/** The Latin files of Google Fonts (IBM Plex Mono v20 on 2026-10-06; Inter and Inter Tight on 2026-10-08). */
const FILES: Record<string, string> = {
  'inter-tight-latin-wght.woff2':
    '0853f2772e021f0e121726ea62a169db758febefa5b3b4dd3e2ba8b0faf27d7d',
  'inter-latin-opsz-wght.woff2': '2a4af46ed9b378ee608dbd447942f19c08919661506f5523e6150f27824ca9bb',
  'ibm-plex-mono-latin-400.woff2':
    'c36f509c0a8f9f85f29cb44bc8701d8a9e0b14c499e77a884f789ead7093a7ac',
  'ibm-plex-mono-latin-500.woff2':
    'a76f53ca6612e7b3828eec2311098675b7f9849ae4169a8bcef6302aec02a6c0',
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
    for (const licence of ['OFL-IBM-Plex.txt', 'OFL-Inter.txt', 'OFL-InterTight.txt'])
      expect(readFileSync(join(FONTS, licence), 'utf8')).toContain('SIL Open Font License');
    // and no licence is left for a face that is gone
    expect(
      readdirSync(FONTS)
        .filter((f) => f.endsWith('.txt'))
        .sort(),
    ).toEqual(['OFL-IBM-Plex.txt', 'OFL-Inter.txt', 'OFL-InterTight.txt']);
    // only what the app uses: under 200 KB for the four
    const bytes = woff2.reduce((sum, f) => sum + statSync(join(FONTS, f)).size, 0);
    expect(bytes).toBeLessThan(200 * 1024);
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
    // the display face and the UI face: one variable file each, 100 to 900, as Google gives them
    expect(fonts).toMatch(
      /interTight = localFont\(\{[^}]*weight: '100 900'[^}]*variable: '--font-inter-tight'[^}]*display: 'swap'[^}]*preload: true/s,
    );
    expect(fonts).toMatch(
      /inter = localFont\(\{[^}]*weight: '100 900'[^}]*variable: '--font-inter'[^}]*display: 'swap'[^}]*preload: true/s,
    );
    // no serif and no Plex Sans is loaded any more (IDENTITY-2)
    expect(fonts).not.toMatch(/newsreader|plex-sans|plexSans/i);
    expect(mono).toMatch(
      /weight: '400'[\s\S]*weight: '500'[\s\S]*variable: '--font-plex-mono'[\s\S]*display: 'swap'[\s\S]*preload: false/,
    );
  });

  it('keep metric-matched fallbacks, with the figures next/font works out, by name and by figure', () => {
    const css = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8');
    const face = (name: string) =>
      css.match(new RegExp(`@font-face \\{\\s*font-family: "${name}";([^}]*)\\}`))?.[1] ?? '';
    const figures = (name: string) =>
      [...face(name).matchAll(/(ascent-override|descent-override|size-adjust): ([\d.]+)%/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      );
    // capsize's figures (ascent 1984, descent 494, 2048 units; average widths 880 and 978) against
    // Arial's (913): size-adjust = width / 913, the overrides = metric / (2048 × size-adjust)
    expect(figures('Inter Tight Fallback')).toEqual([
      'ascent-override 100.51',
      'descent-override 25.03',
      'size-adjust 96.39',
    ]);
    expect(figures('Inter Fallback')).toEqual([
      'ascent-override 90.44',
      'descent-override 22.52',
      'size-adjust 107.12',
    ]);
    expect(figures('IBM Plex Mono Fallback')).toEqual([
      'ascent-override 76.16',
      'descent-override 20.43',
      'size-adjust 134.59',
    ]);
    const fonts = readFileSync(join(WEB, 'app', 'fonts.ts'), 'utf8');
    const mono = readFileSync(join(WEB, 'app', 'fonts-mono.ts'), 'utf8');
    expect(fonts).toContain("fallback: ['Inter Tight', 'Inter Tight Fallback']");
    expect(fonts).toContain("fallback: ['Inter', 'Inter Fallback']");
    // the fallbacks of the faces that are gone are gone with them
    expect(css).not.toMatch(/Newsreader|Plex Sans/);
    expect(mono).toContain("fallback: ['IBM Plex Mono', 'IBM Plex Mono Fallback']");
    // next/font's own guess at a fallback is switched off, so there is one fallback, the one written
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

  it('each keep their own name, over the Latin range Google lists', () => {
    const fonts = readFileSync(join(WEB, 'app', 'fonts.ts'), 'utf8');
    const all = ranges();
    expect(all).toHaveLength(2);
    for (const range of all) expect(range).toContain('U+0000-00FF');
    // each face keeps its own name in the stylesheet, as it has from Google
    for (const name of ['Inter Tight', 'Inter'])
      expect(fonts).toContain(`{ prop: 'font-family', value: "'${name}'" }`);
    expect(readFileSync(join(WEB, 'app', 'fonts-mono.ts'), 'utf8')).toContain(
      `{ prop: 'font-family', value: "'IBM Plex Mono'" }`,
    );
    expect(fonts).toMatch(
      /fontVariables = `\$\{inter\.variable\} \$\{interTight\.variable\} \$\{plexMono\.variable\}`/,
    );
  });

  it('hold every character the dictionaries and Bearing write, but the signs no face ever had', () => {
    const covered = ranges().map(inRange);
    /**
     * Arrows and comparison signs: in none of the Latin files Google serves for these faces, so the
     * system's face draws them. So does it the Greek letters Bearing writes in its methods: Inter
     * comes from Google as a Latin file here, and there is no Greek file to fetch at build (IDENTITY-2).
     * A new one is added here by someone who looked.
     */
    const SYSTEM_DRAWN = new Set(['→', '↗', '≤', '≥', '≈', 'τ', 'Σ', 'Δ', 'σ']);
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
    // the bite: the Greek letters are there, and no file of ours holds them
    expect(written.has('τ')).toBe(true);
    expect(covered.some((holds) => holds('τ'))).toBe(false);
  });
});
