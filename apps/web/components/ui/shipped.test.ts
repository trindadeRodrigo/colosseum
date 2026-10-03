import { dirname, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
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
