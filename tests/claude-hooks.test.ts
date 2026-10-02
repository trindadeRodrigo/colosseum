import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The Bash guard that every Claude session in this repo runs (.claude/hooks/guard-bash.mjs, rules in lib.mjs).
const hooks = join(import.meta.dirname, '..', '.claude', 'hooks');
let repo: string;
let guardVerdict: (command: string, cwd: string) => string | null;

const git = (args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: repo,
    stdio: 'ignore',
  });
const blocked = (command: string) => guardVerdict(command, repo) !== null;

beforeAll(async () => {
  ({ guardVerdict } = await import(pathToFileURL(join(hooks, 'lib.mjs')).href));
  repo = mkdtempSync(join(tmpdir(), 'guard-'));
  git(['init', '-q', '-b', 'main']);
  git(['commit', '-q', '--allow-empty', '-m', 'init']);
  git(['branch', 'staging']);
  git(['switch', '-q', '-c', 'chore/x']);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const BLOCKED = [
  'git push -f',
  'git push --force',
  'git push --force-with-lease',
  'git push --force-with-lease=chore/x origin chore/x',
  'git push origin HEAD:main',
  'git push upstream chore/x:staging',
  'git push origin +main',
  'git push origin +chore/x',
  'git -C . push origin main',
  'git push origin main',
  'git push origin staging',
  'git push origin refs/heads/main',
  'git push origin HEAD:refs/heads/main',
  'git push origin HEAD:refs/heads/staging',
  'git push origin main:main',
  'git push origin "main"',
  "git push origin 'HEAD:main'",
  'git push -fu origin chore/x',
  'git push -uf origin chore/x',
  'git push --force-if-includes --force-with-lease origin x',
  'git push --mirror origin',
  'git push --all origin',
  'git push origin --delete staging',
  'git push origin :staging',
  'git push origin main~1:main',
  'git push origin HEAD:main --no-verify',
  'cd apps && git push origin main',
  'echo hi; git push origin main',
  'true || git push origin main',
  'git fetch & git push origin main',
  '(git push origin main)',
  'bash -c "git push origin main"',
  'git push origin $(echo main)',
  'B=main; git push origin $B',
  'git push origin HEAD:ma""in',
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true',
  'tsx scripts/mainnet/sign-and-send.ts',
  'node ./scripts/archive/x.ts',
  'pnpm run sign-and-send',
  'pnpm sign-and-send',
  'pnpm -s sign-and-send -- --foo',
  'npm run sign-and-send',
  'yarn sign-and-send',
  'npx pnpm sign-and-send',
  'cd scripts/mainnet && tsx sign-and-send.ts',
  'cd scripts && tsx mainnet/sign-and-send.ts',
  'tsx scripts/mainnet/../mainnet/sign-and-send.ts',
  'tsx scripts//mainnet/sign-and-send.ts',
  'tsx ./scripts/./mainnet/sign-and-send.ts',
  'pnpm exec tsx scripts/mainnet/sign-and-send.ts',
  'git commit -n -m x',
  'git commit --no-verify -m x',
  'git commit -nm x',
  'git commit -anm x',
  'git push --no-verify origin chore/x',
  'git add . && git commit --no-verify -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'pnpm wallet:export',
  'tsx scripts/wallet-export.ts',
  'CLUSTER=mainnet RPC_URL=x OWNER_KEYPAIR=y tsx spikes/solana-vault-swap/scripts/run-swap.ts --send',
  'export CLUSTER=mainnet; tsx spikes/solana-vault-swap/scripts/run-swap.ts --send',
  'gh api -X PATCH repos/o/r/git/refs/heads/staging -f sha=abc',
  'git push origin chore/*',
];

const ALLOWED = [
  'gh pr merge 12 --merge',
  'cat scripts/mainnet/sign-and-send.ts | tsx -',
  'cat scripts/mainnet/sign-and-send.ts > /tmp/x.ts && tsx /tmp/x.ts',
  'cp scripts/mainnet/sign-and-send.ts /tmp/x.ts',
  'head -c 100000 scripts/mainnet/sign-and-send.ts > x.ts',
  'pnpm execute:demo',
  'tsx scripts/execute-demo.ts',
  'git push origin feature/main-menu',
  'git push origin chore/organize',
  'git push -u origin chore/organize',
  'git push origin fix/staging-banner',
  'git push origin docs/main',
  'git push origin web/main',
  'git push origin chore/x # not main',
  'grep -r "scripts/mainnet" docs',
  'rg "scripts/mainnet/" docs CLAUDE.md',
  'git log main..HEAD',
  'git log --oneline staging..HEAD',
  'cat scripts/mainnet/README.md',
  'ls scripts/mainnet/',
  'ls -la scripts/archive/',
  'git diff upstream/staging...HEAD -- scripts/mainnet/',
  'git log --oneline -- scripts/archive/',
  'git grep -n "push" -- docs',
  'git log --grep="push to main"',
  'git commit -m "docs: explain why we do not push to main"',
  'git commit -m "chore: move sign-and-send under scripts/mainnet/"',
  'git commit -m "docs: never use --no-verify"',
  'git commit -m "fix: x" -m "second; line"',
  'git stash push -m wip',
  'git stash push -u -m "wip main"',
  'git push',
  'git push -u origin HEAD',
  'git push origin HEAD',
  'git fetch origin main',
  'git switch -c chore/x origin/staging',
  'git merge origin/staging',
  'git pull --ff-only',
  'gh pr create --base staging --title "push fix" --body "x"',
  'gh pr create --base staging --title "git: block push to main" --body x',
  'echo "git push origin main"',
  'pnpm verify',
  'pnpm test tests/risk-layer/pools.test.ts',
  'biome check scripts/mainnet/sign-and-send.ts',
  'pnpm exec biome format scripts/archive/d2pm-spike.ts',
  'pnpm exec tsc -p tsconfig.json',
  'git blame scripts/mainnet/sign-and-send.ts',
  'git ls-files scripts/archive/',
  'git rm --cached scripts/archive/x.ts',
  'git restore scripts/mainnet/sign-and-send.ts',
  'git checkout upstream/staging -- scripts/mainnet/README.md',
  'sed -n 1,20p scripts/mainnet/sign-and-send.ts',
  'wc -l scripts/archive/*.ts',
  'find . -path "./scripts/archive/*" -name "*.ts"',
  'grep -n "sign-and-send" package.json | head',
  'grep -rn "pnpm sign-and-send" docs',
  'cat package.json | grep sign-and-send',
  'git diff --stat | tail -5',
  'git push origin chore/x 2>&1 | tail -5',
  'git log --oneline -5 | cat; git push origin chore/x',
  'CLUSTER=devnet tsx spikes/solana-vault-swap/scripts/run-swap.ts',
  'gh api repos/o/r/git/refs/heads/main',
  'gh pr create --base staging --title x --body "$(cat <<EOF\nline about push to main\ngit push origin main\nEOF\n)"',
  'git commit -m "$(cat <<EOF\nvault: x\n\ntsx scripts/mainnet/sign-and-send.ts was moved\nEOF\n)"',
  'git commit --amend -m x',
  'pnpm exec vitest run tests/risk-layer/pools.test.ts',
  'node .claude/hooks/session-start.mjs',
  // Reading or copying a mainnet script is not running it. The guard stops mistakes; it is not a sandbox.
];

const ON_A_SHARED_BRANCH = [
  'git push',
  'git push origin',
  'git push origin HEAD',
  'git push -u origin HEAD',
  'git push --set-upstream origin HEAD',
  'git push origin @',
  'git push -q',
];

describe('the Bash guard', () => {
  it('blocks pushes to shared branches, force pushes, skipped checks and the money scripts', () => {
    expect(BLOCKED.filter((c) => !blocked(c))).toEqual([]);
  });
  it('allows ordinary work, including text that only mentions those commands', () => {
    expect(ALLOWED.filter(blocked)).toEqual([]);
  });
  it('blocks every bare push while on main', () => {
    git(['switch', '-q', 'main']);
    try {
      expect(ON_A_SHARED_BRANCH.filter((c) => !blocked(c))).toEqual([]);
    } finally {
      git(['switch', '-q', 'chore/x']);
    }
  });
  it('blocks a push after switching to a shared branch in the same command', () => {
    expect(blocked('git checkout main && git merge staging && git push')).toBe(true);
    expect(blocked('git switch staging; git push origin HEAD')).toBe(true);
  });
  it('allows pushing a new branch made in the same command', () => {
    expect(blocked('git switch -c chore/y && git push -u origin HEAD')).toBe(false);
  });
  it('exits with 2 as a hook when it blocks, and 0 when it does not', { timeout: 30_000 }, () => {
    const run = (command: string) =>
      spawnSync('node', [join(hooks, 'guard-bash.mjs')], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
        encoding: 'utf8',
      });
    expect(run('git push origin main').status).toBe(2);
    expect(run('git push origin main').stderr).toContain('would land on main');
    expect(run('git status').status).toBe(0);
  });
});
