import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chainRows, chains, createDb, type Db, seedChains } from '@colosseum/db';
import { type EnvLike, parseChainConfigs } from '@colosseum/schemas';
import { parseArgs } from './args';
import { sourcesFromEnv } from './chains';
import { hiderFromEnv } from './hide';
import { reasonOf } from './pass';
import { runSnapshots } from './run';

// The snapshot worker (docs/vault/PROMPT-BUILD-PORTFOLIO.md, slice 1): a worker with no HTTP listener
// that reads every vault we know on each chain and keeps what it read, a pass every ten minutes.
//
//   CHAIN_MODE_SOLANA=readonly SOLANA_RPC_URL=<devnet node> \
//     pnpm --filter @colosseum/snapshot start --once
//   ... --loop [--interval 600]    a pass every interval seconds, until stopped; a failed pass is said
//                                  and followed by another after a back-off (loop.ts)
//   ... --dry-run                  reads and prints, writes nothing
//
// It reads and never signs: it holds no key, loads no signing entry, and makes a reader of each real
// chain, never an adapter (chains.ts). It runs on the test networks until a person says otherwise:
// CHAIN_NETWORK_<CHAIN>=mainnet stops it here, before a node or the database is touched. What is wrong at
// start is said on stderr and ends it with 1 before any pass. No line carries a node's address, the
// database's or the ping's (hide.ts).

/** After a good pass, and its /fail after a failed one. Never throws and never prints the URL. */
export type Ping = (ok: boolean) => Promise<void>;

/**
 * The health check of SNAPSHOT_PING_URL (healthchecks.io), as the keeper's (apps/keeper/src/alerts.ts):
 * optional, a POST with ten seconds to answer, and a post that fails is said on stderr in words of its
 * own. The URL is a key to the check, so nothing repeats it.
 */
export function pingFromEnv(
  env: EnvLike,
  o: { fetch?: typeof fetch; warn?: (line: string) => void } = {},
): Ping {
  const post = o.fetch ?? fetch;
  const warn = o.warn ?? ((line: string) => console.error(line));
  const url = env.SNAPSHOT_PING_URL?.trim() || null;
  return async (ok) => {
    if (!url) return;
    try {
      const res = await post(ok ? url : `${url.replace(/\/$/, '')}/fail`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) warn(`the health check answered ${res.status}`);
    } catch {
      warn('the health check could not be reached');
    }
  };
}

/**
 * The database is held to the networks of this environment before the first pass, as the API holds it at
 * its start: every `chain_id` points at a row of `chains`, and one database serves one network.
 * `seedChains` writes the rows and refuses a database whose row names another network, so devnet's
 * snapshots never join a local copy's (both are `sandbox`, and a row does not say which). A dry run
 * writes nothing: it makes the same check on the rows it reads.
 */
export async function holdChains(db: Db, env: EnvLike, dryRun: boolean): Promise<void> {
  const configs = parseChainConfigs(env);
  if (!dryRun) return seedChains(db, configs);
  chainRows(await db.select({ id: chains.id, network: chains.network }).from(chains), configs);
}

export type StartDeps = {
  sources?: typeof sourcesFromEnv;
  /** Opens no connection until the first query. */
  open?: () => { db: Db; client: { end(options?: { timeout?: number }): Promise<void> } };
  holdChains?: typeof holdChains;
  run?: typeof runSnapshots;
  /** Handed what ends the database client, to call when the process is told to stop. */
  onStop?: (end: () => Promise<void>) => void;
  fetch?: typeof fetch;
  warn?: (line: string) => void;
};

/**
 * The worker from its command line and its environment. Rejects on what is wrong at start, before the
 * database is opened, and, with --once, when a pass failed. The message never carries an address: the
 * caller still prints it through the hider, for what a library put in one.
 */
export async function start(
  argv: readonly string[],
  env: EnvLike,
  deps: StartDeps = {},
): Promise<void> {
  const hide = hiderFromEnv(env);
  const warn = deps.warn ?? ((line: string) => console.error(hide(line)));
  const args = parseArgs(argv);
  // Mainnet, a chain that cannot be read and a node of another network all stop it here.
  const sources = await (deps.sources ?? sourcesFromEnv)(env, { warn });
  const { db, client } = (deps.open ?? createDb)();
  // An open query gets five seconds; a stop is not held up by a node that hangs.
  (deps.onStop ?? stopOnSignal)(() => client.end({ timeout: 5 }));
  try {
    await (deps.holdChains ?? holdChains)(db, env, args.dryRun);
    await (deps.run ?? runSnapshots)({
      sources,
      db,
      loop: args.loop,
      dryRun: args.dryRun,
      intervalMs: args.intervalS * 1000,
      hide,
      ping: pingFromEnv(env, { warn, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    });
  } finally {
    await client.end();
  }
}

/** Stopped by a signal, the worker closes its database client and exits as a shell reports the signal. */
function stopOnSignal(end: () => Promise<void>): void {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)
    process.once(signal, () => {
      end()
        .catch(() => {})
        .finally(() => process.exit(code));
    });
}

/** True when this file is what the process was started on (`tsx src/main.ts`), not when a test imports it. */
function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * What the worker says of an error that ends it: its reason as a pass says one (reasonOf of
 * pass.ts), through the hider. That is the message, with the code in front where the error has one;
 * and a query the database did not take is said by its code alone, since its message is the query
 * and says nothing of why. Never the error itself: its cause and its stack are where a transport
 * error keeps the address it failed on.
 */
export function lastWords(env: EnvLike, e: unknown): string {
  return hiderFromEnv(env)(reasonOf(e));
}

if (isEntry()) {
  // An error nothing caught would be printed whole by the runtime, cause and all. It ends the worker
  // all the same, with its reason alone.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const)
    process.on(event, (e: unknown) => {
      console.error(lastWords(process.env, e));
      process.exit(1);
    });
  start(process.argv.slice(2), process.env).then(
    // A pass may leave a timer or a socket behind: with --once the worker is done when its pass is.
    () => process.exit(0),
    (e) => {
      console.error(lastWords(process.env, e));
      process.exit(1);
    },
  );
}
