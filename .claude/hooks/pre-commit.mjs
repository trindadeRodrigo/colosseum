#!/usr/bin/env node
// PreToolUse hook that runs before `git commit`. A commit goes through only if lint and the typechecks pass.
// Exit code 2 blocks the commit; the tail of the failing output is shown to Claude.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const r = spawnSync('pnpm', ['verify:quick'], { cwd: root, encoding: 'utf8', timeout: 280_000 });
if (r.status === 0) process.exit(0);
const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
console.error(`Commit blocked: \`pnpm verify:quick\` failed. Fix it, then commit again.\n${tail}`);
process.exit(2);
