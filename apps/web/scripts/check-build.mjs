#!/usr/bin/env node
// Runs after `next build` (see "build" in package.json). The build fails if the output holds anything
// that exists for development only: the throwaway wallet, the dev page, or any route under /dev.
// It also looks for one string every build ships, so a change in where Next writes its output makes
// this check fail instead of pass on nothing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

/** Every route path the build knows, from its manifests and from the folders it wrote. */
function routes(out) {
  const found = new Set();
  for (const name of ['app-path-routes-manifest.json', 'server/app-paths-manifest.json']) {
    const path = join(out, name);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(manifest)) {
      found.add(key);
      if (typeof value === 'string' && value.startsWith('/')) found.add(value);
    }
  }
  const app = join(out, 'server', 'app');
  if (existsSync(app))
    for (const name of readdirSync(app)) found.add(`/${name.replace(/\.[a-z]+$/, '')}`);
  return [...found];
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
    if (/^\/dev(\/|$)/.test(route)) problems.push(`the build has a development route: ${route}`);
  if (!shipped)
    problems.push(
      `"${REQUIRED}" was not found: the check is not reading the build output, so it proves nothing`,
    );
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? '.next');
  const problems = checkBuild(out);
  if (problems.length) {
    console.error(`Build check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('Build check: no development-only code or route in the build.');
}
