// One collector run for one chain: a token's prices and quotes are read with eth_call at one block, and
// one row per token is appended to a dated JSONL file. The run holds one block for all tokens unless that
// block grows old or its state is gone; then it takes a fresh one. Read-only: no transaction, no key.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Call,
  decodeAggregate3,
  decodeClQuote,
  decodeSqrtPrice,
  decodeV4Quote,
  encodeAggregate3,
  encodeClQuote,
  encodeGetSlot0,
  encodeV4Quote,
  SEL,
} from './abi';
import { type ChainConfig, rpcFor, type TokenConfig } from './config';
import {
  type AssetSnapshotRow,
  buildRow,
  buyAmounts,
  METHOD_VERSION,
  midUsd,
  nearMedian,
  type PoolQuotes,
  type Quote,
  type Side,
  sellAmounts,
} from './curve';
import { type ListRun, listCandidates, poolRows } from './listed';
import { oracleCalls, oracleRows } from './oracle';
import {
  cacheIsFresh,
  cachePath,
  confirm,
  discover,
  type PoolCache,
  type PoolRef,
  readCache,
  writeCache,
} from './pools';
import { createRpc, type Rpc, type RpcReply, type RpcRequest, RpcUnreachable } from './rpc';

/** Where the quoter's code is placed for the length of one eth_call. Nothing is deployed there. */
const QUOTER_AT = '0x5151515151515151515151515151515151515152';
/** The public RPCs cap eth_call at 50M gas (measured 2026-10-02 on both Robinhood Chain endpoints). */
const CALL_GAS = '0x2faf080';
/** Gas one v3-style swap may use before the quoter gives up on that size. */
const GAS_PER_SWAP = 20_000_000n;
/** A pool whose mid is further than this from the median of the token's pools is left out of the run. */
const MAX_MID_GAP = 0.02;
/** A v4 batch that runs out of gas is tried again without its largest size, this many times. */
const V4_SIZE_DROPS = 3;
/**
 * A run that has held one block longer than this takes a fresh one before its next token. The public
 * RPC keeps a block's state for a few minutes only (2,000 blocks back answered on Oct 3, 10,000 did
 * not; a block is about a tenth of a second), and a run takes about ten seconds: one this old was
 * paused, by a sleeping machine, not slow.
 */
export const MAX_PIN_AGE_MS = 2 * 60_000;
/** How many times one token is measured again on a fresh block after its block's state went missing. */
export const MAX_REPINS_PER_TOKEN = 2;

/**
 * What the endpoints answer when the pinned block, or its state, is not there any more. The first three
 * are from the overnight run of Oct 2 to 3, the rest from asking both Robinhood Chain endpoints for
 * blocks they do not have (fixtures/risk-evm/rpc-errors.json).
 */
const BLOCK_GONE =
  /historical state .*is not available|missing trie node|layer stale|header not found|block not found|unknown block|unsupported block number/i;
export const isBlockGone = (message: string | undefined): boolean => BLOCK_GONE.test(message ?? '');

/** The pinned block cannot be read any more: the token is measured again, whole, on a fresh block. */
class BlockGone extends Error {}
/** The endpoint answered a call with an error of its own (rate, plan limit, no reply for the call). */
class EndpointRefused extends Error {}
/**
 * The endpoint was reached and would not give a fresh block. Nothing more can be measured until it
 * does, so the run stops there and the hour tries again, as it does when the endpoint is unreachable.
 */
class PinRefused extends EndpointRefused {}
/**
 * Whether a token left without a row is worth another try within the hour: yes when the network, the
 * endpoint or the block's state was the reason, no when the call itself is at fault (it reverted, or
 * the collector's own data is wrong), because the same call gives the same answer.
 */
const worthRetrying = (e: unknown): boolean =>
  e instanceof RpcUnreachable ||
  e instanceof BlockGone ||
  (e instanceof EndpointRefused && !/revert/i.test(e.message));

const quoterCode = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'cl-quoter.json'), 'utf8')) as {
    deployedBytecode: string;
  }
).deployedBytecode;

export type RunOptions = {
  dir: string;
  maxPools: number;
  minLiquidityUsd: number;
  poolsMaxAgeHours: number;
  rediscover: boolean;
  env?: Record<string, string | undefined>;
  /**
   * A run on the asset list (PLAN-UNIVERSE RU.6): the chain's tokens are the list's, each token's pools
   * are the cut's reachable dollar pools confirmed on chain, and every reachable pool gets a row of its
   * own in pools/<day>.jsonl. Absent = the run is as it always was.
   */
  listed?: ListRun;
  /** Measure only these tokens (by symbol): a second attempt within the hour fills in what the first missed. */
  only?: ReadonlySet<string> | null;
  /**
   * When the next scheduled run starts (ms). A run that is still going then, because it was paused,
   * leaves its remaining tokens to that run instead of measuring them twice within a minute.
   */
  until?: number;
  /** For tests: a client that answers from a recording. The collector builds its own from the chain's URL. */
  rpc?: Rpc;
  /** For tests: the clock and the wait between tokens. */
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  log: (event: Record<string, unknown>) => void;
};

export type TokenResult = {
  asset: string;
  pools: number;
  refMidUsd: number | null;
  /** Sell cost in percent at $10k and $50k, for the run log. */
  sell10k: number | null;
  sell50k: number | null;
  /** The block the token's row was read at. Absent when no row was written. */
  block?: number;
  /** Why there is no row. */
  error?: string;
  /** True when the reason may pass (network, endpoint, block state): worth another try within the hour. */
  retry?: boolean;
};

export type RunSummary = {
  chain: string;
  chainId: number;
  /** The first block the run pinned. A token measured again on a fresh block carries its own. */
  block: number;
  blockTime: string;
  /** How many times the run took a fresh block: its own grew too old, or its state was gone. */
  repins: number;
  /** Set when the run stopped early: the endpoint could not be reached or refused a fresh block, or the next scheduled run was due. */
  aborted?: string;
  rows: number;
  tokens: TokenResult[];
  file: string;
  poolsRediscovered: boolean;
  rpcCalls: number;
  httpRequests: number;
  durationMs: number;
  methodVersion: string;
  /** A list run only: the files it read, the pools it was given and the pool rows it wrote. */
  list?: {
    list: string;
    cut: string;
    poolsConfirmed: number;
    poolRows: number;
    poolRowsQuoted: number;
    poolRowsByReason: Record<string, number>;
    poolsFile: string;
    handListNotTracked: string[];
    /** The oracle read of the run (RU.7): rows written, how many carry a price, and why not when it failed. */
    oracleRows: number;
    oracleRowsRead: number;
    oracleFile: string;
    oracleError?: string;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One side of one pool at every size: the eth_call that asks for it. */
export function quoteRequest(
  chain: ChainConfig,
  pool: PoolRef,
  side: Side,
  amountsIn: bigint[],
  blockTag: string,
): RpcRequest {
  // selling the token is zeroForOne when the token is token0; buying is the other direction
  const zeroForOne = side === 'sell' ? pool.tokenIs0 : !pool.tokenIs0;
  if (pool.kind === 'cl') {
    return {
      method: 'eth_call',
      params: [
        {
          to: QUOTER_AT,
          data: encodeClQuote(pool.id, zeroForOne, amountsIn, GAS_PER_SWAP),
          gas: CALL_GAS,
        },
        blockTag,
        { [QUOTER_AT]: { code: quoterCode } },
      ],
    };
  }
  if (!chain.v4 || !pool.key) throw new Error(`v4 pool ${pool.id} has no key`);
  const quoter = chain.v4.quoter;
  const key = pool.key;
  const calls: Call[] = amountsIn.map((a) => ({
    target: quoter,
    callData: encodeV4Quote(key, zeroForOne, a),
  }));
  return {
    method: 'eth_call',
    params: [{ to: chain.multicall3, data: encodeAggregate3(calls), gas: CALL_GAS }, blockTag],
  };
}

/** The quotes in a reply to quoteRequest, one per amount asked; null where the pool gave none. */
export function decodeQuotes(
  pool: PoolRef,
  result: string,
  amountsIn: bigint[],
): Array<Quote | null> {
  if (pool.kind === 'cl') {
    const { ins, outs } = decodeClQuote(result);
    return amountsIn.map((_, i) => {
      const out = outs[i] ?? 0n;
      return out > 0n ? { out, filledIn: ins[i] ?? 0n } : null;
    });
  }
  const replies = decodeAggregate3(result);
  return amountsIn.map((sent, i) => {
    const r = replies[i];
    // a quote is two words: amountOut and the Quoter's gas estimate. A pool that cannot take the whole
    // amount makes the Quoter revert (NotEnoughLiquidity), so a quote that came back was filled in full.
    if (!r?.success || r.data.length !== 130) return null;
    const out = decodeV4Quote(r.data);
    return out > 0n ? { out, filledIn: sent } : null;
  });
}

const outOfGas = (r: RpcReply) => /out of gas|gas required exceeds/i.test(r.error?.message ?? '');

type LivePool = { ref: PoolRef; midUsd: number };

async function quoteToken(
  chain: ChainConfig,
  rpc: Rpc,
  token: TokenConfig,
  pools: LivePool[],
  blockTag: string,
  log: RunOptions['log'],
): Promise<PoolQuotes[]> {
  const quotes: PoolQuotes[] = pools.map((p) => ({
    pool: p.ref.id,
    midUsd: p.midUsd,
    sellIn: sellAmounts(p.midUsd, token.decimals),
    buyIn: buyAmounts(chain.dollar.decimals),
    sell: [],
    buy: [],
  }));
  const jobs = pools.flatMap((p, at) =>
    (['sell', 'buy'] as const).map((side) => {
      const target = quotes[at] as PoolQuotes;
      return { pool: p.ref, side, target, amounts: side === 'sell' ? target.sellIn : target.buyIn };
    }),
  );
  const replies = await rpc.batch(
    jobs.map((j) => quoteRequest(chain, j.pool, j.side, j.amounts, blockTag)),
  );
  for (const [i, job] of jobs.entries()) {
    let reply = replies[i] as RpcReply;
    let asked = job.amounts;
    // Multicall3 has no gas limit per call, so one large size that walks a whole v4 pool can use up the call
    for (let drop = 0; job.pool.kind === 'v4' && outOfGas(reply) && drop < V4_SIZE_DROPS; drop++) {
      asked = asked.slice(0, -1);
      const retry = quoteRequest(chain, job.pool, job.side, asked, blockTag);
      reply = (await rpc.batch([retry]))[0] as RpcReply;
    }
    if (outOfGas(reply)) {
      // the pool is there but too costly to walk at these sizes: no quote from it, the others still count
      log({ event: 'quote_out_of_gas', asset: token.symbol, pool: job.pool.id, side: job.side });
      job.target[job.side] = job.amounts.map(() => null);
      continue;
    }
    if (isBlockGone(reply.error?.message)) throw new BlockGone(reply.error?.message);
    // anything else (the endpoint refused, no answer) says nothing about the pool. A row built without
    // it would pass off a thinner pool's cost as the best, so the token gets no row this run.
    if (reply.error || typeof reply.result !== 'string')
      throw new EndpointRefused(
        `${job.side} quote from pool ${job.pool.id} failed: ${reply.error?.message ?? 'no result'}`,
      );
    const got = decodeQuotes(job.pool, reply.result, asked);
    job.target[job.side] = job.amounts.map((_, k) => got[k] ?? null);
  }
  return quotes;
}

const costAt = (row: AssetSnapshotRow, usd: number) =>
  row.sell.find((p) => p.notionalUsd === usd)?.costPct ?? null;

/** The block a token is measured at, and when this process took it. */
type Pin = { tag: string; number: number; time: Date; takenAt: number };

function toPin(head: unknown, takenAt: number): Pin {
  const h = head as { number?: string; timestamp?: string } | null | undefined;
  if (!h?.number || !h.timestamp) throw new Error('no latest block from the RPC');
  return {
    tag: h.number,
    number: Number(h.number),
    time: new Date(Number(h.timestamp) * 1000),
    takenAt,
  };
}

async function pinLatest(rpc: Rpc, now: () => number): Promise<Pin> {
  try {
    return toPin(await rpc.call('eth_getBlockByNumber', ['latest', false]), now());
  } catch (e) {
    if (e instanceof RpcUnreachable) throw e;
    // rpc.call raises a plain error when the endpoint answers with one: a refusal, not a dead network
    throw new PinRefused(`no fresh block: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type TokenPools = { token: TokenConfig; pools: PoolRef[]; confirmed: PoolRef[] };
/** Pool prices read at one block. Quotes for these tokens are asked at the same block, never another. */
type Mids = { pin: Pin; byToken: Map<string, LivePool[]> };

/** The mid of every pool of these tokens, in one call at the pinned block. */
async function readMids(
  chain: ChainConfig,
  rpc: Rpc,
  tokens: TokenPools[],
  pin: Pin,
): Promise<Mids> {
  const calls: Call[] = tokens.flatMap((t) =>
    t.pools.map((p) => {
      if (p.kind === 'cl') return { target: p.id, callData: `0x${SEL.slot0}` };
      if (!chain.v4) throw new Error(`${chain.id} has a v4 pool listed but no v4 contracts`);
      return { target: chain.v4.stateView, callData: encodeGetSlot0(p.id) };
    }),
  );
  const byToken = new Map<string, LivePool[]>();
  if (calls.length === 0) return { pin, byToken };
  const [reply] = await rpc.batch([
    {
      method: 'eth_call',
      params: [{ to: chain.multicall3, data: encodeAggregate3(calls) }, pin.tag],
    },
  ]);
  if (isBlockGone(reply?.error?.message)) throw new BlockGone(reply?.error?.message);
  if (!reply || reply.error || typeof reply.result !== 'string')
    throw new EndpointRefused(`pool prices failed: ${reply?.error?.message ?? 'no result'}`);
  const replies = decodeAggregate3(reply.result);
  let next = 0;
  for (const { token, pools } of tokens) {
    const priced: LivePool[] = [];
    for (const ref of pools) {
      const r = replies[next++];
      if (!r?.success || r.data.length < 66) continue;
      const sqrtPrice = decodeSqrtPrice(r.data);
      if (sqrtPrice > 0n)
        priced.push({
          ref,
          midUsd: midUsd(sqrtPrice, ref.tokenIs0, token.decimals, chain.dollar.decimals),
        });
    }
    byToken.set(token.symbol, priced);
  }
  return { pin, byToken };
}

export async function collectOnce(chain: ChainConfig, opts: RunOptions): Promise<RunSummary> {
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const started = now();
  const { url, label } = rpcFor(chain, opts.env);
  const rpc = opts.rpc ?? createRpc(url);

  // 1. the right chain, and a first block
  const [idReply, blockReply] = await rpc.batch([
    { method: 'eth_chainId', params: [] },
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
  ]);
  const chainId = Number(idReply?.result);
  if (chainId !== chain.chainId)
    throw new Error(`${chain.rpcEnv} answers for chain ${chainId}, not ${chain.chainId}`);
  let pin = toPin(blockReply?.result, now());
  const first = pin;

  // 2. the pool list, from the file unless it is missing, old or asked for. The lookup reads the
  // chain as it is now, not at the pinned block: it takes a while and only needs today's pools.
  // A list run keeps its own file: the hand list's pools and the list's never replace each other.
  const listed = opts.listed;
  const path = listed ? join(opts.dir, `pools-${chain.id}-list.json`) : cachePath(opts.dir, chain);
  let cache: PoolCache | null = readCache(path);
  let poolsRediscovered = false;
  const fresh =
    cacheIsFresh(cache, chain, {
      maxPools: opts.maxPools,
      maxAgeHours: opts.poolsMaxAgeHours,
      now: new Date(now()),
    }) &&
    (!listed || cache.cut === listed.cut);
  if (opts.rediscover || !fresh) {
    try {
      cache = listed
        ? await confirmListed(chain, rpc, listed, opts.maxPools, new Date(now()))
        : await discover(chain, rpc, {
            maxPools: opts.maxPools,
            minLiquidityUsd: opts.minLiquidityUsd,
            candidateLimit: opts.maxPools * 4,
            blockTag: 'latest',
            previous: cache,
            log: opts.log,
          });
      writeCache(path, cache);
      poolsRediscovered = true;
    } catch (e) {
      if (e instanceof RpcUnreachable || !cache) throw e;
      // a list run never falls back to pools confirmed from another cut: its rows would name this one
      if (listed && cache.cut !== listed.cut) throw e;
      opts.log({ event: 'discover_failed_using_old_list', error: String(e) });
    }
  }
  if (!cache) throw new Error('no pool list');
  const todo: TokenPools[] = chain.tokens
    .filter((token) => !opts.only || opts.only.has(token.symbol))
    .map((token) => {
      const kept = cache.tokens[token.symbol];
      const sameToken = kept?.address.toLowerCase() === token.address.toLowerCase();
      const confirmed = sameToken ? kept.pools : [];
      // a list run's file holds every confirmed pool; the limit is applied here, so a pool left out by
      // it is known as confirmed and says so on its row
      return { token, confirmed, pools: listed ? confirmed.slice(0, opts.maxPools) : confirmed };
    });

  // 3. per token: the pools' prices and their quotes, both at one block, then the row
  const sourceAt = (p: Pin) =>
    `eth_call at block ${p.number} on ${chain.name} (chain ${chain.chainId}) through ${label}: Uniswap-v3-style pools by an injected quoter (state override), Uniswap v4 pools by the deployed Quoter; pool list from ${listed ? `${listed.cut} through ${listed.list}` : 'DexScreener'}`;
  const fileAt = (p: Pin) => join(opts.dir, 'assets', `${p.time.toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(join(opts.dir, 'assets'), { recursive: true });
  const poolsFileAt = (p: Pin) =>
    join(opts.dir, 'pools', `${p.time.toISOString().slice(0, 10)}.jsonl`);
  if (listed) mkdirSync(join(opts.dir, 'pools'), { recursive: true });
  const poolTally = { rows: 0, quoted: 0, byReason: {} as Record<string, number> };
  /** A list run: one row per reachable pool of the token, with its own quote or the reason it has none. */
  const writePoolRows = (
    token: TokenConfig,
    confirmed: PoolRef[],
    asked: PoolRef[],
    at: Pin,
    priced: LivePool[],
    quotes: PoolQuotes[],
  ) => {
    if (!listed) return;
    const lines = poolRows({
      chain,
      token,
      listed,
      blockTime: at.time,
      blockNumber: at.number,
      confirmed,
      asked,
      priced,
      quotes,
      source: sourceAt(at),
    });
    if (lines.length === 0) return;
    appendFileSync(poolsFileAt(at), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    for (const l of lines) {
      poolTally.rows++;
      if (l.reason === null) poolTally.quoted++;
      else poolTally.byReason[l.reason] = (poolTally.byReason[l.reason] ?? 0) + 1;
    }
  };
  // A list run: the feed of every token it is about to measure, in one call at the block it holds.
  // The oracle is recorded beside the pool price, never blended with it (ORACLE-VS-DEX); a failed read
  // costs the run nothing but these rows.
  const oracleFileAt = (p: Pin) =>
    join(opts.dir, 'oracle', `${p.time.toISOString().slice(0, 10)}.jsonl`);
  const oracle: { rows: number; read: number; error?: string } = { rows: 0, read: 0 };
  if (listed) {
    const withFeed = todo.flatMap(({ token }) => {
      const feed = listed.feeds[token.symbol];
      return feed ? [{ token, feed }] : [];
    });
    try {
      if (withFeed.length > 0) {
        const [reply] = await rpc.batch([
          {
            method: 'eth_call',
            params: [
              {
                to: chain.multicall3,
                data: encodeAggregate3(oracleCalls(withFeed.map((t) => t.feed))),
              },
              pin.tag,
            ],
          },
        ]);
        if (!reply || reply.error || typeof reply.result !== 'string')
          throw new Error(reply?.error?.message ?? 'no result');
        const lines = oracleRows({
          chain: chain.id,
          tokens: withFeed,
          replies: decodeAggregate3(reply.result),
          blockTime: pin.time,
          blockNumber: pin.number,
          source: `latestRoundData() of each feed's proxy by eth_call (Multicall3) at block ${pin.number} on ${chain.name} (chain ${chain.chainId}) through ${label}; feeds from ${listed.list}`,
        });
        mkdirSync(join(opts.dir, 'oracle'), { recursive: true });
        appendFileSync(oracleFileAt(pin), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
        oracle.rows = lines.length;
        oracle.read = lines.filter((l) => l.price !== null).length;
      }
    } catch (e) {
      if (e instanceof RpcUnreachable) throw e;
      oracle.error = e instanceof Error ? e.message : String(e);
      opts.log({ event: 'oracle_read_failed', block: pin.number, error: oracle.error });
    }
  }
  const results: TokenResult[] = [];
  let mids: Mids | null = null;
  /** Set when the block in use must be replaced before the next read: why, for the log. */
  let repin: Record<string, unknown> | null = null;
  let rows = 0;
  let repins = 0;
  let aborted: string | undefined;
  /** Why the tokens the run did not reach were left, and whether this hour should try them again. */
  let left: { error: string; retry: boolean } | undefined;
  /** Paused past the hour: what is not measured yet belongs to the next run, which is due now. */
  const nextRunDue = () => opts.until !== undefined && now() >= opts.until;
  const NEXT_RUN_DUE = 'the next scheduled run is due';
  for (const [i, { token, pools, confirmed }] of todo.entries()) {
    if (nextRunDue()) {
      aborted = NEXT_RUN_DUE;
      left = { error: `not tried: ${aborted}`, retry: false };
      break;
    }
    const result: TokenResult = {
      asset: token.symbol,
      pools: 0,
      refMidUsd: null,
      sell10k: null,
      sell50k: null,
    };
    results.push(result);
    if (pools.length === 0) {
      result.error = 'no eligible pool';
      // its reachable pools are all against another token: each still gets its row, with the reason,
      // stamped with the block the run holds (nothing is read for it)
      writePoolRows(token, confirmed, pools, pin, [], []);
      continue;
    }
    for (let again = 0; ; ) {
      try {
        const age = now() - pin.takenAt;
        // the run was paused: what is left starts again on a fresh block
        if (!repin && age > MAX_PIN_AGE_MS)
          repin = { reason: 'pin_too_old', asset: token.symbol, fromBlock: pin.number, ageMs: age };
        if (repin) {
          if (nextRunDue()) {
            // a fresh block now would be a sample of the next hour, which that run takes itself:
            // this token (its own block could not be read) and the rest are left to it
            aborted = NEXT_RUN_DUE;
            left = { error: `not tried: ${aborted}`, retry: false };
            result.error = `not measured: ${aborted}`;
            break;
          }
          const why = repin;
          pin = await pinLatest(rpc, now);
          opts.log({ event: 'repinned', ...why });
          repins++;
          repin = null;
          mids = null;
        }
        // prices for every token still to do, at the block in use; after a fresh block, read again
        if (mids?.pin !== pin) mids = await readMids(chain, rpc, todo.slice(i), pin);
        const at = mids.pin;
        const priced = mids.byToken.get(token.symbol) ?? [];
        const live = nearMedian(priced, MAX_MID_GAP);
        result.pools = live.length;
        result.refMidUsd = live[0]?.midUsd ?? null;
        if (live.length === 0) {
          result.error = priced.length
            ? 'the pools disagree on the price'
            : 'no pool returned a price';
          writePoolRows(token, confirmed, pools, at, priced, []);
          break;
        }
        const quotes = await quoteToken(chain, rpc, token, live, at.tag, opts.log);
        writePoolRows(token, confirmed, pools, at, priced, quotes);
        const row = buildRow({
          token,
          dollarDecimals: chain.dollar.decimals,
          blockTime: at.time,
          blockNumber: at.number,
          pools: quotes,
          source: sourceAt(at),
        });
        if (!row.sell.some((p) => p.outUsd !== null)) {
          result.error = 'no pool gave a sell quote';
          break;
        }
        appendFileSync(fileAt(at), `${JSON.stringify(row)}\n`);
        rows++;
        result.block = at.number;
        result.sell10k = costAt(row, 10_000);
        result.sell50k = costAt(row, 50_000);
        break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof BlockGone && again < MAX_REPINS_PER_TOKEN) {
          // nothing of this token is kept: its prices and its quotes are read again on a fresh block
          again++;
          repin = {
            reason: 'block_gone',
            asset: token.symbol,
            fromBlock: pin.number,
            error: message,
          };
          continue;
        }
        result.error = e instanceof BlockGone ? `the block's state was gone: ${message}` : message;
        if (worthRetrying(e)) result.retry = true;
        if (e instanceof RpcUnreachable || e instanceof PinRefused) {
          // the other tokens would only wait out the same timeouts, or meet the same refusal
          aborted = message;
          left = { error: `not tried: ${message}`, retry: true };
        }
        break;
      }
    }
    if (left) break;
    await wait(200); // the RPC is free and shared
  }
  for (const { token, pools } of todo.slice(results.length)) {
    const blank = { asset: token.symbol, pools: 0, refMidUsd: null, sell10k: null, sell50k: null };
    if (pools.length === 0) results.push({ ...blank, error: 'no eligible pool' });
    else results.push({ ...blank, error: left?.error, ...(left?.retry ? { retry: true } : {}) });
  }

  const stats = rpc.stats();
  return {
    chain: chain.id,
    chainId: chain.chainId,
    block: first.number,
    blockTime: first.time.toISOString(),
    repins,
    ...(aborted ? { aborted } : {}),
    rows,
    tokens: results,
    file: fileAt(first),
    poolsRediscovered,
    rpcCalls: stats.rpcCalls,
    httpRequests: stats.httpRequests,
    durationMs: now() - started,
    methodVersion: METHOD_VERSION,
    ...(listed
      ? {
          list: {
            list: listed.list,
            cut: listed.cut,
            poolsConfirmed: todo.reduce((n, t) => n + t.pools.length, 0),
            poolRows: poolTally.rows,
            poolRowsQuoted: poolTally.quoted,
            poolRowsByReason: poolTally.byReason,
            poolsFile: poolsFileAt(first),
            handListNotTracked: listed.handListNotTracked,
            oracleRows: oracle.rows,
            oracleRowsRead: oracle.read,
            oracleFile: oracleFileAt(first),
            ...(oracle.error ? { oracleError: oracle.error } : {}),
          },
        }
      : {}),
  };
}

/**
 * The pool list of a list run: the cut's reachable dollar pools of each token, kept only when the chain
 * confirms them, exactly as a DexScreener candidate is. Two calls; DexScreener is not asked.
 */
async function confirmListed(
  chain: ChainConfig,
  rpc: Rpc,
  listed: ListRun,
  maxPools: number,
  at: Date,
): Promise<PoolCache> {
  const confirmed = await confirm(
    chain,
    rpc,
    chain.tokens.map((token) => ({
      token,
      cands: listCandidates(chain, listed.pools[token.symbol] ?? []),
    })),
    Number.MAX_SAFE_INTEGER,
    'latest',
  );
  return {
    chain: chain.id,
    chainId: chain.chainId,
    discoveredAt: at.toISOString(),
    source: `${listed.cut} through ${listed.list}, then token0(), token1(), the factory's getPool() and the position manager's poolKeys() on chain`,
    method: 'cut_candidates_confirmed_onchain',
    maxPools,
    cut: listed.cut,
    tokens: Object.fromEntries(
      confirmed.map((f) => [
        f.token.symbol,
        { address: f.token.address, pools: f.pools, skipped: f.skipped },
      ]),
    ),
  };
}
