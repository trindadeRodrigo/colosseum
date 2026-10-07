import 'dotenv/config';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { multipleAccounts, RISK_HOME } from '../lib-lending';
import { rpcStats } from '../lib-pools';
import { readSplitCapture, saveCapture } from '../lib-split';
import solanaList from '../universe/solana.json';
import {
  batchedReader,
  encodeRecording,
  failedRunPools,
  folderRefusal,
  hourFolder,
  type PoolOutcome,
  planOf,
  poolOutcomes,
  RAW_ARRAYS_METHOD,
  RAW_ARRAYS_METHOD_VERSION,
  RAW_ARRAYS_SOURCE,
  type RawSelection,
  runSummary,
  scrubbed,
  secretsOf,
  selectRawArrayPools,
  withholdingUndecodable,
} from './lib';

// PLAN-UNIVERSE RU.12 — the hourly job `com.colosseum.risk-raw-arrays` (minute 25): the pool account and every tick
// or bin array of each concentrated-liquidity pool of the tracked stocks that the pool collector does not record
// itself, as raw bytes, in the collector's file format, into a folder of its own:
//   <RISK_RAW_ARRAYS_DIR>/<YYYY-MM-DD>/<HH>/<pool>.json.gz
//   <RISK_RAW_ARRAYS_DIR>/runs.jsonl                               one line per run
// It reads the collector's registry and cache under RISK_HOME and writes none of the collector's files or folders.
// It is installed beside the other jobs by scripts/risk/raw-arrays/install-job.sh, which loads this one agent and
// reloads none (gate PRICE-JOB). The tracked stocks are scripts/risk/universe/solana.json, put inside the bundle
// when it is built, because a launchd agent cannot read ~/Documents: a new list needs a new install.
//
// RISK_RAW_ARRAYS_DIR has no default here. The installer writes the folder of its own home into the bundle it
// builds (<home>/raw-arrays), so only an installed bundle knows where to write, and a run by hand names a folder:
//   RISK_RAW_ARRAYS_DIR=<a folder of your own> pnpm risk:raw-arrays
//
// Read-only on the chain: getMultipleAccounts in batches of 100, one at a time, through the shared rpc() and its
// backoff. No getProgramAccounts: which arrays a pool has comes from the collector's cache (it lists each pool again
// about hourly, and at once when its own liquidity check fails), so a list here is as old as the collector's.
//
// Settings:
//   RISK_RAW_ARRAYS_ALL=1          also read the pools the collector writes itself. It writes each of them only in
//                                  the runs where it lists the pool again, about half the hours. Where both folders
//                                  hold a pool's hour the API reads the collector's file, and this job's if that one
//                                  does not read.
//   RISK_RAW_ARRAYS_SKIP=other,…   leave out pools by exit path (none by default).
//   RISK_RAW_ARRAYS_BATCH=<1..100> the accounts in one call (100).
//   RISK_RAW_ARRAYS_CAPTURE=<file> also save what the run read as a split capture, with what the read knew beside it
//                                  (<file>.read.json), for `pnpm risk:raw-arrays-check`.
// `--plan` prints what a run would read, from the registry and the cache, and stops: no network, nothing written.
const KIND = 'raw-arrays-run';
/** No call is started after this long: the batches still to read are then not read, and their pools say so. */
const READ_BUDGET_MS = 120_000;
const plan = process.argv.includes('--plan');
const started = Date.now();
const say = (e: unknown) => scrubbed(e, secretsOf(process.env.SOLANA_RPC_URL));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// what every row says of itself: where its figures are from. Each tvlUsd is the registry's, as old as the registry.
const PROVENANCE = {
  source: RAW_ARRAYS_SOURCE,
  method: RAW_ARRAYS_METHOD,
  methodVersion: RAW_ARRAYS_METHOD_VERSION,
  provenance: 'live',
  tvlUsdSource: 'the pool collector’s registry, as of registry.fetchedAt',
} as const;

// The collector rewrites cache.json in place at the end of each of its runs: a read that falls inside that write sees
// half a file. That is a parse error, tried again; a missing file is not.
async function readJson<T>(file: string, attempts: number): Promise<T> {
  for (let i = 1; ; i++) {
    const text = readFileSync(file, 'utf8');
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      if (i >= attempts)
        throw new Error(`${file} is not readable as JSON after ${attempts} tries: ${say(e)}`);
      await sleep(2_000);
    }
  }
}

// What a path is on the disk: its device and inode, following links; null when nothing is there. Two names of one
// folder (a link, another letter case, another spelling of the volume) give the same answer.
const idOf = (path: string): string | null => {
  try {
    const s = statSync(path);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
};
// The collector's homes: this run's and the default one, so a run pointed at another home still may not write into
// the live one. The collector writes <home>/raw whatever RISK_RAW_DIR says (that variable is the API's): both are
// refused.
const HOMES = [resolve(RISK_HOME), join(homedir(), '.colosseum', 'risk')];
const RAWS = [
  ...HOMES.map((h) => join(h, 'raw')),
  process.env.RISK_RAW_DIR ? resolve(process.env.RISK_RAW_DIR) : '',
];
const refusalOf = (folder: string) => folderRefusal(resolve(folder), HOMES, RAWS, idOf);

/**
 * The folder this run may write into, decided before anything is read or created. It is refused when no folder is
 * named, when it is one of the collector's (`folderRefusal`), and when it already holds another job's run log.
 */
function ownFolder(): string {
  const named = process.env.RISK_RAW_ARRAYS_DIR;
  if (!named)
    throw new Error(
      'RISK_RAW_ARRAYS_DIR is not set: name the folder this run writes into (the installed job has its own)',
    );
  const dir = resolve(named);
  const refusal = refusalOf(dir);
  if (refusal) throw new Error(`${refusal}: this job writes only into a folder of its own`);
  // A run log that begins with another job's line is not this job's folder, whatever its name. An empty one proves
  // nothing (a log someone emptied, a first line the disk had no room for) and is this job's to write.
  const log = join(dir, 'runs.jsonl');
  if (existsSync(log)) {
    const head = Buffer.alloc(200);
    const fd = openSync(log, 'r');
    const n = readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    const first = head.subarray(0, n).toString('utf8');
    if (first.trim() && !first.includes(`"kind":"${KIND}"`))
      throw new Error(`${dir} holds a runs.jsonl that is not this job's: not a folder of its own`);
  }
  return dir;
}

/**
 * The collector's own folder, looked at and never written: for each of its pools, the hours since the newest hour
 * folder that holds a file of it, and in how many of the newest 24 hour folders it has one. `maxFolders` hour folders
 * are looked at, newest first.
 */
function collectorFiles(dir: string, pools: ReadonlySet<string>, at: number, maxFolders: number) {
  const newest = new Map<string, string>();
  const in24 = new Map<string, number>();
  let looked = 0;
  if (!existsSync(dir)) return { found: false, looked, newest, in24 };
  const days = readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  scan: for (const d of days) {
    const hours = readdirSync(join(dir, d))
      .filter((h) => /^\d{2}$/.test(h))
      .sort()
      .reverse();
    for (const h of hours) {
      if (looked >= maxFolders) break scan;
      // a folder of an hour after this run is none of its business (a clock set back, a hand-made folder)
      if (Date.parse(`${d}T${h}:00:00.000Z`) > at) continue;
      looked++;
      for (const f of readdirSync(join(dir, d, h))) {
        const pool = f.endsWith('.json.gz') ? f.slice(0, -'.json.gz'.length) : '';
        if (!pools.has(pool)) continue;
        if (!newest.has(pool)) newest.set(pool, `${d}T${h}:00:00.000Z`);
        if (looked <= 24) in24.set(pool, (in24.get(pool) ?? 0) + 1);
      }
    }
  }
  return { found: true, looked, newest, in24 };
}

// What the run knows so far, where a failure can still see it: a run that stops says how far it got and for which
// pools.
const state: {
  stage: 'inputs' | 'read' | 'write' | 'row';
  dir: string | null;
  inputs: Record<string, unknown> | null;
  sel: RawSelection | null;
  finished: boolean;
} = { stage: 'inputs', dir: null, inputs: null, sel: null, finished: false };

function failureRow(error: string) {
  return {
    kind: KIND,
    startedAt: new Date(started).toISOString(),
    error,
    stage: state.stage,
    ...(state.inputs ?? {}),
    ...(state.sel ? failedRunPools(state.sel, state.stage) : { pools: null }),
    rpc: { ...rpcStats },
    seconds: { total: (Date.now() - started) / 1000 },
    ...PROVENANCE,
  };
}
// The row is printed first (the job's log), then appended to the job's own file once its folder is known to be its
// own. A run refused its folder, or given none, is in the log only.
function leave(row: object) {
  console.log(JSON.stringify(row));
  if (!state.dir) return;
  try {
    mkdirSync(state.dir, { recursive: true });
    appendFileSync(join(state.dir, 'runs.jsonl'), `${JSON.stringify(row)}\n`);
  } catch (e) {
    console.log(
      JSON.stringify({ kind: KIND, error: `the run's line was not appended: ${say(e)}` }),
    );
    process.exitCode = 1;
  }
}
// launchd ends a job with SIGTERM at logout and shutdown: the run leaves its line and stops
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (!state.finished && !plan) leave(failureRow(`terminated (${signal})`));
    process.exit(1);
  });

async function run() {
  // the folder first: whatever fails after this leaves its line there
  if (!plan) state.dir = ownFolder();

  const reg = await readJson<{
    fetchedAt?: string;
    methodVersion?: string;
    pools: Parameters<typeof selectRawArrayPools>[0];
  }>(join(RISK_HOME, 'registry.json'), 4);
  const cache = await readJson<{
    children: Record<string, string[]>;
    childrenAt?: Record<string, string>;
  }>(join(RISK_HOME, 'cache.json'), 4);
  const skip = new Set((process.env.RISK_RAW_ARRAYS_SKIP ?? '').split(',').filter(Boolean));
  const everyPool = process.env.RISK_RAW_ARRAYS_ALL === '1';
  const tracked = new Set(solanaList.assets.map((a) => a.address));
  const sel = selectRawArrayPools(reg.pools, { tracked, skipExitPaths: skip, everyPool });
  const inputs = {
    registry: { fetchedAt: reg.fetchedAt ?? null, methodVersion: reg.methodVersion ?? null },
    tracked: {
      stocks: tracked.size,
      source: 'scripts/risk/universe/solana.json',
      fetchedAt: solanaList.fetchedAt,
    },
    settings: { everyPool, skipExitPaths: [...skip] },
  };
  if (plan) {
    console.log(
      JSON.stringify({
        kind: 'raw-arrays-plan',
        ...inputs,
        ...planOf(sel, cache.children),
        ...PROVENANCE,
        source: 'the pool collector’s registry.json and cache.json (no chain read)',
      }),
    );
    return;
  }
  const dir = state.dir as string;
  state.inputs = inputs;
  state.sel = sel;
  // the shared rpc() falls back to the public endpoint when this is not set, and says nothing
  if (!process.env.SOLANA_RPC_URL)
    throw new Error('SOLANA_RPC_URL is not set (the installed job reads it from its env file)');

  state.stage = 'read';
  const size = Math.min(100, Math.max(1, Number(process.env.RISK_RAW_ARRAYS_BATCH) || 100));
  const batched = batchedReader(multipleAccounts, {
    size,
    pastDeadline: () => Date.now() - started > READ_BUDGET_MS,
    say,
  });
  const reader = withholdingUndecodable(batched.read, sel.read);
  const capture = await readSplitCapture(
    { direct: sel.read, twoHop: [], listed: null },
    cache.children,
    { twoHop: false, tracked: [], trackedSource: null, registry: inputs.registry },
    {
      read: reader.read,
      // no price is read: a recording is bytes, and whoever reads it prices it
      solUsd: async () => null,
      now: () => new Date(),
      rpcCalls: () => rpcStats.calls,
    },
  );
  // Asked for by hand, for the check: the capture, and beside it what the read knew that a capture does not hold
  // (each account's slot, the accounts no call answered, the pool accounts withheld, when the lists were made). A
  // file that cannot be written, or a place this job may not write, must not cost the run its recordings.
  let captureSaved: { file: string } | { error: string } | null = null;
  const captureFile = process.env.RISK_RAW_ARRAYS_CAPTURE;
  if (captureFile)
    try {
      const refusal = refusalOf(dirname(resolve(captureFile)));
      if (refusal) throw new Error(refusal);
      saveCapture(captureFile, capture);
      writeFileSync(
        `${captureFile}.read.json`,
        JSON.stringify({
          slots: [...batched.slots],
          failed: [...batched.failed],
          undecodable: [...reader.undecodable],
          childrenAt: Object.fromEntries(
            sel.read.flatMap((p) => {
              const t = cache.childrenAt?.[p.address];
              return t ? [[p.address, t]] : [];
            }),
          ),
        }),
      );
      captureSaved = { file: captureFile };
    } catch (e) {
      captureSaved = { error: say(e) };
    }

  state.stage = 'write';
  const outcomes: PoolOutcome[] = poolOutcomes(capture, sel.read, {
    childrenAt: cache.childrenAt,
    undecodable: reader.undecodable,
    slots: batched.slots,
    failed: batched.failed,
  });
  const { day, hour } = hourFolder(capture.fetchedAt);
  const outDir = join(dir, day, hour);
  mkdirSync(outDir, { recursive: true });
  // what a run killed in this hour left half written: its .tmp files, once they are too old to be a run's still going
  for (const f of readdirSync(outDir))
    if (f.endsWith('.tmp') && Date.now() - statSync(join(outDir, f)).mtimeMs > 600_000)
      rmSync(join(outDir, f));
  const bytes = new Map<string, number>();
  const done = outcomes.map((o): PoolOutcome => {
    if (!o.written) return o;
    const file = join(outDir, `${o.pool.address}.json.gz`);
    // written beside and renamed, so a reader never sees half a file; the name is this process's own
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const buf = encodeRecording(o.recording);
      writeFileSync(tmp, buf);
      renameSync(tmp, file);
      bytes.set(o.pool.address, buf.length);
      return o;
    } catch (e) {
      rmSync(tmp, { force: true });
      return { pool: o.pool, written: false, reason: 'write_failed', detail: say(e) };
    }
  });

  state.stage = 'row';
  const summary = runSummary(sel, done, capture, bytes);
  // The collector's pools, read here or not: how long ago it last wrote each, and in how many of its newest 24 hour
  // folders. It writes a pool only in the runs where it lists the pool's arrays again, so these are not all 24.
  const at = Date.parse(capture.fetchedAt);
  let collector: Record<string, unknown>;
  try {
    const seen = collectorFiles(
      join(resolve(RISK_HOME), 'raw'),
      new Set(sel.collector.map((p) => p.address)),
      at,
      72,
    );
    const perPool = sel.collector
      .map((p) => {
        const t = seen.newest.get(p.address);
        return {
          pool: p.address,
          asset: p.assetSymbol,
          // null: no file in the folders looked at
          hoursSinceNewest: t ? Math.floor((at - Date.parse(t)) / 3_600_000) : null,
          filesInNewest24: seen.in24.get(p.address) ?? 0,
        };
      })
      .sort((a, b) => a.filesInNewest24 - b.filesInNewest24);
    collector = {
      rule: 'the Raydium and Orca pools among the pools that hold 80% of registry TVL',
      pools: sel.collector.length,
      readHereToo: everyPool,
      folderFound: seen.found,
      hourFoldersLooked: seen.looked,
      perPool,
    };
  } catch (e) {
    collector = { pools: sel.collector.length, error: say(e) };
  }
  const row = {
    kind: KIND,
    startedAt: new Date(started).toISOString(),
    fetchedAt: capture.fetchedAt,
    folder: outDir,
    ...inputs,
    ...summary,
    collector,
    ...(captureSaved ? { capture: captureSaved } : {}),
    rpc: { ...rpcStats, ...batched.stats, batchSize: size },
    seconds: { read: capture.rpc.seconds, total: (Date.now() - started) / 1000 },
    ...PROVENANCE,
  };
  state.finished = true;
  leave(row);
  // A failed run: a pool in none of the four places, nothing written, or a pool this run itself failed to read or
  // write. A pool the chain or the cache does not have is not a failure of the run.
  const own = new Set(['read_failed', 'read_torn', 'write_failed']);
  if (
    !summary.accounted ||
    !summary.pools.written ||
    summary.notWritten.some((n) => own.has(n.reason ?? ''))
  )
    process.exitCode = 1;
}

try {
  await run();
} catch (e) {
  state.finished = true;
  // a run that stops still leaves its line: in its log, and in its own folder once that folder is known to be its own
  const row = failureRow(say(e));
  if (plan) console.log(JSON.stringify(row));
  else leave(row);
  process.exitCode = 1;
}
