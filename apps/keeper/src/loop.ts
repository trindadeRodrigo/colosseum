// The keeper's rounds, one after another (DESIGN-VAULT section 10). With --loop, a round that fails (a
// node that does not answer, a DNS error, a 429 or a 5xx) is said as one line and an alert, and the next
// round comes after a back-off: 15 s, doubled after each failure in a row, at most 5 minutes, and back to
// the interval once a round goes through. The loop never ends on a failed round; only what is wrong at
// start (a key that is not the keeper's, the wrong network) stops the keeper, before the first round.
// With --once, the failed round is said and the keeper exits with it.

export const BACKOFF_FIRST_MS = 15_000;
export const BACKOFF_MAX_MS = 300_000;

/** How long to wait after the `failures`-th failed round in a row. */
export const backoffMs = (failures: number) =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

export type RoundFailure = {
  outcome: 'round-failed';
  reason: string;
  alert: true;
  /** Failed rounds in a row, this one included. */
  failures: number;
  /** When the next round starts, in seconds; absent with --once. */
  retryInS?: number;
};

export type LoopOptions = {
  /** One round. A round that throws has failed. */
  round: () => Promise<void>;
  loop: boolean;
  intervalMs: number;
  /** Says a failed round: the log line and the alerts. Its own failure never stops the loop. */
  failed: (failure: RoundFailure) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function keepRunning(o: LoopOptions): Promise<void> {
  const sleep = o.sleep ?? wait;
  let failures = 0;
  for (;;) {
    try {
      await o.round();
      failures = 0;
    } catch (e) {
      failures++;
      const reason = e instanceof Error ? e.message : String(e);
      const failure: RoundFailure = { outcome: 'round-failed', reason, alert: true, failures };
      if (!o.loop) {
        await o.failed(failure);
        throw e;
      }
      const delay = backoffMs(failures);
      try {
        await o.failed({ ...failure, retryInS: delay / 1000 });
      } catch {
        // The round is tried again whatever became of saying it.
      }
      await sleep(delay);
      continue;
    }
    if (!o.loop) return;
    await sleep(o.intervalMs);
  }
}
