import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { keepRunning, type RoundFailure } from '../../apps/keeper/src/loop';

// The keeper's loop: a failed round (a node that did not answer) is said and followed by another round
// after a back-off, never the end of the keeper; with --once it is the end. What is wrong at start still
// stops the keeper before any round.

const run = promisify(execFile);
const STOP = new Error('the test has seen enough');

/** Rounds that fail or pass as `fates` says, and a sleep that ends the loop after `sleeps` waits. */
function harness(fates: ('fail' | 'pass')[], sleeps: number, loop = true) {
  const waited: number[] = [];
  const failed: RoundFailure[] = [];
  let rounds = 0;
  const done = keepRunning({
    loop,
    intervalMs: 60_000,
    round: async () => {
      const fate = fates[rounds++] ?? 'pass';
      if (fate === 'fail') throw new Error('the Solana RPC did not answer getProgramAccounts');
    },
    failed: (f) => {
      failed.push(f);
    },
    sleep: async (ms) => {
      waited.push(ms);
      if (waited.length >= sleeps) throw STOP;
    },
  });
  return { done, waited, failed, rounds: () => rounds };
}

describe("the keeper's loop", () => {
  it('follows a failed round with another, after a back-off, and goes back to the interval once one passes', async () => {
    const h = harness(['fail', 'fail', 'pass', 'fail', 'pass'], 5);
    await expect(h.done).rejects.toBe(STOP);
    expect(h.rounds()).toBe(5);
    expect(h.waited).toEqual([15_000, 30_000, 60_000, 15_000, 60_000]);
    expect(h.failed).toEqual([
      {
        outcome: 'round-failed',
        reason: 'the Solana RPC did not answer getProgramAccounts',
        alert: true,
        failures: 1,
        retryInS: 15,
      },
      expect.objectContaining({ failures: 2, retryInS: 30 }),
      expect.objectContaining({ failures: 1, retryInS: 15 }),
    ]);
  });

  it('doubles the back-off up to five minutes while rounds keep failing', async () => {
    const h = harness(Array(8).fill('fail'), 8);
    await expect(h.done).rejects.toBe(STOP);
    expect(h.waited).toEqual([15, 30, 60, 120, 240, 300, 300, 300].map((s) => s * 1_000));
    expect(h.failed.map((f) => f.failures)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('carries on when saying the failure fails too', async () => {
    let rounds = 0;
    const waited: number[] = [];
    const done = keepRunning({
      loop: true,
      intervalMs: 60_000,
      round: async () => {
        if (rounds++ === 0) throw new Error('fetch failed');
      },
      failed: () => {
        throw new Error('the webhook did not answer');
      },
      sleep: async (ms) => {
        waited.push(ms);
        if (waited.length >= 2) throw STOP;
      },
    });
    await expect(done).rejects.toBe(STOP);
    expect([rounds, waited]).toEqual([2, [15_000, 60_000]]);
  });

  it('with --once, says the failed round and ends with it', async () => {
    const h = harness(['fail'], 1, false);
    await expect(h.done).rejects.toThrow('the Solana RPC did not answer getProgramAccounts');
    expect(h.waited).toEqual([]);
    expect(h.failed).toEqual([
      {
        outcome: 'round-failed',
        reason: 'the Solana RPC did not answer getProgramAccounts',
        alert: true,
        failures: 1,
      },
    ]);
    const passed = harness(['pass'], 1, false);
    await expect(passed.done).resolves.toBeUndefined();
    expect(passed.waited).toEqual([]);
  });

  it('still stops at start on what is wrong with the set-up, in --loop', async () => {
    const start = (env: Record<string, string>) =>
      run('pnpm', ['--filter', '@colosseum/keeper', 'start', '--loop'], {
        env: { ...process.env, SOLANA_RPC_URL: '', ...env },
        timeout: 60_000,
      }).then(
        () => ({ code: 0, stderr: '' }),
        (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
      );
    const mainnet = await start({ CHAIN_NETWORK_SOLANA: 'mainnet' });
    expect(mainnet.code).not.toBe(0);
    expect(mainnet.stderr).toContain('the keeper does not run on mainnet in this slot');
    const noNode = await start({ CHAIN_NETWORK_SOLANA: 'testnet' });
    expect(noNode.code).not.toBe(0);
    expect(noNode.stderr).toContain('SOLANA_RPC_URL is not set');
  }, 120_000);
});
