#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks the few commands no session should run, whatever the permission mode.
// Exit code 2 blocks the call; the message on stderr is shown to Claude. The rules are in lib.mjs.
import { readFileSync } from 'node:fs';
import { guardVerdict } from './lib.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const why = guardVerdict(String(input.tool_input?.command ?? ''), input.cwd);
if (why) {
  console.error(`Blocked by .claude/hooks/guard-bash.mjs: ${why}`);
  // The exit code is set, never forced with process.exit(): on some Node builds process.exit() can crash on the
  // way out, and a crashed hook does not block.
  process.exitCode = 2;
}
