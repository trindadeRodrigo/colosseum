// How the database client is opened, from the environment. Two settings, both for a hosted database
// behind a connection pooler:
//
// DB_POOL_MAX     how many connections this process holds at most. Default 10 (the driver's own). A
//                 pooler in session mode gives each client one server connection for as long as it is
//                 connected, and caps how many a project may hold: every process that opens the
//                 database (the API, the keeper, a script) counts against that cap with its own pool.
// DB_PGBOUNCER    `transaction` when DATABASE_URL goes through a pooler in transaction mode
//                 (Supabase's on port 6543, PgBouncer's `pool_mode = transaction`). A server connection
//                 is then lent for one transaction at a time, so a statement prepared on one is not
//                 there on the next: the driver is told to prepare none. Left out, or `session`,
//                 statements are prepared as before.
//
// What the API locks with holds in either mode: its advisory locks are transaction-scoped
// (`pg_advisory_xact_lock`) and its timeouts are `SET LOCAL`, both inside one transaction.

export type PoolEnv = { DB_POOL_MAX?: string; DB_PGBOUNCER?: string };

/** The most connections a process may be set to hold: above it the value is a mistake, not a pool. */
export const POOL_MAX_LIMIT = 100;

/** The options the driver is opened with. Throws on a value it cannot read, naming the variable. */
export function poolOptions(env: PoolEnv): { max: number; prepare: boolean } {
  const raw = env.DB_POOL_MAX?.trim();
  const max = raw ? Number(raw) : 10;
  if (raw && (!/^\d+$/.test(raw) || max < 1 || max > POOL_MAX_LIMIT))
    throw new Error(`DB_POOL_MAX: expected a number of connections from 1 to ${POOL_MAX_LIMIT}`);
  const mode = env.DB_PGBOUNCER?.trim().toLowerCase();
  if (mode && mode !== 'transaction' && mode !== 'session')
    throw new Error('DB_PGBOUNCER: expected `transaction` or `session`');
  return { max, prepare: mode !== 'transaction' };
}
