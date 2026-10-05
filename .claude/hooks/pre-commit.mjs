#!/usr/bin/env node
// PreToolUse hook for `git commit`. A commit goes through only if lint and the typechecks pass.
// Exit code 2 blocks the commit; the tail of the failing output is shown to Claude.
// A commit that changes only documents and images skips the check: CI still runs everything.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { git, gitCall, simpleCommands } from './lib.mjs';

// The exit code is set, never forced with process.exit(): on some Node builds process.exit() can crash on the way
// out, and a crashed hook does not block.
function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  // The `if` filter in settings.json is best-effort and lets other commands through, so check here.
  const commit = simpleCommands(String(input.tool_input?.command ?? ''), input.cwd)
    .map(gitCall)
    .find((call) => call?.sub === 'commit');
  if (!commit) return 0;

  // The commit's own checkout: in a worktree CLAUDE_PROJECT_DIR still points at the main one.
  const root =
    git(['rev-parse', '--show-toplevel'], commit.cwd) ??
    process.env.CLAUDE_PROJECT_DIR ??
    input.cwd;
  const changed = (git(['status', '--porcelain'], root) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop());
  if (changed.every((f) => /\.(md|mdx|txt|csv|png|jpe?g|avif|webp|svg|pdf)$/i.test(f))) return 0;

  const r = spawnSync('pnpm', ['verify:quick'], { cwd: root, encoding: 'utf8', timeout: 280_000 });
  if (r.status === 0) return 0;
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
  console.error(
    `Commit blocked: \`pnpm verify:quick\` failed in ${root}. Fix it, then commit again.\n${r.error ? `${r.error.message}\n` : ''}${tail}`,
  );
  return 2;
}
process.exitCode = main();
