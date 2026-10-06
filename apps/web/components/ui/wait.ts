import { useEffect, useState } from 'react';

// How long a wait for data has lasted, in the steps a screen shows (Waiting.tsx): nothing for the first
// 400ms, the loader and its words, a calm line after 4 seconds (the hosted API may be waking), and after
// a minute the failure with a retry.

/** After this long a wait says the data service may be waking. */
export const SLOW_AFTER_MS = 4_000;
/** After this long a wait gives up and offers to try again. */
export const GIVE_UP_AFTER_MS = 60_000;
/** A wait shorter than this shows no loader: only the still boxes. */
export const LOADER_AFTER_MS = 400;

export type WaitPhase = 'quiet' | 'waiting' | 'slow' | 'over';

/**
 * Where a wait is: `quiet` for its first 400ms, `waiting`, `slow` after 4s, `over` after a minute.
 * `attempt` starts the clock again: a retry is a new wait.
 */
export function useWaitPhase(active: boolean, attempt = 0): WaitPhase {
  const [phase, setPhase] = useState<WaitPhase>('quiet');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is what starts the clock again
  useEffect(() => {
    setPhase('quiet');
    if (!active) return;
    const timers = [
      setTimeout(() => setPhase('waiting'), LOADER_AFTER_MS),
      setTimeout(() => setPhase('slow'), SLOW_AFTER_MS),
      setTimeout(() => setPhase('over'), GIVE_UP_AFTER_MS),
    ];
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [active, attempt]);
  return phase;
}
