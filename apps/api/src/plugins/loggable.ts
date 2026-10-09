// What of an error may go in a log line. It imports nothing: every route's handler reads it, the
// /v1 ones included.

/**
 * A failed database query, as the drivers throw it: Drizzle's error holds the statement and its
 * `params`, postgres.js's its `query` and `parameters`, and each one's message and stack repeat them.
 * Those values are a person's id, their wallet, their words.
 */
export function isDatabaseError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  const called = nameOf(err);
  if (called === 'DrizzleQueryError' || called === 'PostgresError') return true;
  if (typeof e.query === 'string' && ('params' in e || 'parameters' in e)) return true;
  // A driver's error under another: a transaction that failed, a wrapped query.
  return e.cause !== undefined && e.cause !== err && isDatabaseError(e.cause);
}

/** What an error is called: its name, or its class's where it kept the plain one (Drizzle's does). */
function nameOf(err: unknown): string {
  const e = err as { name?: unknown; constructor?: { name?: unknown } };
  const own = typeof e.name === 'string' && e.name !== 'Error' ? e.name : e.constructor?.name;
  return typeof own === 'string' && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(own) ? own : 'Error';
}

const codeOf = (err: unknown): string | undefined => {
  const own = (err as { code?: unknown } | null)?.code;
  if (typeof own === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(own)) return own;
  const under = (err as { cause?: unknown } | null)?.cause;
  return under !== undefined && under !== err ? codeOf(under) : undefined;
};

/**
 * What of an error goes in a log line. A database's error goes by its name and its code alone, never
 * its message, its stack (which opens with the message) or its values. Any other error goes whole.
 */
export function loggable(err: unknown): unknown {
  if (!isDatabaseError(err)) return err;
  const code = codeOf(err);
  return { type: nameOf(err), ...(code ? { code } : {}) };
}
