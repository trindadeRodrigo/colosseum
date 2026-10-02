import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = ['Cargo.toml', 'Cargo.lock'];
const PROGRAMS = [
  { binary: 'basket.so', source: 'programs/basket' },
  { binary: 'mock_router.so', source: 'programs/mock-router' },
];
// The flags are explained in programs/README.md.
const BUILD = ['build', '--no-idl', '--', '--tools-version', 'v1.54'];

function newest(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
}

/** Builds the programs when a binary is missing or older than its Rust sources. */
export default function setup(): void {
  const stale = PROGRAMS.some(({ binary, source }) => {
    const built = join(ROOT, 'target', 'deploy', binary);
    if (!existsSync(built)) return true;
    const changed = Math.max(...[...SHARED, source].map((p) => newest(join(ROOT, p))));
    return statSync(built).mtimeMs < changed;
  });
  if (!stale) return;
  console.log('programs changed since the last build: anchor', BUILD.join(' '));
  execFileSync('anchor', BUILD, { cwd: ROOT, stdio: 'inherit' });
}
