import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Notifier } from '../../apps/keeper/src/alerts';
import { type KeeperRun, runKeeper, type Wired } from '../../apps/keeper/src/keeper';
import { newMemory } from '../../apps/keeper/src/memory';

// The keeper once set up, as main.ts runs it on either chain: a round whose node does not answer is
// said as `round-failed`, alerted, pinged as a failure, and followed by another round after the
// back-off; a round that goes through is pinged as one and carries the low-gas alert.

const NODE = 'https://node.example/key-in-the-path';
const STOP = new Error('the test has seen enough');

function keeper(failures: number) {
  let asked = 0;
  const wired = {
    network: 'solana-devnet',
    stateName: 'solana-devnet-test',
    adapter: {
      listAssets: async () => {
        if (asked++ < failures) throw new Error(`the Solana RPC at ${NODE} did not answer`);
        return [{ id: 'solana:usdc', cls: 'cash', priceKind: 'scope', decimals: 6 }];
      },
      listAutoFollowVaults: async () => [],
    },
    sign: async () => ({ wire: '', txId: '' }),
    gas: async () => ({ have: 1n, low: 5n, unit: 'lamports' }),
  } as unknown as Wired;
  const lines: Record<string, unknown>[] = [];
  const pings: boolean[] = [];
  const alerts: string[][] = [];
  const waited: number[] = [];
  const notify: Notifier = {
    alert: async (l) => {
      alerts.push(l);
    },
    ping: async (ok) => {
      pings.push(ok);
    },
  };
  const run = (o: Partial<KeeperRun>) =>
    runKeeper({
      wired,
      loop: true,
      dryRun: true,
      intervalMs: 60_000,
      memory: newMemory(),
      save: () => {},
      notify,
      hide: (t) => t.split(NODE).join('<SOLANA_RPC_URL>'),
      out: (l) => lines.push(JSON.parse(l)),
      sleep: async (ms) => {
        waited.push(ms);
        if (waited.length >= failures + 1) throw STOP;
      },
      ...o,
    });
  return { run, lines, pings, alerts, waited };
}

describe('the keeper, set up', () => {
  it('says a failed round, alerts and pings it, and runs the next one after the back-off', async () => {
    const k = keeper(2);
    await expect(k.run({})).rejects.toBe(STOP);
    expect(k.waited).toEqual([15_000, 30_000, 60_000]);
    expect(k.lines.map((l) => [l.outcome ?? l.round, l.reason, l.retryInS])).toEqual([
      ['round-failed', 'the Solana RPC at <SOLANA_RPC_URL> did not answer', 15],
      ['round-failed', 'the Solana RPC at <SOLANA_RPC_URL> did not answer', 30],
      ['done', undefined, undefined],
    ]);
    expect(k.pings).toEqual([false, false, true]);
    expect(k.alerts).toEqual([
      ['the round failed: the Solana RPC at <SOLANA_RPC_URL> did not answer'],
      ['the round failed: the Solana RPC at <SOLANA_RPC_URL> did not answer'],
      ["the keeper's gas is low: 1 of the 5 lamports it should keep"],
    ]);
    expect(JSON.stringify(k.lines)).not.toContain(NODE);
  });

  it('with --once, ends with the failed round, said and pinged', async () => {
    const k = keeper(1);
    await expect(k.run({ loop: false })).rejects.toThrow('did not answer');
    expect([k.lines.length, k.pings, k.waited]).toEqual([1, [false], []]);
  });

  it('is what main.ts runs, for either chain, after setting it up', () => {
    const main = readFileSync(new URL('../../apps/keeper/src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/await runKeeper\(\{/);
    // No loop of its own, and no round outside runKeeper.
    expect(main).not.toMatch(/for \(;;\)|while \(true\)|runRound\(/);
  });
});
