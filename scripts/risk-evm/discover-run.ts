// One discovery pass for one chain (PLAN-UNIVERSE RU.2): every pool of every token of the universe
// file, from the creation events, DexScreener and the factory asked directly, each confirmed on chain,
// with the money it holds. Read-only: eth_getLogs, eth_call and public GETs. The hourly collector
// reads nothing this writes.
import {
  type Call,
  decodeLiquidityNet,
  decodePoolKey,
  decodeSqrtPrice,
  decodeTick,
  decodeUint,
  encodeBalanceOf,
  encodeGetLiquidity,
  encodeGetSlot0,
  encodePoolKeys,
  intWord,
  SEL,
  wordToAddress,
} from './abi';
import type { ChainConfig } from './config';
import {
  type Answer,
  allowedSpan,
  amountsInBand,
  bandTicks,
  bitmapWords,
  blockWindows,
  type Candidate,
  CL_SELF_READS,
  type Created,
  creationFilters,
  DISCOVERY_METHOD,
  type DollarPool,
  decodeV3Created,
  decodeV4Created,
  dexPools,
  fileUnder,
  fillFromSelf,
  gapsFor,
  getPoolCalls,
  getPoolFactories,
  isIdle,
  type LogFilter,
  mergeCandidates,
  money,
  type PoolRow,
  type PoolState,
  type Price,
  poolOf,
  priceFromDollarPools,
  type RawLog,
  reach,
  summarize,
  type TokenSummary,
  ticksOfWord,
  tooManyLogs,
  venueOf,
  ZERO_ADDRESS,
} from './discovery';
import { MULTICALL_CHUNK, multicall } from './multicall';
import type { DexPair } from './pools';
import type { UniverseToken } from './registry';
import type { Rpc, RpcReply } from './rpc';
import { isBlockGone } from './run';

const DEXSCREENER = 'https://api.dexscreener.com/token-pairs/v1';
/** DexScreener returns at most this many pairs per token; at the cap, more may exist. */
export const DEXSCREENER_CAP = 30;
/** State is read at one block for as long as this; the public RPC drops a block's state within minutes. */
const PIN_MAX_AGE_MS = 45_000;
const MAX_REPINS = 3;
/** getLiquidity is one storage read: many fit in one eth_call. */
const LIQUIDITY_CHUNK = 1_000;
/** A pool whose band spans more bitmap words, or holds more initialized ticks, than this is not walked. */
const MAX_BITMAP_WORDS = 64;
const MAX_TICKS_PER_POOL = 900;

const lower = (a: string) => a.toLowerCase();

export type LogCache = {
  chainId: number;
  /** Lower-case addresses the scan filtered on, sorted. A token outside it means scanning again. */
  tokens: string[];
  fromBlock: number;
  scannedTo: number;
  created: Created[];
};

export type LogsProbe = {
  /** The blocks asked for in one query: the whole scan. */
  span: { fromBlock: number; toBlock: number };
  /** That one query, with the token filter: the pools of every token, whichever side they are on. */
  filtered: { tokens: number; ok: boolean; answer: string };
  /** The span the endpoint then allowed for the filtered query, and whether a query of that span passed. */
  window: number | null;
  windowQuery: { ok: boolean; answer: string } | null;
  usable: boolean;
};

export type DiscoverDeps = {
  rpc: Rpc;
  /** A public GET returning JSON; throws on a failure. */
  fetchJson: (url: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  log: (event: Record<string, unknown>) => void;
};

export type DiscoverOptions = {
  tokens: UniverseToken[];
  universe: { file: string; fetchedAt: string };
  rpcLabel: string;
  /** Half-width of the band a v4 pool's positions are read in, as a share (0.5 = price / 1.5 to price × 1.5). */
  band: number;
  /** A dollar pool prices its token only if it holds at least this many dollars. */
  minRefUsd: number;
  /** The other token of a pool is priced only where the pool's stock side is worth at least this. */
  minSideUsd: number;
  /** First block of the log scan. */
  fromBlock: number;
  /** 'off' skips the events and takes the fallback, as when the endpoint refuses them. */
  logs: 'auto' | 'off';
  logCache: LogCache | null;
  /** eth_getLogs queries per HTTP request, and the wait between requests. */
  logBatch: number;
  logPauseMs: number;
  dexPauseMs: number;
};

export type DiscoveryFile = {
  chain: string;
  chainId: number;
  provenance: 'live';
  source: string;
  method: string;
  /** Time of the last block state was read at. Each pool row carries its own block and time. */
  fetchedAt: string;
  blocks: { logsFrom: number | null; logsTo: number | null; stateFirst: number; stateLast: number };
  universe: { file: string; fetchedAt: string; tokens: number; confirmed: number };
  params: { band: number; minRefUsd: number; minSideUsd: number };
  logsProbe: LogsProbe | null;
  sources: {
    creationEvents: {
      used: boolean;
      complete: boolean;
      v3Pools: number;
      v4Pools: number;
      queries: number;
    };
    dexscreener: { asked: number; failed: string[]; atCap: number; pools: number };
    factoryGetPool: { calls: number; found: number; notSeenElsewhere: number };
  };
  counts: {
    tokens: number;
    withPools: number;
    noPool: number;
    notConfirmed: number;
    pools: number;
    reachable: number;
    tvlMeasured: number;
    tvlNull: number;
    idleNotListed: number;
    twoStockPools: number;
  };
  /** How the band estimate compares with measured balances, on the v3 dollar pools of the floor or more. */
  bandCheck: { pools: number; medianRatio: number | null; p10: number | null; p90: number | null };
  prices: Array<Price & { symbol: string | null }>;
  rpc: {
    rpcCalls: number;
    httpRequests: number;
    seconds: number;
    steps: Array<{ step: string; rpcCalls: number; httpRequests: number; seconds: number }>;
  };
  tokens: TokenSummary[];
  pools: PoolRow[];
};

type Pin = { tag: string; number: number; time: string; at: number };

const answerOf = (r: RpcReply | undefined): { ok: boolean; answer: string } =>
  r?.error || r?.result === undefined
    ? { ok: false, answer: r?.error?.message ?? 'no result' }
    : { ok: true, answer: `${(r.result as unknown[]).length} logs` };

const hex = (n: number) => `0x${n.toString(16)}`;
const logQuery = (f: LogFilter, from: number, to: number) => ({
  method: 'eth_getLogs',
  params: [{ address: f.address, topics: f.topics, fromBlock: hex(from), toBlock: hex(to) }],
});

/**
 * What the endpoint allows for the creation events (the plan's "probe first"): the whole scan in one
 * query with the token filter, then a query of the span its refusal names. The answer to the same
 * question with no token filter is in fixtures/risk-evm/robinhood-discovery.json and the README; it
 * is not asked here, because where it is allowed it returns every pool of the chain.
 */
export async function probeLogs(
  rpc: Rpc,
  filters: LogFilter[],
  tokens: number,
  fromBlock: number,
  head: number,
): Promise<LogsProbe> {
  const f = filters.find((x) => x.kind === 'v4') ?? filters[0];
  if (!f)
    return {
      span: { fromBlock, toBlock: head },
      filtered: { tokens, ok: false, answer: 'no contract to ask' },
      window: null,
      windowQuery: null,
      usable: false,
    };
  const [filtered] = await rpc.batch([logQuery(f, fromBlock, head)]);
  const fl = answerOf(filtered);
  const life = head - fromBlock + 1;
  // a refusal for the number of logs is handled by narrowing; one for the span names the span allowed
  const window = fl.ok || tooManyLogs(fl.answer) ? life : allowedSpan(fl.answer);
  let windowQuery: LogsProbe['windowQuery'] = null;
  if (window !== null && !fl.ok) {
    const span = Math.min(window, life);
    const [r] = await rpc.batch([logQuery(f, head - span + 1, head)]);
    windowQuery = answerOf(r);
  }
  return {
    span: { fromBlock, toBlock: head },
    filtered: { tokens, ...fl },
    window,
    windowQuery,
    usable:
      window !== null && (fl.ok || windowQuery?.ok === true || tooManyLogs(windowQuery?.answer)),
  };
}

/** Every creation event of the filters between two blocks. A window refused for its size is halved. */
export async function scanCreated(
  deps: DiscoverDeps,
  filters: LogFilter[],
  from: number,
  to: number,
  window: number,
  opts: { batch: number; pauseMs: number },
): Promise<{ created: Created[]; queries: number }> {
  const jobs = filters.flatMap((f) =>
    blockWindows(from, to, window).map(([a, b]) => ({ f, a, b })),
  );
  const created: Created[] = [];
  let queries = 0;
  while (jobs.length) {
    const part = jobs.splice(0, opts.batch);
    queries += part.length;
    const replies = await deps.rpc.batch(part.map((j) => logQuery(j.f, j.a, j.b)));
    for (const [i, j] of part.entries()) {
      const r = replies[i];
      if (r?.error || !Array.isArray(r?.result)) {
        const message = r?.error?.message ?? 'no result';
        if (tooManyLogs(message) && j.b > j.a) {
          const mid = j.a + Math.floor((j.b - j.a) / 2);
          jobs.push({ f: j.f, a: j.a, b: mid }, { f: j.f, a: mid + 1, b: j.b });
          continue;
        }
        throw new Error(`eth_getLogs ${j.a}..${j.b} refused: ${message}`);
      }
      for (const l of r.result as RawLog[])
        created.push(j.f.kind === 'v4' ? decodeV4Created(l) : decodeV3Created(l));
    }
    if (queries % (opts.batch * 50) === 0)
      deps.log({ event: 'log_scan', queries, left: jobs.length, pools: created.length });
    if (jobs.length) await deps.sleep(opts.pauseMs);
  }
  return { created, queries };
}

const quantile = (sorted: number[], q: number): number | null => {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] as number;
};

export async function runDiscovery(
  chain: ChainConfig,
  deps: DiscoverDeps,
  opts: DiscoverOptions,
): Promise<{ file: DiscoveryFile; logCache: LogCache | null }> {
  const { rpc } = deps;
  const startedAt = deps.now();
  const steps: DiscoveryFile['rpc']['steps'] = [];
  let mark = { ...rpc.stats(), at: startedAt };
  const step = (name: string) => {
    const s = rpc.stats();
    const at = deps.now();
    steps.push({
      step: name,
      rpcCalls: s.rpcCalls - mark.rpcCalls,
      httpRequests: s.httpRequests - mark.httpRequests,
      seconds: (at - mark.at) / 1000,
    });
    mark = { ...s, at };
    deps.log({ event: 'step_done', ...steps.at(-1) });
  };

  const confirmed = opts.tokens.filter((t) => t.confirmed);
  /** lower-case address → the registry's spelling */
  const stocks = new Map(confirmed.map((t) => [lower(t.address), t.address]));
  const symbolOf = new Map(confirmed.map((t) => [lower(t.address), t.symbol]));
  const dollar = lower(chain.dollar.address);
  const dollarUnit = 10 ** chain.dollar.decimals;

  const getPin = async (): Promise<Pin> => {
    const b = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
      'latest',
      false,
    ]);
    return {
      tag: b.number,
      number: Number(b.number),
      time: new Date(Number(b.timestamp) * 1000).toISOString(),
      at: deps.now(),
    };
  };
  let pin = await getPin();
  const firstPin = pin;
  /**
   * The answers to `perItem(item)` for every item, each item's calls at one block. The block is
   * replaced when it grows old or its state is gone; an item is never split across two blocks.
   */
  async function readAtPin<T>(
    items: T[],
    perItem: (item: T) => Call[],
    chunkCalls: number,
  ): Promise<Array<{ item: T; replies: Answer[]; pin: Pin }>> {
    const out: Array<{ item: T; replies: Answer[]; pin: Pin }> = [];
    let i = 0;
    while (i < items.length) {
      const group: Array<{ item: T; calls: Call[] }> = [];
      let n = 0;
      while (i + group.length < items.length) {
        const calls = perItem(items[i + group.length] as T);
        if (group.length > 0 && n + calls.length > chunkCalls) break;
        group.push({ item: items[i + group.length] as T, calls });
        n += calls.length;
      }
      for (let repin = 0; ; repin++) {
        if (deps.now() - pin.at > PIN_MAX_AGE_MS) pin = await getPin();
        try {
          const replies = await multicall(
            rpc,
            chain.multicall3,
            group.flatMap((g) => g.calls),
            pin.tag,
            chunkCalls,
          );
          let at = 0;
          for (const g of group) {
            out.push({ item: g.item, replies: replies.slice(at, at + g.calls.length), pin });
            at += g.calls.length;
          }
          break;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (!isBlockGone(message) || repin >= MAX_REPINS) throw e;
          deps.log({ event: 'block_gone_repin', block: pin.number });
          pin = await getPin();
        }
      }
      i += group.length;
    }
    return out;
  }

  /**
   * Two rounds of calls per item at one block: the second round is planned from the first round's
   * answers (`plan` returns null to skip it). Both rounds of an item are answered by the same block,
   * so what the second reads belongs to the state the first read.
   */
  async function readTwiceAtPin<T, P extends { calls: Call[] }>(
    items: T[],
    firstCalls: (item: T) => Call[],
    plan: (item: T, replies: Answer[]) => P | null,
    chunkCalls: number,
  ): Promise<Array<{ item: T; first: Answer[]; plan: P | null; second: Answer[]; pin: Pin }>> {
    const out: Array<{ item: T; first: Answer[]; plan: P | null; second: Answer[]; pin: Pin }> = [];
    let i = 0;
    while (i < items.length) {
      const group: Array<{ item: T; calls: Call[] }> = [];
      let n = 0;
      while (i + group.length < items.length) {
        const calls = firstCalls(items[i + group.length] as T);
        if (group.length > 0 && n + calls.length > chunkCalls) break;
        group.push({ item: items[i + group.length] as T, calls });
        n += calls.length;
      }
      for (let repin = 0; ; repin++) {
        if (deps.now() - pin.at > PIN_MAX_AGE_MS) pin = await getPin();
        const at = pin;
        try {
          const a = await multicall(
            rpc,
            chain.multicall3,
            group.flatMap((g) => g.calls),
            at.tag,
            chunkCalls,
          );
          let k = 0;
          const planned = group.map((g) => {
            const first = a.slice(k, k + g.calls.length);
            k += g.calls.length;
            return { item: g.item, first, plan: plan(g.item, first) };
          });
          const b = await multicall(
            rpc,
            chain.multicall3,
            planned.flatMap((x) => x.plan?.calls ?? []),
            at.tag,
            chunkCalls,
          );
          k = 0;
          for (const x of planned) {
            const m = x.plan?.calls.length ?? 0;
            out.push({ ...x, second: b.slice(k, k + m), pin: at });
            k += m;
          }
          break;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (!isBlockGone(message) || repin >= MAX_REPINS) throw e;
          deps.log({ event: 'block_gone_repin', block: at.number });
          pin = await getPin();
        }
      }
      i += group.length;
    }
    return out;
  }

  // 1. the creation events ----------------------------------------------------------------------
  const filters = creationFilters(
    chain,
    confirmed.map((t) => t.address),
  );
  let probe: LogsProbe | null = null;
  let created: Created[] = [];
  let logCache: LogCache | null = null;
  const events = { used: false, complete: false, queries: 0 };
  if (opts.logs === 'auto' && filters.length > 0 && confirmed.length > 0) {
    probe = await probeLogs(rpc, filters, confirmed.length, opts.fromBlock, pin.number);
    deps.log({ event: 'logs_probe', ...probe });
    step('logs_probe');
    if (probe.usable && probe.window !== null) {
      const mine = [...stocks.keys()].sort();
      const c = opts.logCache;
      const cache =
        c !== null &&
        c.chainId === chain.chainId &&
        c.fromBlock <= opts.fromBlock &&
        c.scannedTo <= pin.number &&
        mine.every((a) => c.tokens.includes(a))
          ? c
          : null;
      const from = cache ? cache.scannedTo + 1 : opts.fromBlock;
      const scan = await scanCreated(deps, filters, from, pin.number, probe.window, {
        batch: opts.logBatch,
        pauseMs: opts.logPauseMs,
      });
      const all = new Map<string, Created>();
      for (const c of [...(cache?.created ?? []), ...scan.created]) all.set(c.id, c);
      created = [...all.values()].filter(
        (c) => stocks.has(c.token0) || stocks.has(c.token1), // a cache may hold a wider token list
      );
      logCache = {
        chainId: chain.chainId,
        tokens: cache?.tokens ?? mine,
        fromBlock: cache?.fromBlock ?? opts.fromBlock,
        scannedTo: pin.number,
        created: [...all.values()],
      };
      events.used = true;
      events.complete = true;
      events.queries = scan.queries;
      step('log_scan');
    }
  }
  const logsTo = events.used ? pin.number : null;
  // kept events may reach further back than this run was asked to scan
  const logsFrom = logCache?.fromBlock ?? null;

  // 2. DexScreener -------------------------------------------------------------------------------
  const fromDex: Array<ReturnType<typeof dexPools>[number]> = [];
  const namedFor = new Map<string, string>();
  const dexFailed: string[] = [];
  const atCap = new Set<string>();
  for (const t of confirmed) {
    try {
      const pairs = await deps.fetchJson(`${DEXSCREENER}/${chain.dexscreener}/${t.address}`);
      if (!Array.isArray(pairs)) throw new Error('not a list of pairs');
      if (pairs.length >= DEXSCREENER_CAP) atCap.add(t.address);
      for (const p of dexPools(pairs as DexPair[], chain, t.address)) {
        if (!namedFor.has(p.id)) {
          namedFor.set(p.id, t.address);
          fromDex.push(p);
        }
      }
    } catch (e) {
      dexFailed.push(t.address);
      deps.log({ event: 'dexscreener_failed', token: t.symbol, error: String(e) });
    }
    await deps.sleep(opts.dexPauseMs);
  }
  step('dexscreener');

  // 3. confirm what only DexScreener named -------------------------------------------------------
  const cands = mergeCandidates(chain, created, fromDex);
  const refused = new Map<string, Record<string, number>>();
  const refuse = (token: string | undefined, why: string) => {
    if (!token) return;
    const r = refused.get(token) ?? {};
    r[why] = (r[why] ?? 0) + 1;
    refused.set(token, r);
  };
  const drop = (c: Candidate, why: string) => {
    refuse(namedFor.get(c.id), why);
    cands.delete(c.id);
  };
  const allowlisted = new Set(chain.clFactories.map((f) => lower(f.address)));
  const unknownCl = [...cands.values()].filter((c) => c.kind === 'cl' && c.token0 === null);
  const selfReads = await readAtPin(
    unknownCl,
    (c) => CL_SELF_READS.map((sel) => ({ target: c.id, callData: `0x${sel}` })),
    MULTICALL_CHUNK,
  );
  const claimants: Candidate[] = [];
  for (const { item: c, replies } of selfReads) {
    const why = fillFromSelf(c, replies);
    if (why) drop(c, why);
    else if (c.factory !== null && allowlisted.has(c.factory)) claimants.push(c);
  }
  // a contract can claim any factory: only the factory's own answer counts
  const vouched = await readAtPin(
    claimants,
    (c) =>
      getPoolCalls(chain, c.token0 as string, c.token1 as string, {
        fee: c.fee,
        tickSpacing: c.tickSpacing,
      }),
    MULTICALL_CHUNK,
  );
  for (const { item: c, replies } of vouched) {
    if (replies.some((r) => poolOf(r) === c.id)) {
      c.attested = true;
      c.sources.push('v3_factory_getpool');
    } else drop(c, 'claims_a_factory_that_does_not_name_it');
  }
  const pm = chain.v4?.positionManager;
  const unknownV4 = [...cands.values()].filter((c) => c.kind === 'v4' && c.token0 === null);
  if (pm) {
    const keys = await readAtPin(
      unknownV4,
      (c) => [{ target: pm, callData: encodePoolKeys(c.id) }],
      MULTICALL_CHUNK,
    );
    for (const { item: c, replies } of keys) {
      const r = replies[0];
      const key = r?.success && r.data.length === 322 ? decodePoolKey(r.data) : null;
      if (!key || key.tickSpacing === 0) {
        drop(c, 'no_pool_key_on_the_position_manager');
        continue;
      }
      c.token0 = lower(key.currency0);
      c.token1 = lower(key.currency1);
      c.fee = key.fee;
      c.tickSpacing = key.tickSpacing;
      c.hooks = lower(key.hooks);
      c.factory = lower(chain.v4?.poolManager ?? ZERO_ADDRESS);
      c.attested = true;
    }
  } else for (const c of unknownV4) drop(c, 'no_v4_on_this_chain');
  for (const c of [...cands.values()])
    if (!fileUnder(c.token0 as string, c.token1 as string, stocks))
      drop(c, 'no_stock_of_the_registry_in_the_pair');
  step('confirm_candidates');

  // 4. the factory asked directly: each token against each other token seen with it, at each tier --
  let wrapped: string | null = null;
  if (pm) {
    const [r] = await readAtPin([pm], (a) => [{ target: a, callData: `0x${SEL.weth9}` }], 1);
    const a = r?.replies[0];
    wrapped = a?.success && a.data.length === 66 ? wordToAddress(BigInt(a.data)) : null;
  }
  const tiers = new Map<string, { fee: number | null; tickSpacing: number | null }>();
  for (const c of cands.values())
    if (c.kind === 'cl' && c.attested)
      tiers.set(`${c.fee}/${c.tickSpacing}`, { fee: c.fee, tickSpacing: c.tickSpacing });
  const tierList = [...tiers.values()];
  const pairsToAsk = new Map<string, { a: string; b: string }>();
  const askPair = (a: string, b: string) => {
    if (a === b || a === ZERO_ADDRESS || b === ZERO_ADDRESS) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    pairsToAsk.set(`${x}/${y}`, { a: x, b: y });
  };
  for (const t of stocks.keys()) {
    askPair(t, dollar);
    if (wrapped) askPair(t, wrapped);
  }
  for (const c of cands.values()) {
    // every pair of a v3-style pool, and of a v4 pool DexScreener lists: not the memecoin launches
    if (c.kind === 'v4' && !c.sources.includes('dexscreener')) continue;
    askPair(c.token0 as string, c.token1 as string);
  }
  const asked = [...pairsToAsk.values()].flatMap((p) => tierList.map((tier) => ({ ...p, tier })));
  const getPoolReplies = await readAtPin(
    asked,
    (q) => getPoolCalls(chain, q.a, q.b, q.tier),
    MULTICALL_CHUNK,
  );
  const getPool = { calls: 0, found: 0, notSeenElsewhere: 0 };
  for (const { item: q, replies } of getPoolReplies) {
    getPool.calls += replies.length;
    for (const [k, r] of replies.entries()) {
      const id = poolOf(r);
      if (!id) continue;
      getPool.found++;
      const have = cands.get(id);
      if (have) {
        if (!have.sources.includes('v3_factory_getpool')) have.sources.push('v3_factory_getpool');
        continue;
      }
      getPool.notSeenElsewhere++;
      cands.set(id, {
        kind: 'cl',
        id,
        token0: q.a,
        token1: q.b,
        fee: q.tier.fee,
        tickSpacing: q.tier.tickSpacing,
        hooks: null,
        factory: getPoolFactories(chain, q.tier)[k] ?? null,
        attested: true,
        createdBlock: null,
        sources: ['v3_factory_getpool'],
        dex: null,
      });
    }
  }
  step('factory_getpool');

  // 5. what each pool holds ----------------------------------------------------------------------
  const states = new Map<string, PoolState>();
  const big = (r: Answer | undefined) =>
    r?.success && r.data.length === 66 ? decodeUint(r.data) : null;
  const sqrtOf = (r: Answer | undefined) =>
    r?.success && r.data.length >= 130 ? decodeSqrtPrice(r.data) : null;
  const tickOf = (r: Answer | undefined) =>
    r?.success && r.data.length >= 130 ? decodeTick(r.data) : null;
  const stateView = chain.v4?.stateView;
  /** The calls that read a pool's own state; the same list is asked again with its ticks. */
  const stateCalls = (c: Candidate): Call[] =>
    c.kind === 'cl'
      ? [
          { target: c.token0 as string, callData: encodeBalanceOf(c.id) },
          { target: c.token1 as string, callData: encodeBalanceOf(c.id) },
          { target: c.id, callData: `0x${SEL.slot0}` },
          { target: c.id, callData: `0x${SEL.liquidity}` },
        ]
      : [
          { target: stateView as string, callData: encodeGetSlot0(c.id) },
          { target: stateView as string, callData: encodeGetLiquidity(c.id) },
        ];
  const stateOf = (c: Candidate, replies: Answer[], p: Pin): PoolState => {
    const [slot0, liquidity] =
      c.kind === 'cl' ? [replies[2], replies[3]] : [replies[0], replies[1]];
    return {
      block: p.number,
      fetchedAt: p.time,
      balance0: c.kind === 'cl' ? big(replies[0]) : null,
      balance1: c.kind === 'cl' ? big(replies[1]) : null,
      sqrtPriceX96: sqrtOf(slot0),
      liquidity: big(liquidity),
      tick: tickOf(slot0),
      inBand: null,
    };
  };
  const cl = [...cands.values()].filter((c) => c.kind === 'cl');
  for (const { item: c, replies, pin: p } of await readAtPin(cl, stateCalls, MULTICALL_CHUNK))
    states.set(c.id, stateOf(c, replies, p));
  step('state_v3');
  const v4 = [...cands.values()].filter((c) => c.kind === 'v4');
  const idle = new Map<string, { clNoBalance: number; v4NoLiquidityInRange: number }>();
  const idleFor = (token: string) => {
    let v = idle.get(token);
    if (!v) {
      v = { clNoBalance: 0, v4NoLiquidityInRange: 0 };
      idle.set(token, v);
    }
    return v;
  };
  if (stateView) {
    // first which pools have liquidity in range at all, then price and liquidity of those at one block
    const first = await readAtPin(
      v4,
      (c) => [{ target: stateView, callData: encodeGetLiquidity(c.id) }],
      LIQUIDITY_CHUNK,
    );
    // a pool whose liquidity could not be read is kept: only one read as zero is idle
    const live = first.filter((r) => big(r.replies[0]) !== 0n).map((r) => r.item);
    const liveIds = new Set(live.map((c) => c.id));
    for (const c of v4) {
      if (liveIds.has(c.id)) continue;
      const f = fileUnder(c.token0 as string, c.token1 as string, stocks);
      if (f) idleFor(f.token).v4NoLiquidityInRange++;
      cands.delete(c.id);
    }
    for (const { item: c, replies, pin: p } of await readAtPin(live, stateCalls, MULTICALL_CHUNK))
      states.set(c.id, stateOf(c, replies, p));
  } else for (const c of v4) cands.delete(c.id);
  step('state_v4');

  // 5b. what the positions hold within the band of the price. A pool's state, its tick bitmap and
  // the liquidity of each initialized tick are read at one block: positions a few ticks wide are moved
  // every few blocks on these pools, and a tick list older than the state it is applied to leaves a
  // position without its edge. Only pools whose tick layout is known: the allowlisted factories' and v4.
  const walkable = [...cands.values()].filter((c) => {
    const s = states.get(c.id);
    if (!s || s.tick === null || s.sqrtPriceX96 === null || s.sqrtPriceX96 <= 0n) return false;
    if (!c.tickSpacing || c.tickSpacing <= 0 || (s.liquidity ?? 0n) === 0n) return false;
    // the words are counted at the first read's tick, with one to spare either side for a price that moved
    const r = bandTicks(s.tick, opts.band);
    return (
      (c.kind === 'v4' || c.attested) &&
      bitmapWords(r.lo, r.hi, c.tickSpacing).length <= MAX_BITMAP_WORDS
    );
  });
  /** The words read for a pool: those of the band at the first read's tick, and one more each side. */
  const wordsOf = (c: Candidate): number[] => {
    const r = bandTicks((states.get(c.id) as PoolState).tick as number, opts.band);
    const w = bitmapWords(r.lo, r.hi, c.tickSpacing as number);
    return [(w[0] as number) - 1, ...w, (w.at(-1) as number) + 1];
  };
  const bitmapCall = (c: Candidate, w: number): Call =>
    c.kind === 'cl'
      ? { target: c.id, callData: `0x${SEL.tickBitmap}${intWord(w)}` }
      : {
          target: stateView as string,
          callData: `0x${SEL.getTickBitmap}${c.id.slice(2)}${intWord(w)}`,
        };
  const tickCall = (c: Candidate, t: number): Call =>
    c.kind === 'cl'
      ? { target: c.id, callData: `0x${SEL.ticks}${intWord(t)}` }
      : {
          target: stateView as string,
          callData: `0x${SEL.getTickLiquidity}${c.id.slice(2)}${intWord(t)}`,
        };
  const walked = await readTwiceAtPin(
    walkable,
    (c) => [...stateCalls(c), ...wordsOf(c).map((w) => bitmapCall(c, w))],
    (c, replies) => {
      // the ticks of the band at this block's price, from this block's bitmap
      const n = stateCalls(c).length;
      const tick = tickOf(c.kind === 'cl' ? replies[2] : replies[0]);
      if (tick === null) return null;
      const range = bandTicks(tick, opts.band);
      const read = wordsOf(c);
      const needed = bitmapWords(range.lo, range.hi, c.tickSpacing as number);
      if (needed.some((w) => !read.includes(w))) return null; // the price left the words read
      const ticks = read
        .flatMap((w, i) => ticksOfWord(w, big(replies[n + i]) ?? 0n, c.tickSpacing as number))
        .filter((t) => t >= range.lo && t <= range.hi);
      if (ticks.length > MAX_TICKS_PER_POOL) return null;
      if (replies.slice(n).some((r) => !r.success || r.data.length !== 66)) return null;
      return { ticks, calls: ticks.map((t) => tickCall(c, t)) };
    },
    LIQUIDITY_CHUNK,
  );
  for (const { item: c, first, plan, second, pin: p } of walked) {
    if (!plan) continue; // the first read stands, without what is in the band
    const s = stateOf(c, first.slice(0, stateCalls(c).length), p);
    if (
      s.sqrtPriceX96 === null ||
      s.tick === null ||
      s.liquidity === null ||
      second.some((r) => !r.success || r.data.length < 130)
    )
      continue;
    s.inBand = amountsInBand(
      s.liquidity,
      s.sqrtPriceX96,
      s.tick,
      plan.ticks.map((t, i) => ({
        tick: t,
        liquidityNet: decodeLiquidityNet((second[i] as Answer).data),
      })),
      bandTicks(s.tick, opts.band),
    );
    states.set(c.id, s);
  }
  step('ticks_in_band');

  // 6. prices: the dollar token, each stock from its own dollar pools, then the other tokens ----------
  const prices = new Map<string, Price>();
  prices.set(dollar, {
    address: dollar,
    usdPerRaw: 1 / dollarUnit,
    method: 'dollar_token_counts_as_one',
    refPool: null,
    refDollarUsd: null,
    reason: null,
    block: null,
  });
  const dollarPoolsOf = (token: string, kind: 'cl' | 'v4'): DollarPool[] => {
    const out: DollarPool[] = [];
    for (const c of cands.values()) {
      if (c.kind !== kind || !c.attested) continue;
      if (kind === 'v4' && c.hooks !== ZERO_ADDRESS) continue;
      const tokenIs0 = c.token0 === token && c.token1 === dollar;
      if (!tokenIs0 && !(c.token1 === token && c.token0 === dollar)) continue;
      const s = states.get(c.id);
      if (!s || s.sqrtPriceX96 === null || s.sqrtPriceX96 <= 0n) continue;
      if ((s.liquidity ?? 0n) === 0n) continue; // nothing in range: the price is whatever it was left at
      let dollarRaw: number | null;
      if (kind === 'cl') {
        const b = tokenIs0 ? s.balance1 : s.balance0;
        dollarRaw = b === null ? null : Number(b);
      } else {
        dollarRaw = s.inBand === null ? null : tokenIs0 ? s.inBand.raw1 : s.inBand.raw0;
      }
      if (dollarRaw === null) continue;
      out.push({
        id: c.id,
        kind,
        tokenIs0,
        sqrtPriceX96: s.sqrtPriceX96,
        dollarUsd: dollarRaw / dollarUnit,
        block: s.block,
      });
    }
    return out;
  };
  const priceOf = (token: string): Price =>
    priceFromDollarPools(
      token,
      [...dollarPoolsOf(token, 'cl'), ...dollarPoolsOf(token, 'v4')],
      chain.dollar.decimals,
      opts.minRefUsd,
    );
  for (const t of stocks.keys()) prices.set(t, priceOf(t));

  // the other tokens worth a lookup: those of a pool whose stock side is at least the floor
  const stockSideUsd = (c: Candidate): number | null => {
    const f = fileUnder(c.token0 as string, c.token1 as string, stocks);
    const s = states.get(c.id);
    if (!f || !s) return null;
    const p = prices.get(lower(f.token))?.usdPerRaw ?? null;
    return money(c.kind, f.tokenIs0, s, { token: p, other: null }).tokenUsd;
  };
  const lookUp = new Set<string>();
  if (wrapped) lookUp.add(wrapped);
  for (const c of cands.values()) {
    const f = fileUnder(c.token0 as string, c.token1 as string, stocks);
    if (!f || prices.has(f.other) || f.other === ZERO_ADDRESS) continue;
    const side = stockSideUsd(c);
    if (side !== null && side >= opts.minSideUsd) lookUp.add(f.other);
  }
  // their dollar pools: the factory is asked for each, and the ones not read yet are read now
  const others = [...lookUp].filter((a) => !prices.has(a));
  const otherPools = await readAtPin(
    others.flatMap((a) => tierList.map((tier) => ({ a, tier }))),
    (q) => getPoolCalls(chain, q.a, dollar, q.tier),
    MULTICALL_CHUNK,
  );
  const refCands: Array<{ id: string; token: string; tokenIs0: boolean }> = [];
  for (const { item: q, replies } of otherPools)
    for (const r of replies) {
      const id = poolOf(r);
      if (id) refCands.push({ id, token: q.a, tokenIs0: q.a < dollar });
    }
  const refReads = await readAtPin(
    refCands,
    (c) => [
      { target: dollar, callData: encodeBalanceOf(c.id) },
      { target: c.id, callData: `0x${SEL.slot0}` },
      { target: c.id, callData: `0x${SEL.liquidity}` },
    ],
    MULTICALL_CHUNK,
  );
  const refPools = new Map<string, DollarPool[]>();
  for (const { item: c, replies, pin: p } of refReads) {
    const bal = big(replies[0]);
    const slot0 = replies[1];
    if (bal === null || !slot0?.success || slot0.data.length < 66) continue;
    if ((big(replies[2]) ?? 0n) === 0n) continue;
    const list = refPools.get(c.token) ?? [];
    list.push({
      id: c.id,
      kind: 'cl',
      tokenIs0: c.tokenIs0,
      sqrtPriceX96: decodeSqrtPrice(slot0.data),
      dollarUsd: Number(bal) / dollarUnit,
      block: p.number,
    });
    refPools.set(c.token, list);
  }
  for (const a of others)
    prices.set(
      a,
      priceFromDollarPools(a, refPools.get(a) ?? [], chain.dollar.decimals, opts.minRefUsd),
    );
  if (wrapped) {
    const w = prices.get(wrapped) as Price;
    prices.set(ZERO_ADDRESS, {
      ...w,
      address: ZERO_ADDRESS,
      method: w.usdPerRaw === null ? null : 'same_as_wrapped_native',
    });
  }
  step('prices');

  // 7. the rows ----------------------------------------------------------------------------------
  const otherSymbol = (a: string): string | null =>
    symbolOf.get(a) ??
    (a === dollar
      ? chain.dollar.symbol
      : a === ZERO_ADDRESS
        ? 'native'
        : a === wrapped
          ? 'wrapped native'
          : null);
  const rows: PoolRow[] = [];
  for (const c of cands.values()) {
    const f = fileUnder(c.token0 as string, c.token1 as string, stocks);
    const s = states.get(c.id);
    if (!f || !s) continue;
    if (isIdle(c.kind, s)) {
      if (c.kind === 'cl') idleFor(f.token).clNoBalance++;
      else idleFor(f.token).v4NoLiquidityInRange++;
      continue;
    }
    const other = prices.get(f.other);
    const m = money(c.kind, f.tokenIs0, s, {
      token: prices.get(lower(f.token))?.usdPerRaw ?? null,
      other: other?.usdPerRaw ?? null,
      otherLookedUp: other !== undefined,
    });
    const [balToken, balOther] = f.tokenIs0 ? [s.balance0, s.balance1] : [s.balance1, s.balance0];
    rows.push({
      id: c.id,
      kind: c.kind,
      venue: venueOf(chain, c),
      factory: c.factory,
      token: f.token,
      symbol: symbolOf.get(lower(f.token)) as string,
      other: f.other,
      otherSymbol: otherSymbol(f.other),
      otherIsStock: f.otherIsStock,
      filedUnder: f.filedUnder,
      tokenIs0: f.tokenIs0,
      againstDollar: f.other === dollar,
      fee: c.fee,
      tickSpacing: c.tickSpacing,
      hooks: c.hooks,
      sources: [...c.sources].sort(),
      createdBlock: c.createdBlock,
      ...reach(c),
      block: s.block,
      fetchedAt: s.fetchedAt,
      balanceToken: balToken === null ? null : balToken.toString(),
      balanceOther: balOther === null ? null : balOther.toString(),
      liquidity: s.liquidity === null ? null : s.liquidity.toString(),
      sqrtPriceX96: s.sqrtPriceX96 === null ? null : s.sqrtPriceX96.toString(),
      dexscreener: c.dex,
      ...m,
    });
  }
  // largest first, unmeasured last; the id settles ties so two runs on the same answers agree
  rows.sort(
    (a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // 8. what the run could not have seen, per token ---------------------------------------------------
  const gaps = new Map<string, string[]>();
  for (const t of confirmed) {
    const g = gapsFor({
      eventsUsed: events.used,
      dexFailed: dexFailed.includes(t.address),
      dexAtCap: atCap.has(t.address),
    });
    if (g.length) gaps.set(t.address, g);
  }
  const tokens = summarize(opts.tokens, rows, { idle, refused, gaps });

  const ratios = rows
    .filter(
      (r) =>
        r.kind === 'cl' &&
        r.reachable &&
        r.againstDollar &&
        r.tvlUsd !== null &&
        r.tvlUsd >= opts.minRefUsd &&
        r.bandUsd !== null,
    )
    .map((r) => (r.bandUsd as number) / (r.tvlUsd as number))
    .sort((a, b) => a - b);
  let stateFirst = firstPin.number;
  let stateLast = firstPin.number;
  for (const s of states.values()) {
    stateFirst = Math.min(stateFirst, s.block);
    stateLast = Math.max(stateLast, s.block);
  }
  const idleNotListed = [...idle.values()].reduce(
    (n, v) => n + v.clNoBalance + v.v4NoLiquidityInRange,
    0,
  );
  const total = rpc.stats();
  const file: DiscoveryFile = {
    chain: chain.id,
    chainId: chain.chainId,
    provenance: 'live',
    source: `${events.used ? `PoolCreated events of the v3 factory and Initialize events of the v4 pool manager (eth_getLogs, blocks ${logsFrom} to ${logsTo}), ` : ''}${DEXSCREENER}/${chain.dexscreener}/{token}, the factory's getPool(), then balanceOf(), slot0(), liquidity() and the v4 StateView by eth_call at blocks ${stateFirst} to ${stateLast} on ${chain.name} (chain ${chain.chainId}) through ${opts.rpcLabel}`,
    method: DISCOVERY_METHOD,
    fetchedAt: pin.time,
    blocks: { logsFrom, logsTo, stateFirst, stateLast },
    universe: {
      ...opts.universe,
      tokens: opts.tokens.length,
      confirmed: confirmed.length,
    },
    params: { band: opts.band, minRefUsd: opts.minRefUsd, minSideUsd: opts.minSideUsd },
    logsProbe: probe,
    sources: {
      creationEvents: {
        ...events,
        v3Pools: created.filter((c) => c.kind === 'cl').length,
        v4Pools: created.filter((c) => c.kind === 'v4').length,
      },
      dexscreener: {
        asked: confirmed.length,
        failed: dexFailed,
        atCap: atCap.size,
        pools: fromDex.length,
      },
      factoryGetPool: getPool,
    },
    counts: {
      tokens: tokens.length,
      withPools: tokens.filter((t) => t.status === 'pools').length,
      noPool: tokens.filter((t) => t.status === 'no_pool').length,
      notConfirmed: tokens.filter((t) => t.status === 'not_confirmed').length,
      pools: rows.length,
      reachable: rows.filter((r) => r.reachable).length,
      tvlMeasured: rows.filter((r) => r.tvlUsd !== null).length,
      tvlNull: rows.filter((r) => r.tvlUsd === null).length,
      idleNotListed,
      twoStockPools: rows.filter((r) => r.otherIsStock).length,
    },
    bandCheck: {
      pools: ratios.length,
      medianRatio: quantile(ratios, 0.5),
      p10: quantile(ratios, 0.1),
      p90: quantile(ratios, 0.9),
    },
    prices: [...prices.values()].map((p) => ({ ...p, symbol: otherSymbol(p.address) })),
    rpc: { ...total, seconds: (deps.now() - startedAt) / 1000, steps },
    tokens,
    pools: rows,
  };
  return { file, logCache };
}
