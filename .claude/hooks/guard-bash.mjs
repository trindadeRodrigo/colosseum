#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks the few commands no session should run, whatever the permission mode.
// Exit code 2 blocks the call; the message on stderr is shown to Claude.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = String(input.tool_input?.command ?? '');
const block = (why) => {
  console.error(`Blocked by .claude/hooks/guard-bash.mjs: ${why}`);
  process.exit(2);
};

// Look at each simple command on its own, so `cd x && git push origin main` is still caught.
for (const part of command.split(/&&|\|\||[;|\n]/)) {
  const text = part.trim();
  if (/\bgit\b.*\bpush\b/.test(text)) {
    if (/(^|\s)(--force|--force-with-lease|-f)(\s|=|$)|\s\+\S/.test(text))
      block('force pushes are not allowed.');
    if (/(^|[\s:])(main|staging)(\s|$)/.test(text))
      block('do not push to main or staging. Open a pull request into staging.');
    if (!/\bpush\b\s+\S*\s*\S+/.test(text)) {
      let branch = '';
      try {
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: input.cwd,
          encoding: 'utf8',
        }).trim();
      } catch {}
      if (branch === 'main' || branch === 'staging')
        block(`you are on ${branch}. Work on a branch and open a pull request into staging.`);
    }
  }
  if (/scripts\/(mainnet|archive)\//.test(text) || /\bpnpm\b.*\bsign-and-send\b/.test(text)) {
    if (!/^\s*(ls|cat|head|tail|wc|git\s+(log|diff|show|mv|add|status))\b/.test(text))
      block(
        'scripts under scripts/mainnet and scripts/archive can spend real money. A person runs them, never an agent.',
      );
  }
  if (/\bgit\b.*--no-verify\b/.test(text)) block('do not skip the checks.');
}
process.exit(0);
