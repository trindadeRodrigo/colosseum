import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBuild, FORBIDDEN, REQUIRED } from '../../scripts/check-build.mjs';
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

const CLEAN = {
  'static/chunks/app.js': `x.displayName="${WALLET_MARKER}"`,
  'app-path-routes-manifest.json': JSON.stringify({ '/page': '/', '/monitor/page': '/monitor' }),
  'server/app/monitor.html': '<html></html>',
};

describe('the check that runs after every production build', () => {
  it('looks for the strings the code carries', () => {
    expect(Object.keys(FORBIDDEN).sort()).toEqual([DEV_PAGE_MARKER, TEST_WALLET_MARKER].sort());
    expect(REQUIRED).toBe(WALLET_MARKER);
    const web = join(import.meta.dirname, '..', '..');
    // The build script runs the check, and the dev page's route file has the development extension.
    const scripts = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).scripts;
    expect(scripts.build).toBe('next build && node scripts/check-build.mjs');
    expect(readFileSync(join(web, 'app/dev/wallet/page.dev.tsx'), 'utf8')).toContain('DevWallet');
    const config = readFileSync(join(web, 'next.config.ts'), 'utf8');
    expect(config).toContain("dev ? ['dev.tsx', ...ROUTES] : ROUTES");
  });

  it('passes a build with none of it', () => {
    expect(checkBuild(build(CLEAN))).toEqual([]);
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

  it('fails when it cannot find what every build ships, instead of passing on nothing', () => {
    expect(checkBuild(build({ 'static/chunks/app.js': 'nothing of ours' }))).toEqual([
      expect.stringContaining('proves nothing'),
    ]);
    expect(checkBuild(join(tmpdir(), 'no-such-build-output'))).toEqual([
      expect.stringContaining('no build output'),
    ]);
  });

  it('leaves out what `next dev` writes, which is not part of a build', () => {
    const out = build({ ...CLEAN, 'dev/static/chunks/1.js': TEST_WALLET_MARKER });
    expect(checkBuild(out)).toEqual([]);
  });
});
