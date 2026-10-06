// `pnpm risk-evm:history [--chain robinhood] [--days 30] [--window 100000]` (PLAN-UNIVERSE RU.14):
// every Swap event of every pool of the cut, the last `--days` days from the chain's head, newest
// window first, into <RISK_EVM_DIR>/history/<chain>/swaps/<pool>/<day>.jsonl. Read-only on the chain,
// no database. A stopped walk resumes from the oldest window it finished (cursor.json); a finished walk
// is not walked again: move the folder aside first. The run's figures go to runs.jsonl and are quoted
// in the plan.
//
//   headers.jsonl   the block headers a swap's time is interpolated from (one every --header-step
//                   blocks), and the exact blocks read to measure that interpolation
//   cursor.json     head, the first block of the span, the oldest block done, and whether it is complete
//   swaps/<pool>/<day>.jsonl   one line per swap; <day>.done once every window of that UTC day is in
import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetList } from '@colosseum/schemas';
import { CHAINS, type ChainConfig, rpcFor } from './config';
import type { CutRow } from './cut';
import {
  blockTime,
  completeDays,
  DEFAULT_HEADER_STEP,
  DEFAULT_WINDOW,
  dayOf,
  errorProbePlan,
  type Header,
  HISTORY_METHOD,
  type HistoryPool,
  historyPools,
  type SwapFilter,
  type SwapRow,
  swapFilters,
  walkSwaps,
} from './history';
import { acquireLock } from './loop';
import { createRpc, type Rpc, type RpcReply } from './rpc';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const LIST_DIR = process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe';
const chainId = option('--chain') ?? 'robinhood';
const chain = CHAINS.find((c) => c.id === chainId);
if (!chain) {
  console.error(`"${chainId}" is not in config.ts`);
  process.exit(1);
}
const days = Number(option('--days') ?? 30);
const window = Number(option('--window') ?? DEFAULT_WINDOW);
const headerStep = Number(option('--header-step') ?? DEFAULT_HEADER_STEP);
/** Requests per second the public endpoint took in RU.2's probe. */
const PAUSE_MS = 1_000;
/** Headers asked in one HTTP request. */
const HEADER_BATCH = 10;
/** One exact block read in every this-many header gaps, to measure the interpolation. */
const PROBE_EVERY = 25;

export type Cursor = {
  chain: string;
  method: string;
  head: number;
  headT: number;
  /** The first block of the span (its time is at most `days` before the head's). */
  from: number;
  fromT: number;
  days: number;
  window: number;
  /** The oldest block whose window is written, and its time; `from` when complete. */
  oldestDone: number;
  oldestDoneT: number;
  complete: boolean;
  pools: number;
  startedAt: string;
  updatedAt: string;
  /** The largest difference seen between an interpolated time and the block's own, in seconds. */
  maxTimeErrorS: number | null;
};

const hex = (n: number) => `0x${n.toString(16)}`;

/** The headers of `blocks`, read in batches; a block the endpoint has no header for stops the run. */
export async function readHeaders(
  rpc: Rpc,
  blocks: number[],
  sleep: (ms: number) => Promise<unknown>,
): Promise<Header[]> {
  const out: Header[] = [];
  for (let i = 0; i < blocks.length; i += HEADER_BATCH) {
    const part = blocks.slice(i, i + HEADER_BATCH);
    const replies: RpcReply[] = await rpc.batch(
      part.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })),
    );
    for (const [k, r] of replies.entries()) {
      const ts = (r.result as { timestamp?: string } | null)?.timestamp;
      if (r.error || !ts)
        throw new Error(`header of block ${part[k]}: ${r.error?.message ?? 'no result'}`);
      out.push({ block: part[k] as number, t: Number(BigInt(ts)) });
    }
    if (i + HEADER_BATCH < blocks.length) await sleep(PAUSE_MS);
  }
  return out;
}

/**
 * The headers of the span, head down to the first block whose time is `days` back, every `step`
 * blocks; and `from`, the first block of the span: the newest header at or before the span's start.
 */
export async function spanHeaders(
  rpc: Rpc,
  head: Header,
  days: number,
  step: number,
  sleep: (ms: number) => Promise<unknown>,
): Promise<{ headers: Header[]; from: Header }> {
  const start = head.t - days * 86_400;
  const got: Header[] = [head];
  let next = head.block - step;
  while ((got.at(-1) as Header).t > start && next >= 0) {
    const blocks: number[] = [];
    for (let k = 0; k < HEADER_BATCH && next >= 0; k++, next -= step) blocks.push(next);
    got.push(...(await readHeaders(rpc, blocks, sleep)));
    await sleep(PAUSE_MS);
  }
  const headers = got.sort((a, b) => a.block - b.block);
  const from = [...headers].reverse().find((h) => h.t <= start) ?? (headers[0] as Header);
  return { headers: headers.filter((h) => h.block >= from.block), from };
}

export type HistoryDeps = {
  rpc: Rpc;
  sleep: (ms: number) => Promise<unknown>;
  log: (event: Record<string, unknown>) => void;
  now: () => Date;
};

type Pending = { rows: SwapRow[]; done: Set<string> };

const jsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

/** One walk of one chain, from the head or from a cursor. Returns the run's figures. */
export async function runHistory(
  deps: HistoryDeps,
  chain: ChainConfig,
  pools: HistoryPool[],
  root: string,
  opts: { days: number; window: number; headerStep: number; probeEvery?: number },
): Promise<Record<string, unknown>> {
  const startedAt = deps.now();
  const cursorFile = join(root, 'cursor.json');
  const headersFile = join(root, 'headers.jsonl');
  mkdirSync(join(root, 'swaps'), { recursive: true });
  const filters: SwapFilter[] = swapFilters(chain, pools);
  const byAddress = new Map(pools.map((p) => [p.address, p]));

  let cursor: Cursor | null = existsSync(cursorFile)
    ? (JSON.parse(readFileSync(cursorFile, 'utf8')) as Cursor)
    : null;
  if (cursor?.complete) {
    deps.log({ event: 'already_complete', head: cursor.head, from: cursor.from });
    return { event: 'already_complete', ...cursor };
  }
  let headers: Header[];
  if (cursor) {
    headers = jsonl<Header & { exact?: boolean }>(headersFile)
      .filter((h) => !h.exact)
      .sort((a, b) => a.block - b.block);
    deps.log({
      event: 'resume',
      head: cursor.head,
      from: cursor.from,
      oldestDone: cursor.oldestDone,
    });
  } else {
    const headBlock = Number(BigInt(await deps.rpc.call<string>('eth_blockNumber', [])));
    const [head] = await readHeaders(deps.rpc, [headBlock], deps.sleep);
    const span = await spanHeaders(
      deps.rpc,
      head as Header,
      opts.days,
      opts.headerStep,
      deps.sleep,
    );
    headers = span.headers;
    // the interpolation measured against the chain: one exact block in every PROBE_EVERY gaps
    const probes = await readHeaders(
      deps.rpc,
      errorProbePlan(headers, opts.probeEvery ?? PROBE_EVERY),
      deps.sleep,
    );
    const errors = probes.map((p) => Math.abs(blockTime(headers, p.block) - p.t));
    writeFileSync(
      headersFile,
      `${[
        ...headers.map((h) => JSON.stringify(h)),
        ...probes.map((p) => JSON.stringify({ ...p, exact: true })),
      ].join('\n')}\n`,
    );
    cursor = {
      chain: chain.id,
      method: HISTORY_METHOD,
      head: (head as Header).block,
      headT: (head as Header).t,
      from: span.from.block,
      fromT: span.from.t,
      days: opts.days,
      window: opts.window,
      oldestDone: (head as Header).block + 1,
      oldestDoneT: (head as Header).t,
      complete: false,
      pools: pools.length,
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      maxTimeErrorS: errors.length ? Math.max(...errors) : null,
    };
    writeFileSync(cursorFile, JSON.stringify(cursor, null, 2));
    deps.log({
      event: 'span',
      head: cursor.head,
      headT: new Date(cursor.headT * 1000).toISOString(),
      from: cursor.from,
      fromT: new Date(cursor.fromT * 1000).toISOString(),
      headers: headers.length,
      probes: probes.length,
      maxTimeErrorS: cursor.maxTimeErrorS,
    });
  }
  const c = cursor as Cursor;
  const doneMarker = JSON.stringify({
    source: `${chain.name} JSON-RPC eth_getLogs (Swap events of Uniswap v3 pools and the v4 pool manager)`,
    method: HISTORY_METHOD,
    provenance: 'live',
    timeMethod: `linear between block headers ${opts.headerStep} blocks apart`,
    maxTimeErrorS: c.maxTimeErrorS,
  });
  const marked = new Set<string>();
  const mark = (oldestDone: number) => {
    for (const day of completeDays(blockTime(headers, oldestDone), c.headT))
      for (const p of pools) {
        const file = join(root, 'swaps', p.address, `${day}.jsonl`);
        const key = `${p.address}/${day}`;
        if (marked.has(key) || !existsSync(file)) continue;
        writeFileSync(file.replace('.jsonl', '.done'), `${doneMarker}\n`);
        marked.add(key);
      }
  };
  if (c.oldestDone <= c.head) mark(c.oldestDone);

  const unknownPools = new Set<string>();
  const result = await walkSwaps(
    deps,
    filters,
    c.from,
    c.oldestDone - 1,
    { window: opts.window, pauseMs: PAUSE_MS },
    (w) => {
      const pending = new Map<string, Pending>();
      for (const r of w.rows) {
        if (!byAddress.has(r.pool)) {
          // a v3 address list and a v4 id list answer only the pools asked; anything else is a surprise
          unknownPools.add(r.pool);
          continue;
        }
        r.t = blockTime(headers, r.block);
        const key = `${r.pool}/${dayOf(r.t)}`;
        let p = pending.get(key);
        if (!p) {
          p = { rows: [], done: new Set() };
          pending.set(key, p);
        }
        p.rows.push(r);
      }
      for (const [key, p] of pending) {
        const [pool, day] = key.split('/') as [string, string];
        mkdirSync(join(root, 'swaps', pool), { recursive: true });
        appendFileSync(
          join(root, 'swaps', pool, `${day}.jsonl`),
          `${p.rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
        );
      }
      c.oldestDone = w.from;
      c.oldestDoneT = blockTime(headers, w.from);
      c.complete = w.from === c.from;
      c.updatedAt = deps.now().toISOString();
      writeFileSync(cursorFile, JSON.stringify(c, null, 2));
      mark(w.from);
    },
  );
  const stats = deps.rpc.stats();
  const summary = {
    event: 'run',
    chain: chain.id,
    method: HISTORY_METHOD,
    head: c.head,
    from: c.from,
    days: opts.days,
    span: {
      from: new Date(c.fromT * 1000).toISOString(),
      to: new Date(c.headT * 1000).toISOString(),
    },
    pools: pools.length,
    ...result,
    unknownPools: [...unknownPools],
    maxTimeErrorS: c.maxTimeErrorS,
    complete: c.complete,
    ...stats,
    durationS: Math.round((deps.now().getTime() - startedAt.getTime()) / 1000),
    startedAt: startedAt.toISOString(),
  };
  deps.log(summary);
  return summary;
}

if (process.argv[1]?.endsWith('history-run.ts')) {
  const listPath = join(LIST_DIR, `${chain.id}.json`);
  if (!existsSync(listPath)) {
    console.error(`${listPath} is absent: run pnpm risk:universe ${chain.id} first`);
    process.exit(1);
  }
  const list = JSON.parse(readFileSync(listPath, 'utf8')) as AssetList;
  const cutName = list.inputs.cut ?? '';
  const cutPath = join(dir, cutName);
  if (!cutName || !existsSync(cutPath)) {
    console.error(`${listPath} was written from ${cutName || 'no cut'}, which is not in ${dir}`);
    process.exit(1);
  }
  const cut = JSON.parse(readFileSync(cutPath, 'utf8')) as { chain: string; pools: CutRow[] };
  const pools = historyPools(cut, chain);
  const root = join(dir, 'history', chain.id);
  mkdirSync(root, { recursive: true });
  const release = acquireLock(join(root, 'run.lock'), 6 * 60 * 60_000);
  if (!release) {
    console.error(`another walk holds ${join(root, 'run.lock')}`);
    process.exit(1);
  }
  const runs = join(root, 'runs.jsonl');
  const log = (e: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...e });
    appendFileSync(runs, `${line}\n`);
    console.log(line);
  };
  const rpc = createRpc(rpcFor(chain).url, { timeoutMs: 120_000 });
  log({ event: 'start', cut: cutName, pools: pools.length, days, window, headerStep });
  try {
    await runHistory(
      { rpc, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log, now: () => new Date() },
      chain,
      pools,
      root,
      { days, window, headerStep },
    );
  } catch (e) {
    log({ event: 'stopped', error: e instanceof Error ? e.message : String(e) });
    release();
    process.exit(1);
  }
  release();
}
