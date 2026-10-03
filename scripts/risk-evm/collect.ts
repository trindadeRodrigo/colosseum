import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, type ChainConfig } from './config';
import { acquireLock, type MissedWhy, runLoop, type Slot } from './loop';
import { collectOnce } from './run';
import { type Attempt, attemptOf, missedLine, runSlot, slotLine } from './slot';

// EVM depth collector (REVM-1, method evmq-0.1): what it costs to sell and buy stock tokens at Rodrigo's
// size grid, read from the real pools with eth_call. See README.md.
//   pnpm risk-evm:collect                 one run
//   pnpm risk-evm:collect --loop          one run an hour until stopped
//   pnpm risk-evm:collect --rediscover    look for the deepest pools again before the run
//   pnpm risk-evm:collect --chain base    a chain that is switched off in config.ts
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** A pool below this DexScreener liquidity is not worth a call. */
const MIN_POOL_USD = 10_000;
/** The pool list is looked up again once it is a day old: the deepest pool of a token changes slowly. */
const POOLS_MAX_AGE_HOURS = 24;
/**
 * In the loop, a run that left tokens without a row for a reason that may pass (network down, endpoint
 * refusing) is tried again after these waits, for those tokens only: about 2, 6, 14 and 30 minutes
 * after the first attempt. A ten-minute outage then costs minutes, not the hour's sample.
 */
const RETRY_AFTER_MIN = [2, 4, 8, 16];
/** No retry starts this close to the next scheduled run. */
const RETRY_MARGIN_MS = 2 * 60_000;

const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const runsFile = join(dir, 'runs.jsonl');
const only = option('--chain');
const chains = only ? CHAINS.filter((c) => c.id === only) : CHAINS.filter((c) => c.enabled);
if (chains.length === 0) {
  console.error(`no chain to collect${only ? `: "${only}" is not in config.ts` : ''}`);
  process.exit(1);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (ms: number) => new Date(ms).toISOString();
const log = (event: Record<string, unknown>) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), ...event }));
const record = (line: Record<string, unknown>) => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(runsFile, `${JSON.stringify(line)}\n`);
};
const pct = (v: number | null) => (v === null ? '     n/a' : `${v.toFixed(3).padStart(7)}%`);

let stop = false;
let wake = () => {};
/** A wait that a stop signal cuts short. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });

/** `--rediscover` holds until one run has looked the pools up again, however many attempts that takes. */
let rediscover = flag('--rediscover');

/** One attempt at one chain: the tokens named, or all of them. Holds the run lock while it measures. */
async function attempt(
  chain: ChainConfig,
  slot: Slot,
  tokens: ReadonlySet<string> | null,
  n: number,
): Promise<Attempt> {
  const scheduledAt = iso(slot.at);
  let release: (() => void) | null = null;
  try {
    // one run at a time, across processes too: a one-off run and the loop share this lock
    release = acquireLock(join(dir, 'run.lock'), 60 * 60_000);
    if (!release) throw new Error(`another run holds ${join(dir, 'run.lock')}`);
    const s = await collectOnce(chain, {
      dir,
      maxPools: num('RISK_EVM_MAX_POOLS', 3),
      minLiquidityUsd: MIN_POOL_USD,
      poolsMaxAgeHours: POOLS_MAX_AGE_HOURS,
      rediscover,
      only: tokens,
      until: slot.until,
      log,
    });
    if (s.poolsRediscovered) rediscover = false;
    for (const t of s.tokens) {
      console.log(
        `${chain.id} ${t.asset.padEnd(6)} pools=${t.pools} mid=${(t.refMidUsd ?? 0).toFixed(2).padStart(9)} sell $10k=${pct(t.sell10k)} $50k=${pct(t.sell50k)}${t.error ? `  ${t.error}` : ''}`,
      );
    }
    record({ ...s, scheduledAt, attempt: n });
    console.log(JSON.stringify({ ...s, tokens: s.tokens.length, scheduledAt, attempt: n }));
    return attemptOf(s);
  } catch (e) {
    record({
      chain: chain.id,
      scheduledAt,
      attempt: n,
      failedAt: iso(Date.now()),
      error: message(e),
    });
    log({ event: 'attempt_failed', chain: chain.id, scheduledAt, attempt: n, error: message(e) });
    throw e;
  } finally {
    release?.();
  }
}

/**
 * One scheduled run of every chain, with its retries. Each chain ends with a line in the run log:
 * how many rows the hour got, which tokens are missing and why. Returns the rows written per chain.
 */
async function runAll(
  event: 'slot' | 'one_off',
  slot: Slot,
  retryAfterMs: number[],
): Promise<number[]> {
  const rows: number[] = [];
  for (const chain of chains) {
    if (stop) break;
    const startedAt = Date.now();
    const outcome = await runSlot({
      attempt: (tokens, n) => attempt(chain, slot, tokens, n),
      retryAfterMs,
      until: slot.until,
      marginMs: RETRY_MARGIN_MS,
      now: Date.now,
      sleep,
      stopped: () => stop,
    });
    rows.push(outcome.rows.length);
    const line = slotLine(
      event,
      chain,
      { scheduledAt: slot.at, startedAt, finishedAt: Date.now() },
      outcome,
    );
    record(line);
    if (line.rows < line.tokens) log({ ...line, event: `${event}_incomplete` });
  }
  return rows;
}

/** A scheduled hour that passed with no run at all. */
function recordMissed(at: number, why: MissedWhy): void {
  for (const chain of chains) {
    const line = missedLine(chain, at, Date.now(), why);
    record(line);
    log({ ...line, event: 'slot_missed' });
  }
}

if (!flag('--loop')) {
  // one attempt, no retries: a person is watching and can run it again
  const rows = await runAll('one_off', { at: Date.now(), until: Number.POSITIVE_INFINITY }, []);
  if (rows.length < chains.length || rows.some((n) => n === 0)) process.exitCode = 1;
} else {
  const releaseLoop = acquireLock(join(dir, 'loop.lock'));
  if (!releaseLoop) {
    console.error(`a collector loop is already running (${join(dir, 'loop.lock')})`);
    process.exit(1);
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      // a run in progress finishes its rows first
      stop = true;
      log({ event: 'stopping', signal: sig });
      wake();
    });
  }
  const intervalMs = num('RISK_EVM_INTERVAL_MIN', 60) * 60_000;
  log({ event: 'loop_started', everyMinutes: intervalMs / 60_000, dir, pid: process.pid });
  try {
    await runLoop({
      runOnce: (slot) =>
        runAll(
          'slot',
          slot,
          RETRY_AFTER_MIN.map((m) => m * 60_000),
        ),
      intervalMs,
      now: Date.now,
      sleep,
      stopped: () => stop,
      onError: (e, slot) =>
        log({ event: 'run_failed', scheduledAt: iso(slot.at), error: message(e) }),
      onMissed: recordMissed,
    });
  } finally {
    releaseLoop();
  }
}
