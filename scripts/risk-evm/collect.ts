import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS } from './config';
import { acquireLock, runLoop } from './loop';
import { collectOnce } from './run';

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

const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const runsFile = join(dir, 'runs.jsonl');
const only = option('--chain');
const chains = only ? CHAINS.filter((c) => c.id === only) : CHAINS.filter((c) => c.enabled);
if (chains.length === 0) {
  console.error(`no chain to collect${only ? `: "${only}" is not in config.ts` : ''}`);
  process.exit(1);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const log = (event: Record<string, unknown>) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), ...event }));
const pct = (v: number | null) => (v === null ? '     n/a' : `${v.toFixed(3).padStart(7)}%`);

/** One run of every chain. Throws after the last chain if any of them failed. */
async function runAll(rediscover: boolean): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // one run at a time, across processes too: a one-off run and the loop share this lock
  const release = acquireLock(join(dir, 'run.lock'), 15 * 60_000);
  if (!release) throw new Error(`another run holds ${join(dir, 'run.lock')}`);
  const failed: string[] = [];
  try {
    for (const chain of chains) {
      try {
        const s = await collectOnce(chain, {
          dir,
          maxPools: num('RISK_EVM_MAX_POOLS', 3),
          minLiquidityUsd: MIN_POOL_USD,
          poolsMaxAgeHours: POOLS_MAX_AGE_HOURS,
          rediscover,
          log,
        });
        for (const t of s.tokens) {
          console.log(
            `${chain.id} ${t.asset.padEnd(6)} pools=${t.pools} mid=${(t.refMidUsd ?? 0).toFixed(2).padStart(9)} sell $10k=${pct(t.sell10k)} $50k=${pct(t.sell50k)}${t.error ? `  ${t.error}` : ''}`,
          );
        }
        appendFileSync(runsFile, `${JSON.stringify(s)}\n`);
        console.log(JSON.stringify({ ...s, tokens: s.tokens.length }));
        if (s.rows === 0) failed.push(`${chain.id}: no row written`);
      } catch (e) {
        const error = message(e);
        appendFileSync(
          runsFile,
          `${JSON.stringify({ chain: chain.id, failedAt: new Date().toISOString(), error })}\n`,
        );
        failed.push(`${chain.id}: ${error}`);
      }
    }
  } finally {
    release();
  }
  if (failed.length) throw new Error(failed.join('; '));
}

if (!flag('--loop')) {
  try {
    await runAll(flag('--rediscover'));
  } catch (e) {
    log({ event: 'run_failed', error: message(e) });
    process.exitCode = 1;
  }
} else {
  const releaseLoop = acquireLock(join(dir, 'loop.lock'));
  if (!releaseLoop) {
    console.error(`a collector loop is already running (${join(dir, 'loop.lock')})`);
    process.exit(1);
  }
  let stop = false;
  let wake = () => {};
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      // a run in progress finishes its rows first
      stop = true;
      log({ event: 'stopping', signal: sig });
      wake();
    });
  }
  let rediscover = flag('--rediscover');
  const intervalMs = num('RISK_EVM_INTERVAL_MIN', 60) * 60_000;
  log({ event: 'loop_started', everyMinutes: intervalMs / 60_000, dir, pid: process.pid });
  try {
    await runLoop({
      runOnce: async () => {
        await runAll(rediscover);
        rediscover = false;
      },
      intervalMs,
      now: Date.now,
      sleep: (ms) =>
        new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        }),
      stopped: () => stop,
      onError: (e) => log({ event: 'run_failed', error: message(e) }),
    });
  } finally {
    releaseLoop();
  }
}
