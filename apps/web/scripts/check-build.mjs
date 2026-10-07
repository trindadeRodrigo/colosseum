#!/usr/bin/env node
// Runs after `next build` (see "build" in package.json). The build fails if the output holds anything
// that exists for development only: the throwaway wallet, the dev page, any route under /dev, or any
// file of a development-only folder (DEV_ONLY below) in what a route was built from.
// It holds the landing's 3D joint to its budget (STAGE_BUDGET), and no file a browser is sent may hold
// a key (SECRET_SHAPES).
// It also looks for one string every build ships and one file every route is built from, so a change
// in where Next writes its output makes this check fail instead of pass on nothing.
// Last, it runs the design system's test of the built stylesheet and fonts, which a plain test run
// skips for want of a build (components/ui/forbidden.test.ts), and starts the build to ask who may
// frame each address (check-frames.mjs).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Strings that must not be in a production build. Each is a constant in the file named. */
export const FORBIDDEN = {
  'test-wallet:throwaway-keys': 'features/wallet/test/test-driver.ts (TEST_WALLET_MARKER)',
  'dev-page:wallet-check': 'features/wallet/dev/marker.ts (DEV_PAGE_MARKER)',
};
/** A string every build must contain: features/wallet/marker.ts (WALLET_MARKER). */
export const REQUIRED = 'wallet-port:shipped';

/**
 * The landing's 3D (joint-stage.md: "stage JS (three + scene) ≤ 180 KB gzip"): the browser chunks
 * that carry three.js or a scene, by strings each keeps when minified (three's renderer names itself
 * in its warnings; each scene marks its canvas: the hero's joint-scene.ts, the closing's
 * coins-scene.ts). The two scenes share three.js, and are held together to the one budget.
 */
export const STAGE_BUDGET = 180 * 1024;
export const STAGE_MARKERS = ['WebGLRenderer', 'tf-joint-ink', 'tf-coins-ink'];

/**
 * What no file a browser is sent may hold: a node's URL with its key in it, a provider's or a
 * database's key, a private key in any of its usual forms, a webhook's address. A `NEXT_PUBLIC_` value
 * is written into the bundle as it is, so a keyed RPC URL set as `NEXT_PUBLIC_CHAIN_READ_RPC_<CHAIN>`
 * would be public: the read node of the web is a public one (features/wallet/README.md). A server
 * component can also write a value into a page it renders ahead of time, so the pages and the
 * payloads the build wrote (`SENT_FILES`) are read as the bundle is. Each shape answers whether the
 * text holds one; the match is never printed.
 *
 * A placeholder is not a key: `?api-key=YOUR_API_KEY`, as a library's own documentation writes it.
 */
const PLACEHOLDER = /^(your|my|example|xxx+|<|\$\{|\{\{|%)/i;
const keyed = (shape) => (text) =>
  [...text.matchAll(shape)].some((m) => !PLACEHOLDER.test(m[1] ?? ''));
/** A JWT whose claims name Supabase's service role: the key that passes every row rule. */
const serviceRoleJwt = (text) =>
  [...text.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{16,}/g)].some(
    (m) => {
      try {
        return /"role"\s*:\s*"service_role"/.test(Buffer.from(m[1], 'base64url').toString());
      } catch {
        return false;
      }
    },
  );
/** A 64-byte array by the SHA-256 of its numbers, spaces dropped: 16 hex characters of it. */
export const fingerprint = (array) =>
  createHash('sha256').update(array.replace(/\s/g, '')).digest('hex').slice(0, 16);

/**
 * The 64-byte arrays a build may ship: a library's constant, by its fingerprint, with what it is. An
 * entry is added only after the array was looked at where the library defines it. Anything else of
 * that shape fails the build, whatever it is called.
 */
export const KNOWN_BYTE_TABLES = new Map([
  // Sixty-four zeros: the parameter block of BLAKE2b in blakejs 1.2.1 (`parameterBlock` in
  // blake2b.js), which the library fills in before each hash. Under the sign-in library's wallets.
  ['ca0101ae4bf3b31b', 'blakejs: the empty BLAKE2b parameter block'],
]);

const BYTE = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const BYTES_64 = new RegExp(`\\[\\s*(?:${BYTE}\\s*,\\s*){63}${BYTE}\\s*\\]`, 'g');
export const SECRET_SHAPES = {
  'a URL with an api key in its query': keyed(/[?&]api[-_]?key=([A-Za-z0-9_-]{8,})/gi),
  'a keyed node URL': keyed(
    /(?:alchemy\.com\/v2|infura\.io\/v3|quiknode\.pro)\/([A-Za-z0-9_-]{16,})/gi,
  ),
  'a provider key': (text) => /\bsk-[A-Za-z0-9_-]{32,}/.test(text),
  'a database URL with a password': (text) =>
    /\bpostgres(ql)?:\/\/[^\s"'`:@/]+:[^\s"'`@/]{6,}@/i.test(text),
  'a Supabase service-role key': (text) =>
    /\bsb_secret_[A-Za-z0-9_-]{16,}/.test(text) || serviceRoleJwt(text),
  // the header and a body after it: a library that reads keys names the header alone
  'a private key in PEM': (text) =>
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:\\r|\\n|\s)+[A-Za-z0-9+/=]{40,}/.test(text),
  // 32 bytes of hex beside a name that says what they are: a hash or a topic has no such name
  'a private key in hex': (text) =>
    /(?:private|secret)[_-]?key["'`]?\s*[:=]\s*["'`]?(?:0x)?[0-9a-fA-F]{64}\b/i.test(text),
  // A Solana keypair: 64 bytes as an array of numbers, under any name or none (`const k = [...]`,
  // `payer`, `authority`). A library's own table of 64 bytes is told apart by what it is, never by
  // what it is called: each one a build ships is listed in KNOWN_BYTE_TABLES by its fingerprint.
  'a Solana secret key': (text) => {
    for (const m of text.matchAll(BYTES_64)) {
      const print = fingerprint(m[0]);
      if (KNOWN_BYTE_TABLES.has(print)) continue;
      // the fingerprint, and the letters before it with every digit masked: enough to say which
      // table it is and list it, and nothing of the bytes
      const before = text.slice(Math.max(0, (m.index ?? 0) - 48), m.index).replace(/\d/g, '#');
      return `fingerprint ${print}, after ${JSON.stringify(before)}`;
    }
    return false;
  },
  'a Discord webhook': (text) =>
    /discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[A-Za-z0-9_-]{20,}/i.test(text),
};

/**
 * The files of a build a browser is sent: the bundle, and under `server/app` the pages rendered ahead
 * of time and their payloads (`.html`, `.rsc`, `.body`, and the `.meta` beside them).
 */
export const SENT_FILES = /^(static\/|server\/app\/.*\.(html|rsc|body|meta)$)/;

/** What `next dev` and the build cache write. Neither is served by `next start`. */
const SKIP = new Set(['dev', 'cache', 'diagnostics', 'types']);

function* files(dir, root = dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (dir === root && SKIP.has(name)) continue;
    if (statSync(path).isDirectory()) yield* files(path, root);
    else yield path;
  }
}

const json = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

/** Every route path the build knows, from each of its manifests and from the folders it wrote. */
function routes(out) {
  const found = new Set();
  // App Router: route file to path. Pages Router: path to file.
  for (const name of ['app-path-routes-manifest.json', 'server/app-paths-manifest.json']) {
    for (const [key, value] of Object.entries(json(join(out, name)) ?? {})) {
      found.add(key);
      if (typeof value === 'string' && value.startsWith('/')) found.add(value);
    }
  }
  for (const key of Object.keys(json(join(out, 'server/pages-manifest.json')) ?? {}))
    found.add(key);
  const manifest = json(join(out, 'routes-manifest.json')) ?? {};
  for (const list of [manifest.staticRoutes, manifest.dynamicRoutes, manifest.dataRoutes])
    for (const route of list ?? []) if (typeof route?.page === 'string') found.add(route.page);
  for (const top of ['server/app', 'server/pages']) {
    const dir = join(out, top);
    if (existsSync(dir))
      for (const name of firstSegments(dir)) found.add(`/${name.replace(/\.[a-z.]+$/, '')}`);
  }
  return [...found];
}

/** What a build wrote at the top of a routes folder, looking inside route groups: `(app)/dev` is `dev`. */
function* firstSegments(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (/^\(.+\)$/.test(name) && statSync(path).isDirectory()) yield* firstSegments(path);
    else yield name;
  }
}

/**
 * A route as its address. Some manifests name the route group a page is in, `/(app)/dev/ui/page`: a
 * group is a folder and no part of the address.
 */
const address = (route) => route.replace(/\/\([^/]+\)(?=\/|$)/g, '') || '/';

/**
 * Folders whose files are for development and tests only. No built route may come from them: a
 * folder named `dev`, `test` or `fixtures`, at any depth, under the app's own source folders. That is
 * a feature's `dev` and `test` (the wallet's dev page and test driver, the doubles the screens are
 * tested against), a component folder's `fixtures` and `test` (the design system's sample content and
 * test helpers), the same under `i18n` and `lib`, and the pages under a `dev` folder of the app, in a
 * route group or not (the showcase and the wallet check, in app/(app)/dev). A file of a package is
 * never one of ours, whatever its folders are called. components/ui/shipped.test.ts and
 * components/shell/product-routes.test.ts read the imports for the same.
 */
export const DEV_ONLY =
  /^(?!.*(^|\/)node_modules\/).*(^|\/)(features|components|i18n|lib|app)\/([^/]+\/)*(dev|test|fixtures)\//;
/** A file every route is built from: the proof that the source maps name our files. */
export const ALWAYS_BUILT = 'features/wallet/WalletProvider.tsx';

/**
 * The source files the server side of the build was made from, read from its source maps. A client
 * component is built for the server too, so a file any route imports is named here, with one
 * exception: what is loaded with `ssr: false`. For that, see features/wallet/imports.test.ts, which
 * reads the imports themselves.
 */
function sources(out) {
  const found = new Map();
  const dir = join(out, 'server');
  if (!existsSync(dir)) return found;
  for (const path of files(dir)) {
    if (!path.endsWith('.js.map')) continue;
    let map;
    try {
      map = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const names = [map.sources ?? [], ...(map.sections ?? []).map((s) => s.map?.sources ?? [])];
    for (const name of names.flat())
      if (typeof name === 'string') found.set(decodeURIComponent(name), relative(out, path));
  }
  return found;
}

/** @returns {string[]} what is wrong with the build in `out`; empty when it is clean. */
export function checkBuild(out) {
  if (!existsSync(out)) return [`no build output at ${out}`];
  const problems = [];
  let shipped = false;
  for (const path of files(out)) {
    const text = readFileSync(path, 'latin1');
    if (text.includes(REQUIRED)) shipped = true;
    for (const [marker, origin] of Object.entries(FORBIDDEN))
      if (text.includes(marker))
        problems.push(`${relative(out, path)} contains "${marker}", from ${origin}`);
  }
  for (const route of routes(out))
    if (/^\/dev(\/|$)/.test(address(route)))
      problems.push(`the build has a development route: ${route}`);
  let stage = 0;
  for (const path of files(out)) {
    if (!relative(out, path).startsWith('static/chunks/') || !path.endsWith('.js')) continue;
    const bytes = readFileSync(path);
    const text = bytes.toString('latin1');
    if (STAGE_MARKERS.some((marker) => text.includes(marker))) stage += gzipSync(bytes).length;
  }
  for (const path of files(out)) {
    if (!SENT_FILES.test(relative(out, path).split('\\').join('/'))) continue;
    const text = readFileSync(path, 'latin1');
    for (const [what, holds] of Object.entries(SECRET_SHAPES)) {
      const found = holds(text);
      if (found)
        problems.push(
          `${relative(out, path)} holds ${what}${typeof found === 'string' ? ` (${found})` : ''}: a browser is sent this file`,
        );
    }
  }
  if (stage > STAGE_BUDGET)
    problems.push(
      `the 3D joint's chunks are ${stage} bytes gzipped, over the ${STAGE_BUDGET} of joint-stage.md`,
    );
  if (!shipped)
    problems.push(
      `"${REQUIRED}" was not found: the check is not reading the build output, so it proves nothing`,
    );
  const built = sources(out);
  for (const [source, chunk] of built)
    if (DEV_ONLY.test(source)) problems.push(`${chunk} was built from ${source}`);
  if (![...built.keys()].some((source) => source.endsWith(ALWAYS_BUILT)))
    problems.push(
      `no source map names ${ALWAYS_BUILT}: the check cannot see which files the routes were built from`,
    );
  return problems;
}

/** The test file that reads the built stylesheet and fonts, as a path from the repository root. */
export const BUILT_CSS_TEST = 'apps/web/components/ui/forbidden.test.ts';

/**
 * Runs that test once more, now that there is a build to read. REQUIRE_WEB_BUILD makes its two build
 * checks fail on a missing or stale build instead of being skipped. Returns the exit code.
 */
function builtStylesheetCheck() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const require = createRequire(join(root, 'package.json'));
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const run = spawnSync(process.execPath, [vitest, 'run', '--root', root, BUILT_CSS_TEST], {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_WEB_BUILD: '1' },
  });
  return run.status ?? 1;
}

/** Starts the build and asks who may frame each address (check-frames.mjs). Returns the exit code. */
function framesCheck() {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-frames.mjs');
  return spawnSync(process.execPath, [script], { stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? '.next');
  const problems = checkBuild(out);
  if (problems.length) {
    console.error(`Build check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('Build check: no development-only code or route in the build.');
    // Only for the build in its usual place: the test reads apps/web/.next and nothing else.
    if (process.argv[2] === undefined) process.exitCode = builtStylesheetCheck() || framesCheck();
  }
}
