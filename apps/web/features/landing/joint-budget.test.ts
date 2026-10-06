import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// What the landing's 3D joint may fetch: nothing but its own module, since the drawing is computed; and the only files it has, the stills of the fallbacks, small and credited. The chunk's
// own weight (at most 180 KB gzipped, joint-stage.md) is held after every build by
// scripts/check-build.mjs (STAGE_BUDGET, STAGE_MARKERS).

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const KB = 1024;
const BUDGET = { assets: 40 * KB, still: 10 * KB };

const SCENE = [
  'joint-scene.ts',
  'joint-ink.ts',
  'joint-geometry.ts',
  'joint-pose.ts',
  'coins-scene.ts',
  'coins.ts',
];

describe('what the 3D joint fetches', () => {
  it('imports three and its line and geometry helpers, its own files, and nothing that could fetch', () => {
    for (const file of SCENE) {
      const text = readFileSync(join(HERE, file), 'utf8');
      const from = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(
        from.filter(
          (f) => f !== 'three' && !f?.startsWith('three/examples/jsm/') && !f?.startsWith('./'),
        ),
        file,
      ).toEqual([]);
      expect(text, file).not.toMatch(/Loader\b|fetch\(|XMLHttpRequest|import\(/);
    }
  });

  it('serves its stills small, with their provenance: each SVG under 10 KB, all under 40 KB', () => {
    const dir = join(WEB, 'public', 'landing', 'joint');
    const sizes = readdirSync(dir)
      .filter((name) => name.endsWith('.svg'))
      .map((name) => [name, statSync(join(dir, name)).size] as const);
    expect(sizes.map(([name]) => name).sort()).toEqual(
      ['apart', 'seated'].flatMap((s) => ['dark', 'light'].map((g) => `joint-${s}-${g}.svg`)),
    );
    for (const [name, size] of sizes) expect(size, name).toBeLessThan(BUDGET.still);
    expect(sizes.reduce((sum, [, size]) => sum + size, 0)).toBeLessThan(BUDGET.assets);
    // imagery-style.md §6: a render is credited as one, with its source beside it
    const provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
    expect(provenance.kind).toBe('render');
    expect([...provenance.files].sort()).toEqual(sizes.map(([name]) => name).sort());
  });

  it('is fetched only by the stage, and only on demand: no file imports the scene as a value', () => {
    const root = join(WEB);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(path, 'utf8');
          // a static import of the scene (not `import type`), from anywhere in the app
          if (/^import\s+(?!type\b)[^;]*from\s+'[^']*joint-scene'/m.test(text)) found.push(path);
        }
      }
    };
    for (const top of ['app', 'features', 'components']) walk(join(root, top));
    // the dev page that makes the stills is a route under `next dev` only
    expect(found.map((f) => f.slice(root.length + 1))).toEqual([
      'app/(marketing)/dev/joint/page.dev.tsx',
    ]);
    expect(readFileSync(join(HERE, 'JointStage.tsx'), 'utf8')).toContain("import('./joint-scene')");
  });

  it('loads the closing’s coins on demand too: no file imports their scene as a value', () => {
    const found: string[] = [];
    for (const top of ['app', 'features', 'components']) {
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          if (name === 'node_modules' || name.startsWith('.')) continue;
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
            const text = readFileSync(path, 'utf8');
            if (/^import\s+(?!type\b)[^;]*from\s+'[^']*coins-scene'/m.test(text)) found.push(path);
          }
        }
      };
      walk(join(WEB, top));
    }
    expect(found).toEqual([]);
    expect(readFileSync(join(HERE, 'ClosingCoins.tsx'), 'utf8')).toContain(
      "import('./coins-scene')",
    );
  });
});
