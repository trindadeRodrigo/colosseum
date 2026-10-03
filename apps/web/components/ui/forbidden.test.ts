import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { BLUE, isBlueOrViolet, parseColor } from './test/color';
import { builtCss, read, sourceFiles, variables, WEB } from './test/css';
import {
  COMPOSER_RADIUS,
  classTokens,
  type Finding,
  type Kind,
  scanCss,
  scanSource,
  strangeFamilies,
} from './test/forbidden';

// The forbidden things (STYLE.md, "Never"), looked for in the source of apps/web and in the stylesheet
// the app is built from: a blue or a violet, a shadow, a corner that is not 0 or 2px outside the
// composer, a typeface that is not one of the three, a font fetched from another origin.

/**
 * What was written before the design system and still breaks it. WEB-1 and WEB-2 rebuild these pages
 * on the primitives, and each entry comes out with its page. An entry that no longer matches anything
 * fails the test, so the list can only shrink. Nothing is added here: new code follows the rules.
 */
const LEGACY: Record<string, readonly Kind[]> = {
  // Rodrigo's pages and components: Tailwind's cool greys, blue links, 4px corners, chart colours
  'app/layout.tsx': ['hue'],
  'app/page.tsx': ['hue'],
  'app/monitor/page.tsx': ['hue', 'radius'],
  'app/embed/[id]/layout.tsx': ['hue', 'radius'],
  'app/risk/page.tsx': ['hue'],
  'app/risk/[asset]/page.tsx': ['hue'],
  'app/risk/methodology/page.tsx': ['hue'],
  'components/GoalFlow.tsx': ['hue', 'radius'],
  'components/PlanView.tsx': ['hue'],
  'components/Provenance.tsx': ['radius'],
  'components/StatsCard.tsx': ['hue', 'radius'],
  'components/ScheduleChart.tsx': ['hue'],
  'components/risk/CostCurveChart.tsx': ['hue'],
  'components/risk/HourOfWeekHeatmap.tsx': ['hue'],
  // the sign-in control and its dev page (WAL-1), plain until they take the Button
  'features/wallet/SignIn.tsx': ['hue'],
  'features/wallet/dev/DevWallet.tsx': ['hue'],
};

/**
 * The stylesheet of @solana/wallet-adapter-react-ui, which app/providers.tsx imports: violet, shadows,
 * rounded corners, and DM Sans fetched from Google when a page loads. It is not part of globals.css, so
 * it shows only in the output of a build. It goes when the shell stops importing it (token-mapping.md,
 * section 7, restyles the adapter).
 */
const ADAPTER = {
  importedBy: 'app/providers.tsx',
  stylesheet: '@solana/wallet-adapter-react-ui/styles.css',
  kinds: ['hue', 'shadow', 'radius', 'font', 'host'] as readonly Kind[],
};

/** Tailwind's own base fonts, kept for those pages by the two `initial` lines in globals.css. */
const BASE_FONT_RULES = ['html, :host', 'code, kbd, samp, pre'];

/** Test files and what only they load are not shipped, and hold forbidden things on purpose. */
const notScanned = (file: string) =>
  /\.test\.ts$/.test(file) || file.startsWith('components/ui/test/');

const files = [...sourceFiles()].filter((file) => !notScanned(file));
const scripts = files.filter((file) => /\.(tsx?|jsx?|mjs)$/.test(file));
const tokens = new Map(scripts.map((file) => [file, classTokens(file, read(file))]));
const users = (name: string) => scripts.filter((file) => tokens.get(file)?.has(name));

type Blame = { finding: Finding; files: string[] };

/** Who put a forbidden rule in the stylesheet: the files whose strings hold its class name. */
function blame(findings: Finding[], root: postcss.Root): Blame[] {
  return findings.map((finding) => {
    let classes = finding.classes;
    if (classes.length === 0 && finding.variable) {
      // a theme variable is there because a utility reads it
      const readers = new Set<string>();
      root.walkDecls((decl) => {
        if (!decl.value.includes(`var(${finding.variable}`)) return;
        const rule = decl.parent as postcss.Rule;
        for (const m of (rule.selector ?? '').matchAll(/\.((?:\\.|[\w-])+)/g))
          readers.add((m[1] as string).replace(/\\(.)/g, '$1'));
      });
      classes = [...readers];
    }
    return { finding, files: [...new Set(classes.flatMap(users))] };
  });
}

const say = (b: Blame) =>
  `${b.finding.kind}: ${b.finding.what} in "${b.finding.where}", from ${b.files.join(', ') || 'no element: a word in a comment or a string that Tailwind took for a class'}`;

describe('the forbidden things', () => {
  describe('the rule for blue and violet', () => {
    it('is a hue between 200° and 330° in OKLCH with a chroma of 0.008 or more', () => {
      expect(BLUE).toEqual({ from: 200, to: 330, chroma: 0.008 });
      const is = (c: string) => isBlueOrViolet(parseColor(c) as never);
      for (const blue of [
        '#0000ff',
        '#1d4ed8',
        'rgb(99 102 241)',
        'hsl(270 80% 60%)',
        'oklch(48.8% 0.243 264.376)',
        '#512da8',
        '#CAE3F4',
        '#6b7280',
      ])
        expect(is(blue), blue).toBe(true);
      // every colour of the brand, the three status pigments included, and true greys
      for (const fine of [
        '#F6F1E8',
        '#1C1712',
        '#7A5A3A',
        '#E6D3B7',
        '#6E655B',
        '#2F4A2A',
        '#8A5A00',
        '#A8324A',
        '#E58AA0',
        '#FAEAEC',
        '#0D0B09',
        '#ffffff',
        '#000000',
        '#808080',
        'rgb(0 0 0 / 0.1)',
      ])
        expect(is(fine), fine).toBe(false);
    });
  });

  describe('in the source of apps/web', () => {
    const found = scripts.flatMap((file) =>
      scanSource(file, read(file)).map((f) => ({ file, ...f })),
    );

    it('reads the app: the pages, the primitives and the showcase', () => {
      expect(files).toContain('app/globals.css');
      expect(files).toContain('components/ui/Button.tsx');
      expect(files).toContain('app/page.tsx');
      expect(files.some(notScanned)).toBe(false);
    });

    it('finds nothing forbidden outside the pages listed as legacy', () => {
      const fresh = found.filter((f) => !LEGACY[f.file]?.includes(f.kind));
      expect(fresh.map((f) => `${f.file}: ${f.kind}: ${f.what}`)).toEqual([]);
    });

    it('still imports the wallet adapter’s stylesheet, which is why that stylesheet is excused', () => {
      expect(read(ADAPTER.importedBy)).toContain(ADAPTER.stylesheet);
    });

    it('uses the composer’s rounded utilities in the composer only', () => {
      for (const name of Object.keys(COMPOSER_RADIUS))
        expect(users(name), name).toEqual(['components/ui/Composer.tsx']);
    });
  });

  describe('in the stylesheet the app is built from', async () => {
    const root = await builtCss();
    const vars = variables(root, (s) => s === ':root' || s === ':host' || s === '.light');
    const blamed = blame(scanCss(root, vars), root);
    const base = (b: Blame) =>
      b.finding.kind === 'font' && BASE_FONT_RULES.some((rule) => b.finding.where.endsWith(rule));
    const legacy = (b: Blame) =>
      b.files.length > 0 && b.files.every((file) => LEGACY[file]?.includes(b.finding.kind));

    it('compiles, with the tokens and the utilities the primitives use', () => {
      expect(vars.get('--radius')).toBe('2px');
      const selectors: string[] = [];
      root.walkRules((rule) => {
        selectors.push(rule.selector);
      });
      expect(selectors).toEqual(expect.arrayContaining(['.bg-card', '.rounded-md', '.tf-hatch']));
    });

    it('finds nothing forbidden that a legacy page does not account for', () => {
      expect(blamed.filter((b) => !base(b) && !legacy(b)).map(say)).toEqual([]);
    });

    it('keeps Tailwind’s base fonts only for the pages not yet rebuilt', () => {
      const kept = blamed.filter(base);
      expect(kept.map((b) => b.finding.where.split(' > ').at(-1)).sort()).toEqual(
        [...BASE_FONT_RULES].sort(),
      );
    });

    it('rounds nothing but the composer: 20px for the box, a round send button', () => {
      const corners = new Map<string, string>();
      root.walkDecls('border-radius', (decl) => {
        const rule = decl.parent as postcss.Rule;
        corners.set(rule.selector, decl.value);
      });
      expect(corners.get('.rounded-composer')).toBe('var(--tf-radius-composer)');
      expect(corners.get('.rounded-round')).toBe('var(--tf-radius-round)');
      expect(vars.get('--tf-radius-composer')).toBe('20px');
      expect(corners.get('.rounded-md')).toBe('var(--radius)');
    });

    it('has no legacy entry that could be deleted', () => {
      const sourceKinds = new Map<string, Set<Kind>>();
      const note = (file: string, kind: Kind) =>
        sourceKinds.set(file, (sourceKinds.get(file) ?? new Set()).add(kind));
      for (const file of scripts) for (const f of scanSource(file, read(file))) note(file, f.kind);
      for (const b of blamed) for (const file of b.files) note(file, b.finding.kind);
      const stale = Object.entries(LEGACY).flatMap(([file, kinds]) =>
        kinds.filter((kind) => !sourceKinds.get(file)?.has(kind)).map((kind) => `${file}: ${kind}`),
      );
      expect(stale).toEqual([]);
    });
  });

  describe('in the output of `next build`, when there is a fresh one', () => {
    const out = join(WEB, '.next');
    const chunks = join(out, 'static');
    const css: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.css')) css.push(path);
      }
    };
    // A build older than the source says nothing about the source: it is not read.
    const built = existsSync(join(out, 'BUILD_ID')) ? statSync(join(out, 'BUILD_ID')).mtimeMs : 0;
    const newest = Math.max(...files.map((file) => statSync(join(WEB, file)).mtimeMs));
    const fresh = built > newest && existsSync(chunks);
    if (fresh) walk(chunks);

    it.skipIf(!fresh)(
      'finds nothing forbidden beyond the legacy pages and the wallet adapter’s stylesheet',
      async () => {
        expect(css.length).toBeGreaterThan(0);
        const source = await builtCss();
        const problems: string[] = [];
        const excused = new Set<Kind>();
        for (const path of css) {
          const root = postcss.parse(readFileSync(path, 'utf8'), { from: path });
          const vars = variables(root, (s) => s === ':root' || s === ':host' || s === '.light');
          for (const b of blame(scanCss(root, vars), root)) {
            // the stylesheet of @solana/wallet-adapter-react-ui, imported by app/providers.tsx
            const adapter =
              b.finding.where.includes('.wallet-adapter-') || /DM\+Sans/.test(b.finding.what);
            const known = adapter && ADAPTER.kinds.includes(b.finding.kind);
            if (known) excused.add(b.finding.kind);
            const base =
              b.finding.kind === 'font' &&
              /(^|,)\s*(html|:host|code|kbd|samp|pre)\b/.test(b.finding.where);
            const legacy =
              b.files.length > 0 && b.files.every((f) => LEGACY[f]?.includes(b.finding.kind));
            if (!known && !base && !legacy) problems.push(say(b));
          }
        }
        expect(source).toBeDefined();
        expect(problems).toEqual([]);
        // every kind the adapter is excused for is still there to excuse
        expect([...excused].sort()).toEqual([...ADAPTER.kinds].sort());
      },
    );

    it.skipIf(!fresh)(
      'serves the three typefaces from this origin, each with a metric-matched fallback',
      () => {
        const all = css.map((path) => readFileSync(path, 'utf8')).join('\n');
        const faces = [...all.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] as string);
        const named = (name: string) =>
          faces.filter((f) =>
            new RegExp(`font-family:\\s*["']?${name}["']?\\s*[;}]`).test(`${f};`),
          );
        for (const face of ['IBM Plex Sans', 'IBM Plex Mono', 'Newsreader']) {
          expect(named(face).length, face).toBeGreaterThan(0);
          for (const rule of named(face)) {
            expect(rule).toMatch(/src:\s*url\((?!["']?https?:)/); // a file of this build, not another host
            expect(rule).toMatch(/font-display:\s*swap/);
          }
          const fallback = named(`${face} Fallback`);
          expect(fallback, `${face} Fallback`).toHaveLength(1);
          expect(fallback[0]).toMatch(/size-adjust/);
          expect(fallback[0]).toMatch(/ascent-override/);
        }
        expect(
          faces.flatMap((f) => strangeFamilies(/font-family:\s*([^;]+)/.exec(f)?.[1] ?? '')),
        ).toEqual([]);
      },
    );
  });
});
