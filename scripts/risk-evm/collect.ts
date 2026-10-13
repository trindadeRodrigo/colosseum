import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AssetList } from '@colosseum/schemas';
import { CHAINS, type ChainConfig } from './config';
import { type ListRun, listRun } from './listed';
import { acquireLock, type MissedWhy, runLoop, type Slot } from './loop';
import { collectOnce } from './run';
import {
  type Attempt,
  attemptOf,
  missedLine,
  RETRY_AFTER_MIN,
  RETRY_MARGIN_MS,
  runSlot,
  slotLine,
} from './slot';

// EVM depth collector (REVM-1, method evmq-0.1): what it costs to sell and buy stock tokens at Rodrigo's
// size grid, read from the real pools with eth_call. See README.md.
//   pnpm risk-evm:collect                 one run
//   pnpm risk-evm:collect --loop          one run an hour until stopped
//   pnpm risk-evm:collect --rediscover    look for the deepest pools again before the run
//   pnpm risk-evm:collect --chain base    a chain that is switched off in config.ts
//   pnpm risk-evm:collect --list          the tracked stocks of scripts/risk/universe/<chain>.json and every
//                                         reachable pool of each (PLAN-UNIVERSE RU.6); also with --loop.
//                                         Without it the run is the hand list of config.ts, as before.
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

/** "Every pool": a limit no token reaches. */
const ALL_POOLS = Number.MAX_SAFE_INTEGER;
/** A pool below this DexScreener liquidity is not worth a call. */
const MIN_POOL_USD = 10_000;
/** The pool list is looked up again once it is a day old: the deepest pool of a token changes slowly. */
const POOLS_MAX_AGE_HOURS = 24;
const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const runsFile = join(dir, 'runs.jsonl');
const only = option('--chain');
const chains = only ? CHAINS.filter((c) => c.id === only) : CHAINS.filter((c) => c.enabled);
if (chains.length === 0) {
  console.error(`no chain to collect${only ? `: "${only}" is not in config.ts` : ''}`);
  process.exit(1);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where the asset lists are (DU2). */
const LIST_DIR = process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe';
/**
 * `--list`: each chain's tokens and pools from its asset list and the cut that list names. A chain with
 * no list file keeps the hand list of config.ts, and the run says so. A list whose cut is not on this
 * machine, or is another cut, stops the run: the list holds counts, the cut holds the pools.
 */
const lists = new Map<string, { chain: ChainConfig; listed: ListRun }>();
if (flag('--list')) {
  for (const chain of chains) {
    const listPath = join(LIST_DIR, `${chain.id}.json`);
    if (!existsSync(listPath)) {
      console.error(
        `${listPath} is absent: ${chain.id} is collected from the hand list of config.ts`,
      );
      continue;
    }
    try {
      const list = AssetList.parse(JSON.parse(readFileSync(listPath, 'utf8')));
      const cutName = list.inputs.cut ?? '';
      const cutPath = join(dir, cutName);
      if (!cutName || !existsSync(cutPath))
        throw new Error(
          `${listPath} was written from ${cutName || 'no cut'}, which is not in ${dir}: run pnpm risk-evm:pareto, pnpm risk-evm:oracles and pnpm risk:universe ${chain.id} on this machine`,
        );
      const { tokens, listed } = listRun(chain, list, JSON.parse(readFileSync(cutPath, 'utf8')), {
        list: listPath,
        cut: cutName,
      });
      lists.set(chain.id, { chain: { ...chain, tokens }, listed });
      console.error(
        `${chain.id}: ${tokens.length} tracked stocks from ${listPath} (${cutName})${listed.handListNotTracked.length ? `; in config.ts and not tracked, not read in this run: ${listed.handListNotTracked.join(', ')}` : ''}`,
      );
    } catch (e) {
      console.error(message(e));
      process.exit(1);
    }
  }
}
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
  configured: ChainConfig,
  slot: Slot,
  tokens: ReadonlySet<string> | null,
  n: number,
): Promise<Attempt> {
  const fromList = lists.get(configured.id);
  const chain = fromList?.chain ?? configured;
  const scheduledAt = iso(slot.at);
  let release: (() => void) | null = null;
  try {
    // one run at a time, across processes too: a one-off run and the loop share this lock
    release = acquireLock(join(dir, 'run.lock'), 60 * 60_000);
    if (!release) throw new Error(`another run holds ${join(dir, 'run.lock')}`);
    const s = await collectOnce(chain, {
      dir,
      // the per-token pool limit is a setting: three on the hand list, every reachable pool on the asset list
      maxPools: num('RISK_EVM_MAX_POOLS', fromList ? ALL_POOLS : 3),
      listed: fromList?.listed,
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
      lists.get(chain.id)?.chain ?? chain,
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
    const line = missedLine(lists.get(chain.id)?.chain ?? chain, at, Date.now(), why);
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
