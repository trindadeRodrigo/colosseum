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
 * What was written before the design system and still breaks it. WEB-2 rebuilds these pages on the
 * primitives, and each entry comes out with its page. An entry that no longer matches anything fails
 * the test, so the list can only shrink. Nothing is added here: new code follows the rules.
 * WEB-1 moved the pages into their own route group, app/(structurer), as they were, and took the
 * sign-in control off the list: it is built on the primitives now.
 */
const LEGACY: Record<string, readonly Kind[]> = {
  // Rodrigo's pages and components: Tailwind's cool greys, blue links, 4px corners, chart colours,
  // and two uppercase labels
  'app/(structurer)/layout.tsx': ['hue'],
  'components/PlanView.tsx': ['hue'],
  'components/Provenance.tsx': ['radius', 'case'],
  'components/ScheduleChart.tsx': ['hue'],
  // the wallet check, a development page (WAL-1), plain until it takes the primitives
  'features/wallet/dev/DevWallet.tsx': ['hue'],
};

/**
 * Pictures drawn at build by `next/og`, which reads no stylesheet and so no `var(--font-…)`: each
 * names the brand's face itself, and that finding alone is excused. So is the one place the faces are
 * defined (app/fonts.ts): the Greek file of IBM Plex Sans is told the sans face's name there, so the
 * two files are one family.
 */
const DRAWN: Record<string, string> = {
  'app/opengraph-image.tsx': "fontFamily: 'Newsreader'",
  'app/fonts.ts': 'font-family',
};

/** The product's own routes and what they are built from: none of it may ever be on the list above. */
const PRODUCT =
  /^(app\/\((app|marketing|embed)\)|components\/shell|features\/(account|goal|portfolio|landing|order|embed)|i18n)\//;

/**
 * The stylesheet of @solana/wallet-adapter-react-ui, which the layout of the pages not yet rebuilt
 * imports (app/(structurer)/providers.tsx): violet, shadows, rounded corners, and DM Sans fetched from
 * Google when a page loads. It is not part of globals.css, so it shows only in the output of a build.
 * The product's routes do not import it. It goes with the last of those pages (WEB-2).
 */
const ADAPTER = {
  importedBy: 'app/(structurer)/providers.tsx',
  stylesheet: '@solana/wallet-adapter-react-ui/styles.css',
  kinds: ['hue', 'shadow', 'radius', 'font', 'host', 'align'] as readonly Kind[],
};

/**
 * Where text may be centred, and by what. Centred or justified body text is forbidden (STYLE.md), so
 * anything else that centres text fails, whichever file it is in.
 */
const CENTRED: Record<string, string> = {
  'components/ui/SubscribeBlock.tsx':
    'subscribe-block.md: the one centred composition on marketing, with a lede of three lines at most',
  'components/ui/ExitPlanLine.tsx':
    'exit-plan-line.md: the amount sits in the middle of its dimension line; a label on a drawing',
};

/**
 * Tailwind's two base rules for type. They read the tokens now (the two `initial` lines that kept
 * Tailwind's own fonts are gone), so neither is a finding any more.
 */
const BASE_FONT_RULES = ['html, :host', 'code, kbd, samp, pre'];
/** The class that keeps the system's faces for the pages not yet rebuilt, and the one file that asks for it. */
const SYSTEM_FACES = { utility: 'tf-system-faces', usedBy: 'app/(structurer)/layout.tsx' };

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

/** Centred text that a spec allows: every file that uses the class is on the list. */
const centred = (b: Blame) =>
  b.finding.kind === 'align' && b.files.length > 0 && b.files.every((file) => file in CENTRED);

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

  describe('the rules, on a stylesheet and a file written to break them', () => {
    const kinds = (css: string, vars = new Map<string, string>()) =>
      scanCss(postcss.parse(css), vars).map((f) => f.kind);

    it('finds uppercase anywhere but on the MOCK plate', () => {
      expect(kinds('.label { text-transform: uppercase }')).toEqual(['case']);
      expect(kinds('.hover\\:uppercase:hover { text-transform: uppercase }')).toEqual(['case']);
      expect(kinds('.tf-mock-plate { text-transform: uppercase }')).toEqual([]);
      expect(kinds('.label { text-transform: none }')).toEqual([]);
    });

    it('finds italic text and a weight under 400, and leaves a font file’s own description alone', () => {
      expect(kinds('.a { font-style: italic }')).toEqual(['italic']);
      expect(kinds('.a { font: italic 400 1rem/1.5 var(--font-sans) }')).toEqual(['italic']);
      expect(kinds('.a { font-weight: 300 }')).toEqual(['weight']);
      expect(kinds('.a { font-weight: lighter }')).toEqual(['weight']);
      const light = new Map([['--font-weight-light', '300']]);
      expect(kinds('.font-light { font-weight: var(--font-weight-light) }', light)).toEqual([
        'weight',
      ]);
      expect(kinds('.a { font-weight: 400 } .b { font-weight: 600 }')).toEqual([]);
      expect(
        kinds('@font-face { font-family: Newsreader; font-style: normal; font-weight: 200 800 }'),
      ).toEqual([]);
    });

    it('finds a gradient anywhere but in the hatch', () => {
      expect(kinds('.a { background-image: linear-gradient(to right, #7a5a3a, #e6d3b7) }')).toEqual(
        ['gradient'],
      );
      expect(kinds('.a { --tw-gradient-stops: radial-gradient(#7a5a3a, #e6d3b7) }')).toEqual([
        'gradient',
      ]);
      expect(
        kinds(
          '.tf-hatch { background-image: repeating-linear-gradient(45deg, #6e655b 0 1px, transparent 1px 6px) }',
        ),
      ).toEqual([]);
    });

    it('finds a blur, a backdrop filter and a glow, written plainly or as Tailwind composes them', () => {
      expect(kinds('.a { filter: blur(1px) }')).toEqual(['blur']);
      expect(kinds('.blur-\\[1px\\] { --tw-blur: blur(1px) }')).toEqual(['blur']);
      expect(
        kinds('.a { backdrop-filter: var(--tw-backdrop-blur,) var(--tw-backdrop-saturate,) }'),
      ).toEqual(['blur']);
      expect(kinds('.a { -webkit-backdrop-filter: saturate(1.8) }')).toEqual(['blur']);
      expect(kinds('.a { backdrop-filter: none }')).toEqual([]);
      expect(kinds('.a { text-shadow: 0 0 8px #e6d3b7 }')).toEqual(['shadow']);
    });

    it('finds centred and justified text', () => {
      expect(kinds('.a { text-align: center } .b { text-align: justify }')).toEqual([
        'align',
        'align',
      ]);
      expect(kinds('.a { text-align: left } .b { text-align: end }')).toEqual([]);
    });

    it('finds the same things written into a component: inline styles and CSS as text', () => {
      const found = (code: string) => scanSource('x.tsx', code).map((f) => f.kind);
      expect(found("const a = <p style={{ textTransform: 'uppercase' }}>x</p>;")).toEqual(['case']);
      expect(found("const a = <p style={{ fontStyle: 'italic', fontWeight: 300 }}>x</p>;")).toEqual(
        ['italic', 'weight'],
      );
      expect(found("const a = <p style={{ textAlign: 'center' }}>x</p>;")).toEqual(['align']);
      expect(found("const a = <p style={{ backdropFilter: 'saturate(2)' }}>x</p>;")).toEqual([
        'blur',
      ]);
      expect(found("const a = <p style={{ filter: 'blur(2px)' }}>x</p>;")).toEqual([
        'blur',
        'blur',
      ]);
      expect(found("const a = { background: 'linear-gradient(#7a5a3a, #e6d3b7)' };")).toEqual([
        'gradient',
      ]);
      expect(
        found('const a = <p className="[text-transform:uppercase] [font-style:italic]">x</p>;'),
      ).toEqual(['case', 'italic']);
      expect(found("const a = <p style={{ fontWeight: 500, textAlign: 'left' }}>x</p>;")).toEqual(
        [],
      );
    });
  });

  describe('in the source of apps/web', () => {
    const found = scripts.flatMap((file) =>
      scanSource(file, read(file)).map((f) => ({ file, ...f })),
    );

    it('reads the app: the pages, the primitives and the showcase', () => {
      expect(files).toContain('app/globals.css');
      expect(files).toContain('components/ui/Button.tsx');
      expect(files).toContain('app/(structurer)/plans/[id]/page.tsx');
      expect(files).toContain('app/(marketing)/page.tsx');
      expect(files).toContain('app/(app)/monitor/page.tsx');
      expect(files).toContain('components/shell/AppNav.tsx');
      expect(files.some(notScanned)).toBe(false);
    });

    it('lists no file of the product as legacy', () => {
      expect(files.filter((file) => PRODUCT.test(file)).length).toBeGreaterThan(10);
      expect(Object.keys(LEGACY).filter((file) => PRODUCT.test(file))).toEqual([]);
    });

    it('finds nothing forbidden outside the pages listed as legacy', () => {
      const fresh = found.filter(
        (f) =>
          !LEGACY[f.file]?.includes(f.kind) && !(f.kind === 'font' && DRAWN[f.file] === f.what),
      );
      // and each picture's excuse is still needed
      for (const [file, what] of Object.entries(DRAWN))
        expect(
          found.some((f) => f.file === file && f.what === what),
          file,
        ).toBe(true);
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
      expect(blamed.filter((b) => !base(b) && !legacy(b) && !centred(b)).map(say)).toEqual([]);
    });

    it('sets uppercase nowhere but one legacy label: the boxed MOCK is gone (MOCK-QUIET)', () => {
      const upper: string[] = [];
      root.walkDecls('text-transform', (decl) => {
        if (/uppercase/.test(decl.value)) upper.push((decl.parent as postcss.Rule).selector);
      });
      expect(upper.sort()).toEqual(['.uppercase']);
      expect(users('uppercase').sort()).toEqual(['components/Provenance.tsx']);
    });

    it('centres text only where a spec allows it, and every such place still does', () => {
      const centring = (file: string) =>
        [...(tokens.get(file) ?? [])].some((token) => /(^|:)text-(center|justify)$/.test(token));
      expect(scripts.filter(centring).sort()).toEqual(Object.keys(CENTRED).sort());
      expect(blamed.filter(centred).length).toBeGreaterThan(0);
    });

    it('draws one gradient, the hatch, and makes no utility for an italic, a light weight or a blur', () => {
      const gradients: string[] = [];
      root.walkDecls((decl) => {
        if (/gradient\(/.test(decl.value)) gradients.push((decl.parent as postcss.Rule).selector);
      });
      expect(gradients).toEqual(['.tf-hatch']);
      const selectors = new Set<string>();
      root.walkRules((rule) => {
        selectors.add(rule.selector);
      });
      for (const name of ['.italic', '.font-light', '.font-thin', '.blur', '.backdrop-blur'])
        expect(selectors.has(name), name).toBe(false);
    });

    it('sets the base fonts from the tokens, and keeps the system’s faces only for the pages not yet rebuilt', () => {
      // no base rule is a finding any more: both resolve to the faces of the design system
      expect(blamed.filter(base)).toEqual([]);
      const families = new Map<string, string>();
      root.walkDecls('font-family', (decl) => {
        families.set((decl.parent as postcss.Rule).selector, decl.value.replace(/\s+/g, ' '));
      });
      const [sans, mono] = BASE_FONT_RULES.map((rule) => families.get(rule) ?? '');
      expect(sans).toMatch(/^var\(--default-font-family\b/);
      expect(mono).toMatch(/^var\(--default-mono-font-family\b/);
      expect(vars.get('--default-font-family')).toBe('var(--tf-font-sans)');
      expect(vars.get('--default-mono-font-family')).toBe('var(--tf-font-mono)');
      // the pages in app/(structurer) keep the system's own faces, named from the allowed fallbacks
      expect(families.get(`.${SYSTEM_FACES.utility}`)).toBe(
        'system-ui, -apple-system, "Segoe UI", Arial, sans-serif',
      );
      expect(families.get(`.${SYSTEM_FACES.utility} :is(code, kbd, samp, pre)`)).toBe(
        'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      );
      expect(users(SYSTEM_FACES.utility)).toEqual([SYSTEM_FACES.usedBy]);
      // and the base class of the design system goes on the product's <body> and the landing's
      expect(users('tf-app').filter((file) => !file.startsWith('app/(app)/dev/'))).toEqual([
        'app/(marketing)/layout.tsx',
        'components/shell/AppDocument.tsx',
      ]);
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

  // A plain test run skips these two when there is no build, or one older than the source. The web
  // `build` script ends with scripts/check-build.mjs, which runs this file once more with
  // REQUIRE_WEB_BUILD=1, and then they are not skipped: a missing or stale build fails. That is how
  // CI reads the real output.
  describe('in the output of `next build`, when there is a fresh one', () => {
    const required = process.env.REQUIRE_WEB_BUILD === '1';
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
    // next-env.d.ts is written by Next itself, after the build
    const newest = Math.max(
      ...files
        .filter((file) => file !== 'next-env.d.ts')
        .map((file) => statSync(join(WEB, file)).mtimeMs),
    );
    const fresh = built > newest && existsSync(chunks);
    if (fresh) walk(chunks);

    it.runIf(required)('has a build to read, newer than every source file', () => {
      expect(built, 'there is no build in apps/web/.next').toBeGreaterThan(0);
      expect(fresh, 'the build in apps/web/.next is older than the source').toBe(true);
    });

    it.skipIf(!fresh && !required)(
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
            if (!known && !base && !legacy && !centred(b)) problems.push(say(b));
          }
        }
        expect(source).toBeDefined();
        expect(problems).toEqual([]);
        // every kind the adapter is excused for is still there to excuse
        expect([...excused].sort()).toEqual([...ADAPTER.kinds].sort());
      },
    );

    it.skipIf(!fresh && !required)(
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
