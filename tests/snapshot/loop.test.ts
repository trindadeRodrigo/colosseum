import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keepRunning, type RoundFailure } from '../../apps/snapshot/src/loop';

// The snapshot worker's loop is a copy of the keeper's, since no app imports another. The copy is held
// to the original here: the two files are the same from their first `export` on, and the keeper's
// back-off cases (tests/keeper/loop.test.ts) pass on the copy, with the same harness.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** A loop file from its first `export` line to its end: everything but the header comment. */
function body(text: string): string {
  const at = text.search(/^export /m);
  if (at < 0) throw new Error('the file exports nothing');
  return text.slice(at);
}

const STOP = new Error('the test has seen enough');

/** Passes that fail or go through as `fates` says, and a sleep that ends the loop after `sleeps` waits. */
function harness(fates: ('fail' | 'pass')[], sleeps: number, loop = true) {
  const waited: number[] = [];
  const failed: RoundFailure[] = [];
  let rounds = 0;
  const done = keepRunning({
    loop,
    intervalMs: 600_000,
    round: async () => {
      const fate = fates[rounds++] ?? 'pass';
      if (fate === 'fail') throw new Error('Unavailable: the node did not answer getSlot');
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

describe("the snapshot worker's loop", () => {
  it("is the keeper's, byte for byte, from the first export on", () => {
    const keeper = body(read('../../apps/keeper/src/loop.ts'));
    const copy = body(read('../../apps/snapshot/src/loop.ts'));
    expect(copy).toBe(keeper);
    // And the comparison is of the whole loop, not of a tail of it.
    expect(keeper).toContain('export async function keepRunning');
    expect(keeper.startsWith('export const BACKOFF_FIRST_MS')).toBe(true);
  });

  it('says in its header that it is a copy, and what holds it to the original', () => {
    const header = read('../../apps/snapshot/src/loop.ts').split(/^export /m)[0] ?? '';
    expect(header).toContain('apps/keeper/src/loop.ts');
    expect(header).toContain('tests/snapshot/loop.test.ts');
  });

  it('follows a failed pass with another, after a back-off, and goes back to the interval once one passes', async () => {
    const h = harness(['fail', 'fail', 'pass', 'fail', 'pass'], 5);
    await expect(h.done).rejects.toBe(STOP);
    expect(h.rounds()).toBe(5);
    expect(h.waited).toEqual([15_000, 30_000, 600_000, 15_000, 600_000]);
    expect(h.failed).toEqual([
      {
        outcome: 'round-failed',
        reason: 'Unavailable: the node did not answer getSlot',
        alert: true,
        failures: 1,
        retryInS: 15,
      },
      expect.objectContaining({ failures: 2, retryInS: 30 }),
      expect.objectContaining({ failures: 1, retryInS: 15 }),
    ]);
  });

  it('doubles the back-off up to five minutes while passes keep failing', async () => {
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
      intervalMs: 600_000,
      round: async () => {
        if (rounds++ === 0) throw new Error('fetch failed');
      },
      failed: () => {
        throw new Error('the ping did not answer');
      },
      sleep: async (ms) => {
        waited.push(ms);
        if (waited.length >= 2) throw STOP;
      },
    });
    await expect(done).rejects.toBe(STOP);
    expect([rounds, waited]).toEqual([2, [15_000, 600_000]]);
  });

  it('with the loop off, says the failed pass and ends with it', async () => {
    const h = harness(['fail'], 1, false);
    await expect(h.done).rejects.toThrow('Unavailable: the node did not answer getSlot');
    expect(h.waited).toEqual([]);
    expect(h.failed).toEqual([
      {
        outcome: 'round-failed',
        reason: 'Unavailable: the node did not answer getSlot',
        alert: true,
        failures: 1,
      },
    ]);
    const passed = harness(['pass'], 1, false);
    await expect(passed.done).resolves.toBeUndefined();
    expect(passed.waited).toEqual([]);
  });
});
