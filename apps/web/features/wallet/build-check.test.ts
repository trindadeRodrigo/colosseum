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
  fingerprint,
  KNOWN_BYTE_TABLES,
  REQUIRED,
  SECRET_SHAPES,
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

describe('what a browser is sent', () => {
  // made here, never a real key: each is the shape alone
  const key = 'k'.repeat(40);
  const jwt = (claims: object) =>
    [{ alg: 'HS256', typ: 'JWT' }, claims, 'signature-of-sixteen+']
      .map((part) =>
        typeof part === 'string' ? part : Buffer.from(JSON.stringify(part)).toString('base64url'),
      )
      .join('.')
      .replace('+', 'x');
  const keypair = `[${Array.from({ length: 64 }, (_, i) => (i * 37) % 256).join(',')}]`;
  it.each([
    ['a keyed Solana node', `fetch("https://mainnet.helius-rpc.com/?api-key=${key}")`],
    ['a keyed EVM node', `url:"https://base-mainnet.g.alchemy.com/v2/${key}"`],
    ['a provider key', `authorization:"Bearer sk-${key}"`],
    ['a database URL', `"postgresql://postgres:${key}@db.example:5432/postgres"`],
    ['a Supabase service-role JWT', `key:"${jwt({ iss: 'supabase', role: 'service_role' })}"`],
    ['a Supabase secret key', `key:"sb_secret_${key}"`],
    [
      'a PEM private key',
      `"-----BEGIN PRIVATE KEY-----\\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(2)}"`,
    ],
    ['a hex private key', `PRIVATE_KEY="0x${'ab'.repeat(32)}"`],
    ['a Solana secret key', `secretKey:new Uint8Array(${keypair})`],
    ['a Discord webhook', `"https://discord.com/api/webhooks/123456789012345678/${key}"`],
  ])('may not hold %s', (_, text) => {
    const out = build({ ...CLEAN, 'static/chunks/env.js': text });
    const problems = checkBuild(out);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^static\/chunks\/env\.js holds /);
    // the finding names the file and the shape, never the key
    expect(problems[0]).not.toContain(key);
  });

  it('may hold a public node, a public id, a placeholder and what only looks like a key', () => {
    const out = build({
      ...CLEAN,
      'static/chunks/env.js': [
        'rpc:"https://api.devnet.solana.com",app:"cm0publicprivyappid000000",t:"task-list ask-me"',
        // a library's own example, and a template it fills in later
        'docs:"https://rpc.example/?api-key=YOUR_API_KEY",u:"https://x.example/?api-key=${apiKey}"',
        // an anon key is public by design; a PEM header alone is a parser's constant
        `anon:"${jwt({ iss: 'supabase', role: 'anon' })}",h:"-----BEGIN PRIVATE KEY-----"`,
        // a hash and a topic are 32 bytes of hex with no name that says "key"; a table is not 64 bytes
        `topic:"0x${'cd'.repeat(32)}",table:[${Array.from({ length: 256 }, (_, i) => i).join(',')}]`,
      ].join(';'),
    });
    expect(checkBuild(out)).toEqual([]);
    expect(Object.keys(SECRET_SHAPES)).toHaveLength(9);
  });

  it('takes a placeholder for one only when the whole value is one', () => {
    const holds = (value: string) =>
      checkBuild(
        build({ ...CLEAN, 'static/chunks/env.js': `u:"https://rpc.example/?api-key=${value}"` }),
      ).length;
    for (const placeholder of ['YOUR_API_KEY', 'API_KEY_HERE', 'xxxxxxxx', 'XXXXXXXXXXXX'])
      expect(holds(placeholder), placeholder).toBe(0);
    // a key is a key whatever it begins with
    for (const real of [
      'my8f3k2j9d0s1a7q',
      'yourKey_4f9a2c7e1b',
      'example-9f8e7d6c5b4a',
      'YOUR_API_KEY_9f8e7d6c',
    ])
      expect(holds(real), real).toBe(1);
  });

  it('says where a 64-byte array is and what short name it has, and nothing of what stands beside it', () => {
    // a neighbour that is itself a secret: a base58 key and a hex key right before the array
    const base58 = '5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UT1mQa';
    const hex = 'deadbeefcafebabefeedfacedeadbeefcafebabefeedfacedeadbeefcafebabe';
    for (const [text, named] of [
      [`a="${base58}",b="${hex}",payer=${keypair}`, 'payer'],
      [`"${base58}":${keypair}`, null],
      [`${hex}=${keypair}`, null],
    ] as const) {
      const [problem] = checkBuild(build({ ...CLEAN, 'static/chunks/env.js': text }));
      expect(problem).toMatch(/fingerprint [0-9a-f]{16}, at offset \d+/);
      expect(problem?.includes('named ')).toBe(named !== null);
      if (named) expect(problem).toContain(`named ${named}`);
      for (const secret of [base58, hex])
        for (let i = 0; i + 6 <= secret.length; i += 6)
          expect(problem, text).not.toContain(secret.slice(i, i + 6));
    }
  });

  it('flags 64 bytes under any name, and lets through only a table listed by its fingerprint', () => {
    // a key is not always called one: a plain name, a payer, an authority, no name at all
    for (const text of [
      `const k=${keypair};`,
      `payer:${keypair}`,
      `authority=Uint8Array.from(${keypair})`,
      `f(${keypair})`,
    ]) {
      const problems = checkBuild(build({ ...CLEAN, 'static/chunks/env.js': text }));
      expect(problems, text).toHaveLength(1);
      // the finding gives the fingerprint to list it by, and none of the bytes
      expect(problems[0]).toContain(`fingerprint ${fingerprint(keypair)}`);
      expect(problems[0]).not.toContain(keypair.slice(1, 40));
    }
    // the one table listed: sixty-four zeros, as blakejs ships them, and nothing else
    const zeros = `[${Array.from({ length: 64 }, () => 0).join(',')}]`;
    expect([...KNOWN_BYTE_TABLES.keys()]).toEqual([fingerprint(zeros)]);
    expect(checkBuild(build({ ...CLEAN, 'static/chunks/env.js': `d=${zeros}` }))).toEqual([]);
    // a library's table, once listed, is let through; the same bytes changed by one are not
    KNOWN_BYTE_TABLES.set(fingerprint(keypair), 'a table made for this test');
    try {
      expect(checkBuild(build({ ...CLEAN, 'static/chunks/env.js': `t=${keypair}` }))).toEqual([]);
      const other = keypair.replace(/\d+\]$/, '7]');
      expect(checkBuild(build({ ...CLEAN, 'static/chunks/env.js': `t=${other}` }))).toHaveLength(1);
    } finally {
      KNOWN_BYTE_TABLES.delete(fingerprint(keypair));
    }
  });

  it('reads the pages and payloads rendered ahead of time as it reads the bundle', () => {
    for (const path of ['server/app/index.html', 'server/app/goal.rsc', 'server/app/plan.meta']) {
      const problems = checkBuild(build({ ...CLEAN, [path]: `"sb_secret_${key}"` }));
      expect(problems, path).toHaveLength(1);
      expect(problems[0]).toContain(path);
    }
  });

  it('is not read into what the server alone keeps', () => {
    const out = build({
      ...CLEAN,
      'server/chunks/db.js': `"postgresql://u:${'p'.repeat(12)}@h/db"`,
    });
    expect(checkBuild(out)).toEqual([]);
  });
});

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
