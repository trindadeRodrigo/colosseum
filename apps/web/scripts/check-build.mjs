#!/usr/bin/env node
// Runs after `next build` (see "build" in package.json). The build fails if the output holds anything
// that exists for development only: the throwaway wallet, the dev page, any route under /dev, or any
// file of a development-only folder (DEV_ONLY below) in what a route was built from.
// It also looks for one string every build ships and one file every route is built from, so a change
// in where Next writes its output makes this check fail instead of pass on nothing.
// Last, it runs the design system's test of the built stylesheet and fonts, and the weight of the
// landing's 3D chunk, which a plain test run skips for want of a build
// (components/ui/forbidden.test.ts, features/landing/joint-budget.test.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strings that must not be in a production build. Each is a constant in the file named. */
export const FORBIDDEN = {
  'test-wallet:throwaway-keys': 'features/wallet/test/test-driver.ts (TEST_WALLET_MARKER)',
  'dev-page:wallet-check': 'features/wallet/dev/marker.ts (DEV_PAGE_MARKER)',
};
/** A string every build must contain: features/wallet/marker.ts (WALLET_MARKER). */
export const REQUIRED = 'wallet-port:shipped';

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
/** The test file that weighs the landing's 3D chunk (joint-stage.md: at most 180 KB gzipped). */
export const JOINT_BUDGET_TEST = 'apps/web/features/landing/joint-budget.test.ts';

/**
 * Runs those tests once more, now that there is a build to read. REQUIRE_WEB_BUILD makes their build
 * checks fail on a missing or stale build instead of being skipped. Returns the exit code.
 */
function builtStylesheetCheck() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const require = createRequire(join(root, 'package.json'));
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const tests = [BUILT_CSS_TEST, JOINT_BUDGET_TEST];
  const run = spawnSync(process.execPath, [vitest, 'run', '--root', root, ...tests], {
    stdio: 'inherit',
    env: { ...process.env, REQUIRE_WEB_BUILD: '1' },
  });
  return run.status ?? 1;
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
    if (process.argv[2] === undefined) process.exitCode = builtStylesheetCheck();
  }
}
