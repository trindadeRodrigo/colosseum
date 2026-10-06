import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// What the landing's 3D joint may fetch: nothing but its own module, since the wood and the room are
// computed; and the only files it has, the stills of the fallbacks, small and credited. The chunk's
// own weight (at most 180 KB gzipped, joint-stage.md) is held after every build by
// scripts/check-build.mjs (STAGE_BUDGET, STAGE_MARKERS).

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const KB = 1024;
const BUDGET = { assets: 1.5 * 1024 * KB, still: 100 * KB };

const SCENE = ['joint-scene.ts', 'joint-wood.ts', 'joint-geometry.ts', 'joint-pose.ts'];

describe('what the 3D joint fetches', () => {
  it('imports three’s core and its own files, and nothing that could fetch', () => {
    for (const file of SCENE) {
      const text = readFileSync(join(HERE, file), 'utf8');
      const from = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(
        from.filter((f) => f !== 'three' && !f?.startsWith('./')),
        file,
      ).toEqual([]);
      expect(text, file).not.toMatch(/Loader\b|fetch\(|XMLHttpRequest|import\(/);
    }
  });

  it('serves its stills small, with their provenance: each under 100 KB, all under 1.5 MB', () => {
    const dir = join(WEB, 'public', 'landing', 'joint');
    const sizes = readdirSync(dir)
      .filter((name) => name.endsWith('.webp'))
      .map((name) => [name, statSync(join(dir, name)).size] as const);
    expect(sizes.map(([name]) => name).sort()).toEqual(
      ['apart', 'seated'].flatMap((s) => ['dark', 'light'].map((g) => `joint-${s}-${g}.webp`)),
    );
    for (const [name, size] of sizes) expect(size, name).toBeLessThan(BUDGET.still);
    expect(sizes.reduce((sum, [, size]) => sum + size, 0)).toBeLessThan(BUDGET.assets);
    // imagery-style.md §6: a render is credited as one, with its source beside it
    const provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
    expect(provenance.kind).toBe('render');
    expect([...provenance.files].sort()).toEqual(sizes.map(([name]) => name).sort());
  });
});
