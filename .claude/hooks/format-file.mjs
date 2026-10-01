#!/usr/bin/env node
// PostToolUse hook for Edit and Write. Formats the file that was just written with the repo's formatter.
// It never blocks: a formatting failure is left for `pnpm verify` to report.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const file = input.tool_input?.file_path;
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
if (!file || !root) process.exit(0);

const rel = relative(root, file);
const skip =
  rel.startsWith('..') ||
  /^(\.design|node_modules|docs|spikes)\//.test(rel) ||
  rel.includes('/node_modules/');
const biome = join(root, 'node_modules', '.bin', 'biome');
if (skip || !/\.(ts|tsx|js|mjs|json|css)$/.test(rel) || !existsSync(biome)) process.exit(0);

try {
  execFileSync(biome, ['format', '--write', file], { cwd: root, stdio: 'ignore', timeout: 20_000 });
} catch {}
process.exit(0);
