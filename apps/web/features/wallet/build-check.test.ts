import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALWAYS_BUILT,
  checkBuild,
  DEV_ONLY,
  FORBIDDEN,
  REQUIRED,
  STAGE_BUDGET,
  STAGE_MARKERS,
} from '../../scripts/check-build.mjs';
import { DEV_PAGE_MARKER } from './dev/marker';
import { WALLET_MARKER } from './marker';
import { TEST_WALLET_MARKER } from './test/test-driver';

// scripts/check-build.mjs runs after every `next build` and fails it when development-only code is in
// the output. Here: the strings it looks for are the ones the code carries, and it bites on each.

const made: string[] = [];
/** A stand-in for `.next`: the files a build writes, with the contents given. */
function build(files: Record<string, string>): string {
  const out = mkdtempSync(join(tmpdir(), 'check-build-'));
  made.push(out);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  return out;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A source map as the build writes one beside a server chunk. */
const map = (...sources: string[]) => JSON.stringify({ version: 3, sources });
const OURS = '../../../../../../apps/web/';

const CLEAN = {
  'static/chunks/app.js': `x.displayName="${WALLET_MARKER}"`,
  'app-path-routes-manifest.json': JSON.stringify({ '/page': '/', '/monitor/page': '/monitor' }),
  'routes-manifest.json': JSON.stringify({ staticRoutes: [{ page: '/' }, { page: '/monitor' }] }),
  'server/pages-manifest.json': JSON.stringify({ '/404': 'pages/404.html' }),
  'server/app/monitor.html': '<html></html>',
  'server/chunks/ssr/1.js.map': map(`${OURS}app/(app)/layout.tsx`, `${OURS}${ALWAYS_BUILT}`),
};

describe('the check that runs after every production build', () => {
  it('looks for the strings the code carries', () => {
    expect(Object.keys(FORBIDDEN).sort()).toEqual([DEV_PAGE_MARKER, TEST_WALLET_MARKER].sort());
    expect(REQUIRED).toBe(WALLET_MARKER);
    const web = join(import.meta.dirname, '..', '..');
    // The build script runs the check, and the dev page's route file has the development extension.
    const scripts = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).scripts;
    expect(scripts.build).toBe('next build && node scripts/check-build.mjs');
    expect(readFileSync(join(web, 'app/(app)/dev/wallet/page.dev.tsx'), 'utf8')).toContain(
      'DevWallet',
    );
    const config = readFileSync(join(web, 'next.config.ts'), 'utf8');
    expect(config).toContain("dev ? ['dev.tsx', ...ROUTES] : ROUTES");
  });

  it('passes a build with none of it', () => {
    expect(checkBuild(build(CLEAN))).toEqual([]);
  });

  it('holds the joint to 180 KB gzipped (joint-stage.md), found by its renderer or the scene’s mark', () => {
    expect(STAGE_BUDGET).toBe(180 * 1024);
    // the mark the scene puts on its canvas, read from its source: the two cannot drift apart
    const scene = readFileSync(
      join(import.meta.dirname, '..', 'landing', 'joint-scene.ts'),
      'utf8',
    );
    const mark = /const MARK = '([^']+)'/.exec(scene)?.[1];
    expect(mark).toBe('tf-joint-ink');
    expect(STAGE_MARKERS).toContain(mark);
    // a chunk with only the scene in it (three split away) is weighed too
    const noise = randomBytes(360 * 1024).toString('base64');
    const sceneOnly = build({ ...CLEAN, 'static/chunks/scene.js': `"${mark}";${noise}` });
    expect(checkBuild(sceneOnly)).toEqual([expect.stringContaining('the 3D joint')]);
  });

  it('holds the landing’s 3D joint to its budget, gzipped', () => {
    // a chunk that compresses to little passes, however long it is
    const small = build({
      ...CLEAN,
      'static/chunks/3d.js': `new WebGLRenderer;${'a'.repeat(400_000)}`,
    });
    expect(checkBuild(small)).toEqual([]);
    // one that does not, over the budget, fails
    const noise = randomBytes(360 * 1024).toString('base64');
    const big = build({ ...CLEAN, 'static/chunks/3d.js': `new WebGLRenderer;${noise}` });
    expect(checkBuild(big)).toEqual([expect.stringContaining('the 3D joint')]);
  });

  it('fails when the throwaway wallet is in a chunk', () => {
    const out = build({ ...CLEAN, 'static/chunks/1.js': `marker:"${TEST_WALLET_MARKER}"` });
    expect(checkBuild(out)).toEqual([expect.stringContaining('static/chunks/1.js contains')]);
  });

  it('fails when the dev page is in a chunk, on the server side too', () => {
    const out = build({ ...CLEAN, 'server/chunks/ssr/2.js': `"data-marker":"${DEV_PAGE_MARKER}"` });
    expect(checkBuild(out)).toEqual([expect.stringContaining('server/chunks/ssr/2.js contains')]);
  });

  it('fails when a route under /dev is in a manifest or on disk', () => {
    const manifest = build({
      ...CLEAN,
      'app-path-routes-manifest.json': JSON.stringify({ '/dev/wallet/page': '/dev/wallet' }),
    });
    expect(checkBuild(manifest).join('\n')).toContain('development route: /dev/wallet');
    const folder = build({ ...CLEAN, 'server/app/dev/wallet.html': '<html></html>' });
    expect(checkBuild(folder)).toEqual(['the build has a development route: /dev']);
    // A route that only starts with the same letters is not one.
    expect(checkBuild(build({ ...CLEAN, 'server/app/developers.html': '' }))).toEqual([]);
  });

  it('fails on a /dev route inside a route group, as the build names it', () => {
    // The development pages are in app/(app)/dev. A group is a folder and no part of the address, and
    // the build names it in one manifest and in the folders it writes.
    const manifest = build({
      ...CLEAN,
      'server/app-paths-manifest.json': JSON.stringify({
        '/(app)/goal/page': 'app/(app)/goal/page.js',
        '/(app)/dev/wallet/page': 'app/(app)/dev/wallet/page.js',
      }),
    });
    expect(checkBuild(manifest)).toEqual([
      'the build has a development route: /(app)/dev/wallet/page',
    ]);
    const folder = build({ ...CLEAN, 'server/app/(app)/dev/ui.html': '<html></html>' });
    expect(checkBuild(folder)).toEqual(['the build has a development route: /dev']);
    // The product's own routes in that group are not development routes.
    const product = build({
      ...CLEAN,
      'server/app-paths-manifest.json': JSON.stringify({
        '/(app)/goal/page': 'app/(app)/goal/page.js',
        '/(structurer)/[...missing]/page': 'app/(structurer)/[...missing]/page.js',
      }),
      'server/app/(app)/goal.html': '',
      'server/app/(app)/developers.html': '',
    });
    expect(checkBuild(product)).toEqual([]);
  });

  it('fails when it cannot find what every build ships, instead of passing on nothing', () => {
    expect(checkBuild(build({ ...CLEAN, 'static/chunks/app.js': 'nothing of ours' }))).toEqual([
      expect.stringContaining('proves nothing'),
    ]);
    expect(checkBuild(join(tmpdir(), 'no-such-build-output'))).toEqual([
      expect.stringContaining('no build output'),
    ]);
  });

  it('fails when a /dev route is in any of the other manifests', () => {
    const cases = {
      'routes-manifest.json': JSON.stringify({ dynamicRoutes: [{ page: '/dev/[tool]' }] }),
      'server/pages-manifest.json': JSON.stringify({ '/dev/wallet': 'pages/dev/wallet.js' }),
      'server/app-paths-manifest.json': JSON.stringify({
        '/dev/wallet/page': 'app/dev/wallet/page.js',
      }),
      'server/pages/dev.html': '',
    };
    for (const [file, text] of Object.entries(cases))
      expect(checkBuild(build({ ...CLEAN, [file]: text })).join('\n'), file).toContain(
        'the build has a development route: /dev',
      );
  });

  it('fails when a route was built from a file of the dev or the test folder', () => {
    // No marker survives here: dev/rpc.ts carries none. The source map is what gives it away.
    for (const file of ['features/wallet/dev/rpc.ts', 'features/wallet/test/fixtures.ts']) {
      const out = build({
        ...CLEAN,
        'server/chunks/ssr/2.js.map': map(
          `${OURS}app/(structurer)/monitor/page.tsx`,
          `${OURS}${file}`,
        ),
      });
      expect(checkBuild(out)).toEqual([`server/chunks/ssr/2.js.map was built from ${OURS}${file}`]);
    }
    // A map in sections, and a path written with escapes, are read the same way.
    const sections = build({
      ...CLEAN,
      'server/app/page.js.map': JSON.stringify({
        version: 3,
        sections: [{ map: { sources: [`${OURS}features/wallet/dev/self%2Dtransfer.ts`] } }],
      }),
    });
    expect(checkBuild(sections)).toHaveLength(1);
    expect(DEV_ONLY.test('apps/web/features/wallet/developer.ts')).toBe(false);
    expect(DEV_ONLY.test('apps/web/features/wallet/testing/x.ts')).toBe(false);
  });

  it('fails when no source map names our files, instead of passing on nothing', () => {
    const { 'server/chunks/ssr/1.js.map': _, ...noMaps } = CLEAN;
    expect(checkBuild(build(noMaps))).toEqual([expect.stringContaining('cannot see which files')]);
    const others = build({
      ...noMaps,
      'server/chunks/ssr/9.js.map': map('node_modules/next/x.js'),
    });
    expect(checkBuild(others)).toEqual([expect.stringContaining('cannot see which files')]);
  });

  it('leaves out what `next dev` writes, which is not part of a build', () => {
    const out = build({ ...CLEAN, 'dev/static/chunks/1.js': TEST_WALLET_MARKER });
    expect(checkBuild(out)).toEqual([]);
  });
});
