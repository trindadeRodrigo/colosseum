// Every pool of every stock token on an EVM chain (PLAN-UNIVERSE RU.2), with no I/O: the creation
// events, the merge of the sources, what the vault can reach, and the money a pool holds.
// Method evm-discovery-0.1 (README.md, "The token list and every pool").
//
// Addresses are compared and stored in lower case, except a stock token's own address, which is kept
// as the issuer's registry writes it: that is the key of a token everywhere (two tokens may share a
// symbol), and it is what the collector writes as `assetMint`.
import { addressWord, type Call, SEL, TOPIC, word, words, wordToAddress, wordToInt } from './abi';
import type { ChainConfig } from './config';
import type { DexPair } from './pools';

export const DISCOVERY_METHOD = 'evm-discovery-0.1';

export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const lower = (a: string) => a.toLowerCase();

// ---------------------------------------------------------------------------------------------
// Creation events
// ---------------------------------------------------------------------------------------------

export type RawLog = { address: string; topics: string[]; data: string; blockNumber: string };

/** A pool as its factory (v3) or the pool manager (v4) announced it. */
export type Created = {
  kind: 'cl' | 'v4';
  /** Pool address (cl) or pool id (v4). */
  id: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  /** v4 only. */
  hooks: string | null;
  block: number;
};

const topicAddress = (t: string | undefined) => {
  if (!t || !/^0x[0-9a-fA-F]{64}$/.test(t)) throw new Error(`not a topic: ${t}`);
  return `0x${t.slice(26).toLowerCase()}`;
};

/** PoolCreated of a Uniswap v3 factory. */
export function decodeV3Created(log: RawLog): Created {
  if (log.topics[0] !== TOPIC.v3PoolCreated || log.topics.length !== 4)
    throw new Error('not a PoolCreated log');
  const ws = words(log.data);
  if (ws.length !== 2) throw new Error(`PoolCreated: expected 2 words, got ${ws.length}`);
  return {
    kind: 'cl',
    id: wordToAddress(ws[1] as bigint),
    token0: topicAddress(log.topics[1]),
    token1: topicAddress(log.topics[2]),
    fee: Number(BigInt(log.topics[3] as string)),
    tickSpacing: wordToInt(ws[0] as bigint, 24),
    hooks: null,
    block: Number(log.blockNumber),
  };
}

/** Initialize of the v4 pool manager. */
export function decodeV4Created(log: RawLog): Created {
  if (log.topics[0] !== TOPIC.v4Initialize || log.topics.length !== 4)
    throw new Error('not an Initialize log');
  const ws = words(log.data);
  if (ws.length !== 5) throw new Error(`Initialize: expected 5 words, got ${ws.length}`);
  return {
    kind: 'v4',
    id: (log.topics[1] as string).toLowerCase(),
    token0: topicAddress(log.topics[2]),
    token1: topicAddress(log.topics[3]),
    fee: Number(ws[0] as bigint),
    tickSpacing: wordToInt(ws[1] as bigint, 24),
    hooks: wordToAddress(ws[2] as bigint),
    block: Number(log.blockNumber),
  };
}

export type LogFilter = {
  kind: 'cl' | 'v4';
  address: string;
  topics: Array<string | string[] | null>;
};

/**
 * The filters that list every pool with one of `tokens` on either side: two per source, because a
 * token can be the first or the second of a pair. `address` is the only contract whose events count,
 * so a log that comes back is that contract's own word.
 */
export function creationFilters(chain: ChainConfig, tokens: string[]): LogFilter[] {
  const topics = tokens.map((t) => `0x${addressWord(t)}`);
  const out: LogFilter[] = [];
  for (const f of chain.clFactories) {
    if (f.getPoolBy !== 'fee') continue; // only the Uniswap v3 event is decoded here
    out.push({ kind: 'cl', address: f.address, topics: [TOPIC.v3PoolCreated, topics] });
    out.push({ kind: 'cl', address: f.address, topics: [TOPIC.v3PoolCreated, null, topics] });
  }
  if (chain.v4) {
    const pm = chain.v4.poolManager;
    if (pm) {
      out.push({ kind: 'v4', address: pm, topics: [TOPIC.v4Initialize, null, topics] });
      out.push({ kind: 'v4', address: pm, topics: [TOPIC.v4Initialize, null, null, topics] });
    }
  }
  return out;
}

/** [from, to] block ranges of at most `size` blocks covering from..to, both ends included. */
export function blockWindows(from: number, to: number, size: number): Array<[number, number]> {
  if (!(size >= 1)) throw new Error(`window size must be 1 or more, got ${size}`);
  const out: Array<[number, number]> = [];
  for (let a = from; a <= to; a += size) out.push([a, Math.min(a + size - 1, to)]);
  return out;
}

/** The block span an endpoint says it allows, read from its refusal ("only 100000 are allowed"). */
export function allowedSpan(message: string | undefined): number | null {
  const m = /only (\d+) (?:blocks )?are allowed/i.exec(message ?? '');
  return m ? Number(m[1]) : null;
}

/** True when an endpoint refuses a log query for the number of logs it matched, not for its span. */
export const tooManyLogs = (message: string | undefined) =>
  /exceeds limit|too many (?:logs|results)|response size/i.test(message ?? '');

// ---------------------------------------------------------------------------------------------
// Candidates: one entry per pool, whatever named it
// ---------------------------------------------------------------------------------------------

export type Source = 'dexscreener' | 'v3_factory_log' | 'v3_factory_getpool' | 'v4_initialize_log';

export type DexInfo = {
  dexId: string;
  labels: string[];
  /** DexScreener's own estimates, kept as given. Never used as a pool's TVL. */
  liquidityUsd: number | null;
  volumeH24Usd: number | null;
};

export type Candidate = {
  kind: 'cl' | 'v4';
  id: string;
  /** Null until the chain has said what the pool pairs. */
  token0: string | null;
  token1: string | null;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  /** cl: what factory() of the pool answers. v4: the pool manager. */
  factory: string | null;
  /** True when an allowlisted factory or the pool manager itself named the pool. */
  attested: boolean;
  createdBlock: number | null;
  sources: Source[];
  dex: DexInfo | null;
};

const idKind = (id: string): 'cl' | 'v4' | null =>
  /^0x[0-9a-fA-F]{40}$/.test(id) ? 'cl' : /^0x[0-9a-fA-F]{64}$/.test(id) ? 'v4' : null;

/** Every DexScreener pair of this chain that has `token` on one side, as pool ids with the estimate. */
export function dexPools(
  pairs: Array<DexPair & { labels?: string[]; volume?: { h24?: number } }>,
  chain: Pick<ChainConfig, 'dexscreener'>,
  token: string,
): Array<{ id: string; kind: 'cl' | 'v4'; dex: DexInfo }> {
  const out: Array<{ id: string; kind: 'cl' | 'v4'; dex: DexInfo }> = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (p.chainId !== chain.dexscreener) continue;
    const has = [p.baseToken?.address, p.quoteToken?.address].some(
      (a) => a?.toLowerCase() === token.toLowerCase(),
    );
    const id = (p.pairAddress ?? '').toLowerCase();
    const kind = idKind(id);
    if (!has || !kind || seen.has(id)) continue;
    seen.add(id);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      id,
      kind,
      dex: {
        dexId: p.dexId ?? 'unknown',
        labels: Array.isArray(p.labels) ? p.labels.filter((l) => typeof l === 'string') : [],
        liquidityUsd: num(p.liquidity?.usd),
        volumeH24Usd: num(p.volume?.h24),
      },
    });
  }
  return out;
}

/** One candidate per pool id from the creation events and DexScreener's pairs. */
export function mergeCandidates(
  chain: ChainConfig,
  created: Created[],
  fromDex: Array<{ id: string; kind: 'cl' | 'v4'; dex: DexInfo }>,
): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const c of created) {
    if (out.has(c.id)) continue; // the same event came back under both filters (a pool of two stocks)
    out.set(c.id, {
      kind: c.kind,
      id: c.id,
      token0: c.token0,
      token1: c.token1,
      fee: c.fee,
      tickSpacing: c.tickSpacing,
      hooks: c.hooks,
      factory:
        c.kind === 'v4'
          ? lower(chain.v4?.poolManager ?? ZERO_ADDRESS)
          : lower(chain.clFactories.find((f) => f.getPoolBy === 'fee')?.address ?? ZERO_ADDRESS),
      attested: true,
      createdBlock: c.block,
      sources: [c.kind === 'v4' ? 'v4_initialize_log' : 'v3_factory_log'],
      dex: null,
    });
  }
  for (const d of fromDex) {
    const have = out.get(d.id);
    if (have) {
      if (!have.sources.includes('dexscreener')) have.sources.push('dexscreener');
      have.dex ??= d.dex;
      continue;
    }
    out.set(d.id, {
      kind: d.kind,
      id: d.id,
      token0: null,
      token1: null,
      fee: null,
      tickSpacing: null,
      hooks: null,
      factory: null,
      attested: false,
      createdBlock: null,
      sources: ['dexscreener'],
      dex: d.dex,
    });
  }
  return out;
}

/** What is read from a v3-style pool nobody has vouched for yet: five calls. */
export const CL_SELF_READS = [SEL.token0, SEL.token1, SEL.factory, SEL.fee, SEL.tickSpacing];

export type Answer = { success: boolean; data: string };
const oneWord = (r: Answer | undefined): bigint | null =>
  r?.success && r.data.length === 66 ? BigInt(r.data) : null;

/**
 * Fills a DexScreener-only v3-style candidate from the pool's own answers to CL_SELF_READS. Returns
 * why it is refused, or null when it is kept. token0() and token1() must answer: a pool that cannot
 * say what it pairs is not confirmed. factory(), fee() and tickSpacing() may be missing (another
 * venue's pool need not have them).
 */
export function fillFromSelf(c: Candidate, replies: Answer[]): string | null {
  const [t0, t1, factory, fee, spacing] = replies.map(oneWord);
  if (t0 === null || t1 === null || t0 === undefined || t1 === undefined)
    return 'does_not_answer_token0_token1';
  c.token0 = wordToAddress(t0);
  c.token1 = wordToAddress(t1);
  c.factory = factory === null || factory === undefined ? null : wordToAddress(factory);
  c.fee = fee === null || fee === undefined ? null : Number(fee);
  c.tickSpacing = spacing === null || spacing === undefined ? null : wordToInt(spacing, 24);
  return null;
}

/** The factories getPoolCalls asks for a tier, in the order of its calls. */
export const getPoolFactories = (
  chain: ChainConfig,
  tier: { fee: number | null; tickSpacing: number | null },
): string[] =>
  chain.clFactories
    .filter((f) => {
      const by = f.getPoolBy === 'fee' ? tier.fee : tier.tickSpacing;
      return by !== null && by >= 0;
    })
    .map((f) => f.address.toLowerCase());

/** getPool on every allowlisted factory for a pair at one fee (or tick spacing). */
export function getPoolCalls(
  chain: ChainConfig,
  a: string,
  b: string,
  tier: { fee: number | null; tickSpacing: number | null },
): Call[] {
  const [t0, t1] = lower(a) < lower(b) ? [a, b] : [b, a];
  return chain.clFactories.flatMap((f) => {
    const by = f.getPoolBy === 'fee' ? tier.fee : tier.tickSpacing;
    if (by === null || by < 0) return [];
    return [
      {
        target: f.address,
        callData: `0x${f.getPoolBy === 'fee' ? SEL.getPoolByFee : SEL.getPoolByTickSpacing}${addressWord(t0)}${addressWord(t1)}${word(by)}`,
      },
    ];
  });
}

/** The pool address in a getPool answer, lower case; null for "no such pool". */
export const poolOf = (r: Answer | undefined): string | null => {
  const w = oneWord(r);
  if (w === null || w === 0n) return null;
  return wordToAddress(w);
};

// ---------------------------------------------------------------------------------------------
// Filing and reach
// ---------------------------------------------------------------------------------------------

export type Filing = {
  /** The stock the pool is filed under: the registry's address of it. */
  token: string;
  other: string;
  tokenIs0: boolean;
  /** True when the other side is a stock of the registry too. */
  otherIsStock: boolean;
  filedUnder: 'its_only_stock' | 'token0_of_two_stocks';
};

/**
 * Which stock a pool is filed under. `stocks` maps a lower-case address to the registry's spelling.
 * A pool is one row. With one stock in the pair it is that stock's; with two it is filed under token0
 * (the lower address), and `otherIsStock` says the other side would claim it too. Null when neither
 * side is a stock of the registry.
 */
export function fileUnder(
  token0: string,
  token1: string,
  stocks: ReadonlyMap<string, string>,
): Filing | null {
  const s0 = stocks.get(lower(token0));
  const s1 = stocks.get(lower(token1));
  if (s0 && s1)
    return {
      token: s0,
      other: lower(token1),
      tokenIs0: true,
      otherIsStock: true,
      filedUnder: 'token0_of_two_stocks',
    };
  if (s0)
    return {
      token: s0,
      other: lower(token1),
      tokenIs0: true,
      otherIsStock: false,
      filedUnder: 'its_only_stock',
    };
  if (s1)
    return {
      token: s1,
      other: lower(token0),
      tokenIs0: false,
      otherIsStock: false,
      filedUnder: 'its_only_stock',
    };
  return null;
}

export type Reach = {
  reachable: boolean;
  unreachableReason: 'has_hook' | 'other_venue' | null;
};

/**
 * Whether the vault's swap path reaches the pool (DESIGN-VAULT section 8: the allowlisted factories'
 * pools and hookless v4 pools). A pool it cannot reach is kept and marked, never dropped (DU3).
 */
export function reach(c: Pick<Candidate, 'kind' | 'hooks' | 'attested'>): Reach {
  if (c.kind === 'v4')
    return c.hooks !== null && lower(c.hooks) === ZERO_ADDRESS && c.attested
      ? { reachable: true, unreachableReason: null }
      : { reachable: false, unreachableReason: 'has_hook' };
  return c.attested
    ? { reachable: true, unreachableReason: null }
    : { reachable: false, unreachableReason: 'other_venue' };
}

/** A name for the venue: the allowlisted factory's, "uniswap-v4", or DexScreener's word for it. */
export function venueOf(chain: ChainConfig, c: Candidate): string {
  if (c.kind === 'v4') return 'uniswap-v4';
  if (c.attested) {
    const f = chain.clFactories.find((x) => lower(x.address) === c.factory);
    return f?.name ?? `factory:${c.factory}`;
  }
  if (c.dex) return [c.dex.dexId, ...c.dex.labels].join('-').toLowerCase();
  return c.factory ? `factory:${c.factory}` : 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/** Raw token1 per raw token0 at a pool's price. */
export const raw1Per0 = (sqrtPriceX96: bigint): number => {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s;
};

/**
 * Dollars per raw unit of a token, from a pool that pairs it with the dollar token (one dollar token
 * counts as one dollar, as everywhere in this collector). Decimals of the token are not needed.
 */
export function usdPerRawFromPool(
  sqrtPriceX96: bigint,
  tokenIs0: boolean,
  dollarDecimals: number,
): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  const p = raw1Per0(sqrtPriceX96);
  const dollarRawPerTokenRaw = tokenIs0 ? p : 1 / p;
  const v = dollarRawPerTokenRaw / 10 ** dollarDecimals;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Uniswap's tick bounds: a price is 1.0001^tick. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** The ticks a band of `band` either side of the price reaches (0.5 = from price / 1.5 to price × 1.5). */
export function bandTicks(tick: number, band: number): { lo: number; hi: number } {
  if (!(band > 0)) throw new Error(`band must be above 0, got ${band}`);
  const d = Math.ceil(Math.log(1 + band) / Math.log(1.0001));
  return { lo: Math.max(MIN_TICK, tick - d), hi: Math.min(MAX_TICK, tick + d) };
}

/** The tick-bitmap words that hold the initialized ticks between `lo` and `hi`, for one tick spacing. */
export function bitmapWords(lo: number, hi: number, tickSpacing: number): number[] {
  if (!(tickSpacing > 0)) throw new Error(`tick spacing must be positive, got ${tickSpacing}`);
  const first = Math.floor(lo / tickSpacing) >> 8;
  const last = Math.floor(hi / tickSpacing) >> 8;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** The initialized ticks a bitmap word names, lowest first. */
export function ticksOfWord(wordPos: number, bitmap: bigint, tickSpacing: number): number[] {
  const out: number[] = [];
  for (let bit = 0; bit < 256; bit++)
    if ((bitmap >> BigInt(bit)) & 1n) out.push((wordPos * 256 + bit) * tickSpacing);
  return out;
}

const sqrtAtTick = (tick: number) => 1.0001 ** (tick / 2);

/**
 * What the pool's positions hold between the ticks `lo` and `hi`: raw token0 above the price and raw
 * token1 below it, following the liquidity as it changes at each initialized tick. `ticks` are the
 * initialized ticks inside [lo, hi] with their liquidityNet. Liquidity placed outside the band is not
 * counted, so this is at most what the pool holds.
 */
export function amountsInBand(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tick: number,
  ticks: Array<{ tick: number; liquidityNet: bigint }>,
  range: { lo: number; hi: number },
): { raw0: number; raw1: number } {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  if (!(s > 0)) return { raw0: 0, raw1: 0 };
  const sorted = [...ticks].sort((a, b) => a.tick - b.tick);
  // upward: token0 is what a buyer takes out as the price rises
  let raw0 = 0;
  let l = Number(liquidity);
  let at = s;
  for (const t of sorted) {
    if (t.tick <= tick || t.tick > range.hi) continue;
    const next = sqrtAtTick(t.tick);
    if (next > at) raw0 += l * (1 / at - 1 / next);
    at = Math.max(at, next);
    l += Number(t.liquidityNet);
  }
  const top = sqrtAtTick(range.hi);
  if (top > at && l > 0) raw0 += l * (1 / at - 1 / top);
  // downward: token1 is what a seller takes out as the price falls
  let raw1 = 0;
  l = Number(liquidity);
  at = s;
  for (const t of sorted.reverse()) {
    if (t.tick > tick || t.tick < range.lo) continue;
    const next = sqrtAtTick(t.tick);
    if (next < at) raw1 += l * (at - next);
    at = Math.min(at, next);
    l -= Number(t.liquidityNet);
  }
  const bottom = sqrtAtTick(range.lo);
  if (bottom < at && l > 0) raw1 += l * (at - bottom);
  return { raw0, raw1 };
}

export type Price = {
  /** Lower-case address; the zero address is the chain's native coin. */
  address: string;
  /** Dollars per raw unit; null when not measured. */
  usdPerRaw: number | null;
  method:
    | 'dollar_token_counts_as_one'
    | 'mid_of_deepest_dollar_pool'
    | 'mid_of_deepest_v4_dollar_pool'
    | 'same_as_wrapped_native'
    | null;
  /** The pool the price was read from, and the dollar tokens it held (v4: within the band). */
  refPool: string | null;
  refDollarUsd: number | null;
  reason: 'no_dollar_pool_above_floor' | 'not_looked_up' | null;
  block: number | null;
};

/** A dollar pool of a token, as read at one block. */
export type DollarPool = {
  id: string;
  kind: 'cl' | 'v4';
  tokenIs0: boolean;
  sqrtPriceX96: bigint;
  /** Dollar tokens the pool holds, in dollars (v4: within the band). */
  dollarUsd: number;
  block: number;
};

/**
 * The price of a token from its dollar pools, of either kind: the mid of the pool holding the most
 * dollar tokens, if that pool holds at least `minRefUsd`. A thinner pool prices nothing: its mid moves
 * with a small trade. The caller passes only pools with liquidity in range: a pool with none keeps a
 * stale price. Equal depth falls back to the pool id so the choice does not depend on input order.
 */
export function priceFromDollarPools(
  address: string,
  pools: DollarPool[],
  dollarDecimals: number,
  minRefUsd: number,
): Price {
  const best = [...pools]
    .filter((p) => p.dollarUsd >= minRefUsd && p.sqrtPriceX96 > 0n)
    .sort((a, b) => b.dollarUsd - a.dollarUsd || (a.id < b.id ? -1 : 1))[0];
  const usdPerRaw = best
    ? usdPerRawFromPool(best.sqrtPriceX96, best.tokenIs0, dollarDecimals)
    : null;
  if (!best || usdPerRaw === null)
    return {
      address: lower(address),
      usdPerRaw: null,
      method: null,
      refPool: null,
      refDollarUsd: null,
      reason: 'no_dollar_pool_above_floor',
      block: null,
    };
  return {
    address: lower(address),
    usdPerRaw,
    method: best.kind === 'cl' ? 'mid_of_deepest_dollar_pool' : 'mid_of_deepest_v4_dollar_pool',
    refPool: best.id,
    refDollarUsd: best.dollarUsd,
    reason: null,
    block: best.block,
  };
}

/** What was read from a pool at one block. Amounts are raw units. */
export type PoolState = {
  block: number;
  /** Time of that block. */
  fetchedAt: string;
  /** cl: the pool's own balance of each token. Null on v4: the pool manager holds every pool's money. */
  balance0: bigint | null;
  balance1: bigint | null;
  /** Null where the pool gave none (a venue without slot0() or liquidity()). */
  sqrtPriceX96: bigint | null;
  liquidity: bigint | null;
  tick: number | null;
  /**
   * Raw amounts the positions hold within the band of the price (amountsInBand); null where the ticks
   * were not read.
   */
  inBand: { raw0: number; raw1: number } | null;
};

export type Money = {
  /** The stock side, the other side, and their sum, in dollars. Null = not measured, never zero. */
  tokenUsd: number | null;
  otherUsd: number | null;
  tvlUsd: number | null;
  tvlMethod: 'balances_held_by_the_pool' | 'v4_positions_within_band_of_the_price' | null;
  tvlReason:
    | 'token_not_priced'
    | 'other_token_not_priced'
    | 'stock_side_below_floor_other_token_not_looked_up'
    | 'pool_state_not_read'
    | null;
  /**
   * What the positions hold within the band, on any pool whose ticks were read, Uniswap v3 pools
   * included: there it sits beside the measured balances, so a reader can see how the two compare.
   */
  bandUsd: number | null;
};

/**
 * The money in a pool. cl: the balances the pool holds, each at its token's price. v4: what its
 * positions hold within the band of the price (the pool manager holds every pool's balances in one
 * account, so a v4 pool has no balance of its own to read), labelled as such. A side whose token has no price makes the total null with the reason;
 * a total is never the sum of one side and a zero.
 */
export function money(
  kind: 'cl' | 'v4',
  tokenIs0: boolean,
  state: PoolState,
  price: { token: number | null; other: number | null; otherLookedUp?: boolean },
): Money {
  const [p0, p1] = tokenIs0 ? [price.token, price.other] : [price.other, price.token];
  const sides = (a0: number | null, a1: number | null) => {
    const u0 = a0 === null || p0 === null ? null : a0 * p0;
    const u1 = a1 === null || p1 === null ? null : a1 * p1;
    return tokenIs0 ? { tokenUsd: u0, otherUsd: u1 } : { tokenUsd: u1, otherUsd: u0 };
  };
  const inBand = state.inBand;
  const bandSides = inBand ? sides(inBand.raw0, inBand.raw1) : null;
  const bandUsd =
    bandSides && bandSides.tokenUsd !== null && bandSides.otherUsd !== null
      ? bandSides.tokenUsd + bandSides.otherUsd
      : null;
  const measured =
    kind === 'cl'
      ? state.balance0 !== null && state.balance1 !== null
        ? sides(Number(state.balance0), Number(state.balance1))
        : null
      : bandSides;
  if (!measured)
    return {
      tokenUsd: null,
      otherUsd: null,
      tvlUsd: null,
      tvlMethod: null,
      tvlReason: 'pool_state_not_read',
      bandUsd,
    };
  const tvlUsd =
    measured.tokenUsd !== null && measured.otherUsd !== null
      ? measured.tokenUsd + measured.otherUsd
      : null;
  return {
    ...measured,
    tvlUsd,
    tvlMethod:
      tvlUsd === null
        ? null
        : kind === 'cl'
          ? 'balances_held_by_the_pool'
          : 'v4_positions_within_band_of_the_price',
    tvlReason:
      tvlUsd !== null
        ? null
        : price.token === null
          ? 'token_not_priced'
          : price.otherLookedUp === false
            ? 'stock_side_below_floor_other_token_not_looked_up'
            : 'other_token_not_priced',
    bandUsd,
  };
}

/**
 * True when a pool was read and has nothing a row could describe: no balance (cl), no liquidity in
 * range (v4). A pool whose read failed is not idle: it keeps its row, with `pool_state_not_read`.
 */
export const isIdle = (kind: 'cl' | 'v4', s: PoolState): boolean =>
  kind === 'cl' ? s.balance0 === 0n && s.balance1 === 0n : s.liquidity === 0n;

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

export type PoolRow = {
  id: string;
  kind: 'cl' | 'v4';
  venue: string;
  factory: string | null;
  /** The stock this pool is filed under: its address as the registry writes it. */
  token: string;
  symbol: string;
  other: string;
  /** The other side's symbol where it is known without a read: a stock, the dollar token, the native coin. */
  otherSymbol: string | null;
  otherIsStock: boolean;
  filedUnder: Filing['filedUnder'];
  tokenIs0: boolean;
  againstDollar: boolean;
  fee: number | null;
  tickSpacing: number | null;
  hooks: string | null;
  sources: Source[];
  createdBlock: number | null;
  reachable: boolean;
  unreachableReason: Reach['unreachableReason'];
  block: number;
  fetchedAt: string;
  /** Raw amounts as decimal strings; null where the pool has none of its own (v4) or gave none. */
  balanceToken: string | null;
  balanceOther: string | null;
  liquidity: string | null;
  sqrtPriceX96: string | null;
  dexscreener: DexInfo | null;
} & Money;

export type TokenSummary = {
  address: string;
  symbol: string;
  status: 'pools' | 'no_pool' | 'not_confirmed';
  /** Rows in `pools` filed under this token. */
  pools: number;
  reachable: number;
  byVenue: Record<string, number>;
  /** Sum of the rows' measured TVL; null when no row has one. Rows without one are counted beside it. */
  tvlUsd: number | null;
  tvlUnmeasured: number;
  /** Pools the chain announced for the token that hold nothing now, and so have no row. */
  idle: { clNoBalance: number; v4NoLiquidityInRange: number };
  /** Candidates that were not confirmed on chain, by reason. */
  refused: Record<string, number>;
  /** What this run could not have seen for the token. Empty = every source answered in full. */
  gaps: string[];
};

/**
 * What a run could not have seen for one token. Without the creation events, the pools are only those
 * DexScreener lists (at most 30 a token) and those the factory names for the pairs seen. Other venues
 * are only ever known from DexScreener.
 */
export function gapsFor(o: {
  eventsUsed: boolean;
  dexFailed: boolean;
  dexAtCap: boolean;
}): string[] {
  const g: string[] = [];
  if (!o.eventsUsed)
    g.push('v4_pools_from_dexscreener_only', 'v3_pools_from_dexscreener_and_getpool_only');
  if (o.dexFailed) g.push('dexscreener_failed_other_venues_not_listed');
  else if (o.dexAtCap) g.push('dexscreener_at_its_cap_other_venues_may_be_missing');
  return g;
}

/** One summary per token of the universe, in its order. Every token gets one, pools or not. */
export function summarize(
  tokens: Array<{ address: string; symbol: string; confirmed: boolean }>,
  rows: PoolRow[],
  extra: {
    idle: ReadonlyMap<string, { clNoBalance: number; v4NoLiquidityInRange: number }>;
    refused: ReadonlyMap<string, Record<string, number>>;
    gaps: ReadonlyMap<string, string[]>;
  },
): TokenSummary[] {
  const by = new Map<string, PoolRow[]>();
  for (const r of rows) {
    const list = by.get(r.token);
    if (list) list.push(r);
    else by.set(r.token, [r]);
  }
  return tokens.map((t) => {
    const mine = by.get(t.address) ?? [];
    const byVenue: Record<string, number> = {};
    for (const r of mine) byVenue[r.venue] = (byVenue[r.venue] ?? 0) + 1;
    const measured = mine.filter((r) => r.tvlUsd !== null);
    return {
      address: t.address,
      symbol: t.symbol,
      status: !t.confirmed ? 'not_confirmed' : mine.length > 0 ? 'pools' : 'no_pool',
      pools: mine.length,
      reachable: mine.filter((r) => r.reachable).length,
      byVenue,
      tvlUsd: measured.length ? measured.reduce((s, r) => s + (r.tvlUsd as number), 0) : null,
      tvlUnmeasured: mine.length - measured.length,
      idle: extra.idle.get(t.address) ?? { clNoBalance: 0, v4NoLiquidityInRange: 0 },
      refused: extra.refused.get(t.address) ?? {},
      gaps: extra.gaps.get(t.address) ?? [],
    };
  });
}
