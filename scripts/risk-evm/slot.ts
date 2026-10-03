// One scheduled run and its second chances. A run that leaves tokens without a row for a reason that
// may pass (the network was down, the endpoint refused) is tried again a few times within the hour,
// for those tokens only, and never into the next scheduled run.

export type Missing = { asset: string; error: string; retry: boolean };
export type Attempt = { rows: string[]; missing: Missing[] };

/** What one run achieved, token by token: a token has a row exactly when it has no error. */
export function attemptOf(run: {
  tokens: Array<{ asset: string; error?: string; retry?: boolean }>;
}): Attempt {
  return {
    rows: run.tokens.filter((t) => !t.error).map((t) => t.asset),
    missing: run.tokens.flatMap((t) =>
      t.error ? [{ asset: t.asset, error: t.error, retry: t.retry === true }] : [],
    ),
  };
}

export type SlotDeps = {
  /**
   * Measures the tokens named, or all of them when `only` is null, and says which got a row and which
   * did not. `retry` on a missing token says whether another try could help. Throws when nothing could
   * be measured at all.
   */
  attempt: (only: ReadonlySet<string> | null, n: number) => Promise<Attempt>;
  /** How long to wait before the second attempt, the third, and so on. */
  retryAfterMs: number[];
  /** When the next scheduled run starts. A retry that would begin within `marginMs` of it is not made. */
  until: number;
  marginMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
};

export type SlotOutcome = {
  attempts: number;
  /** Tokens that got a row, over all attempts. */
  rows: string[];
  /** Tokens that did not, with the last reason. */
  missing: Array<{ asset: string; error: string }>;
  /** Set when the last attempt measured nothing at all. */
  error: string | null;
  /** Why it ended. */
  ended: 'complete' | 'nothing to retry' | 'out of attempts' | 'next run is due' | 'stopped';
};

export async function runSlot(d: SlotDeps): Promise<SlotOutcome> {
  const rows: string[] = [];
  let missing: Missing[] = [];
  let only: Set<string> | null = null;
  let error: string | null = null;
  let attempts = 0;
  const done = (ended: SlotOutcome['ended']): SlotOutcome => ({
    attempts,
    rows,
    missing: missing.map(({ asset, error: why }) => ({ asset, error: why })),
    error,
    ended,
  });
  for (;;) {
    attempts++;
    try {
      const a = await d.attempt(only, attempts);
      rows.push(...a.rows);
      // a retry covers only the tokens worth retrying: the others stay missing for the reason they had
      missing = [...missing.filter((m) => !m.retry), ...a.missing];
      error = null;
      only = new Set(missing.filter((m) => m.retry).map((m) => m.asset));
      if (only.size === 0) return done(missing.length ? 'nothing to retry' : 'complete');
    } catch (e) {
      // nothing was measured: the same tokens (all of them on a first attempt) are tried again
      error = e instanceof Error ? e.message : String(e);
    }
    const wait = d.retryAfterMs[attempts - 1];
    if (wait === undefined) return done('out of attempts');
    const resume = d.now() + wait;
    if (resume > d.until - d.marginMs) return done('next run is due');
    // short naps against the wall clock: timers stand still while a laptop sleeps
    while (d.now() < resume && !d.stopped()) await d.sleep(Math.min(resume - d.now(), 30_000));
    if (d.stopped()) return done('stopped');
    if (d.now() > d.until - d.marginMs) return done('next run is due');
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The line that closes one scheduled hour of one chain in runs.jsonl: what it got, what it lacks and
 * why. `event` is "slot" for the loop's hours and "one_off" for a run started by hand, which is not
 * part of the hourly sample.
 */
export function slotLine(
  event: 'slot' | 'one_off',
  chain: { id: string; tokens: unknown[] },
  times: { scheduledAt: number; startedAt: number; finishedAt: number },
  outcome: SlotOutcome,
) {
  return {
    event,
    chain: chain.id,
    scheduledAt: iso(times.scheduledAt),
    startedAt: iso(times.startedAt),
    finishedAt: iso(times.finishedAt),
    attempts: outcome.attempts,
    rows: outcome.rows.length,
    tokens: chain.tokens.length,
    missing: outcome.missing,
    error: outcome.error,
    ended: outcome.ended as SlotOutcome['ended'] | 'missed',
  };
}

/**
 * The line for a scheduled hour in which the collector did not run at all: a later hour had already
 * come when it could run again ('passed'), or it came back with less than half the interval left
 * before the next run ('late').
 */
export function missedLine(
  chain: { id: string; tokens: unknown[] },
  scheduledAt: number,
  backAt: number,
  why: 'passed' | 'late' = 'passed',
) {
  return {
    event: 'slot' as const,
    chain: chain.id,
    scheduledAt: iso(scheduledAt),
    attempts: 0,
    rows: 0,
    tokens: chain.tokens.length,
    missing: [],
    error:
      why === 'late'
        ? `not run: the collector came back at ${iso(backAt)}, with less than half the interval left before the next run`
        : `not run: the collector was asleep or still on an earlier run at this hour; it came back at ${iso(backAt)}`,
    ended: 'missed' as const,
  };
}
