#!/usr/bin/env node
// SessionStart hook. Fetches from the remotes and prints where this checkout stands, so the session knows
// whether to pull before working. What it prints is added to the session's context.
import { execFileSync } from 'node:child_process';

const git = (args, timeout = 10_000) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    }).trim();
  } catch {
    return null;
  }
};

if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') process.exit(0);

const fetched = git(['fetch', '--all', '--quiet', '--prune'], 20_000) !== null;
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
const counts = (ref) => {
  const out = git(['rev-list', '--left-right', '--count', `HEAD...${ref}`]);
  if (!out) return null;
  const [ahead, behind] = out.split(/\s+/).map(Number);
  return { ahead, behind };
};
const staging = ['upstream/staging', 'origin/staging'].find((r) =>
  git(['rev-parse', '--verify', '--quiet', r]),
);
const dirty = (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length;

const lines = [
  `Git status at session start (${fetched ? 'fetched just now' : 'FETCH FAILED, may be stale'}):`,
];
lines.push(`- branch: ${branch}${upstream ? ` (tracks ${upstream})` : ' (no upstream set)'}`);
if (upstream) {
  const c = counts(upstream);
  if (c?.behind)
    lines.push(
      `- BEHIND ${upstream} by ${c.behind} commit(s): pull before working (git pull --ff-only).`,
    );
  if (c?.ahead) lines.push(`- ahead of ${upstream} by ${c.ahead} commit(s), not pushed yet.`);
  if (c && !c.behind && !c.ahead) lines.push(`- up to date with ${upstream}.`);
}
if (staging && branch !== 'staging') {
  const c = counts(staging);
  if (c?.behind)
    lines.push(
      `- ${staging} has ${c.behind} commit(s) this branch does not have: merge or rebase before opening a pull request.`,
    );
}
if (dirty) lines.push(`- ${dirty} uncommitted file(s) in the working tree.`);
if (branch === 'main' || branch === 'staging')
  lines.push(`- You are on ${branch}. Work happens on a branch: run /start-work.`);
console.log(lines.join('\n'));
