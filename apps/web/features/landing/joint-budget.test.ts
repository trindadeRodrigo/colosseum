import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// What the landing's 3D joint may weigh (joint-stage.md: the stage's JS, three and the scene, at most
// 180 KB gzipped, loaded after the first paint), and what it may fetch: nothing but its own module.
// The wood and the room are computed; the only files are the stills of the fallbacks, under 1.5 MB
// together. The chunk is measured in the output of `next build`: a plain test run skips that part
// when there is no fresh build, and scripts/check-build.mjs runs this file again with
// REQUIRE_WEB_BUILD=1 after every build, so CI measures the real chunk.

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const KB = 1024;
export const BUDGET = { js: 180 * KB, assets: 1.5 * 1024 * KB, still: 100 * KB };

const SCENE = ['joint-scene.ts', 'joint-wood.ts', 'joint-geometry.ts', 'joint-pose.ts'];

describe('the 3D joint’s budget', () => {
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

  describe('in the output of `next build`, when there is a fresh one', () => {
    const required = process.env.REQUIRE_WEB_BUILD === '1';
    const chunks = join(WEB, '.next', 'static', 'chunks');
    const id = join(WEB, '.next', 'BUILD_ID');
    const built = existsSync(id) ? statSync(id).mtimeMs : 0;
    const newest = Math.max(...SCENE.map((f) => statSync(join(HERE, f)).mtimeMs));
    const fresh = built > newest && existsSync(chunks);

    it.skipIf(!fresh && !required)('ships three and the scene in at most 180 KB gzipped', () => {
      expect(fresh, 'there is no build in apps/web/.next newer than the scene').toBe(true);
      const all: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (name.endsWith('.js')) all.push(path);
        }
      };
      walk(chunks);
      // the scene's chunk names its shader program; three's names its renderer in its warnings
      const stage = all.filter((path) => {
        const text = readFileSync(path, 'latin1');
        return text.includes('tf-wood') || text.includes('THREE.WebGLRenderer');
      });
      expect(stage.length).toBeGreaterThan(0);
      const gzipped = stage.reduce((sum, path) => sum + gzipSync(readFileSync(path)).length, 0);
      console.log(
        `the 3D joint: ${stage.length} chunk(s), ${(gzipped / KB).toFixed(1)} KB gzipped`,
      );
      expect(gzipped).toBeLessThanOrEqual(BUDGET.js);
    });
  });
});
