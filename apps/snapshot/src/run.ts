import type { Db } from '@colosseum/db';
import type { ChainId } from '@colosseum/schemas';
import { newChainState } from './discover';
import { keepRunning } from './loop';
import { type PassContext, said, sayer, snapshotChain } from './pass';
import type { ChainSource } from './source';
import { closeOpenRuns } from './store';

// The worker once it is set up (main.ts sets it up): the passes over each chain, one after another,
// each chain in a loop of its own, side by side. A chain whose pass fails backs off alone (loop.ts)
// while the others keep their interval, so one node that does not answer never holds back the rows of
// another chain.

export type SnapshotRun = {
  sources: ChainSource[];
  db: Db;
  /** False: one pass per chain, then return. */
  loop: boolean;
  /** Reads and prints, writes nothing. */
  dryRun: boolean;
  intervalMs: number;
  /**
   * What every reason is said with: main.ts takes node addresses and the database URL out. Default:
   * identity.
   */
  hide?: (text: string) => string;
  /** Where each JSON line goes. Default: stdout. */
  out?: (line: string) => void;
  /**
   * The health ping: true after a pass when no chain's newest pass failed, false after a pass that
   * failed. Its own failure never stops a pass.
   */
  ping?: (ok: boolean) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

/**
 * With loop false: resolves after every chain had one pass, and rejects (after all of them ran) if any
 * pass failed. With loop true: never resolves.
 */
export async function runSnapshots(o: SnapshotRun): Promise<void> {
  if (o.sources.length === 0) throw new Error('the worker was given no chain to read');
  const ctx: PassContext = {
    db: o.db,
    dryRun: o.dryRun,
    hide: o.hide ?? ((text: string) => text),
    out: o.out ?? ((line: string) => console.log(line)),
    now: o.now ?? (() => new Date()),
  };
  const ping = async (ok: boolean) => {
    try {
      await o.ping?.(ok);
    } catch {
      // A ping that could not be sent says nothing about the pass.
    }
  };

  // A worker that was killed in the middle of a pass left its run open, and an open run refuses the
  // next one on its chain: a crash must not keep the next start from reading.
  if (!o.dryRun) {
    const chains = o.sources.map((s) => s.chain);
    await closeOpenRuns(o.db, chains, ctx.now()).catch((e: unknown) => {
      throw new Error(said(ctx, e));
    });
  }

  /** The chains whose newest pass failed. */
  const failing = new Set<ChainId>();
  const loops = o.sources.map((source) => {
    const state = newChainState();
    const say = sayer(ctx, source);
    return keepRunning({
      loop: o.loop,
      intervalMs: o.intervalMs,
      sleep: o.sleep,
      failed: async (f) => {
        failing.add(source.chain);
        // The reason is the pass's own, and a pass fails in words that have been through `hide`.
        say(f);
        await ping(false);
      },
      round: async () => {
        const pass = await snapshotChain(ctx, source, state);
        // A pass another worker's run kept from starting read nothing, and says nothing of the chain.
        if (pass.outcome === 'skipped') return;
        failing.delete(source.chain);
        if (failing.size === 0) await ping(true);
      },
    });
  });

  // Every chain gets its pass, whatever became of another's.
  const ended = await Promise.allSettled(loops);
  const failed = ended.flatMap((end, i) =>
    end.status === 'rejected' ? [{ name: o.sources[i]?.name ?? '', reason: end.reason }] : [],
  );
  const [first] = failed;
  if (!first) return;
  // With the loop on, a failed pass is followed by another and never ends a chain's loop. Only a sleep
  // that throws does, and that is the caller's own error.
  if (o.loop) throw first.reason;
  throw new Error(
    `${failed.length} of ${o.sources.length} chains failed their pass: ${failed
      .map((f) => `${f.name}: ${said(ctx, f.reason)}`)
      .join('; ')}`,
  );
}
