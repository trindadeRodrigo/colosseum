// One collector run for one chain: every figure is read with eth_call at one block, and one row per
// token is appended to a dated JSONL file. Read-only: no transaction, no key.
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
import {
  cacheIsFresh,
  cachePath,
  discover,
  type PoolCache,
  type PoolRef,
  readCache,
  writeCache,
} from './pools';
import { createRpc, type Rpc, type RpcReply, type RpcRequest } from './rpc';

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
  log: (event: Record<string, unknown>) => void;
};

export type TokenResult = {
  asset: string;
  pools: number;
  refMidUsd: number | null;
  /** Sell cost in percent at $10k and $50k, for the run log. */
  sell10k: number | null;
  sell50k: number | null;
  error?: string;
};

export type RunSummary = {
  chain: string;
  chainId: number;
  block: number;
  blockTime: string;
  rows: number;
  tokens: TokenResult[];
  file: string;
  poolsRediscovered: boolean;
  rpcCalls: number;
  httpRequests: number;
  durationMs: number;
  methodVersion: string;
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

/** The quotes in a reply to quoteRequest, one per size asked; null where the pool gave none. */
export function decodeQuotes(pool: PoolRef, result: string, sizes: number): Array<Quote | null> {
  if (pool.kind === 'cl') {
    const { ins, outs } = decodeClQuote(result);
    return Array.from({ length: sizes }, (_, i) => {
      const out = outs[i] ?? 0n;
      return out > 0n ? { out, filledIn: ins[i] ?? 0n } : null;
    });
  }
  const replies = decodeAggregate3(result);
  return Array.from({ length: sizes }, (_, i) => {
    const r = replies[i];
    // a quote is two words: amountOut and the Quoter's gas estimate
    if (!r?.success || r.data.length !== 130) return null;
    const out = decodeV4Quote(r.data);
    // the deployed v4 Quoter does not say how much of the amount the pool took
    return out > 0n ? { out, filledIn: null } : null;
  });
}

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
    let sizes = job.amounts.length;
    // Multicall3 has no gas limit per call, so one size that exhausts a v4 pool can use up the whole call
    for (let drop = 0; job.pool.kind === 'v4' && reply.error && drop < V4_SIZE_DROPS; drop++) {
      sizes--;
      const retry = quoteRequest(chain, job.pool, job.side, job.amounts.slice(0, sizes), blockTag);
      reply = (await rpc.batch([retry]))[0] as RpcReply;
    }
    if (reply.error || typeof reply.result !== 'string') {
      log({
        event: 'quote_failed',
        asset: token.symbol,
        pool: job.pool.id,
        side: job.side,
        error: reply.error?.message ?? 'no result',
      });
      job.target[job.side] = job.amounts.map(() => null);
      continue;
    }
    const got = decodeQuotes(job.pool, reply.result, sizes);
    job.target[job.side] = job.amounts.map((_, k) => got[k] ?? null);
  }
  return quotes;
}

const costAt = (row: AssetSnapshotRow, usd: number) =>
  row.sell.find((p) => p.notionalUsd === usd)?.costPct ?? null;

export async function collectOnce(chain: ChainConfig, opts: RunOptions): Promise<RunSummary> {
  const started = Date.now();
  const { url, label } = rpcFor(chain, opts.env);
  const rpc = createRpc(url);

  // 1. the chain and the block every later call is pinned to
  const [idReply, blockReply] = await rpc.batch([
    { method: 'eth_chainId', params: [] },
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
  ]);
  const chainId = Number(idReply?.result);
  if (chainId !== chain.chainId)
    throw new Error(`${chain.rpcEnv} answers for chain ${chainId}, not ${chain.chainId}`);
  const head = blockReply?.result as { number?: string; timestamp?: string } | undefined;
  if (!head?.number || !head.timestamp) throw new Error('no latest block from the RPC');
  const blockTag = head.number;
  const blockNumber = Number(blockTag);
  const blockTime = new Date(Number(head.timestamp) * 1000);

  // 2. the pool list, from the file unless it is missing, old or asked for
  const path = cachePath(opts.dir, chain);
  let cache: PoolCache | null = readCache(path);
  let poolsRediscovered = false;
  const fresh = cacheIsFresh(cache, chain, {
    maxPools: opts.maxPools,
    maxAgeHours: opts.poolsMaxAgeHours,
    now: new Date(),
  });
  if (opts.rediscover || !fresh) {
    try {
      cache = await discover(chain, rpc, {
        maxPools: opts.maxPools,
        minLiquidityUsd: opts.minLiquidityUsd,
        candidateLimit: opts.maxPools * 4,
        blockTag,
        previous: cache,
        log: opts.log,
      });
      writeCache(path, cache);
      poolsRediscovered = true;
    } catch (e) {
      if (!cache) throw e;
      opts.log({ event: 'discover_failed_using_old_list', error: String(e) });
    }
  }
  if (!cache) throw new Error('no pool list');
  const tokens = chain.tokens.map((token) => ({
    token,
    pools: cache.tokens[token.symbol]?.pools ?? [],
  }));

  // 3. every pool's price, in one call
  const midCalls: Call[] = tokens.flatMap((t) =>
    t.pools.map((p) => {
      if (p.kind === 'cl') return { target: p.id, callData: `0x${SEL.slot0}` };
      if (!chain.v4) throw new Error(`${chain.id} has a v4 pool listed but no v4 contracts`);
      return { target: chain.v4.stateView, callData: encodeGetSlot0(p.id) };
    }),
  );
  const midReplies = midCalls.length
    ? decodeAggregate3(
        await rpc.call<string>('eth_call', [
          { to: chain.multicall3, data: encodeAggregate3(midCalls) },
          blockTag,
        ]),
      )
    : [];

  // 4. per token: quotes from every pool that has a price, then the row
  const source = `eth_call at block ${blockNumber} on ${chain.name} (chain ${chain.chainId}) through ${label}: Uniswap-v3-style pools by an injected quoter (state override), Uniswap v4 pools by the deployed Quoter; pool list from DexScreener`;
  const file = join(opts.dir, 'assets', `${blockTime.toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(join(opts.dir, 'assets'), { recursive: true });
  const results: TokenResult[] = [];
  let rows = 0;
  let next = 0;
  for (const { token, pools } of tokens) {
    const priced: LivePool[] = [];
    for (const ref of pools) {
      const r = midReplies[next++];
      if (!r?.success || r.data.length < 66) continue;
      const sqrtPrice = decodeSqrtPrice(r.data);
      if (sqrtPrice > 0n)
        priced.push({
          ref,
          midUsd: midUsd(sqrtPrice, ref.tokenIs0, token.decimals, chain.dollar.decimals),
        });
    }
    const live = nearMedian(priced, MAX_MID_GAP);
    const result: TokenResult = {
      asset: token.symbol,
      pools: live.length,
      refMidUsd: live[0]?.midUsd ?? null,
      sell10k: null,
      sell50k: null,
    };
    results.push(result);
    if (live.length === 0) {
      result.error = !pools.length
        ? 'no eligible pool'
        : priced.length
          ? 'the pools disagree on the price'
          : 'no pool returned a price';
      continue;
    }
    try {
      const row = buildRow({
        token,
        dollarDecimals: chain.dollar.decimals,
        blockTime,
        blockNumber,
        pools: await quoteToken(chain, rpc, token, live, blockTag, opts.log),
        source,
      });
      if (!row.sell.some((p) => p.outUsd !== null)) throw new Error('no pool gave a sell quote');
      appendFileSync(file, `${JSON.stringify(row)}\n`);
      rows++;
      result.sell10k = costAt(row, 10_000);
      result.sell50k = costAt(row, 50_000);
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    await sleep(200); // the RPC is free and shared
  }

  const stats = rpc.stats();
  return {
    chain: chain.id,
    chainId: chain.chainId,
    block: blockNumber,
    blockTime: blockTime.toISOString(),
    rows,
    tokens: results,
    file,
    poolsRediscovered,
    rpcCalls: stats.rpcCalls,
    httpRequests: stats.httpRequests,
    durationMs: Date.now() - started,
    methodVersion: METHOD_VERSION,
  };
}
