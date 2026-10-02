// Finds each token's deepest dollar pools and keeps the list in a file, so a run does not look again.
// DexScreener names the candidates; the chain decides which are kept: a v3-style pool must come from an
// allowlisted factory, a v4 pool must be hookless, and both must pair the token with the dollar token.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Call,
  decodeAggregate3,
  decodePoolKey,
  encodeAggregate3,
  encodePoolKeys,
  type PoolKey,
  SEL,
  words,
  wordToAddress,
  wordToInt,
} from './abi';
import type { ChainConfig, TokenConfig } from './config';
import type { Rpc } from './rpc';

export type PoolRef = {
  kind: 'cl' | 'v4';
  /** Pool address (cl) or pool id (v4). */
  id: string;
  dex: string;
  tokenIs0: boolean;
  fee: number;
  tickSpacing: number;
  /** v4 only: the key the Quoter needs. */
  key?: PoolKey;
  /** DexScreener's liquidity figure when the pool was found. Used only to rank pools. */
  liquidityUsd: number;
};

export type PoolCache = {
  chain: string;
  chainId: number;
  discoveredAt: string;
  source: string;
  method: string;
  maxPools: number;
  tokens: Record<string, { address: string; pools: PoolRef[]; skipped: Record<string, number> }>;
};

export type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
};

export type Candidate = { kind: 'cl' | 'v4'; id: string; dex: string; liquidityUsd: number };

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const ZERO = `0x${'0'.repeat(40)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** DexScreener pairs of the token against the dollar token, deepest first, at most `limit`. */
export function candidates(
  pairs: DexPair[],
  chain: Pick<ChainConfig, 'dexscreener' | 'dollar' | 'v4'>,
  token: TokenConfig,
  opts: { minLiquidityUsd: number; limit: number },
): Candidate[] {
  const out: Candidate[] = [];
  for (const p of pairs) {
    const base = p.baseToken?.address;
    const quote = p.quoteToken?.address;
    const pairsWithDollar =
      (same(base, token.address) && same(quote, chain.dollar.address)) ||
      (same(quote, token.address) && same(base, chain.dollar.address));
    const liquidityUsd = p.liquidity?.usd ?? 0;
    const id = p.pairAddress ?? '';
    if (p.chainId !== chain.dexscreener || !pairsWithDollar) continue;
    if (liquidityUsd < opts.minLiquidityUsd) continue;
    // an address is a pool contract; 32 bytes is a v4 pool id
    const kind = /^0x[0-9a-fA-F]{40}$/.test(id)
      ? 'cl'
      : /^0x[0-9a-fA-F]{64}$/.test(id)
        ? 'v4'
        : null;
    if (!kind || (kind === 'v4' && !chain.v4)) continue;
    out.push({ kind, id, dex: p.dexId ?? 'unknown', liquidityUsd });
  }
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, opts.limit);
}

const CL_READS = [SEL.factory, SEL.token0, SEL.token1, SEL.fee, SEL.tickSpacing];

/** The calls that check candidates on chain: five reads per v3-style pool, one per v4 pool. */
export function verifyCalls(chain: ChainConfig, cands: Candidate[]): Call[] {
  return cands.flatMap((c) =>
    c.kind === 'cl'
      ? CL_READS.map((sel) => ({ target: c.id, callData: `0x${sel}` }))
      : [{ target: chain.v4?.positionManager ?? ZERO, callData: encodePoolKeys(c.id) }],
  );
}

type Reply = { success: boolean; data: string };

/** Keeps the candidates the chain confirms. `replies` are the answers to verifyCalls, in order. */
export function confirm(
  chain: ChainConfig,
  token: TokenConfig,
  cands: Candidate[],
  replies: Reply[],
  maxPools: number,
): { pools: PoolRef[]; skipped: Record<string, number> } {
  const pools: PoolRef[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const isPair = (a: string, b: string) =>
    (same(a, token.address) && same(b, chain.dollar.address)) ||
    (same(b, token.address) && same(a, chain.dollar.address));
  let i = 0;
  for (const c of cands) {
    const mine = replies.slice(i, i + (c.kind === 'cl' ? CL_READS.length : 1));
    i += mine.length;
    if (mine.some((r) => !r?.success || r.data.length < 66)) {
      skip(c.kind === 'cl' ? 'not a v3-style pool' : 'no pool key on the position manager');
      continue;
    }
    if (pools.length >= maxPools) {
      skip('beyond the pool limit');
      continue;
    }
    if (c.kind === 'cl') {
      const [factory, token0, token1, fee, spacing] = mine.map((r) => words(r.data)[0] as bigint);
      const t0 = wordToAddress(token0 as bigint);
      const t1 = wordToAddress(token1 as bigint);
      if (!chain.clFactories.some((f) => same(f, wordToAddress(factory as bigint)))) {
        skip('factory not on the allowlist');
      } else if (!isPair(t0, t1)) {
        skip('not the token against the dollar token');
      } else {
        pools.push({
          kind: 'cl',
          id: c.id,
          dex: c.dex,
          tokenIs0: same(t0, token.address),
          fee: Number(fee),
          tickSpacing: wordToInt(spacing as bigint, 24),
          liquidityUsd: c.liquidityUsd,
        });
      }
      continue;
    }
    const key = decodePoolKey((mine[0] as Reply).data);
    if (key.tickSpacing === 0) skip('no pool key on the position manager');
    else if (!same(key.hooks, ZERO)) skip('has a hook');
    else if (!isPair(key.currency0, key.currency1)) skip('not the token against the dollar token');
    else {
      pools.push({
        kind: 'v4',
        id: c.id,
        dex: c.dex,
        tokenIs0: same(key.currency0, token.address),
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        key,
        liquidityUsd: c.liquidityUsd,
      });
    }
  }
  return { pools, skipped };
}

export type DiscoverOptions = {
  maxPools: number;
  minLiquidityUsd: number;
  /** Candidates checked on chain per token, so hooked or foreign pools do not crowd out the list. */
  candidateLimit: number;
  blockTag: string;
  previous?: PoolCache | null;
  log: (event: Record<string, unknown>) => void;
};

const DEXSCREENER = 'https://api.dexscreener.com/token-pairs/v1';

export async function discover(
  chain: ChainConfig,
  rpc: Rpc,
  opts: DiscoverOptions,
): Promise<PoolCache> {
  const perToken: Array<{ token: TokenConfig; cands: Candidate[] | null }> = [];
  for (const token of chain.tokens) {
    try {
      const res = await fetch(`${DEXSCREENER}/${chain.dexscreener}/${token.address}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pairs = (await res.json()) as DexPair[];
      perToken.push({
        token,
        cands: candidates(Array.isArray(pairs) ? pairs : [], chain, token, {
          minLiquidityUsd: opts.minLiquidityUsd,
          limit: opts.candidateLimit,
        }),
      });
    } catch (e) {
      opts.log({ event: 'discover_failed', token: token.symbol, error: String(e) });
      perToken.push({ token, cands: null });
    }
    await sleep(250);
  }
  const calls = perToken.flatMap((t) => verifyCalls(chain, t.cands ?? []));
  const replies = calls.length
    ? decodeAggregate3(
        await rpc.call<string>('eth_call', [
          { to: chain.multicall3, data: encodeAggregate3(calls) },
          opts.blockTag,
        ]),
      )
    : [];
  const tokens: PoolCache['tokens'] = {};
  let i = 0;
  for (const { token, cands } of perToken) {
    if (!cands) {
      // DexScreener did not answer for this token: keep what the last discovery found
      const kept = opts.previous?.tokens[token.symbol];
      if (kept && same(kept.address, token.address)) tokens[token.symbol] = kept;
      continue;
    }
    const n = verifyCalls(chain, cands).length;
    const found = confirm(chain, token, cands, replies.slice(i, i + n), opts.maxPools);
    i += n;
    tokens[token.symbol] = { address: token.address, ...found };
  }
  return {
    chain: chain.id,
    chainId: chain.chainId,
    discoveredAt: new Date().toISOString(),
    source: `${DEXSCREENER}/${chain.dexscreener}/{token}, then factory(), token0(), token1() and poolKeys() on chain`,
    method: 'dexscreener_candidates_confirmed_onchain',
    maxPools: opts.maxPools,
    tokens,
  };
}

export const cachePath = (dir: string, chain: ChainConfig) => join(dir, `pools-${chain.id}.json`);

export function readCache(path: string): PoolCache | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PoolCache;
  } catch {
    return null;
  }
}

export function writeCache(path: string, cache: PoolCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** True when the cached list can be used as it is: same chain, same tokens, same limit, not too old. */
export function cacheIsFresh(
  cache: PoolCache | null,
  chain: ChainConfig,
  opts: { maxPools: number; maxAgeHours: number; now: Date },
): cache is PoolCache {
  if (!cache || cache.chainId !== chain.chainId || cache.maxPools !== opts.maxPools) return false;
  const ageHours = (opts.now.getTime() - Date.parse(cache.discoveredAt)) / 3_600_000;
  if (!(ageHours >= 0 && ageHours < opts.maxAgeHours)) return false;
  return chain.tokens.every((t) => same(cache.tokens[t.symbol]?.address, t.address));
}
