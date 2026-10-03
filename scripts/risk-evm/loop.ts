// The hourly loop and the lock that keeps two runs from overlapping.
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Slot = {
  /** The scheduled time of this run. */
  at: number;
  /** The scheduled time of the next one. */
  until: number;
};

export type LoopDeps = {
  runOnce: (slot: Slot) => Promise<unknown>;
  intervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  onError: (error: unknown, slot: Slot) => void;
  /** A scheduled time that passed with no run: the machine was asleep, or an earlier run was still going. */
  onMissed?: (at: number) => void;
};

/**
 * Runs now, then on a fixed grid of `intervalMs` from the first start. Runs never overlap: the next
 * one starts only after the last one returned. When several scheduled times have passed (a sleeping
 * laptop, a long run), only the latest is run, late; the earlier ones are reported as missed and not
 * caught up. A run that throws is reported and the loop carries on.
 */
export async function runLoop(d: LoopDeps): Promise<void> {
  let next = d.now();
  while (!d.stopped()) {
    const wait = next - d.now();
    if (wait > 0) {
      // short naps, so a clock that jumped (sleep, then wake) is noticed within half a minute
      await d.sleep(Math.min(wait, 30_000));
      continue;
    }
    let at = next;
    while (at + d.intervalMs <= d.now()) {
      d.onMissed?.(at);
      at += d.intervalMs;
    }
    next = at + d.intervalMs;
    const slot = { at, until: next };
    try {
      await d.runOnce(slot);
    } catch (e) {
      d.onError(e, slot);
    }
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Takes the lock file, or returns null when a live process holds it. A lock is taken over when its
 * process is gone, or when it is older than `staleAfterMs` (longer than a run can take, so it can only
 * be a reused process id). The returned function releases the lock if this process still holds it.
 */
export function acquireLock(path: string, staleAfterMs?: number): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const read = (): { pid?: number; startedAt?: string } => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return {}; // missing or unreadable: treated as stale
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // written in full under another name, then linked: the lock never exists half-written
    const draft = `${path}.${process.pid}.tmp`;
    writeFileSync(draft, mine);
    try {
      linkSync(draft, path);
      return () => {
        if (read().pid === process.pid) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      rmSync(draft, { force: true });
    }
    const held = read();
    const pid = Number(held.pid);
    const age = Date.now() - Date.parse(held.startedAt ?? '');
    const old = staleAfterMs !== undefined && !(age < staleAfterMs);
    if (Number.isInteger(pid) && pid !== process.pid && alive(pid) && !old) return null;
    rmSync(path, { force: true });
  }
  return null;
}
