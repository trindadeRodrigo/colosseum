// The hourly loop and the lock that keeps two runs from overlapping.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type LoopDeps = {
  runOnce: () => Promise<unknown>;
  intervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  onError: (error: unknown) => void;
};

/**
 * Runs now, then on a fixed grid of `intervalMs` from the first start. Runs never overlap: the next
 * one starts only after the last one returned, and slots missed by a long run (or a sleeping laptop)
 * are skipped, not caught up. A run that throws is reported and the loop carries on.
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
    try {
      await d.runOnce();
    } catch (e) {
      d.onError(e);
    }
    do next += d.intervalMs;
    while (next <= d.now());
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
 * process is gone, or when it is older than `staleAfterMs` (a run takes seconds, so an old run lock
 * means a process id was reused). The returned function releases it.
 */
export function acquireLock(path: string, staleAfterMs?: number): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let held: { pid?: number; startedAt?: string } = {};
      try {
        held = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // unreadable lock: treat it as stale
      }
      const pid = Number(held.pid);
      const age = Date.now() - Date.parse(held.startedAt ?? '');
      const old = staleAfterMs !== undefined && !(age < staleAfterMs);
      if (Number.isInteger(pid) && pid !== process.pid && alive(pid) && !old) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}
