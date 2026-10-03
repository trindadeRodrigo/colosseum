import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALWAYS_BUILT,
  DEV_ONLY as BUILD_DEV_ONLY,
  BUILT_CSS_TEST,
  checkBuild,
  REQUIRED,
} from '../../scripts/check-build.mjs';
import { read, sourceFiles, WEB } from './test/css';

// The showcase, the sample content and the test helpers exist for development. Nothing the product
// ships may import them: a made-up rate must not be able to reach a page. scripts/check-build.mjs
// fails a build that has a /dev route; this reads the imports themselves.

const DEV_ONLY = ['app/dev', 'components/ui/fixtures', 'components/ui/test'];
const inside = (file: string, folder: string) => file === folder || file.startsWith(`${folder}/`);
const devOnly = (file: string) => DEV_ONLY.some((folder) => inside(file, folder));
const notShipped = (file: string) =>
  /\.test\.tsx?$/.test(file) || /\.dev\.tsx$/.test(file) || devOnly(file);

/** The files of apps/web a file imports, as paths from apps/web. */
function imports(file: string): string[] {
  return ts
    .preProcessFile(read(file), true, true)
    .importedFiles.map((i) => i.fileName)
    .flatMap((spec) =>
      spec.startsWith('@/')
        ? [spec.slice(2)]
        : spec.startsWith('.')
          ? [
              relative(WEB, resolve(WEB, dirname(file), spec))
                .split(sep)
                .join('/'),
            ]
          : [],
    );
}

describe('nothing the product ships imports the showcase or its sample content', () => {
  const all = [...sourceFiles()].filter((file) => /\.(tsx?|mjs|jsx?)$/.test(file));
  const shipped = all.filter((file) => !notShipped(file));

  it('reads the app: its pages and the primitives', () => {
    expect(shipped).toContain('app/layout.tsx');
    expect(shipped).toContain('components/ui/ProvenancePin.tsx');
    expect(shipped).not.toContain('components/ui/fixtures/mock.ts');
    expect(shipped).not.toContain('app/dev/ui/Showcase.tsx');
  });

  it('finds no such import', () => {
    const found = shipped.flatMap((file) =>
      imports(file)
        .filter(devOnly)
        .map((target) => `${file} -> ${target}`),
    );
    expect(found).toEqual([]);
  });

  it('keeps every route under app/dev a development route: page.dev.tsx, never page.tsx', () => {
    const routes = all.filter(
      (file) => inside(file, 'app/dev') && /(^|\/)(page|route|layout)\.[jt]sx?$/.test(file),
    );
    expect(routes).toEqual([]);
    expect(all).toContain('app/dev/ui/page.dev.tsx');
  });

  it('bites: the showcase does import the sample content', () => {
    expect(imports('app/dev/ui/Showcase.tsx').some(devOnly)).toBe(true);
  });
});

// The same folders, seen from the other end: scripts/check-build.mjs reads what a production build
// was made from and fails it if a file of one of them is there.
describe('the build check knows the design system’s development-only folders', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const OURS = '../../../../../../apps/web/';
  /** A stand-in for `.next` whose one route was built from the files given. */
  function build(...sources: string[]): string {
    const out = mkdtempSync(join(tmpdir(), 'check-build-ui-'));
    made.push(out);
    const files: Record<string, string> = {
      'static/chunks/app.js': `x.displayName="${REQUIRED}"`,
      'server/chunks/ssr/1.js.map': JSON.stringify({
        version: 3,
        sources: [`${OURS}${ALWAYS_BUILT}`, ...sources.map((file) => `${OURS}${file}`)],
      }),
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), text);
    }
    return out;
  }

  it('names every folder this test calls development-only', () => {
    for (const folder of DEV_ONLY)
      expect(BUILD_DEV_ONLY.test(`apps/web/${folder}/x.tsx`), folder).toBe(true);
    for (const file of [
      'components/ui/fixtures/mock.ts',
      'components/ui/test/cases.tsx',
      'app/dev/ui/Showcase.tsx',
      'app/dev/ui/page.dev.tsx',
    ])
      expect(BUILD_DEV_ONLY.test(`${OURS}${file}`), file).toBe(true);
  });

  it('leaves the primitives and the pages alone', () => {
    for (const file of [
      'components/ui/Card.tsx',
      'components/ui/internal/mock-parts.tsx',
      'components/ui/testing.ts',
      'components/ui/fixtures.ts',
      'app/developers/page.tsx',
      'app/layout.tsx',
    ])
      expect(BUILD_DEV_ONLY.test(`${OURS}${file}`), file).toBe(false);
    expect(checkBuild(build('components/ui/Card.tsx', 'app/layout.tsx'))).toEqual([]);
  });

  it('fails a build made from the sample content, a test helper or the showcase', () => {
    for (const file of [
      'components/ui/fixtures/mock.ts',
      'components/ui/test/html.ts',
      'app/dev/ui/Showcase.tsx',
    ])
      expect(checkBuild(build('app/page.tsx', file))).toEqual([
        `server/chunks/ssr/1.js.map was built from ${OURS}${file}`,
      ]);
  });

  it('runs the test of the built stylesheet after the build, and that test exists', () => {
    expect(BUILT_CSS_TEST).toBe('apps/web/components/ui/forbidden.test.ts');
    expect(existsSync(join(WEB, '..', '..', BUILT_CSS_TEST))).toBe(true);
    const script = read('scripts/check-build.mjs');
    expect(script).toContain("REQUIRE_WEB_BUILD: '1'");
    expect(script).toMatch(/process\.exitCode = builtStylesheetCheck\(\)/);
    expect(read('components/ui/forbidden.test.ts')).toContain(
      "process.env.REQUIRE_WEB_BUILD === '1'",
    );
  });
});
