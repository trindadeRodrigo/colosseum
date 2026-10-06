#!/usr/bin/env node
// Runs from check-build.mjs on the production build: starts it and asks each address below who may
// frame it (lib/frame-policy.ts, proxy.ts). The partner embed's two pages answer the partners'
// policy and no X-Frame-Options; every other address answers `frame-ancestors 'none'` and DENY,
// the ones Next's header rules match without regard to case (`/Embed`) and the ones under /embed
// that are not the embed (`/embed/x`) above all, since they fall to a page with a wallet button.
// While the build is up it also asks for the icons (check-icons.mjs).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconProblems } from './check-icons.mjs';

/** [address, who may frame it] */
export const CASES = [
  ['/embed', 'partners'],
  ['/embed?scheme=dark', 'partners'],
  ['/embed/solana/abc', 'partners'],
  ['/embed/x', 'nobody'],
  ['/embed/a/b/c', 'nobody'],
  ['/Embed', 'nobody'],
  ['/EMBED/solana/abc', 'nobody'],
  ['/eMbEd/x', 'nobody'],
  ['/embedded', 'nobody'],
  ['/goal', 'nobody'],
  ['/', 'nobody'],
  ['/sign-in', 'nobody'],
  ['/api/nothing', 'nobody'],
];

const PORT = Number(process.env.FRAME_CHECK_PORT ?? 3290);

/** What the address answered, against what it should; empty when they agree. */
export function judge(path, want, headers) {
  const csp = headers.get('content-security-policy') ?? '(none)';
  const xfo = headers.get('x-frame-options');
  if (want === 'partners' && (!/^frame-ancestors 'self'( https:\/\/\S+)*$/.test(csp) || xfo))
    return [`${path}: ${csp}, X-Frame-Options ${xfo ?? '(none)'}; the embed should be framable`];
  if (want === 'nobody' && (csp !== "frame-ancestors 'none'" || xfo !== 'DENY'))
    return [`${path}: ${csp}, X-Frame-Options ${xfo ?? '(none)'}; nobody should frame it`];
  return [];
}

async function main() {
  const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const next = join(
    dirname(createRequire(join(web, 'package.json')).resolve('next/package.json')),
    'dist/bin/next',
  );
  const server = spawn(process.execPath, [next, 'start', '-p', String(PORT)], {
    cwd: web,
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  const problems = [];
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${base}/embed`, { redirect: 'manual' }).then(
        () => true,
        () => false,
      );
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) problems.push(`the build did not answer on ${base}`);
    else
      for (const [path, want] of CASES) {
        const answer = await fetch(base + path, { redirect: 'manual' });
        problems.push(...judge(path, want, answer.headers));
      }
    // the same build, while it is up: the icons (check-icons.mjs)
    if (up) problems.push(...(await iconProblems(base)));
  } finally {
    server.kill();
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await main();
  if (problems.length) {
    console.error(`Frame check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else
    console.log(
      `Frame check: ${CASES.length} addresses framed as they should be; the icons answer and the heads link them.`,
    );
}
