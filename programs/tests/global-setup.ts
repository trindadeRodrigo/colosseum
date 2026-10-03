import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = ['Cargo.toml', 'Cargo.lock'];
const PROGRAMS = [
  { binary: 'basket.so', source: 'programs/basket' },
  { binary: 'mock_router.so', source: 'programs/mock-router' },
  { binary: 'puppet_router.so', source: 'programs/puppet-router' },
  { binary: 'test_hook.so', source: 'programs/test-hook' },
];
/** Written after a build of the whole workspace made here: its date is when that build ran. */
const STAMP = join(ROOT, 'target', 'deploy', '.built-from-workspace');
// The flags are explained in programs/README.md.
const BUILD = ['build', '--no-idl', '--', '--tools-version', 'v1.54'];

function newest(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
}

/**
 * Builds the programs when one has to be: a binary is missing, or a file changed after both its
 * binary was written and the last build made here. The workspace's manifest and lockfile count for
 * every program.
 *
 * A date on a binary alone does not say enough. Cargo leaves a binary alone when a change does not
 * touch it (another program's dependency in the lockfile, a comment, a checkout that only renews the
 * dates of the sources), so its date stays behind for good and every run would start a build that
 * does nothing. The stamp records that a build of the whole workspace ran and found it up to date.
 */
export default function setup(): void {
  const builtAt = existsSync(STAMP) ? statSync(STAMP).mtimeMs : 0;
  const workspaceChanged = SHARED.some((file) => newest(join(ROOT, file)) > builtAt);
  const stale = PROGRAMS.filter(({ binary, source }) => {
    const built = join(ROOT, 'target', 'deploy', binary);
    if (!existsSync(built)) return true;
    return newest(join(ROOT, source)) > Math.max(statSync(built).mtimeMs, builtAt);
  });
  if (!workspaceChanged && stale.length === 0) return;
  const why = workspaceChanged
    ? 'Cargo.toml or Cargo.lock changed since the last build here'
    : `changed since they were built: ${stale.map((p) => p.source).join(', ')}`;
  console.log(`${why}: anchor`, BUILD.join(' '));
  execFileSync('anchor', BUILD, { cwd: ROOT, stdio: 'inherit' });
  writeFileSync(STAMP, `${new Date().toISOString()}\n`);
}
