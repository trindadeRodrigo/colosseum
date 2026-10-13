import type { BuiltTx } from '@colosseum/schemas';
import type { Notifier } from './alerts';
import type { KeeperAdapter } from './chain';
import { keepRunning } from './loop';
import type { KeeperMemory } from './memory';
import { runRound, type VaultLine } from './round';

// The keeper once it is set up, whichever chain (main.ts sets it up): rounds one after another, each
// one's lines, alerts and health ping, and a failed round said, alerted and retried (loop.ts).

/** What a round runs on, whichever chain: the adapter, who signs, and where the memory is kept. */
export type Wired = {
  network: string;
  adapter: KeeperAdapter;
  sign(tx: BuiltTx): Promise<{ wire: string; txId: string }>;
  /** The state file's name: the network, and what tells a reset copy apart from the one before. */
  stateName: string;
  /** What the keeper's key holds of the chain's coin, and the least it should, in its smallest units. */
  gas(): Promise<{ have: bigint; low: bigint; unit: string }>;
};

export type KeeperRun = {
  wired: Wired;
  loop: boolean;
  dryRun: boolean;
  intervalMs: number;
  memory: KeeperMemory;
  save: (memory: KeeperMemory) => void | Promise<void>;
  notify: Notifier;
  /** What a failed round's reason is said with: main.ts takes the nodes' addresses out. */
  hide?: (text: string) => string;
  /** Where each JSON line goes. Default: stdout. */
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export async function runKeeper(o: KeeperRun): Promise<void> {
  const { wired, memory, notify } = o;
  const out = o.out ?? ((line: string) => console.log(line));
  const hide = o.hide ?? ((text: string) => text);
  const say = (fields: object) =>
    out(JSON.stringify({ at: new Date().toISOString(), network: wired.network, ...fields }));
  const log = (line: VaultLine) => say(line);

  await keepRunning({
    loop: o.loop,
    intervalMs: o.intervalMs,
    sleep: o.sleep,
    failed: async (f) => {
      const reason = hide(f.reason);
      say({ ...f, reason });
      await notify.ping(false);
      await notify.alert([`the round failed: ${reason}`]);
    },
    round: async () => {
      const lines = await runRound(
        { adapter: wired.adapter, dryRun: o.dryRun, log, sign: wired.sign, save: o.save, hide },
        memory,
      );
      const alerts = lines.filter((l) => l.alert).map((l) => `${l.vault}: ${l.reason}`);
      // Low gas: the keeper cannot pay for its legs much longer.
      const gas = await wired.gas().catch(() => null);
      if (gas && gas.have < gas.low)
        alerts.push(
          `the keeper's gas is low: ${gas.have} of the ${gas.low} ${gas.unit} it should keep`,
        );
      await notify.alert(alerts);
      await notify.ping(true);
      say({
        round: 'done',
        vaults: lines.length,
        acted: lines.filter((l) => l.outcome === 'acted').length,
        alerts: lines.filter((l) => l.alert).length,
        inFlight: memory.inFlight.size,
      });
    },
  });
}
