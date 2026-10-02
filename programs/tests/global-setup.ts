import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = ['basket.so', 'mock_router.so'].map((f) => join(ROOT, 'target', 'deploy', f));
// Flags recorded in programs/README.md: the default platform tools cannot build an
// edition-2024 dependency, and the IDL is built separately.
const BUILD = ['build', '--no-idl', '--', '--tools-version', 'v1.54'];

function newest(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
}

/** Builds the programs when a binary is missing or older than the Rust sources. */
export default function setup(): void {
  const sources = ['Cargo.toml', 'Cargo.lock', 'programs/basket', 'programs/mock-router'];
  const changed = Math.max(...sources.map((p) => newest(join(ROOT, p))));
  const stale = ARTIFACTS.some((so) => !existsSync(so) || statSync(so).mtimeMs < changed);
  if (!stale) return;
  console.log('programs changed since the last build: anchor', BUILD.join(' '));
  execFileSync('anchor', BUILD, { cwd: ROOT, stdio: 'inherit' });
}
