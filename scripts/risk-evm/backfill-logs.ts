// PLAN-ASSETS AS.8, series 1: Robinhood Chain's logs for the whole life of every pool and token of the asset
// list (scripts/risk/assets/robinhood.json): swaps, then Transfer from or to the zero address (supply), then
// liquidity events. Read-only on the public RPC through rpc.ts: a log query the endpoint refuses for its size is
// halved (as history.ts walks), a refusal for rate or a Cloudflare 403 waits and asks again slowly, and nothing
// is asked from minute 1 to minute 14 of an hour (the live loop's minutes, `quietWaitMs`).
//
//   count   the chain's life cut into strata, one 100,000-block window sampled in each, every log of the six
//           filters below fetched and counted by class (a pool of the list, another Uniswap pool, a venue not
//           read), and the total estimated by `extrapolate`; nothing is written but the count file
//   fetch   one window of blocks (and optionally one pool or one token, one kind): compact rows, gzip per
//           subject and UTC day, under <out>/robinhood/<kind>/<subject>/<day>.jsonl.gz, with a manifest per
//           subject (windows covered, rows and bytes per day, the checks); a window already covered is skipped
//
// The pools of the list: every pool the creation logs of RU.2 name (creation-logs-robinhood.json: the v3
// factory's PoolCreated and the v4 manager's Initialize to its scanned block) with a token of the list among its
// two (rows not excluded; the gas coin is the zero address). A pool created after that block is counted as
// `unknown_pool`.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  addToManifest,
  BACKFILL_METHOD_VERSION,
  extrapolate,
  type Manifest,
  type ManifestCheck,
  requestSlot,
  type StratumCount,
  strata,
} from '@colosseum/risk';
import { gzLines } from '../risk/assets/gz-lines';
import {
  type Call,
  decodeAggregate3,
  decodePoolKey,
  encodeAggregate3,
  encodePoolKeys,
  SEL,
  TOPIC,
  words,
  wordToAddress,
} from './abi';
import type { ChainConfig } from './config';
import { allowedSpan, blockWindows, tooManyLogs, ZERO_ADDRESS } from './discovery';
import { blockTime, DEFAULT_HEADER_STEP, type Header, QUERY_TIMED_OUT } from './history';
import { isTransient, type Rpc, type RpcReply } from './rpc';

export const LOG_TOPIC = {
  v3Swap: TOPIC.v3Swap,
  v4Swap: TOPIC.v4Swap,
  // Transfer(address indexed from, address indexed to, uint256 value)  ERC-20
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  // Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128, uint256, uint256)  v3 pool
  v3Mint: '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  // Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128, uint256, uint256)  v3 pool
  v3Burn: '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
  // ModifyLiquidity(bytes32 indexed id, address indexed sender, int24, int24, int256, bytes32)  v4 PoolManager
  v4Modify: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
} as const;
const ZERO_WORD = `0x${'0'.repeat(64)}`;

export type LogKind = 'swaps' | 'supply' | 'liquidity';
export const LOG_KINDS: LogKind[] = ['swaps', 'supply', 'liquidity'];

/** One eth_getLogs filter of the series, and how its logs are filed. */
export type LogFilter = {
  name: string;
  kind: LogKind;
  address?: string | string[];
  topics: Array<string | string[] | null>;
  /** The subject a log is filed under: the pool (v3: the log's address; v4: the id in topic 1) or the token. */
  subjectOf: (log: RawLog) => string;
};
export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

/** The six filters of the series. `tokens`: the ERC-20 tokens of the list (the gas coin has no Transfer). */
export function seriesFilters(
  chain: ChainConfig,
  tokens: string[],
  only?: { kind?: LogKind; subject?: string; subjectKind?: 'cl' | 'v4' | 'token' },
): LogFilter[] {
  const pm = chain.v4?.poolManager;
  if (!pm) throw new Error(`${chain.id}: no v4 pool manager in config.ts`);
  const pool = (l: RawLog) => l.address.toLowerCase();
  const v4id = (l: RawLog) => (l.topics[1] ?? '').toLowerCase();
  const one = only?.subject?.toLowerCase();
  const all: LogFilter[] = [
    {
      name: 'v3_swap',
      kind: 'swaps',
      ...(one && only?.subjectKind === 'cl' ? { address: one } : {}),
      topics: [LOG_TOPIC.v3Swap],
      subjectOf: pool,
    },
    {
      name: 'v4_swap',
      kind: 'swaps',
      address: pm,
      topics: one && only?.subjectKind === 'v4' ? [LOG_TOPIC.v4Swap, one] : [LOG_TOPIC.v4Swap],
      subjectOf: v4id,
    },
    {
      name: 'mint',
      kind: 'supply',
      address: one && only?.subjectKind === 'token' ? one : tokens,
      topics: [LOG_TOPIC.transfer, ZERO_WORD],
      subjectOf: pool,
    },
    {
      name: 'burn',
      kind: 'supply',
      address: one && only?.subjectKind === 'token' ? one : tokens,
      topics: [LOG_TOPIC.transfer, null, ZERO_WORD],
      subjectOf: pool,
    },
    {
      name: 'v3_liquidity',
      kind: 'liquidity',
      ...(one && only?.subjectKind === 'cl' ? { address: one } : {}),
      topics: [[LOG_TOPIC.v3Mint, LOG_TOPIC.v3Burn]],
      subjectOf: pool,
    },
    {
      name: 'v4_liquidity',
      kind: 'liquidity',
      address: pm,
      topics: one && only?.subjectKind === 'v4' ? [LOG_TOPIC.v4Modify, one] : [LOG_TOPIC.v4Modify],
      subjectOf: v4id,
    },
  ];
  return all.filter((f) => {
    if (only?.kind && f.kind !== only.kind) return false;
    if (!one) return true;
    if (only?.subjectKind === 'token') return f.kind === 'supply';
    if (only?.subjectKind === 'cl') return f.name.startsWith('v3_');
    return f.name.startsWith('v4_');
  });
}

/** One log as a compact row: what the chain logged, no decoding beyond the place and the subject. */
export type LogRow = {
  kind: LogKind;
  filter: string;
  subject: string;
  block: number;
  logIndex: number;
  tx: string;
  /** Unix seconds, linear between headers; 0 in a count (no headers read). */
  t: number;
  address: string;
  topics: string[];
  data: string;
};

export const toRow = (f: LogFilter, l: RawLog, t: number): LogRow => ({
  kind: f.kind,
  filter: f.name,
  subject: f.subjectOf(l),
  block: Number(BigInt(l.blockNumber)),
  logIndex: Number(BigInt(l.logIndex)),
  tx: l.transactionHash,
  t,
  address: l.address.toLowerCase(),
  topics: l.topics,
  data: l.data,
});

// ---------------------------------------------------------------------------------------------------------------
// Asking the endpoint

export type Deps = {
  rpc: Rpc;
  /**
   * A client whose requests time out after `timeoutMs` and are never retried by the client itself, so every
   * retry passes through `ask` and its check of the loop's minutes. Without it, `rpc` (a replay in tests).
   */
  rpcFor?: (timeoutMs: number) => Rpc;
  sleep: (ms: number) => Promise<unknown>;
  now: () => Date;
  log: (e: Record<string, unknown>) => void;
  /** False on an endpoint the live loop does not share: its minutes 1 to 14 are not waited out. */
  quietMinutes?: boolean;
};
/** The longest a request may take; less when the loop's minutes are closer. */
export const MAX_REQUEST_MS = 120_000;
/** Waits before asking again: rate, an outage, a 403 from the endpoint's Cloudflare (slowly). */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 300_000, 600_000, 600_000];
export const PAUSE_MS = 1_000;
const hex = (n: number) => `0x${n.toString(16)}`;

/** One request, after the live loop's minutes; an unreachable endpoint or a 403 waits and asks again. */
export async function ask(
  deps: Deps,
  req: { method: string; params: unknown[] },
): Promise<RpcReply> {
  for (let attempt = 0; ; attempt++) {
    // checked before every try: the first and each retry after a wait
    const slot =
      deps.quietMinutes === false
        ? { waitMs: 0, timeoutMs: MAX_REQUEST_MS }
        : requestSlot(deps.now(), MAX_REQUEST_MS);
    if (slot.waitMs > 0) {
      deps.log({ event: 'quiet', waitS: Math.round(slot.waitMs / 1000) });
      await deps.sleep(slot.waitMs);
    }
    const rpc = deps.rpcFor ? deps.rpcFor(slot.timeoutMs) : deps.rpc;
    try {
      const [r] = await rpc.batch([req]);
      if (r && isTransient(r)) throw new Error(r.error?.message ?? 'refused for rate');
      return r ?? { error: { message: 'no reply' } };
    } catch (e) {
      // a stop by the budget or a cost cap ends the run cleanly: never waited out and asked again
      if (e instanceof Error && e.name === 'BudgetStop') throw e;
      const wait = BACKOFF_MS[attempt];
      if (wait === undefined) throw e;
      deps.log({
        event: 'backoff',
        attempt: attempt + 1,
        waitS: wait / 1000,
        error: e instanceof Error ? e.message : String(e),
      });
      await deps.sleep(wait);
    }
  }
}

/** The span the endpoint allowed each filter, once it said (a filter without an address: 30,000 blocks). */
const allowedSpans = new Map<string, number>();

/** Every log of a filter between two blocks; a window refused for its size is halved until it answers. */
export async function logsOf(
  deps: Deps,
  f: LogFilter,
  from: number,
  to: number,
): Promise<{ logs: RawLog[]; queries: number; halvings: number; replyBytes: number }> {
  const known = allowedSpans.get(f.name);
  const jobs: Array<[number, number]> = known
    ? blockWindows(from, to, known).reverse()
    : [[from, to]];
  const logs: RawLog[] = [];
  let queries = 0;
  let halvings = 0;
  let replyBytes = 0;
  while (jobs.length) {
    const [a, b] = jobs.pop() as [number, number];
    queries++;
    const r = await ask(deps, {
      method: 'eth_getLogs',
      params: [
        {
          ...(f.address ? { address: f.address } : {}),
          topics: f.topics,
          fromBlock: hex(a),
          toBlock: hex(b),
        },
      ],
    });
    if (r.error || !Array.isArray(r.result)) {
      const m = r.error?.message ?? 'no result';
      // a filter without an address may span fewer blocks ("only 30000 are allowed", 2026-10-11): cut to that
      const span = allowedSpan(m);
      if (span && span < b - a + 1) {
        allowedSpans.set(f.name, span);
        const parts = blockWindows(a, b, span);
        for (const w of parts.reverse()) jobs.push(w);
        await deps.sleep(PAUSE_MS);
        continue;
      }
      // Alchemy answers some large windows with a bare "Internal error": halved like a window too large
      if ((tooManyLogs(m) || QUERY_TIMED_OUT.test(m) || /internal error/i.test(m)) && b > a) {
        const mid = a + Math.floor((b - a) / 2);
        jobs.push([mid + 1, b], [a, mid]);
        halvings++;
        await deps.sleep(PAUSE_MS);
        continue;
      }
      throw new Error(`eth_getLogs ${f.name} ${a}..${b} refused: ${m}`);
    }
    replyBytes += JSON.stringify(r.result).length;
    logs.push(...(r.result as RawLog[]));
    await deps.sleep(PAUSE_MS);
  }
  return { logs, queries, halvings, replyBytes };
}

// ---------------------------------------------------------------------------------------------------------------
// The list's pools and tokens

export type Created = {
  kind: 'cl' | 'v4';
  id: string;
  token0: string;
  token1: string;
  block: number;
};
/**
 * `list_pool`: a token of the list on either side. `other_pool`: a Uniswap pool of two other tokens.
 * `other_venue`: a contract that logs the v3 Swap but whose factory is not Uniswap's (D4: not read).
 * `unknown_pool`: neither the creation logs nor the chain said (kept, as possibly the list's).
 */
export type PoolClass = 'list_pool' | 'other_pool' | 'other_venue' | 'unknown_pool';

/** Pools of the list: a pool the creation logs name with a token of the list on either side. */
export function classifyPools(created: Created[], listTokens: Set<string>) {
  const cls = new Map<string, 'list_pool' | 'other_pool'>();
  let firstBlock = Number.POSITIVE_INFINITY;
  for (const c of created) {
    const inList = listTokens.has(c.token0.toLowerCase()) || listTokens.has(c.token1.toLowerCase());
    cls.set(c.id.toLowerCase(), inList ? 'list_pool' : 'other_pool');
    if (inList) firstBlock = Math.min(firstBlock, c.block);
  }
  return {
    classOf: (subject: string): PoolClass => cls.get(subject.toLowerCase()) ?? 'unknown_pool',
    listPools: [...cls.values()].filter((v) => v === 'list_pool').length,
    firstBlock,
  };
}

/**
 * The creation logs of RU.2 hold only the pools with a stock token of the registry; any other subject a log
 * names is asked of the chain once: token0(), token1() and factory() of a v3-style contract, poolKeys() of the
 * v4 position manager for a v4 id, through Multicall3 at the head. Its class is then that of its tokens.
 */
export class PoolResolver {
  private cache = new Map<string, PoolClass>();
  calls = 0;
  constructor(
    private chain: ChainConfig,
    private listTokens: Set<string>,
    private created: (subject: string) => PoolClass,
  ) {}
  classOf(subject: string): PoolClass {
    const k = subject.toLowerCase();
    const c = this.created(k);
    return c !== 'unknown_pool' ? c : (this.cache.get(k) ?? 'unknown_pool');
  }
  async resolve(
    deps: Deps,
    rows: Array<Pick<LogRow, 'subject' | 'filter' | 'kind'>>,
  ): Promise<void> {
    const want = new Map<string, 'cl' | 'v4'>();
    for (const r of rows) {
      if (r.kind === 'supply') continue;
      const k = r.subject.toLowerCase();
      if (this.created(k) !== 'unknown_pool' || this.cache.has(k)) continue;
      want.set(k, r.filter.startsWith('v4_') ? 'v4' : 'cl');
    }
    if (!want.size) return;
    const got = await poolTokensOf(deps, this.chain, [...want.entries()]);
    this.calls += got.requests;
    const inList = (a: string) => this.listTokens.has(a.toLowerCase());
    for (const [k, t] of got.pools)
      this.cache.set(
        k,
        t.token0 === null || t.token1 === null || (t.kind === 'cl' && t.uniswap === null)
          ? 'unknown_pool'
          : t.kind === 'cl' && !t.uniswap
            ? 'other_venue'
            : inList(t.token0) || inList(t.token1)
              ? 'list_pool'
              : 'other_pool',
      );
  }
}

/** What the chain says of a pool the creation logs do not name. Null tokens: the chain did not say. */
export type PoolTokens = {
  kind: 'cl' | 'v4';
  token0: string | null;
  token1: string | null;
  /** v3-style: factory() is one of the chain's Uniswap v3 factories (D4: another venue is not read). */
  uniswap: boolean | null;
  factory?: string | null;
  fee?: number;
  tickSpacing?: number;
  hooks?: string;
};

/**
 * token0(), token1() and factory() of each v3-style contract, poolKeys(id) of the v4 position manager for each v4
 * id, through Multicall3 at the head, 400 calls a request (PoolResolver's reads, with the tokens kept).
 */
export async function poolTokensOf(
  deps: Deps,
  chain: ChainConfig,
  subjects: Array<[string, 'cl' | 'v4']>,
): Promise<{ pools: Map<string, PoolTokens>; requests: number }> {
  const pools = new Map<string, PoolTokens>();
  if (!subjects.length) return { pools, requests: 0 };
  const pm = chain.v4?.positionManager as string;
  const uni = new Set(chain.clFactories.map((f) => f.address.toLowerCase()));
  const calls: Call[] = subjects.flatMap(([k, kind]) =>
    kind === 'v4'
      ? [{ target: pm, callData: encodePoolKeys(k) }]
      : [SEL.token0, SEL.token1, SEL.factory].map((sel) => ({ target: k, callData: `0x${sel}` })),
  );
  const replies: Array<{ success: boolean; data: string }> = [];
  let requests = 0;
  for (let i = 0; i < calls.length; i += 400) {
    const part = calls.slice(i, i + 400);
    const r = await ask(deps, {
      method: 'eth_call',
      params: [{ to: chain.multicall3, data: encodeAggregate3(part) }, 'latest'],
    });
    requests++;
    if (r.error || typeof r.result !== 'string')
      throw new Error(`multicall: ${r.error?.message ?? 'no result'}`);
    const got = decodeAggregate3(r.result);
    if (got.length !== part.length)
      throw new Error(`multicall: ${part.length} calls, ${got.length} answers`);
    replies.push(...got);
    await deps.sleep(PAUSE_MS);
  }
  const addr = (x: { success: boolean; data: string } | undefined) =>
    x?.success && x.data.length >= 66 ? wordToAddress(words(x.data)[0] as bigint) : null;
  let at = 0;
  for (const [k, kind] of subjects) {
    if (kind === 'v4') {
      const x = replies[at++];
      let t: PoolTokens = { kind, token0: null, token1: null, uniswap: null };
      if (x?.success && x.data.length === 2 + 5 * 64) {
        const key = decodePoolKey(x.data);
        // a pool the position manager never saw answers zeros
        if (key.tickSpacing !== 0)
          t = {
            kind,
            token0: key.currency0.toLowerCase(),
            token1: key.currency1.toLowerCase(),
            uniswap: true,
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            hooks: key.hooks.toLowerCase(),
          };
      }
      pools.set(k, t);
    } else {
      const [t0, t1, f] = [addr(replies[at]), addr(replies[at + 1]), addr(replies[at + 2])];
      at += 3;
      pools.set(k, {
        kind,
        token0: t0?.toLowerCase() ?? null,
        token1: t1?.toLowerCase() ?? null,
        uniswap: f ? uni.has(f.toLowerCase()) : null,
        factory: f?.toLowerCase() ?? null,
      });
    }
  }
  return { pools, requests };
}

// ---------------------------------------------------------------------------------------------------------------
// count

export type CountInput = {
  chain: ChainConfig;
  filters: LogFilter[];
  resolver: PoolResolver;
  tokens: Set<string>;
  from: number;
  head: number;
  strata: number;
  window: number;
};

/** The sampled count: per stratum, each filter's logs by class, their bytes as compact rows and gzipped. */
export async function countLogs(deps: Deps, inp: CountInput) {
  const st = strata(inp.from, inp.head, inp.strata, inp.window);
  const samples: StratumCount[] = [];
  const t0 = deps.now().getTime();
  let queries = 0;
  let halvings = 0;
  let replyBytes = 0;
  let logsSeen = 0;
  let rpcMs = 0;
  for (const s of st) {
    const counts: Record<string, number> = {};
    let rowBytes = 0;
    let gzBytes = 0;
    for (const f of inp.filters) {
      const a = deps.now().getTime();
      const got = await logsOf(deps, f, s.sample[0], s.sample[1]);
      rpcMs += deps.now().getTime() - a;
      queries += got.queries;
      halvings += got.halvings;
      replyBytes += got.replyBytes;
      logsSeen += got.logs.length;
      const rows = got.logs.map((l) => toRow(f, l, 0));
      await inp.resolver.resolve(deps, rows);
      for (const r of rows) {
        const c =
          f.kind === 'supply'
            ? inp.tokens.has(r.subject)
              ? 'list_token'
              : 'other_token'
            : inp.resolver.classOf(r.subject);
        const k = `${f.name}:${c}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
      // the bytes the fetch would write for this filter's rows of the list: gzip of the JSONL
      const keep = rows.filter((r) =>
        f.kind === 'supply'
          ? inp.tokens.has(r.subject)
          : ['list_pool', 'unknown_pool'].includes(inp.resolver.classOf(r.subject)),
      );
      const text = keep.map((r) => JSON.stringify(r)).join('\n');
      rowBytes += text.length;
      gzBytes += text.length ? gzipSync(text).length : 0;
      counts[`${f.name}:rowBytes`] = (counts[`${f.name}:rowBytes`] ?? 0) + text.length;
      counts[`${f.name}:gzBytes`] =
        (counts[`${f.name}:gzBytes`] ?? 0) + (text.length ? gzipSync(text).length : 0);
    }
    samples.push({ stratum: s, counts, bytes: gzBytes });
    deps.log({
      event: 'stratum',
      from: s.sample[0],
      to: s.sample[1],
      counts,
      rowBytes,
      gzBytes,
    });
  }
  const est = extrapolate(samples);
  return {
    strata: st.length,
    window: inp.window,
    span: { from: inp.from, head: inp.head },
    estimate: est,
    measured: {
      queries,
      halvings,
      replyBytes,
      logsSeen,
      seconds: (deps.now().getTime() - t0) / 1000,
      rpcSeconds: rpcMs / 1000,
      logsPerSecond: logsSeen / Math.max(1, rpcMs / 1000),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// fetch

/** Headers every `step` blocks over [from, to] and both ends, for the rows' times. */
export async function windowHeaders(
  deps: Deps,
  from: number,
  to: number,
  step = DEFAULT_HEADER_STEP,
) {
  const blocks = [...new Set([from, ...blockWindows(from, to, step).map(([a]) => a), to])].sort(
    (a, b) => a - b,
  );
  const out: Header[] = [];
  for (let i = 0; i < blocks.length; i += 10) {
    const part = blocks.slice(i, i + 10);
    for (const b of part) {
      const r = await ask(deps, { method: 'eth_getBlockByNumber', params: [hex(b), false] });
      const ts = (r.result as { timestamp?: string } | null)?.timestamp;
      if (r.error || !ts)
        throw new Error(`header of block ${b}: ${r.error?.message ?? 'no result'}`);
      out.push({ block: b, t: Number(BigInt(ts)) });
    }
    await deps.sleep(PAUSE_MS);
  }
  return out;
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export type FetchInput = {
  out: string;
  filters: LogFilter[];
  /** Whose logs the filters ask for: `*` for the list's every pool and token, else the one subject's address. */
  scope: string;
  from: number;
  to: number;
  window: number;
  /** Keep a row of a pool or token outside the list? Only for a subject named on the command line. */
  keep: (r: LogRow) => boolean;
  /** Called with a piece's rows before `keep` (the resolver asks the chain about pools it does not know). */
  prepare?: (rows: LogRow[]) => Promise<void>;
  /**
   * Called before the first piece and after every piece with what the run has written and the most one piece
   * wrote; it throws (BudgetStop) to end the fetch there, with everything written so far recorded.
   */
  guard?: (p: { nextBytes: number; writtenBytes: number }) => void;
  source: string;
};

type Range = { from: number; to: number };
/** What a fetch has asked, per filter and scope (`v4_swap:*`, `v4_swap:0x6444…`), merged. */
export type Fetched = { version: 2; covered: Record<string, Range[]> };

/** [a, b] less the ranges already covered, in order. */
export function uncovered(a: number, b: number, covered: Range[]): Range[] {
  const out: Range[] = [];
  let at = a;
  for (const c of [...covered].sort((x, y) => x.from - y.from)) {
    if (c.to < at || c.from > b) continue;
    if (c.from > at) out.push({ from: at, to: Math.min(b, c.from - 1) });
    at = Math.max(at, c.to + 1);
    if (at > b) break;
  }
  if (at <= b) out.push({ from: at, to: b });
  return out;
}
const mergeRanges = (rs: Range[], add: Range): Range[] => {
  const all = [...rs, add].sort((x, y) => x.from - y.from);
  const out: Range[] = [];
  for (const r of all) {
    const last = out.at(-1);
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
};

/** The fetch record of a folder; a record of the first form (whole pieces by filter names) is not trusted. */
export function readFetched(path: string): Fetched {
  if (!existsSync(path)) return { version: 2, covered: {} };
  const j = JSON.parse(readFileSync(path, 'utf8')) as Fetched | unknown[];
  return Array.isArray(j) ? { version: 2, covered: {} } : j;
}

/**
 * One window of the series, newest piece first: each 100,000-block piece asked of every filter for the blocks
 * not yet covered for that filter (by this scope, or by the list-wide `*`), its rows timed from the headers and
 * appended gzipped to <out>/<kind>/<subject>/<day>.jsonl.gz, a row already in the day file (by block and log
 * index) dropped, and the piece added to each filter's record and each subject's manifest. Resuming, or
 * fetching a range a narrower or wider fetch already took, asks and writes nothing twice.
 */
export async function fetchLogs(deps: Deps, inp: FetchInput) {
  const t0 = deps.now().getTime();
  const pieces = blockWindows(inp.from, inp.to, inp.window).reverse();
  const stats = {
    pieces: 0,
    skipped: 0,
    rows: 0,
    duplicatesDropped: 0,
    gzBytes: 0,
    rowBytes: 0,
    queries: 0,
    halvings: 0,
  };
  const manifests = new Map<string, Manifest>();
  const manifestPath = (kind: string, subject: string) =>
    join(inp.out, kind, subject, 'manifest.json');
  const load = (kind: LogKind, subject: string): Manifest => {
    const key = `${kind}/${subject}`;
    const have = manifests.get(key);
    if (have) return have;
    const p = manifestPath(kind, subject);
    const m: Manifest = existsSync(p)
      ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest)
      : {
          series: 'robinhood-logs',
          chain: 'robinhood',
          subject,
          methodVersion: BACKFILL_METHOD_VERSION,
          source: inp.source,
          provenance: 'live',
          covered: [],
          days: {},
          rows: 0,
          bytes: 0,
          checks: [],
          updatedAt: deps.now().toISOString(),
        };
    manifests.set(key, m);
    return m;
  };
  // the (block, log index) of every row a day file holds, read once when a piece first extends it
  const keysOf = new Map<string, Set<number>>();
  const keysIn = (file: string) => {
    let k = keysOf.get(file);
    if (k) return k;
    k = new Set<number>();
    if (existsSync(file)) for (const l of gzLines(readFileSync(file))) k.add(rowKey(l));
    keysOf.set(file, k);
    return k;
  };
  const fetchedPath = join(inp.out, 'fetched.json');
  const fetched = readFetched(fetchedPath);
  const coveredFor = (f: LogFilter) => [
    ...(fetched.covered[`${f.name}:*`] ?? []),
    ...(inp.scope === '*' ? [] : (fetched.covered[`${f.name}:${inp.scope}`] ?? [])),
  ];
  let largest = 0;
  inp.guard?.({ nextBytes: 0, writtenBytes: 0 });
  for (const [a, b] of pieces) {
    const asks = inp.filters
      .map((f) => ({ f, ranges: uncovered(a, b, coveredFor(f)) }))
      .filter((x) => x.ranges.length);
    if (!asks.length) {
      stats.skipped++;
      continue;
    }
    const headers = await windowHeaders(deps, a, b);
    const bySubject = new Map<string, LogRow[]>();
    for (const { f, ranges } of asks)
      for (const r0 of ranges) {
        const got = await logsOf(deps, f, r0.from, r0.to);
        stats.queries += got.queries;
        stats.halvings += got.halvings;
        const all = got.logs.map((l) =>
          toRow(f, l, blockTime(headers, Number(BigInt(l.blockNumber)))),
        );
        if (inp.prepare) await inp.prepare(all);
        for (const r of all) {
          if (!inp.keep(r)) continue;
          const k = `${r.kind}/${r.subject}`;
          const list = bySubject.get(k) ?? [];
          list.push(r);
          bySubject.set(k, list);
        }
      }
    const at = deps.now().toISOString();
    let pieceBytes = 0;
    for (const [k, rows] of bySubject) {
      const [kind, subject] = k.split('/') as [LogKind, string];
      rows.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
      const dir = join(inp.out, kind, subject);
      mkdirSync(dir, { recursive: true });
      const days: Record<string, { rows: number; bytes: number }> = {};
      const byDay = new Map<string, LogRow[]>();
      for (const r of rows) byDay.set(dayOf(r.t), [...(byDay.get(dayOf(r.t)) ?? []), r]);
      const m = load(kind, subject);
      let dropped = 0;
      for (const [d, rs] of byDay) {
        const file = join(dir, `${d}.jsonl.gz`);
        const have = keysIn(file);
        const fresh = rs.filter((r) => {
          const key = r.block * 1_000_000 + r.logIndex;
          if (have.has(key)) return false;
          have.add(key);
          return true;
        });
        dropped += rs.length - fresh.length;
        if (!fresh.length) continue;
        const text = `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`;
        const gz = gzipSync(text);
        // a gzip file may hold several members: each piece is appended as its own
        writeFileSync(file, gz, { flag: 'a' });
        days[d] = { rows: have.size, bytes: statSync(file).size };
        stats.rows += fresh.length;
        stats.gzBytes += gz.length;
        stats.rowBytes += text.length;
        pieceBytes += gz.length;
      }
      stats.duplicatesDropped += dropped;
      const checks: ManifestCheck[] = [
        {
          name: 'one_row_per_log',
          passed: true,
          detail: `a (block, log index) is written once: ${dropped} already in the day files dropped from the last piece`,
        },
        {
          name: 'times_inside_headers',
          passed: rows.every((r) => r.t > 0),
          detail: `block times linear between headers every ${DEFAULT_HEADER_STEP} blocks`,
        },
      ];
      const next = addToManifest(m, { from: a, to: b, unit: 'block' }, days, checks, at);
      manifests.set(k, next);
      writeFileSync(manifestPath(kind, subject), `${JSON.stringify(next, null, 1)}\n`);
    }
    for (const { f } of asks) {
      const key = `${f.name}:${inp.scope}`;
      fetched.covered[key] = mergeRanges(fetched.covered[key] ?? [], { from: a, to: b });
    }
    mkdirSync(inp.out, { recursive: true });
    writeFileSync(fetchedPath, JSON.stringify(fetched));
    stats.pieces++;
    largest = Math.max(largest, pieceBytes);
    deps.log({ event: 'piece', from: a, to: b, subjects: bySubject.size, rows: stats.rows });
    inp.guard?.({ nextBytes: largest, writtenBytes: stats.gzBytes });
  }
  const seconds = (deps.now().getTime() - t0) / 1000;
  return { ...stats, seconds, rowsPerSecond: stats.rows / Math.max(1, seconds) };
}

/** The topics of a Transfer: from, to; the value is the data word. */
export const transferParties = (topics: string[], data: string) => ({
  from: wordToAddress(BigInt(topics[1] ?? ZERO_WORD)),
  to: wordToAddress(BigInt(topics[2] ?? ZERO_WORD)),
  value: (words(data)[0] ?? 0n).toString(),
});
export { gzLines, ZERO_ADDRESS };

/** The key a log row is written once under: its block and log index. */
const rowKey = (line: string) => {
  const r = JSON.parse(line) as { block: number; logIndex: number };
  return r.block * 1_000_000 + r.logIndex;
};
