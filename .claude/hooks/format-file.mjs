#!/usr/bin/env node
// PostToolUse hook for Edit and Write. Runs the repo's formatter and safe lint fixes on the file just written,
// the same `biome check` that `pnpm lint` runs. It never blocks: what it cannot fix is left for `pnpm verify`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { git } from './lib.mjs';

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const file = input.tool_input?.file_path;
  if (!file) return;
  // The file's own checkout: in a worktree CLAUDE_PROJECT_DIR still points at the main one.
  const root =
    git(['rev-parse', '--show-toplevel'], dirname(file)) ??
    process.env.CLAUDE_PROJECT_DIR ??
    input.cwd;
  if (!root) return;

  const rel = relative(root, file);
  const skip = rel.startsWith('..') || /(^|\/)(\.design|node_modules|secrets)\//.test(rel);
  const biome = join(root, 'node_modules', '.bin', 'biome');
  if (skip || !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css)$/.test(rel) || !existsSync(biome))
    return;

  try {
    execFileSync(biome, ['check', '--write', file], {
      cwd: root,
      stdio: 'ignore',
      timeout: 20_000,
    });
  } catch {}
  return;
}
main();
