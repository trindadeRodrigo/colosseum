// Finds each token's deepest dollar pools and keeps the list in a file, so a run does not look again.
// DexScreener names the candidates; the chain decides which are kept: a v3-style pool must be the one an
// allowlisted factory deployed, a v4 pool must be hookless, and both must pair the token with the dollar token.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  addressWord,
  type Call,
  decodeAggregate3,
  decodePoolKey,
  encodeAggregate3,
  encodePoolKeys,
  type PoolKey,
  SEL,
  word,
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
  /** Set when the candidates came from a cut file through the asset list (a list run): its name. */
  cut?: string;
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

const CL_READS = [SEL.token0, SEL.token1, SEL.fee, SEL.tickSpacing];

/** First round of on-chain checks: four reads per v3-style candidate, the pool key per v4 candidate. */
export function verifyCalls(chain: ChainConfig, cands: Candidate[]): Call[] {
  return cands.flatMap((c) =>
    c.kind === 'cl'
      ? CL_READS.map((sel) => ({ target: c.id, callData: `0x${sel}` }))
      : [{ target: chain.v4?.positionManager ?? ZERO, callData: encodePoolKeys(c.id) }],
  );
}

type Reply = { success: boolean; data: string };
type Skipped = Record<string, number>;
const skip = (skipped: Skipped, why: string) => {
  skipped[why] = (skipped[why] ?? 0) + 1;
};

/**
 * The candidates that pair the token with the dollar token, in the order given. `replies` are the
 * answers to verifyCalls. A v4 pool must have no hook. A v3-style pool is not trusted yet: what it
 * says about itself still has to be confirmed by a factory (factoryCalls, attested).
 */
export function eligible(
  chain: ChainConfig,
  token: TokenConfig,
  cands: Candidate[],
  replies: Reply[],
): { pools: PoolRef[]; skipped: Skipped } {
  const pools: PoolRef[] = [];
  const skipped: Skipped = {};
  const isPair = (a: string, b: string) =>
    (same(a, token.address) && same(b, chain.dollar.address)) ||
    (same(b, token.address) && same(a, chain.dollar.address));
  let i = 0;
  for (const c of cands) {
    const mine = replies.slice(i, i + (c.kind === 'cl' ? CL_READS.length : 1));
    i += mine.length;
    if (mine.some((r) => !r?.success || r.data.length < 66)) {
      skip(
        skipped,
        c.kind === 'cl' ? 'not a v3-style pool' : 'no pool key on the position manager',
      );
      continue;
    }
    const shared = { id: c.id, dex: c.dex, liquidityUsd: c.liquidityUsd };
    if (c.kind === 'cl') {
      const [token0, token1, fee, spacing] = mine.map((r) => words(r.data)[0] as bigint);
      const t0 = wordToAddress(token0 as bigint);
      if (!isPair(t0, wordToAddress(token1 as bigint))) {
        skip(skipped, 'not the token against the dollar token');
        continue;
      }
      pools.push({
        kind: 'cl',
        ...shared,
        tokenIs0: same(t0, token.address),
        fee: Number(fee),
        tickSpacing: wordToInt(spacing as bigint, 24),
      });
      continue;
    }
    const key = decodePoolKey((mine[0] as Reply).data);
    if (key.tickSpacing === 0) skip(skipped, 'no pool key on the position manager');
    else if (!same(key.hooks, ZERO)) skip(skipped, 'has a hook');
    else if (!isPair(key.currency0, key.currency1))
      skip(skipped, 'not the token against the dollar token');
    else
      pools.push({
        kind: 'v4',
        ...shared,
        tokenIs0: same(key.currency0, token.address),
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        key,
      });
  }
  return { pools, skipped };
}

/**
 * Second round: each allowlisted factory is asked which pool it deployed for the pair and fee (or tick
 * spacing) a v3-style candidate reports. A contract can claim any factory; only the factory's own
 * answer counts.
 */
export function factoryCalls(chain: ChainConfig, token: TokenConfig, pools: PoolRef[]): Call[] {
  return pools
    .filter((p) => p.kind === 'cl')
    .flatMap((p) => {
      const [t0, t1] = p.tokenIs0
        ? [token.address, chain.dollar.address]
        : [chain.dollar.address, token.address];
      return chain.clFactories.map((f) => ({
        target: f.address,
        callData:
          f.getPoolBy === 'fee'
            ? `0x${SEL.getPoolByFee}${addressWord(t0)}${addressWord(t1)}${word(p.fee)}`
            : `0x${SEL.getPoolByTickSpacing}${addressWord(t0)}${addressWord(t1)}${word(p.tickSpacing)}`,
      }));
    });
}

/** The pools a factory vouches for (v4 pools pass as they are), deepest first, up to `maxPools`. */
export function attested(
  chain: ChainConfig,
  found: { pools: PoolRef[]; skipped: Skipped },
  replies: Reply[],
  maxPools: number,
): { pools: PoolRef[]; skipped: Skipped } {
  const pools: PoolRef[] = [];
  const skipped = { ...found.skipped };
  let i = 0;
  for (const p of found.pools) {
    if (p.kind === 'cl') {
      const mine = replies.slice(i, i + chain.clFactories.length);
      i += mine.length;
      const vouched = mine.some(
        (r) => r?.success && r.data.length === 66 && same(wordToAddress(BigInt(r.data)), p.id),
      );
      if (!vouched) {
        skip(skipped, 'not a pool of an allowlisted factory');
        continue;
      }
    }
    if (pools.length >= maxPools) skip(skipped, 'beyond the pool limit');
    else pools.push(p);
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

/**
 * The on-chain word on each token's candidates, in two calls at `blockTag`: what each pool says of
 * itself, then which v3-style pools a factory vouches for. Wherever the candidates come from
 * (DexScreener, or a cut file), a pool is kept only by this.
 */
export async function confirm(
  chain: ChainConfig,
  rpc: Rpc,
  perToken: Array<{ token: TokenConfig; cands: Candidate[] | null }>,
  maxPools: number,
  blockTag: string,
): Promise<
  Array<{ token: TokenConfig; cands: Candidate[] | null; pools: PoolRef[]; skipped: Skipped }>
> {
  const multicall = async (calls: Call[]): Promise<Reply[]> =>
    calls.length
      ? decodeAggregate3(
          await rpc.call<string>('eth_call', [
            { to: chain.multicall3, data: encodeAggregate3(calls) },
            blockTag,
          ]),
        )
      : [];
  const first = await multicall(perToken.flatMap((t) => verifyCalls(chain, t.cands ?? [])));
  let at = 0;
  const found = perToken.map(({ token, cands }) => {
    const n = verifyCalls(chain, cands ?? []).length;
    const mine = first.slice(at, at + n);
    at += n;
    return { token, cands, ...eligible(chain, token, cands ?? [], mine) };
  });
  const second = await multicall(found.flatMap((f) => factoryCalls(chain, f.token, f.pools)));
  at = 0;
  return found.map((f) => {
    const n = factoryCalls(chain, f.token, f.pools).length;
    const kept = attested(chain, f, second.slice(at, at + n), maxPools);
    at += n;
    return { token: f.token, cands: f.cands, ...kept };
  });
}

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
      if (!Array.isArray(pairs)) throw new Error('not a list of pairs');
      perToken.push({
        token,
        cands: candidates(pairs, chain, token, {
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

  const confirmed = await confirm(chain, rpc, perToken, opts.maxPools, opts.blockTag);
  const tokens: PoolCache['tokens'] = {};
  for (const f of confirmed) {
    const kept = { pools: f.pools, skipped: f.skipped };
    const before = opts.previous?.tokens[f.token.symbol];
    const usable = before && same(before.address, f.token.address) && before.pools.length > 0;
    if (kept.pools.length === 0 && usable) {
      // DexScreener failed or came back empty for a token that had pools: keep the last list
      opts.log({ event: 'discover_kept_old_list', token: f.token.symbol });
      tokens[f.token.symbol] = before;
    } else if (f.cands) {
      tokens[f.token.symbol] = { address: f.token.address, ...kept };
    }
  }
  return {
    chain: chain.id,
    chainId: chain.chainId,
    discoveredAt: new Date().toISOString(),
    source: `${DEXSCREENER}/${chain.dexscreener}/{token}, then token0(), token1(), the factory's getPool() and the position manager's poolKeys() on chain`,
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
