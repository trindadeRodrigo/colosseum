import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// The snapshot worker as a person starts it: what is wrong with the set-up stops it before any pass, on
// stderr, with a code that is not 0. Mainnet above all: CHAIN_NETWORK_<CHAIN>=mainnet ends the worker
// before a node or the database is asked anything (as tests/keeper/loop.test.ts holds the keeper).

const run = promisify(execFile);

/**
 * The developer's own settings do not reach the worker under test. The database address is one nothing
 * listens on: a worker that reached for the database before it refused would fail on that instead.
 */
const QUIET = {
  SNAPSHOT_CHAINS: '',
  SNAPSHOT_PING_URL: '',
  CHAIN_MODE_SOLANA: '',
  CHAIN_MODE_ROBINHOOD: '',
  CHAIN_MODE_BASE: '',
  CHAIN_NETWORK_SOLANA: '',
  CHAIN_NETWORK_ROBINHOOD: '',
  CHAIN_NETWORK_BASE: '',
  SOLANA_RPC_URL: '',
  ROBINHOOD_RPC_URL: '',
  DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:9/nowhere',
};

type Ended = { code: number; stdout: string; stderr: string };

const start = (args: string[], env: Record<string, string>): Promise<Ended> =>
  run('pnpm', ['--filter', '@colosseum/snapshot', 'start', ...args], {
    env: { ...process.env, ...QUIET, ...env },
    timeout: 60_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (e: Ended) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

/** The worker's own lines on stdout: each is one JSON object. pnpm's header lines are not. */
const lines = (stdout: string) => stdout.split('\n').filter((line) => line.trim().startsWith('{'));

describe('the snapshot worker at start, as a process', () => {
  it('stops on mainnet before any pass, whatever the chain and its mode', async () => {
    // One start after another, as tests/keeper/loop.test.ts makes its own: several processes at
    // once slow the test files that run beside this one.
    const read = await start(['--once'], {
      CHAIN_NETWORK_SOLANA: 'mainnet',
      CHAIN_MODE_SOLANA: 'readonly',
    });
    // A chain the worker was not asked to read, beside one on the mock that it was.
    const unread = await start(['--once'], {
      CHAIN_NETWORK_BASE: 'mainnet',
      SNAPSHOT_CHAINS: 'solana',
    });
    const looped = await start(['--loop'], {
      CHAIN_NETWORK_ROBINHOOD: 'mainnet',
      CHAIN_MODE_ROBINHOOD: 'mock',
    });
    for (const [ended, key] of [
      [read, 'CHAIN_NETWORK_SOLANA'],
      [unread, 'CHAIN_NETWORK_BASE'],
      [looped, 'CHAIN_NETWORK_ROBINHOOD'],
    ] as const) {
      expect(ended.code, key).not.toBe(0);
      expect(ended.stderr, key).toContain(
        `${key} is mainnet, and the snapshot worker reads the test networks only until a person says otherwise`,
      );
      // No line of a pass, a vault or a run: nothing was read.
      expect(lines(ended.stdout), key).toEqual([]);
      // And it never reached for the database.
      expect(ended.stderr, key).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|nowhere/);
    }
  }, 120_000);

  it('stops with no chain to read, and on a command line it cannot read', async () => {
    const none = await start(['--once'], {});
    // A chain on the mock is not read unless SNAPSHOT_CHAINS names it.
    const mockOnly = await start(['--once'], {
      CHAIN_MODE_SOLANA: 'mock',
      CHAIN_MODE_ROBINHOOD: 'mock',
    });
    const noMode = await start([], { SNAPSHOT_CHAINS: 'solana' });
    const typo = await start(['--once', '--dryrun'], { SNAPSHOT_CHAINS: 'solana' });
    for (const ended of [none, mockOnly]) {
      expect(ended.code).not.toBe(0);
      expect(ended.stderr).toContain('no chain to read: set CHAIN_MODE_<CHAIN> to readonly');
      expect(ended.stderr).toContain('SNAPSHOT_CHAINS');
      expect(lines(ended.stdout)).toEqual([]);
    }
    expect(noMode.code).not.toBe(0);
    expect(noMode.stderr).toContain('say --once or --loop');
    expect(typo.code).not.toBe(0);
    expect(typo.stderr).toContain('--dryrun is not a flag of the snapshot worker');
    expect(lines(typo.stdout)).toEqual([]);
  }, 120_000);
});
