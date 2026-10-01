// Shared by the Bash hooks: reads a shell command well enough to tell what it would run.
// These hooks stop mistakes. They are not a sandbox: a command written to get around them will.
// Branch protection on GitHub and the rules in CLAUDE.md are the real barriers.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'env']);

/** Drops heredoc bodies and quoted text, so a commit message or a pull-request body is never read as a command.
 * A quoted single word keeps its content (`"main"` is still `main`); longer strings are returned in `quoted`. */
export function stripQuotes(command) {
  const quoted = [];
  const text = String(command)
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\s|$|\))/g, ' Q ')
    .replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_, d, s) => {
      const inner = d ?? s ?? '';
      if (/^[^\s;|&()]*$/.test(inner)) return inner;
      quoted.push(inner);
      return ' Q ';
    });
  return { text, quoted };
}

/** Splits a command into simple commands, following `cd` so each one knows its directory.
 * Text handed to `bash -c` or `eval` is read as commands too. */
export function simpleCommands(command, cwd, depth = 0) {
  const { text, quoted } = stripQuotes(command);
  const out = [];
  let dir = cwd;
  for (const raw of text.replace(/#[^\n]*/g, '').split(/&&|\|\||[;|&\n]/)) {
    const tokens = raw
      .replace(/^[\s({]+|[\s)}]+$/g, '')
      .split(/\s+/)
      .filter(Boolean);
    const env = [];
    while (tokens.length && (/^\w+=/.test(tokens[0]) || WRAPPERS.has(tokens[0]))) {
      const first = tokens.shift();
      if (first.includes('=')) env.push(first);
    }
    if (!tokens.length) {
      if (env.length) out.push({ tokens: [], env, cwd: dir });
      continue;
    }
    if (tokens[0] === 'cd' && tokens[1] && !/[$`]/.test(tokens[1]))
      dir = resolve(dir ?? '.', tokens[1]);
    out.push({ tokens, env, cwd: dir });
  }
  if (depth < 2 && /(^|[\s;|&(])((ba|z)?sh\s+-\w*c|eval)\b/.test(text))
    for (const inner of quoted) out.push(...simpleCommands(inner, dir, depth + 1));
  return out;
}

/** For `git [options] <subcommand> ...`: the subcommand, its arguments, the directory and any `-c` settings. */
export function gitCall({ tokens, cwd }) {
  if (tokens[0] !== 'git') return null;
  let i = 1;
  let dir = cwd;
  const config = [];
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C') dir = resolve(dir ?? '.', tokens[i + 1] ?? '.');
    if (tokens[i] === '-c') config.push(tokens[i + 1] ?? '');
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(tokens[i]) ? 2 : 1;
  }
  return { sub: tokens[i], args: tokens.slice(i + 1), cwd: dir, config };
}

export function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

class Blocked extends Error {}
const block = (why) => {
  throw new Blocked(why);
};

const PROTECTED = new Set(['main', 'staging']);
const PACKAGE_MANAGERS = new Set('pnpm npm yarn npx bunx'.split(' '));
const INTERPRETERS = new Set('tsx node bun deno ts-node sh bash zsh source .'.split(' '));
const PUSH_OPTIONS_WITH_VALUE = new Set([
  '-o',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--exec',
]);
const SPEND =
  'it can spend real money or print a private key. A person runs it, never an agent; /mainnet prepares it.';

/** Why a Bash command must not run, or null when it may. `cwd` is the directory the command starts in. */
export function guardVerdict(command, cwd) {
  // A checkout or switch earlier in the same command changes the branch a later push would send.
  let switchedTo = null;
  const mainnetEnv = /\bCLUSTER=mainnet\b/.test(command);
  try {
    for (const cmd of simpleCommands(command, cwd)) {
      const call = gitCall(cmd);

      if (call?.sub === 'checkout' || call?.sub === 'switch') {
        if (!call.args.includes('--')) {
          const flag = call.args.findIndex((a) => /^-[cCbB]$/.test(a));
          switchedTo =
            flag >= 0
              ? call.args[flag + 1]
              : (call.args.find((a) => !a.startsWith('-')) ?? switchedTo);
        }
      }

      if (call?.sub === 'push') {
        const refs = [];
        for (let i = 0; i < call.args.length; i++) {
          const a = call.args[i];
          if (a.startsWith('--force') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith('+'))
            block('force pushes are not allowed.');
          if (a === '--mirror' || a === '--all' || a === '--branches')
            block('push one branch by name, not all of them.');
          if (PUSH_OPTIONS_WITH_VALUE.has(a)) i++;
          else if (!a.startsWith('-')) refs.push(a);
        }
        const current = () =>
          switchedTo ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], call.cwd) ?? '';
        const targets = refs.slice(1).map((ref) => {
          if (/[$`*]/.test(ref))
            block('write the branch name out in a push; no variables or patterns.');
          const dst = (ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref).replace(
            /^refs\/heads\//,
            '',
          );
          return dst === 'HEAD' || dst === '@' ? current() : dst;
        });
        if (!targets.length) {
          // No branch named: git sends the current branch, or the branch it tracks.
          targets.push(current());
          const tracked = switchedTo
            ? null
            : git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], call.cwd);
          if (tracked) targets.push(tracked.slice(tracked.indexOf('/') + 1));
        }
        const hit = targets.find((t) => PROTECTED.has(t));
        if (hit)
          block(
            `this push would land on ${hit}. Push your own branch (git push -u origin HEAD) and open a pull request into staging.`,
          );
      }

      if (call && ['commit', 'push', 'merge'].includes(call.sub)) {
        if (
          call.args.includes('--no-verify') ||
          (call.sub === 'commit' && call.args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) ||
          call.config.some((c) => /^core\.hooksPath=/i.test(c))
        )
          block('do not skip the checks.');
      }

      if (cmd.tokens[0] === 'gh' && cmd.tokens[1] === 'api') {
        const writes = cmd.tokens.some(
          (t, i) =>
            /^(PATCH|POST|PUT|DELETE)$/i.test(t) && /^(-X|--method)$/.test(cmd.tokens[i - 1]),
        );
        if (writes && cmd.tokens.some((t) => /refs\/heads\/(main|staging)$/.test(t)))
          block('do not move main or staging through the API. Open a pull request.');
      }

      // What a package manager ends up running: `pnpm -s exec tsx x.ts` runs `tsx x.ts`.
      const run = [...cmd.tokens];
      const viaPackageManager = PACKAGE_MANAGERS.has(run[0]);
      while (
        run.length &&
        (PACKAGE_MANAGERS.has(run[0]) ||
          /^(exec|run|dlx|x)$/.test(run[0]) ||
          run[0].startsWith('-'))
      )
        run.shift();
      if (viaPackageManager && /^(sign-and-send|wallet:export)$/.test(run[0] ?? '')) block(SPEND);
      if (INTERPRETERS.has(run[0])) {
        for (const t of run.slice(1)) {
          if (!/\.(ts|mts|cts|js|mjs|cjs|sh)$/.test(t) || /[$`]/.test(t)) continue;
          const path = resolve(cmd.cwd ?? '.', t);
          if (/\/scripts\/(mainnet|archive)\//.test(path) || /\/wallet-export\.ts$/.test(path))
            block(SPEND);
        }
        if (mainnetEnv) block(`CLUSTER=mainnet: ${SPEND}`);
      }
    }
  } catch (e) {
    if (e instanceof Blocked) return e.message;
    throw e;
  }
  return null;
}
