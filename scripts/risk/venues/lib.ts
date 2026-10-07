import {
  CLMM_POOL_SIZE,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeCpmmPool,
  decodeDlmmPair,
  decodeWhirlpool,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
} from '@colosseum/risk';
import { mean, median, type StoredQuote } from '../lib-routing-gap';

// PLAN-UNIVERSE RU.13 — the venues we do not read, ranked. One table per chain and a ranking; no decoder is built.
//
// What is measured and what is an estimate, kept apart everywhere below:
// - measured: where Jupiter's stored quotes route an amount (the collector's own rows), who owns each pool on those
//   routes (one chain read), what a pool held on chain at the registry run, the swaps of Robinhood Chain's pools;
// - estimate: DexScreener's liquidity and 24-hour volume, at most 30 pairs a token. An estimate carries its cap.
// A figure nobody has is null with its reason, never zero. Nothing here reads an oracle (gate ORACLE-VS-DEX).
//
// Pure: no file, no environment, no clock, no network. The callers read the files.

export const VENUES_METHOD = 'venues-0.1';
export const ROUTE_POOLS_METHOD = 'route-pools-0.1';
export const BYREAL_PROBE_METHOD = 'byreal-probe-0.1';
/** DexScreener's token-pairs endpoint returns at most this many pairs a token. */
export const DEXSCREENER_PAIR_CAP = 30;

// ---------------------------------------------------------------------------------------------------------------------
// The chain read of the pools on Jupiter's routes
// ---------------------------------------------------------------------------------------------------------------------

/** One pool named on a stored Jupiter route, as the chain answered for it. */
export type RoutePoolRow = {
  address: string;
  /** Jupiter's label for the pool on the routes that name it. */
  labels: string[];
  /** The program that owns the account; null when the chain has no such account. */
  owner: string | null;
  /** Bytes of the account. */
  space: number | null;
  /**
   * The whole account, base64, where the owner is a program `packages/risk` decodes or the account has the size of a
   * Raydium concentrated-liquidity pool (Byreal's and PancakeSwap's do).
   */
  data?: string;
};

/** A token account a pool names as one of its two vaults, as the chain answered. */
export type VaultRow = { mint: string; amount: string; decimals: number };

/** The file `pnpm risk:venues-freeze-pools` writes: one chain read of every pool on a stored route. */
export type RoutePoolsFile = {
  method: string;
  source: string;
  fetchedAt: string;
  slot: number;
  provenance: string;
  quotes: { folder: string; withARoute: number; first: string | null; last: string | null };
  rpc: { calls: number; retries: number; seconds: number };
  /** Jupiter's own table of program to label, taken in the same run. */
  programLabels: { source: string; fetchedAt: string; labels: Record<string, string> };
  /** Symbols of the mints the decoded pools name, from Jupiter's token search in the same run. */
  tokens: { source: string; fetchedAt: string; symbols: Record<string, string> };
  /**
   * The two vaults of each pool that has Raydium's pool size under another program and pairs a tracked stock: what
   * the pool held at `slot`. Keyed by the vault's address.
   */
  vaults: Record<string, VaultRow>;
  pools: RoutePoolRow[];
};

/** The programs `packages/risk` has a validated decoder for (PLAN-RISK Step 2). */
export const DECODED_PROGRAMS: Record<string, string> = {
  [RAYDIUM_CLMM_PROGRAM]: 'raydium_clmm',
  [RAYDIUM_CPMM_PROGRAM]: 'raydium_cpmm',
  [ORCA_WHIRLPOOL_PROGRAM]: 'orca_whirlpool',
  [METEORA_DLMM_PROGRAM]: 'meteora_dlmm',
};

const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

/**
 * The two mints of a pool, read with the decoder of its program. A pool of another program that has the size of a
 * Raydium concentrated-liquidity pool is read with Raydium's header (`decodeClmmPool`): that this is its layout is
 * not proven by a size, so the callers check what comes out (a stock leg's pool must hold the stock). Null when the
 * file holds no bytes for the pool or they do not decode.
 */
export function poolMints(row: RoutePoolRow): [string, string] | null {
  if (!row.data || !row.owner) return null;
  const data = bytesOf(row.data);
  try {
    if (row.owner === ORCA_WHIRLPOOL_PROGRAM) {
      const h = decodeWhirlpool(data);
      return [h.mintA, h.mintB];
    }
    if (row.owner === METEORA_DLMM_PROGRAM) {
      const h = decodeDlmmPair(data);
      return [h.mintX, h.mintY];
    }
    if (row.owner === RAYDIUM_CPMM_PROGRAM) {
      const h = decodeCpmmPool(data);
      return [h.mint0, h.mint1];
    }
    if (row.owner === RAYDIUM_CLMM_PROGRAM || data.length === CLMM_POOL_SIZE) {
      const h = decodeClmmPool(data);
      return [h.mint0, h.mint1];
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// What each pool on a route is to us
// ---------------------------------------------------------------------------------------------------------------------

/** A pool the collector's registry holds: it is read every 5 minutes or every hour. */
export type RegistryPool = { address: string; venue: string; exitPath: string };
/** Every pool the registry run found on the four decoded programs, dust included. */
export type KnownPool = { address: string; asset: string; tvlUsd: number | null };

export type PoolClass =
  /** In the collector's registry. The router uses `direct_usd` and `via_sol`; the others are collected and listed. */
  | { kind: 'read'; venue: string; exitPath: string }
  /**
   * On a program we decode, holding a tracked stock, and not in the collector's registry: a registry matter, not a
   * decoder. `dust_at_the_registry_run`: found by the run and under its floor then. `not_found_by_the_registry_run`:
   * the run searched the four programs by mint and did not find it, so it was created after.
   */
  | {
      kind: 'registry';
      why: 'dust_at_the_registry_run' | 'not_found_by_the_registry_run';
      program: string;
    }
  /** On a program we decode, holding no tracked stock: the pool of another market, on an onward hop. */
  | { kind: 'other_market'; program: string }
  /** Owned by a program `packages/risk` has no validated decoder for. */
  | { kind: 'unread'; program: string }
  | { kind: 'unknown'; why: 'pool_not_in_the_chain_read' | 'no_such_account' | 'pool_not_decoded' };

export type ClassifyContext = {
  registry: ReadonlyMap<string, RegistryPool>;
  known: ReadonlyMap<string, KnownPool>;
  routePools: ReadonlyMap<string, RoutePoolRow>;
  /** Mints of the tracked stocks. */
  tracked: ReadonlySet<string>;
};

export function classifyPool(address: string, ctx: ClassifyContext): PoolClass {
  const reg = ctx.registry.get(address);
  if (reg) return { kind: 'read', venue: reg.venue, exitPath: reg.exitPath };
  const row = ctx.routePools.get(address);
  if (!row) return { kind: 'unknown', why: 'pool_not_in_the_chain_read' };
  if (!row.owner) return { kind: 'unknown', why: 'no_such_account' };
  if (!(row.owner in DECODED_PROGRAMS)) return { kind: 'unread', program: row.owner };
  const mints = poolMints(row);
  if (!mints) return { kind: 'unknown', why: 'pool_not_decoded' };
  if (!mints.some((m) => ctx.tracked.has(m))) return { kind: 'other_market', program: row.owner };
  return {
    kind: 'registry',
    why: ctx.known.has(address) ? 'dust_at_the_registry_run' : 'not_found_by_the_registry_run',
    program: row.owner,
  };
}

/** One key per row of the table: the class and, where it has one, its exit path, reason or program. */
export function classKey(c: PoolClass): string {
  if (c.kind === 'read') return `read:${c.exitPath}`;
  if (c.kind === 'registry') return `registry:${c.why}`;
  if (c.kind === 'unknown') return `unknown:${c.why}`;
  return `${c.kind}:${c.program}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The share of a quote through each leg
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Where a leg sits in a route. The collector keeps no mints, so the ends are found by amount, in raw units, exactly:
 * the stock end is the legs whose stock amounts add up to the quote's (a sale's `inAmount`, a purchase's
 * `outAmount`), the dollar end the legs whose USDC amounts add up to the quote's.
 * - `direct`: at both ends, the stock against dollars in one pool;
 * - `stock_hop`: at the stock end only, the stock against a middle token (SOL, another stock, a gold token);
 * - `dollar_hop`: at the dollar end only, a middle token against dollars;
 * - `middle_hop`: at neither end, between two middle tokens.
 * Where the dollar end is not told apart (two legs of one stored quote in 35,478 pay the same amount), a leg at the
 * stock end is called a stock hop whether or not it pays dollars itself, and every other leg a middle hop.
 */
export type LegRole = 'direct' | 'stock_hop' | 'dollar_hop' | 'middle_hop';

export type QuoteLeg = {
  pool: string;
  label: string;
  role: LegRole;
  /** Percent of the quote's stock that trades in this pool; null off the stock end. */
  stockPct: number | null;
  /** Percent of the quote's dollars that this pool pays (a sale) or takes (a purchase); null off the dollar end. */
  dollarPct: number | null;
  /**
   * The leg's own share of the quote: `stockPct` at the stock end, else `dollarPct` at the dollar end, else the share
   * of the legs that feed it or that it feeds (a middle hop), null when the amounts do not say.
   */
  sharePct: number | null;
};

const MAX_LEGS = 12;
const isRaw = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);

/**
 * The legs whose amounts add up to the target, as a bit mask: exactly one such set, or null (none, or more than one:
 * nothing is guessed).
 */
function onlySubset(target: bigint, amounts: readonly bigint[], skip = -1): number | null {
  if (target <= 0n) return null;
  let found = 0;
  let sets = 0;
  for (let mask = 1; mask < 1 << amounts.length; mask++) {
    if (skip >= 0 && mask & (1 << skip)) continue;
    let sum = 0n;
    for (let i = 0; i < amounts.length; i++) if (mask & (1 << i)) sum += amounts[i] as bigint;
    if (sum === target) {
      found = mask;
      sets++;
    }
  }
  return sets === 1 ? found : null;
}

export type QuoteLegs =
  | { resolved: true; legs: QuoteLeg[] }
  | {
      resolved: false;
      reason: 'no_route' | 'amounts_not_stored' | 'stock_end_not_told_apart';
    };

/**
 * Each leg of a stored quote with its role and its own share. A leg through two pools (the stock to SOL in one, SOL
 * to dollars in another) is two legs, each counted once, each with its own share: the first by the stock it takes,
 * the second by the dollars it pays. The stock end always adds up to the whole quote (100%), and so does the dollar
 * end when it is told apart; a quote whose stock end is not told apart gives nothing.
 */
export function quoteLegs(q: StoredQuote): QuoteLegs {
  const route = q.route ?? [];
  if (!route.length || route.length > MAX_LEGS) return { resolved: false, reason: 'no_route' };
  const sell = q.side === 'sell';
  const raws = [q.amountIn, q.outAmount, ...route.flatMap((h) => [h.inAmount, h.outAmount])];
  if (!raws.every(isRaw)) return { resolved: false, reason: 'amounts_not_stored' };
  const ins = route.map((h) => BigInt(h.inAmount as string));
  const outs = route.map((h) => BigInt(h.outAmount as string));
  const amountIn = BigInt(q.amountIn);
  const amountOut = BigInt(q.outAmount as string);
  // a sale sends the stock in and takes dollars out; a purchase the other way round
  const stockTarget = sell ? amountIn : amountOut;
  const stockAmounts = sell ? ins : outs;
  const dollarTarget = sell ? amountOut : amountIn;
  const dollarAmounts = sell ? outs : ins;
  const stockEnd = onlySubset(stockTarget, stockAmounts);
  if (stockEnd === null) return { resolved: false, reason: 'stock_end_not_told_apart' };
  const dollarEnd = onlySubset(dollarTarget, dollarAmounts);
  const pct = (a: bigint, of: bigint) => (Number(a) / Number(of)) * 100;

  const legs: QuoteLeg[] = route.map((h, i) => {
    const atStock = (stockEnd & (1 << i)) !== 0;
    const atDollar = dollarEnd !== null && (dollarEnd & (1 << i)) !== 0;
    const stockPct = atStock ? pct(stockAmounts[i] as bigint, stockTarget) : null;
    const dollarPct = atDollar ? pct(dollarAmounts[i] as bigint, dollarTarget) : null;
    return {
      pool: h.pool,
      label: h.label ?? 'unknown',
      role: atStock ? (atDollar ? 'direct' : 'stock_hop') : atDollar ? 'dollar_hop' : 'middle_hop',
      stockPct,
      dollarPct,
      sharePct: stockPct ?? dollarPct,
    };
  });
  // A leg at neither end takes its share from the legs whose outputs add up to its input, else from the legs whose
  // inputs add up to its output. With the dollar end not told apart, every leg off the stock end is such a leg. A leg
  // may wait for the leg that feeds it, whatever their order in the route: one pass for each leg at most.
  const sumOf = (mask: number | null) => {
    if (mask === null) return null;
    let sum = 0;
    for (let k = 0; k < legs.length; k++) {
      if (!(mask & (1 << k))) continue;
      const s = (legs[k] as QuoteLeg).sharePct;
      if (s === null) return null;
      sum += s;
    }
    return sum;
  };
  for (let pass = 0; pass < legs.length; pass++) {
    let found = false;
    legs.forEach((leg, i) => {
      if (leg.sharePct !== null) return;
      leg.sharePct =
        sumOf(onlySubset(ins[i] as bigint, outs, i)) ??
        sumOf(onlySubset(outs[i] as bigint, ins, i));
      if (leg.sharePct !== null) found = true;
    });
    if (!found) break;
  }
  return { resolved: true, legs };
}

// ---------------------------------------------------------------------------------------------------------------------
// Where Jupiter routes the amount, by class of pool
// ---------------------------------------------------------------------------------------------------------------------

export type Side = 'sell' | 'buy';
export const SIDES: readonly Side[] = ['sell', 'buy'];

/** One class of pool in one group of quotes (a side and a size, or one stock of them). */
export type ShareCell = {
  /**
   * Percent of the stock amount Jupiter traded in pools of this class, a mean over the group's resolved quotes. Every
   * quote of a group asks for the same dollars, so this is the share of the amount. Over all classes it is 100.
   */
  stockPct: number;
  /**
   * Percent of the amount that passed through pools of this class on a hop that does not trade the stock (a mean
   * over the same quotes). A path is counted once for each pool it crosses, so this column does not add up to 100,
   * and it is never added to `stockPct`.
   */
  onwardPct: number;
  /** Quotes of the group with a leg in a pool of this class. */
  quotes: number;
};

export type ShareGroup = {
  side: Side;
  notionalUsd: number;
  /** Quotes with a route. */
  quotes: number;
  /** Of them, the quotes whose stock end was told apart: the shares are means over these. */
  resolved: number;
  /** Onward legs whose share the amounts did not say: counted, and in no `onwardPct`. */
  onwardLegsWithoutAShare: number;
  byClass: Record<string, ShareCell>;
  byAsset: Record<string, { quotes: number; resolved: number; byClass: Record<string, ShareCell> }>;
};

export type RoutedShares = {
  /** `fetchedAt` of the first and of the last quote with a route. */
  first: string | null;
  last: string | null;
  /** Rows read, and those among them with no route (Jupiter answered an error, or the collector had no price). */
  rows: number;
  withoutARoute: number;
  notResolved: Record<string, number>;
  /** The stocks the quotes cover. */
  assets: string[];
  groups: ShareGroup[];
  /** Every pool seen, with its class, Jupiter's label and the legs it carried. */
  pools: Array<{
    pool: string;
    key: string;
    label: string;
    stockLegs: number;
    onwardLegs: number;
    assets: string[];
  }>;
  /**
   * Stock legs in a pool whose two mints were read and hold no mint of the quoted stock: zero unless the amounts
   * named the wrong leg, so it is the check of the method against the chain.
   */
  stockLegsInPoolsWithoutTheStock: number;
  /** Stock legs in a pool whose mints were read: the legs the check above could look at. */
  stockLegsChecked: number;
};

const cell = (): ShareCell => ({ stockPct: 0, onwardPct: 0, quotes: 0 });

/**
 * Where the stored quotes route their amount. `classOf` gives each pool its key; `mintsOf` gives a pool's two mints
 * where the chain read holds them, for the check of the stock end.
 */
export function routedShares(
  quotes: readonly StoredQuote[],
  classOf: (pool: string) => string,
  mintsOf: (pool: string) => [string, string] | null = () => null,
): RoutedShares {
  const groups = new Map<string, ShareGroup>();
  const pools = new Map<
    string,
    { key: string; label: string; stockLegs: number; onwardLegs: number; assets: Set<string> }
  >();
  const notResolved: Record<string, number> = {};
  const assets = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  let withoutARoute = 0;
  let wrongPool = 0;
  let checked = 0;
  for (const q of quotes) {
    if (!q.route?.length || (q.side !== 'sell' && q.side !== 'buy')) {
      withoutARoute++;
      continue;
    }
    if (!first || q.fetchedAt < first) first = q.fetchedAt;
    if (!last || q.fetchedAt > last) last = q.fetchedAt;
    assets.add(q.asset);
    const gk = `${q.side}|${q.notionalUsd}`;
    const g = groups.get(gk) ?? {
      side: q.side,
      notionalUsd: q.notionalUsd,
      quotes: 0,
      resolved: 0,
      onwardLegsWithoutAShare: 0,
      byClass: {},
      byAsset: {},
    };
    groups.set(gk, g);
    g.byAsset[q.asset] ??= { quotes: 0, resolved: 0, byClass: {} };
    const a = g.byAsset[q.asset] as ShareGroup['byAsset'][string];
    g.quotes++;
    a.quotes++;
    const parsed = quoteLegs(q);
    if (!parsed.resolved) {
      notResolved[parsed.reason] = (notResolved[parsed.reason] ?? 0) + 1;
      continue;
    }
    g.resolved++;
    a.resolved++;
    const seen = new Set<string>();
    for (const leg of parsed.legs) {
      const key = classOf(leg.pool);
      const p = pools.get(leg.pool) ?? {
        key,
        label: leg.label,
        stockLegs: 0,
        onwardLegs: 0,
        assets: new Set<string>(),
      };
      pools.set(leg.pool, p);
      p.assets.add(q.asset);
      g.byClass[key] ??= cell();
      a.byClass[key] ??= cell();
      const targets = [g.byClass[key] as ShareCell, a.byClass[key] as ShareCell];
      if (leg.stockPct !== null) {
        p.stockLegs++;
        for (const t of targets) t.stockPct += leg.stockPct;
        const mints = mintsOf(leg.pool);
        if (mints) {
          checked++;
          if (!mints.includes(q.assetMint)) wrongPool++;
        }
      } else {
        p.onwardLegs++;
        if (leg.sharePct === null) g.onwardLegsWithoutAShare++;
        else for (const t of targets) t.onwardPct += leg.sharePct;
      }
      if (!seen.has(key)) for (const t of targets) t.quotes++;
      seen.add(key);
    }
  }
  // sums become means over the resolved quotes of each group
  for (const g of groups.values()) {
    for (const c of Object.values(g.byClass)) {
      c.stockPct /= g.resolved;
      c.onwardPct /= g.resolved;
    }
    for (const a of Object.values(g.byAsset))
      for (const c of Object.values(a.byClass)) {
        c.stockPct /= a.resolved;
        c.onwardPct /= a.resolved;
      }
  }
  return {
    first,
    last,
    rows: quotes.length,
    withoutARoute,
    notResolved,
    assets: [...assets].sort(),
    groups: [...groups.values()].sort(
      (x, y) => SIDES.indexOf(x.side) - SIDES.indexOf(y.side) || x.notionalUsd - y.notionalUsd,
    ),
    pools: [...pools.entries()]
      .map(([pool, p]) => ({ pool, ...p, assets: [...p.assets].sort() }))
      .sort((x, y) => y.stockLegs + y.onwardLegs - (x.stockLegs + x.onwardLegs)),
    stockLegsInPoolsWithoutTheStock: wrongPool,
    stockLegsChecked: checked,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery: what DexScreener listed (estimates)
// ---------------------------------------------------------------------------------------------------------------------

/** One row of `pools-dexscreener-<stamp>.jsonl`, as far as this table reads it. */
export type DiscoveryRow = {
  assetMint: string;
  symbol: string;
  source: string;
  fetchedAt: string;
  status: number;
  pairs: Array<{
    pairAddress: string;
    dexId: string;
    labels?: string[];
    liquidity?: { usd?: number };
    volume?: { h24?: number };
  }> | null;
};

export type ExcludedPool = { address: string; venue: string; reason: string };

/** Where a pair DexScreener listed ended up in the registry run. */
export type DiscoveryFate =
  | 'collected'
  | 'dust_at_the_registry_run'
  | 'excluded_unsupported_program'
  | 'not_in_the_registry_run';

/** One pair DexScreener listed for a tracked stock. A figure DexScreener did not give is null, never zero. */
export type DiscoveryPair = {
  address: string;
  /** DexScreener's own name: `dexId`, with its labels after a colon. */
  dex: string;
  /** The program that owns the pair, where the registry run read it. */
  program: string | null;
  fate: DiscoveryFate;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** The tracked stocks whose row lists the pair: two for a pair of two tracked stocks. */
  stocks: string[];
};

/** DexScreener's figures over some pairs: estimates. A sum is null when no pair of them carries the figure. */
export type DiscoveryMoney = {
  pools: number;
  liquidityUsd: number | null;
  /** Pairs with no liquidity figure: not in the sum, and not a zero. */
  withoutLiquidity: number;
  volume24hUsd: number | null;
  withoutVolume: number;
  stocks: string[];
};

export function discoveryMoney(pairs: readonly DiscoveryPair[]): DiscoveryMoney {
  const liq = pairs.map((p) => p.liquidityUsd).filter((x): x is number => x !== null);
  const vol = pairs.map((p) => p.volume24hUsd).filter((x): x is number => x !== null);
  return {
    pools: pairs.length,
    liquidityUsd: liq.length ? liq.reduce((t, x) => t + x, 0) : null,
    withoutLiquidity: pairs.length - liq.length,
    volume24hUsd: vol.length ? vol.reduce((t, x) => t + x, 0) : null,
    withoutVolume: pairs.length - vol.length,
    stocks: [...new Set(pairs.flatMap((p) => p.stocks))].sort(),
  };
}

export type DiscoveryVenue = DiscoveryMoney & {
  dex: string;
  /** The programs that own its pairs, where the registry run read them. */
  programs: string[];
  byFate: Record<string, DiscoveryMoney>;
};

export type DiscoveryTable = {
  estimate: true;
  source: string;
  /** `fetchedAt` of the first and of the last token row read. */
  first: string | null;
  last: string | null;
  capPairsPerToken: number;
  /** Tracked stocks whose row is at the cap: pairs beyond it are not listed. */
  atCap: string[];
  /** Tracked stocks with no row, or a row DexScreener did not answer. */
  missing: string[];
  /** Distinct pairs: a pair of two tracked stocks is one pair. */
  pairs: DiscoveryPair[];
  venues: DiscoveryVenue[];
};

const PROGRAM_IN_REASON = /^unsupported program (\S+)$/;

/**
 * What DexScreener listed for the tracked stocks, by its own venue name, with where each pair ended up: collected,
 * dust at the registry run, or excluded for its program. Every money figure here is DexScreener's and an estimate.
 */
export function discoveryTable(
  rows: readonly DiscoveryRow[],
  tracked: ReadonlyMap<string, string>,
  where: {
    registry: ReadonlyMap<string, RegistryPool & { program?: string }>;
    known: ReadonlyMap<string, KnownPool>;
    excluded: ReadonlyMap<string, ExcludedPool>;
  },
): DiscoveryTable {
  const mine = rows.filter((r) => tracked.has(r.assetMint));
  const seen = new Map<string, DiscoveryPair>();
  for (const r of mine)
    for (const p of r.pairs ?? []) {
      const stock = tracked.get(r.assetMint) as string;
      const had = seen.get(p.pairAddress);
      if (had) {
        if (!had.stocks.includes(stock)) had.stocks.push(stock);
        continue;
      }
      const excluded = where.excluded.get(p.pairAddress);
      seen.set(p.pairAddress, {
        address: p.pairAddress,
        dex: `${p.dexId}${p.labels?.length ? `:${p.labels.join('/')}` : ''}`,
        program:
          excluded?.reason.match(PROGRAM_IN_REASON)?.[1] ??
          where.registry.get(p.pairAddress)?.program ??
          null,
        fate: where.registry.has(p.pairAddress)
          ? 'collected'
          : where.known.has(p.pairAddress)
            ? 'dust_at_the_registry_run'
            : excluded
              ? 'excluded_unsupported_program'
              : 'not_in_the_registry_run',
        liquidityUsd: typeof p.liquidity?.usd === 'number' ? p.liquidity.usd : null,
        volume24hUsd: typeof p.volume?.h24 === 'number' ? p.volume.h24 : null,
        stocks: [stock],
      });
    }
  const pairs = [...seen.values()];
  const venues: DiscoveryVenue[] = [...new Set(pairs.map((p) => p.dex))].map((dex) => {
    const own = pairs.filter((p) => p.dex === dex);
    return {
      dex,
      programs: [
        ...new Set(own.map((p) => p.program).filter((x): x is string => x !== null)),
      ].sort(),
      ...discoveryMoney(own),
      byFate: Object.fromEntries(
        [...new Set(own.map((p) => p.fate))].map((fate) => [
          fate,
          discoveryMoney(own.filter((p) => p.fate === fate)),
        ]),
      ),
    };
  });
  const times = mine.map((r) => r.fetchedAt).sort();
  const answered = new Set(mine.filter((r) => r.status === 200 && r.pairs).map((r) => r.assetMint));
  return {
    estimate: true,
    source: [...new Set(mine.map((r) => r.source.replace(/\/[^/]+$/, '/{token}')))].join(', '),
    first: times[0] ?? null,
    last: times[times.length - 1] ?? null,
    capPairsPerToken: DEXSCREENER_PAIR_CAP,
    atCap: mine
      .filter((r) => (r.pairs?.length ?? 0) >= DEXSCREENER_PAIR_CAP)
      .map((r) => tracked.get(r.assetMint) as string)
      .sort(),
    missing: [...tracked]
      .filter(([mint]) => !answered.has(mint))
      .map(([, symbol]) => symbol)
      .sort(),
    pairs,
    venues: venues.sort(
      (x, y) => (y.liquidityUsd ?? -1) - (x.liquidityUsd ?? -1) || x.dex.localeCompare(y.dex),
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a pool of a Raydium-sized fork held (measured)
// ---------------------------------------------------------------------------------------------------------------------

const DOLLARS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

export type ForkPoolMoney =
  | {
      pool: string;
      stock: string;
      /** The stock side at the pool's own price, and the dollar side at par. */
      stockUsd: number;
      dollarUsd: number;
      tvlUsd: number;
    }
  | {
      pool: string;
      tvlUsd: null;
      reason: 'no_dollar_side' | 'vault_not_read' | 'vault_mint_is_not_the_pools' | 'not_decoded';
    };

/**
 * What a pool with Raydium's header held at the read, for a pool that pairs a tracked stock with USDC or USDT: the
 * two vault balances the file holds, the stock side at the pool's own price. A vault whose mint is not the pool's is
 * refused: that is the check that Raydium's header gives the right vault addresses on this program.
 */
export function forkPoolMoney(
  row: RoutePoolRow,
  vaults: Readonly<Record<string, VaultRow>>,
  tracked: ReadonlyMap<string, string>,
): ForkPoolMoney {
  if (!row.data || bytesOf(row.data).length !== CLMM_POOL_SIZE)
    return { pool: row.address, tvlUsd: null, reason: 'not_decoded' };
  const h = decodeClmmPool(bytesOf(row.data));
  const stockIs0 = tracked.has(h.mint0) && DOLLARS.has(h.mint1);
  const stockIs1 = tracked.has(h.mint1) && DOLLARS.has(h.mint0);
  if (!stockIs0 && !stockIs1) return { pool: row.address, tvlUsd: null, reason: 'no_dollar_side' };
  const v0 = vaults[h.vault0];
  const v1 = vaults[h.vault1];
  if (!v0 || !v1) return { pool: row.address, tvlUsd: null, reason: 'vault_not_read' };
  if (v0.mint !== h.mint0 || v1.mint !== h.mint1)
    return { pool: row.address, tvlUsd: null, reason: 'vault_mint_is_not_the_pools' };
  const a0 = Number(v0.amount) / 10 ** v0.decimals;
  const a1 = Number(v1.amount) / 10 ** v1.decimals;
  // token1 per token0 in whole tokens, from the pool's own square-root price
  const p01 = (Number(h.sqrtPriceX64) / 2 ** 64) ** 2 * 10 ** (v0.decimals - v1.decimals);
  const stockUsd = stockIs0 ? a0 * p01 : a1 / p01;
  const dollarUsd = stockIs0 ? a1 : a0;
  return {
    pool: row.address,
    stock: tracked.get(stockIs0 ? h.mint0 : h.mint1) as string,
    stockUsd,
    dollarUsd,
    tvlUsd: stockUsd + dollarUsd,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Byreal probe: what Raydium's decoders make of one pool and one tick array
// ---------------------------------------------------------------------------------------------------------------------

/** The file `pnpm risk:venues-freeze-byreal` writes: one Byreal pool, the list of its arrays, one array in full. */
export type ByrealProbeFile = {
  method: string;
  source: string;
  fetchedAt: string;
  provenance: string;
  program: string;
  pool: { address: string; slot: number; data: string };
  /** Every account of the program that names the pool where a Raydium tick array does. Sizes and first ticks only. */
  children: Array<{ address: string; space: number | null; startTickIndex: number | null }>;
  /** The array holding the pool's current tick, whole; null when the list has no such account. */
  tickArray: { address: string; data: string } | null;
  tickArraySlot: number | null;
  rpc: { calls: number; retries: number; seconds: number };
};

const CLMM_TICKS_PER_ARRAY = 60;
const CLMM_TICK_SIZE = 168;
/** A Raydium tick array: 44 bytes, 60 ticks of 168, and its tail. */
export const CLMM_FIXED_ARRAY_SIZE = 10_240;
const CLMM_BITMAP_EXTENSION_SIZE = 1_832;
/** The header the probe found before the ticks of a Byreal array that is not Raydium's size. */
const DYNAMIC_HEADER_SIZE = 216;
const DYNAMIC_TABLE_OFFSET = 48;

/** The first tick of the Raydium tick array that holds `tick`: arrays are 60 ticks of the pool's spacing wide. */
export function clmmArrayStart(tick: number, tickSpacing: number): number {
  const width = CLMM_TICKS_PER_ARRAY * tickSpacing;
  return Math.floor(tick / width) * width;
}

export type ByrealProbe = {
  pool: {
    address: string;
    /** `decodeClmmPool` returned without throwing. */
    decodes: boolean;
    mint0: string | null;
    mint1: string | null;
    tickSpacing: number | null;
    tickCurrent: number | null;
    liquidity: string | null;
  };
  /** The accounts the program holds for the pool, by size. */
  children: {
    count: number;
    /** Raydium's fixed tick array size: the only layout `decodeClmmTickArray` reads. */
    raydiumFixed: number;
    /** 216 bytes and a whole number of 168-byte ticks, 1 to 60: the layout found in the array read. */
    headerAndTicks: number;
    /** The size of Raydium's bitmap extension. */
    bitmapExtensionSize: number;
    other: number;
    /** Of the arrays that are not Raydium's size, those `decodeClmmTickArray` returns null for: too short for it. */
    decoderReturnsNull: number;
    /** Those long enough that it reads them as Raydium's layout, which they are not. */
    decoderMisreads: number;
  };
  /** The one array read whole: what `decodeClmmTickArray` makes of it. */
  array: {
    address: string;
    space: number;
    startTickIndex: number;
    isRaydiumSize: boolean;
    asRaydium: {
      /** Null when the decoder returns null. */
      ticks: number | null;
      /** Decoded ticks that are not a multiple of the spacing or lie outside the array's 60 ticks. */
      offGridOrOutOfRange: number | null;
    };
    /** The same bytes read as a 216-byte header (a table of 60 slots at byte 48) and then 168-byte ticks. */
    asHeaderAndTicks: {
      fits: boolean;
      allocated: number;
      /** Slots whose tick field is the tick its place in the table says. */
      ticksInPlace: number;
      /** Slots with liquidity, against the count the header gives. */
      initialized: number;
      initializedInHeader: number;
    } | null;
  } | null;
  /**
   * Whether the liquidity invariant (ticks at or below the price add up to the pool's liquidity) can hold with the
   * Raydium decoders as they are: it cannot when the array at the price is misread or left out.
   */
  invariantWithRaydiumDecoders: 'cannot_hold' | 'not_refuted_by_this_array';
  why: string;
};

/**
 * What the Raydium decoders make of the probe's bytes. It decodes nothing new: the second reading of the array is
 * there to say where the layout parts from Raydium's, so a decoder's cost can be judged; it is not a decoder and
 * `packages/risk` is not touched.
 */
export function byrealProbe(file: ByrealProbeFile): ByrealProbe {
  const poolBytes = bytesOf(file.pool.data);
  let header: ReturnType<typeof decodeClmmPool> | null = null;
  try {
    header = decodeClmmPool(poolBytes);
  } catch {
    header = null;
  }
  const isHeaderAndTicks = (space: number) =>
    space > DYNAMIC_HEADER_SIZE &&
    (space - DYNAMIC_HEADER_SIZE) % CLMM_TICK_SIZE === 0 &&
    (space - DYNAMIC_HEADER_SIZE) / CLMM_TICK_SIZE <= CLMM_TICKS_PER_ARRAY;
  const minDecoded = 44 + CLMM_TICKS_PER_ARRAY * CLMM_TICK_SIZE;
  const sizes = file.children.map((c) => c.space ?? 0);
  const fixed = sizes.filter((s) => s === CLMM_FIXED_ARRAY_SIZE).length;
  const dynamic = sizes.filter((s) => s !== CLMM_FIXED_ARRAY_SIZE && isHeaderAndTicks(s));
  const bitmap = sizes.filter((s) => s === CLMM_BITMAP_EXTENSION_SIZE && !isHeaderAndTicks(s));
  const children = {
    count: sizes.length,
    raydiumFixed: fixed,
    headerAndTicks: dynamic.length,
    bitmapExtensionSize: bitmap.length,
    other: sizes.length - fixed - dynamic.length - bitmap.length,
    decoderReturnsNull: dynamic.filter((s) => s < minDecoded).length,
    decoderMisreads: dynamic.filter((s) => s >= minDecoded).length,
  };

  let array: ByrealProbe['array'] = null;
  if (file.tickArray && header) {
    const data = bytesOf(file.tickArray.data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const start = view.getInt32(40, true);
    const width = CLMM_TICKS_PER_ARRAY * header.tickSpacing;
    const decoded = decodeClmmTickArray(data);
    const bad = decoded
      ? decoded.ticks.filter(
          (t) => t.tick % header.tickSpacing !== 0 || t.tick < start || t.tick >= start + width,
        ).length
      : null;
    let asHeaderAndTicks: NonNullable<ByrealProbe['array']>['asHeaderAndTicks'] = null;
    if (isHeaderAndTicks(data.length)) {
      const allocated = (data.length - DYNAMIC_HEADER_SIZE) / CLMM_TICK_SIZE;
      let inPlace = 0;
      let initialized = 0;
      let slots = 0;
      for (let i = 0; i < CLMM_TICKS_PER_ARRAY; i++) {
        const slot = data[DYNAMIC_TABLE_OFFSET + i] as number;
        if (slot === 0 || slot > allocated) continue;
        slots++;
        const o = DYNAMIC_HEADER_SIZE + (slot - 1) * CLMM_TICK_SIZE;
        if (view.getInt32(o, true) === start + i * header.tickSpacing) inPlace++;
        // liquidity_gross, a u128 at byte 20 of the tick: zero when the tick holds nothing
        if (view.getBigUint64(o + 20, true) !== 0n || view.getBigUint64(o + 28, true) !== 0n)
          initialized++;
      }
      const inHeader = data[DYNAMIC_TABLE_OFFSET + CLMM_TICKS_PER_ARRAY + 1] as number;
      asHeaderAndTicks = {
        fits:
          slots === allocated &&
          inPlace === slots &&
          initialized === inHeader &&
          data[DYNAMIC_TABLE_OFFSET + CLMM_TICKS_PER_ARRAY] === allocated,
        allocated,
        ticksInPlace: inPlace,
        initialized,
        initializedInHeader: inHeader,
      };
    }
    array = {
      address: file.tickArray.address,
      space: data.length,
      startTickIndex: start,
      isRaydiumSize: data.length === CLMM_FIXED_ARRAY_SIZE,
      asRaydium: { ticks: decoded ? decoded.ticks.length : null, offGridOrOutOfRange: bad },
      asHeaderAndTicks,
    };
  }
  const misread =
    array !== null &&
    !array.isRaydiumSize &&
    (array.asRaydium.ticks === null || (array.asRaydium.offGridOrOutOfRange ?? 0) > 0);
  return {
    pool: {
      address: file.pool.address,
      decodes: header !== null,
      mint0: header?.mint0 ?? null,
      mint1: header?.mint1 ?? null,
      tickSpacing: header?.tickSpacing ?? null,
      tickCurrent: header?.tickCurrent ?? null,
      liquidity: header ? header.liquidity.toString() : null,
    },
    children,
    array,
    invariantWithRaydiumDecoders: misread ? 'cannot_hold' : 'not_refuted_by_this_array',
    why: misread
      ? 'the array that holds the current tick is not a Raydium tick array: the decoder returns null for it or reads ticks that are not ticks, so the liquidity it rebuilds at the price is not the pool’s'
      : 'the one array read has Raydium’s layout; the invariant needs every array at or below the price, which this probe does not read',
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The gap to Jupiter, and how much of it a venue can account for
// ---------------------------------------------------------------------------------------------------------------------

/** One compared quote: its gap, and the percent of its stock amount Jupiter traded in each class of pool. */
export type GapShare = {
  asset: string;
  side: Side;
  notionalUsd: number;
  /** (Jupiter ÷ our router − 1) × 10,000 with one hop: positive when Jupiter returns more. */
  gapBp: number;
  stockPctByClass: Record<string, number>;
  /**
   * For each class Jupiter traded the stock in: what the gap would be had our router been given that class's legs
   * exactly as Jupiter used them (the rest of the amount routed our way), or null when the legs' dollars could not be
   * followed through the route. See `gapWithLegs` in replay.ts.
   */
  gapWithClassBp?: Record<string, number | null>;
};

export type GapAccountRow = {
  key: string;
  /** Pairs in which Jupiter traded part of the stock in a pool of this class. */
  pairs: number;
  /** Mean share of the stock amount there, over those pairs and over every pair of the group. */
  meanSharePctWhereUsed: number | null;
  meanSharePct: number;
  /** The gap in the pairs that use the class, and in the pairs that do not. */
  gapWhereUsed: { median: number | null; mean: number | null };
  gapElsewhere: { median: number | null; mean: number | null };
  /**
   * The group's gap with the class's legs taken exactly as Jupiter used them in every pair that uses it and that
   * could be replayed, and what that closes of the median and the mean. Jupiter's split and the venue's price at the
   * quote's own moment, not a route our router chose: an estimate of what a decoder would bring, not a bound. Null
   * when the rows carry no replay.
   */
  asJupiterUsedIt: {
    pairsReplayed: number;
    pairsNotReplayed: number;
    gapBp: { median: number | null; mean: number | null };
    closesBp: { median: number; mean: number };
  } | null;
};

export type GapAccount = {
  side: Side;
  notionalUsd: number;
  pairs: number;
  gapBp: { median: number | null; mean: number | null };
  /** The pairs where Jupiter traded the whole stock amount in pools the router uses. */
  withinRoutedPools: { pairs: number; median: number | null; mean: number | null };
  rows: GapAccountRow[];
};

const spreadOf = (xs: readonly number[]) => ({ median: median(xs), mean: mean(xs) });

/**
 * For each side and size: the gap, the gap where Jupiter stayed inside the pools the router uses, and for each other
 * class the most it could account for. `routed` says which classes the router uses.
 */
export function gapAccount(
  rows: readonly GapShare[],
  routed: (key: string) => boolean,
): GapAccount[] {
  const out: GapAccount[] = [];
  const sizes = [...new Set(rows.map((r) => r.notionalUsd))].sort((a, b) => a - b);
  for (const side of SIDES)
    for (const notionalUsd of sizes) {
      const group = rows.filter((r) => r.side === side && r.notionalUsd === notionalUsd);
      if (!group.length) continue;
      const gaps = group.map((r) => r.gapBp);
      const all = spreadOf(gaps);
      const used = (r: GapShare, key: string) => (r.stockPctByClass[key] ?? 0) > 0;
      const inside = group.filter((r) =>
        Object.entries(r.stockPctByClass).every(([k, pct]) => !(pct > 0) || routed(k)),
      );
      const keys = [...new Set(group.flatMap((r) => Object.keys(r.stockPctByClass)))]
        .filter((k) => !routed(k) && group.some((r) => used(r, k)))
        .sort();
      out.push({
        side,
        notionalUsd,
        pairs: group.length,
        gapBp: all,
        withinRoutedPools: {
          pairs: inside.length,
          ...spreadOf(inside.map((r) => r.gapBp)),
        },
        rows: keys.map((key) => {
          const withIt = group.filter((r) => used(r, key));
          const without = group.filter((r) => !used(r, key));
          const replayed = withIt.filter((r) => typeof r.gapWithClassBp?.[key] === 'number');
          const after = spreadOf(
            group.map((r) =>
              used(r, key)
                ? ((r.gapWithClassBp?.[key] as number | null | undefined) ?? r.gapBp)
                : r.gapBp,
            ),
          );
          return {
            key,
            pairs: withIt.length,
            meanSharePctWhereUsed: mean(withIt.map((r) => r.stockPctByClass[key] as number)),
            meanSharePct: mean(group.map((r) => r.stockPctByClass[key] ?? 0)) as number,
            gapWhereUsed: spreadOf(withIt.map((r) => r.gapBp)),
            gapElsewhere: spreadOf(without.map((r) => r.gapBp)),
            asJupiterUsedIt: group.some((r) => r.gapWithClassBp)
              ? {
                  pairsReplayed: replayed.length,
                  pairsNotReplayed: withIt.length - replayed.length,
                  gapBp: after,
                  closesBp: {
                    median: (all.median as number) - (after.median as number),
                    mean: (all.mean as number) - (after.mean as number),
                  },
                }
              : null,
          };
        }),
      });
    }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Robinhood Chain: volume and pools by venue
// ---------------------------------------------------------------------------------------------------------------------

/** One row of `risk_pool_flow` for a Robinhood pool: its 28 days, every regime together. */
export type FlowRow = {
  pool: string;
  assetSymbol: string;
  venue: string | null;
  swaps: number;
  unpricedSwaps: number;
  sellUsd: number;
  buyUsd: number;
  dataFrom: string;
  dataTo: string;
};

/** One pool of the cut, with what discovery read of it. */
export type CutPoolRow = {
  address: string;
  symbol: string;
  venue: string;
  /** `cl`: a pool with its own address (Uniswap v3 and the venues shaped like it); `v4`: a pool of the pool manager. */
  kind: string;
  reachable: boolean;
  unreachableReason: string | null;
  /** Measured on chain by discovery; null when it was not. */
  tvlUsd: number | null;
  factory: string | null;
  /** What the pool answered when discovery read it. */
  answers: { slot0: boolean; liquidity: boolean; fee: boolean; tickSpacing: boolean };
  /** DexScreener's own figures for the pool, where it listed it: estimates. */
  dexscreener: { liquidityUsd: number | null; volumeH24Usd: number | null } | null;
};

/**
 * What a venue is to the code we have, from what its pools answered and from the swaps the walk decoded:
 * - `reached`: the vault's swap path reaches it and the collector quotes it;
 * - `hook`: a Uniswap v4 pool with a hook, which the path leaves out;
 * - `v3_interface`: its pools answer Uniswap v3's own reads and log Uniswap v3's swap: a fork, which needs its
 *   factory's address and no decoder;
 * - `v3_reads_other_swap_log`: they answer the reads, and the walk decoded no swap of theirs;
 * - `cl_other_interface`: concentrated liquidity that does not answer `slot0()`;
 * - `not_cl`: no concentrated-liquidity read answers.
 */
export type RobinhoodFit =
  | 'reached'
  | 'hook'
  | 'v3_interface'
  | 'v3_reads_other_swap_log'
  | 'cl_other_interface'
  | 'not_cl';

export type RobinhoodVenue = {
  venue: string;
  reached: boolean;
  fit: RobinhoodFit;
  factories: string[];
  pools: number;
  stocks: string[];
  /** Measured on chain by discovery (balances the pool holds; on v4 what positions hold near the price). */
  tvlUsd: number;
  poolsWithoutTvl: number;
  /** Swaps the 28-day walk decoded, and their dollars; null when it decoded none for the venue: that is no data. */
  swaps: number;
  unpricedSwaps: number;
  volume28dUsd: number | null;
  volumeReason: 'no_swap_decoded_by_the_walk' | null;
  /** Percent of the dollars the walk measured, over every venue. Null with the volume. */
  volumeSharePct: number | null;
  poolsWithoutASwap: number;
  /** DexScreener's own figures over the pools it listed: estimates. */
  dexscreener: { pools: number; liquidityUsd: number; volume24hUsd: number };
};

export type RobinhoodTable = {
  /** The window of the flow rows. */
  dataFrom: string | null;
  dataTo: string | null;
  pools: number;
  stocks: string[];
  /** Pools of the cut with no flow row, and flow rows of no pool of the cut. */
  poolsWithoutAFlowRow: number;
  flowRowsOutsideTheCut: number;
  volume28dUsd: number;
  reachedVolumeSharePct: number;
  venues: RobinhoodVenue[];
};

/**
 * Robinhood Chain's pools of the cut by venue: 28 days of measured swaps, the money discovery measured, and
 * DexScreener's estimates beside them. Uniswap v4 is two rows, pools with no hook (reached) and pools with one.
 */
export function robinhoodTable(
  flow: readonly FlowRow[],
  cut: readonly CutPoolRow[],
): RobinhoodTable {
  const flowByPool = new Map(flow.map((f) => [f.pool.toLowerCase(), f]));
  const cutIds = new Set(cut.map((p) => p.address.toLowerCase()));
  type Acc = RobinhoodVenue & {
    stockSet: Set<string>;
    factorySet: Set<string>;
    answered: { slot0: number; liquidity: number };
  };
  const venues = new Map<string, Acc>();
  let missing = 0;
  for (const p of cut) {
    const name =
      p.venue === 'uniswap-v4'
        ? p.reachable
          ? 'uniswap-v4 (no hook)'
          : 'uniswap-v4 (hook)'
        : p.venue;
    const v = venues.get(name) ?? {
      venue: name,
      reached: p.reachable,
      fit: 'reached' as RobinhoodFit,
      factories: [],
      pools: 0,
      stocks: [],
      tvlUsd: 0,
      poolsWithoutTvl: 0,
      swaps: 0,
      unpricedSwaps: 0,
      volume28dUsd: 0,
      volumeReason: null,
      volumeSharePct: null,
      poolsWithoutASwap: 0,
      dexscreener: { pools: 0, liquidityUsd: 0, volume24hUsd: 0 },
      stockSet: new Set<string>(),
      factorySet: new Set<string>(),
      answered: { slot0: 0, liquidity: 0 },
    };
    venues.set(name, v);
    v.pools++;
    v.reached = v.reached && p.reachable;
    v.stockSet.add(p.symbol);
    if (p.factory) v.factorySet.add(p.factory.toLowerCase());
    if (p.tvlUsd === null) v.poolsWithoutTvl++;
    else v.tvlUsd += p.tvlUsd;
    if (p.answers.slot0) v.answered.slot0++;
    if (p.answers.liquidity) v.answered.liquidity++;
    if (p.dexscreener) {
      v.dexscreener.pools++;
      v.dexscreener.liquidityUsd += p.dexscreener.liquidityUsd ?? 0;
      v.dexscreener.volume24hUsd += p.dexscreener.volumeH24Usd ?? 0;
    }
    const f = flowByPool.get(p.address.toLowerCase());
    if (!f) {
      missing++;
      continue;
    }
    v.swaps += f.swaps;
    v.unpricedSwaps += f.unpricedSwaps;
    (v.volume28dUsd as number) += f.sellUsd + f.buyUsd;
    if (f.swaps === 0) v.poolsWithoutASwap++;
  }
  for (const v of venues.values()) {
    // No swap decoded for a whole venue is not a venue nobody traded on: the walk reads Uniswap's two swap logs only.
    if (v.swaps === 0) {
      v.volume28dUsd = null;
      v.volumeReason = 'no_swap_decoded_by_the_walk';
    }
    v.fit = v.reached
      ? 'reached'
      : v.venue === 'uniswap-v4 (hook)'
        ? 'hook'
        : v.answered.liquidity === 0
          ? 'not_cl'
          : v.answered.slot0 < v.pools
            ? 'cl_other_interface'
            : v.swaps === 0
              ? 'v3_reads_other_swap_log'
              : 'v3_interface';
  }
  const total = [...venues.values()].reduce((t, v) => t + (v.volume28dUsd ?? 0), 0);
  const rows = [...venues.values()].map(({ stockSet, factorySet, answered: _a, ...v }) => ({
    ...v,
    stocks: [...stockSet].sort(),
    factories: [...factorySet].sort(),
    volumeSharePct: v.volume28dUsd === null ? null : (v.volume28dUsd / total) * 100,
  }));
  const inCut = flow.filter((f) => cutIds.has(f.pool.toLowerCase()));
  const from = inCut.map((f) => f.dataFrom).sort();
  const to = inCut.map((f) => f.dataTo).sort();
  return {
    dataFrom: from[0] ?? null,
    dataTo: to[to.length - 1] ?? null,
    pools: cut.length,
    stocks: [...new Set(cut.map((p) => p.symbol))].sort(),
    poolsWithoutAFlowRow: missing,
    flowRowsOutsideTheCut: flow.length - inCut.length,
    volume28dUsd: total,
    reachedVolumeSharePct:
      (rows.filter((v) => v.reached).reduce((t, v) => t + (v.volume28dUsd ?? 0), 0) / total) * 100,
    venues: rows.sort(
      (x, y) =>
        Number(y.reached) - Number(x.reached) ||
        (y.volume28dUsd ?? -1) - (x.volume28dUsd ?? -1) ||
        y.dexscreener.volume24hUsd - x.dexscreener.volume24hUsd,
    ),
  };
}

/** A pool of `cut-<chain>-<stamp>.json`, as far as this table reads it. */
export type CutFilePool = {
  address: string;
  symbol: string;
  venue: string;
  kind: string;
  reachable: boolean;
  tvlUsd: number | null;
};

/** A pool of `discovery-<chain>-<stamp>.json`, as far as this table reads it. */
export type DiscoveryFilePool = {
  id: string;
  factory?: string | null;
  unreachableReason?: string | null;
  sqrtPriceX96?: string | null;
  liquidity?: string | null;
  fee?: number | null;
  tickSpacing?: number | null;
  dexscreener?: { liquidityUsd?: number | null; volumeH24Usd?: number | null } | null;
};

/**
 * The cut's pools with what discovery read of each: its factory, which of Uniswap v3's reads it answered, and
 * DexScreener's own figures where it listed the pool. A pool of the cut that discovery does not hold is an error:
 * the cut is made from that file.
 */
export function cutPoolRows(
  cut: readonly CutFilePool[],
  discovery: readonly DiscoveryFilePool[],
): CutPoolRow[] {
  const byId = new Map(discovery.map((d) => [d.id.toLowerCase(), d]));
  return cut.map((p) => {
    const d = byId.get(p.address.toLowerCase());
    if (!d) throw new Error(`${p.address}: in the cut and not in its discovery file`);
    return {
      address: p.address,
      symbol: p.symbol,
      venue: p.venue,
      kind: p.kind,
      reachable: p.reachable,
      unreachableReason: d.unreachableReason ?? null,
      tvlUsd: p.tvlUsd,
      factory: d.factory ?? null,
      answers: {
        slot0: d.sqrtPriceX96 != null,
        liquidity: d.liquidity != null,
        fee: d.fee != null,
        tickSpacing: d.tickSpacing != null,
      },
      dexscreener: d.dexscreener
        ? {
            liquidityUsd: d.dexscreener.liquidityUsd ?? null,
            volumeH24Usd: d.dexscreener.volumeH24Usd ?? null,
          }
        : null,
    };
  });
}
