// The 80% rule on one discovery file (PLAN-UNIVERSE RU.3, gate UNIVERSE). No I/O, no clock: the
// command is pareto.ts. The rule itself is trackedSet of @colosseum/risk; this file maps the rows to
// it and reports what the rule could not see, so nothing is chosen in silence.
import { type TrackedSet, trackedSet, type UniversePool } from '@colosseum/risk';
import type { DiscoveryFile } from './discover-run';
import { DEXSCREENER_AT_CAP, DEXSCREENER_FAILED, type PoolRow } from './discovery';

export const CUT_METHOD = 'evm-cut-0.1';
/** A token carrying this gap may be missing its pools on other venues: the file is refused or printed. */
export { DEXSCREENER_FAILED };
export const SHARES = [0.8, 0.9, 0.95, 0.99];

/**
 * One pool as the rule reads it: `address` is the pool id, `asset` the address of the stock the pool is
 * filed under (two tokens may share a symbol, never an address), `tvlUsd` as discovery measured it. A
 * TVL that was not measured stays null: trackedSet leaves it out and counts it, never as zero.
 */
export type CutRow = UniversePool & {
  symbol: string;
  /** The other side of the pair, lower case. */
  other: string;
  otherSymbol: string | null;
  otherIsStock: boolean;
  kind: PoolRow['kind'];
  venue: string;
  reachable: boolean;
  /** Dollars on the stock side alone; known for a priced stock even where the pool's TVL is not. */
  tokenUsd: number | null;
  tvlMethod: PoolRow['tvlMethod'];
  tvlReason: PoolRow['tvlReason'];
};

export const cutRow = (p: PoolRow): CutRow => ({
  address: p.id,
  asset: p.token,
  tvlUsd: p.tvlUsd,
  symbol: p.symbol,
  other: p.other.toLowerCase(),
  otherSymbol: p.otherSymbol,
  otherIsStock: p.otherIsStock,
  kind: p.kind,
  venue: p.venue,
  reachable: p.reachable,
  tokenUsd: p.tokenUsd,
  tvlMethod: p.tvlMethod,
  tvlReason: p.tvlReason,
});

export type CutToken = {
  address: string;
  symbol: string;
  /** False when discovery found no dollar pool deep enough to price the stock. */
  priced: boolean;
  /** Rows discovery wrote for the token, and how many of them the vault reaches. */
  rows: number;
  reachableRows: number;
  gaps: string[];
};

/** What the cut reads of a discovery file. A frozen copy (fixtures/risk/universe) has the same shape. */
export type CutInput = {
  chain: string;
  chainId: number;
  provenance: string;
  source: string;
  method: string;
  fetchedAt: string;
  blocks: DiscoveryFile['blocks'];
  params: DiscoveryFile['params'];
  tokens: CutToken[];
  pools: CutRow[];
  /** Set on a frozen copy that keeps only some rows: which, and how many were left out. */
  rowsLeftOut?: { rule: string; rows: number };
};

export function cutInput(file: DiscoveryFile, fileName: string): CutInput {
  const priced = new Set(
    file.prices.filter((p) => p.usdPerRaw !== null).map((p) => p.address.toLowerCase()),
  );
  return {
    chain: file.chain,
    chainId: file.chainId,
    provenance: file.provenance,
    source: `${fileName} (pnpm risk-evm:discover: ${file.source})`,
    method: file.method,
    fetchedAt: file.fetchedAt,
    blocks: file.blocks,
    params: file.params,
    tokens: file.tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      priced: priced.has(t.address.toLowerCase()),
      rows: t.pools,
      reachableRows: t.reachable,
      gaps: t.gaps,
    })),
    pools: file.pools.map(cutRow),
  };
}

/** The tokens of a file that carry DEXSCREENER_FAILED. Not empty = the command refuses the file. */
export const failedTokens = (input: Pick<CutInput, 'tokens'>): string[] =>
  input.tokens.filter((t) => t.gaps.includes(DEXSCREENER_FAILED)).map((t) => t.symbol);

type Stock = { address: string; symbol: string };

export type ShareCount = {
  share: number;
  pools: number;
  cutUsd: number;
  stocks: number;
  symbols: string[];
  /** Every ranked pool of the stocks this share names. */
  poolsOfTheStocks: number;
};

export type CutReport = {
  chain: string;
  chainId: number;
  provenance: string;
  source: string;
  method: typeof CUT_METHOD;
  /** The discovery's time: the cut is arithmetic on that file and reads nothing else. */
  fetchedAt: string;
  discovery: {
    method: string;
    blocks: CutInput['blocks'];
    params: CutInput['params'];
    rowsLeftOut: CutInput['rowsLeftOut'] | null;
  };
  rule: { share: number; minPoolUsd: number; shares: number[]; mapping: string };
  /** What the input could not have seen. `dexscreenerFailed` not empty means the file was let through by hand. */
  inputGaps: { dexscreenerFailed: string[]; dexscreenerAtCap: string[] };
  counts: {
    tokens: number;
    rows: number;
    measured: number;
    ranked: number;
    rankedUsd: number;
    measuredBelowFloor: number;
    unmeasured: number;
    unmeasuredByReason: Record<string, number>;
  };
  shares: ShareCount[];
  /** The tracked stocks at `rule.share`, largest first by the money in their ranked pools. */
  tracked: Array<
    Stock & {
      poolsInCut: number;
      cutUsd: number;
      pools: number;
      poolsUsd: number;
      reachablePools: number;
      reachableUsd: number;
      byVenue: Record<string, number>;
      dustPools: number;
      unmeasuredPools: number;
    }
  >;
  cut: Array<CutRow & { cumulativeShare: number }>;
  pools: CutRow[];
  /** Stocks with no price: their pools cannot enter the cut. Listed, not decided. */
  unpricedTokens: {
    count: number;
    note: string;
    tokens: Array<Stock & Omit<CutToken, 'gaps' | 'priced' | 'address' | 'symbol'>>;
  };
  /** Rows with no TVL that hold `floorUsd` or more on the stock side. Counted and listed, never ranked. */
  unrankedHoldingStock: {
    floorUsd: number;
    note: string;
    rows: number;
    tokenUsd: number;
    byReason: Record<string, { rows: number; tokenUsd: number }>;
    byVenue: Record<string, { rows: number; tokenUsd: number }>;
    ofTrackedStocks: { rows: number; tokenUsd: number };
    byStock: Array<Stock & { tracked: boolean; rows: number; tokenUsd: number }>;
  };
  /** The same rule on the rows that are not v4: a v4 TVL is a band sum and runs a little low. */
  withoutV4: {
    note: string;
    rankedUsd: number;
    rankedPools: number;
    shares: ShareCount[];
    sameStocksAtShare: boolean;
    onlyWithV4: string[];
    onlyWithoutV4: string[];
  };
  /** Pools of two stocks are one row under token0. Whether they count for both is not decided here. */
  twoStockPools: {
    note: string;
    rows: number;
    ranked: number;
    inCut: number;
    touchingTracked: number;
    /** Tracked stocks that are the other side of such a pool, with what those pools hold. */
    trackedAsOther: Array<Stock & { pools: number; tvlUsd: number }>;
    /** Stocks the rule does not track that would be named if a cut pool also counted for its other side. */
    wouldAlsoBeNamed: string[];
    pools: Array<{
      address: string;
      filedUnder: string;
      other: string | null;
      venue: string;
      reachable: boolean;
      tvlUsd: number | null;
      inCut: boolean;
      filedUnderTracked: boolean;
      otherTracked: boolean;
    }>;
  };
  /** The tracked stocks against the tokens the hourly collector reads (config.ts). */
  vsCollector: {
    collected: number;
    tracked: number;
    both: string[];
    trackedNotCollected: string[];
    collectedNotTracked: Array<
      Stock & {
        why: 'not_in_the_registry' | 'not_priced' | 'no_pool_at_the_floor' | 'below_the_cut';
        /** Its largest ranked pool, the rank of that pool, and the share of the money in the pools ranked above it: the stock is named by any cut wider than that. */
        largestPoolUsd: number | null;
        rank: number | null;
        entersAtShare: number | null;
      }
    >;
  };
};

const lower = (s: string) => s.toLowerCase();
const add = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};
const addUsd = (m: Record<string, { rows: number; tokenUsd: number }>, k: string, usd: number) => {
  const v = m[k] ?? { rows: 0, tokenUsd: 0 };
  v.rows++;
  v.tokenUsd += usd;
  m[k] = v;
};

/**
 * The cut of one chain. `share` and `minPoolUsd` are the rule (DU1); `shares` are the wider cuts counted
 * beside it; `collected` are the tokens the hourly collector reads today.
 */
export function cutReport(
  input: CutInput,
  opts: { share: number; minPoolUsd: number; shares?: number[]; collected: Stock[] },
): CutReport {
  const { share, minPoolUsd, collected } = opts;
  const shares = opts.shares ?? SHARES;
  const symbolOf = new Map(input.tokens.map((t) => [lower(t.address), t.symbol]));
  const name = (address: string) => symbolOf.get(lower(address)) ?? address;
  const rule = { share, minPoolUsd };

  const count = (rows: CutRow[], s: number): ShareCount => {
    const t = trackedSet(rows, { share: s, minPoolUsd });
    return {
      share: s,
      pools: t.cut.length,
      cutUsd: t.cutUsd,
      stocks: t.assets.length,
      symbols: t.assets.map(name).sort(),
      poolsOfTheStocks: t.pools.length,
    };
  };

  const set: TrackedSet<CutRow> = trackedSet(input.pools, rule);
  const tracked = new Set(set.assets.map(lower));
  const inCut = new Set(set.cut.map((p) => p.address));

  let running = 0;
  const cut = set.cut.map((p) => {
    running += p.tvlUsd as number;
    return { ...p, cumulativeShare: running / set.rankedUsd };
  });

  const unmeasuredByReason: Record<string, number> = {};
  let measured = 0;
  for (const p of input.pools)
    if (p.tvlUsd === null) add(unmeasuredByReason, p.tvlReason ?? 'no_reason_given');
    else measured++;

  const perStock = set.assets
    .map((address) => {
      const one = trackedSet(
        input.pools.filter((p) => p.asset === address),
        { share: 1, minPoolUsd },
      );
      const mine = set.cut.filter((p) => p.asset === address);
      const reach = one.pools.filter((p) => p.reachable);
      const byVenue: Record<string, number> = {};
      for (const p of one.pools) add(byVenue, p.venue);
      return {
        address,
        symbol: name(address),
        poolsInCut: mine.length,
        cutUsd: mine.reduce((s, p) => s + (p.tvlUsd as number), 0),
        pools: one.pools.length,
        poolsUsd: one.poolsUsd,
        reachablePools: reach.length,
        reachableUsd: reach.reduce((s, p) => s + (p.tvlUsd as number), 0),
        byVenue,
        dustPools: one.dustPools,
        unmeasuredPools: one.unmeasuredPools,
      };
    })
    .sort((a, b) => b.poolsUsd - a.poolsUsd || (a.address < b.address ? -1 : 1));

  // Rows the rule cannot rank that still hold real money on the stock side.
  const holding = input.pools.filter(
    (p) => p.tvlUsd === null && p.tokenUsd !== null && p.tokenUsd >= minPoolUsd,
  );
  const byReason: Record<string, { rows: number; tokenUsd: number }> = {};
  const byVenue: Record<string, { rows: number; tokenUsd: number }> = {};
  const byAsset: Record<string, { rows: number; tokenUsd: number }> = {};
  for (const p of holding) {
    addUsd(byReason, p.tvlReason ?? 'no_reason_given', p.tokenUsd as number);
    addUsd(byVenue, p.venue, p.tokenUsd as number);
    addUsd(byAsset, p.asset, p.tokenUsd as number);
  }
  const holdingByStock = Object.entries(byAsset)
    .map(([address, v]) => ({
      address,
      symbol: name(address),
      tracked: tracked.has(lower(address)),
      ...v,
    }))
    .sort((a, b) => b.tokenUsd - a.tokenUsd || (a.address < b.address ? -1 : 1));
  const holdingTracked = holdingByStock.filter((s) => s.tracked);

  const noV4 = input.pools.filter((p) => p.kind !== 'v4');
  const setNoV4 = trackedSet(noV4, rule);
  const trackedNoV4 = new Set(setNoV4.assets.map(lower));

  const two = input.pools.filter((p) => p.otherIsStock);
  const twoTouching = two.filter((p) => tracked.has(lower(p.asset)) || tracked.has(p.other));
  const asOther = new Map<string, { pools: number; tvlUsd: number }>();
  for (const p of two) {
    if (!tracked.has(p.other)) continue;
    const v = asOther.get(p.other) ?? { pools: 0, tvlUsd: 0 };
    v.pools++;
    v.tvlUsd += p.tvlUsd ?? 0;
    asOther.set(p.other, v);
  }
  const wouldAlso = new Set<string>();
  for (const p of two)
    if (inCut.has(p.address) && !tracked.has(p.other)) wouldAlso.add(name(p.other));

  const rank = new Map<string, { usd: number; rank: number; at: number }>();
  {
    const all = trackedSet(input.pools, { share: 1, minPoolUsd });
    let sum = 0;
    all.cut.forEach((p, i) => {
      const k = lower(p.asset);
      if (!rank.has(k))
        rank.set(k, { usd: p.tvlUsd as number, rank: i + 1, at: sum / all.rankedUsd });
      sum += p.tvlUsd as number;
    });
  }
  const tokenOf = new Map(input.tokens.map((t) => [lower(t.address), t]));
  const collectedKeys = new Set(collected.map((c) => lower(c.address)));

  return {
    chain: input.chain,
    chainId: input.chainId,
    provenance: input.provenance,
    source: input.source,
    method: CUT_METHOD,
    fetchedAt: input.fetchedAt,
    discovery: {
      method: input.method,
      blocks: input.blocks,
      params: input.params,
      rowsLeftOut: input.rowsLeftOut ?? null,
    },
    rule: {
      share,
      minPoolUsd,
      shares,
      mapping:
        'one row per pool: address = the pool id, asset = the address of the stock it is filed under, tvlUsd as discovery measured it; a TVL that was not measured is left out and counted, never zero',
    },
    inputGaps: {
      dexscreenerFailed: failedTokens(input),
      dexscreenerAtCap: input.tokens
        .filter((t) => t.gaps.includes(DEXSCREENER_AT_CAP))
        .map((t) => t.symbol)
        .sort(),
    },
    counts: {
      tokens: input.tokens.length,
      rows: input.pools.length,
      measured,
      ranked: set.rankedPools,
      rankedUsd: set.rankedUsd,
      measuredBelowFloor: measured - set.rankedPools,
      unmeasured: input.pools.length - measured,
      unmeasuredByReason,
    },
    shares: shares.map((s) => count(input.pools, s)),
    tracked: perStock,
    cut,
    pools: set.pools,
    unpricedTokens: (() => {
      const tokens = input.tokens
        .filter((t) => !t.priced)
        .map((t) => ({
          address: t.address,
          symbol: t.symbol,
          rows: t.rows,
          reachableRows: t.reachableRows,
        }))
        .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
      return {
        count: tokens.length,
        note: `no dollar pool holding $${input.params.minRefUsd} to price the stock, so none of its pools has a TVL and none can enter the cut; whether a thinner pool may price a stock is not decided here`,
        tokens,
      };
    })(),
    unrankedHoldingStock: {
      floorUsd: minPoolUsd,
      note: 'rows with no TVL (the other token has no price) whose stock side alone is at the floor or more; left out of the ranking and the total, listed so the omission is seen',
      rows: holding.length,
      tokenUsd: holding.reduce((s, p) => s + (p.tokenUsd as number), 0),
      byReason,
      byVenue,
      ofTrackedStocks: {
        rows: holdingTracked.reduce((s, x) => s + x.rows, 0),
        tokenUsd: holdingTracked.reduce((s, x) => s + x.tokenUsd, 0),
      },
      byStock: holdingByStock,
    },
    withoutV4: {
      note: 'a v3 TVL is the balances the pool holds; a v4 TVL is what positions hold within the band of the price and runs a little low. This is the same rule with the v4 rows taken out',
      rankedUsd: setNoV4.rankedUsd,
      rankedPools: setNoV4.rankedPools,
      shares: shares.map((s) => count(noV4, s)),
      sameStocksAtShare:
        setNoV4.assets.length === set.assets.length &&
        setNoV4.assets.every((a) => tracked.has(lower(a))),
      onlyWithV4: set.assets
        .filter((a) => !trackedNoV4.has(lower(a)))
        .map(name)
        .sort(),
      onlyWithoutV4: setNoV4.assets
        .filter((a) => !tracked.has(lower(a)))
        .map(name)
        .sort(),
    },
    twoStockPools: {
      note: 'a pool of two stocks is one row, filed under token0 (the lower address). The rule counts it for that stock only; whether it also counts for the other is for RU.4 or the routing item',
      rows: two.length,
      ranked: two.filter((p) => p.tvlUsd !== null && p.tvlUsd > 0 && p.tvlUsd >= minPoolUsd).length,
      inCut: two.filter((p) => inCut.has(p.address)).length,
      touchingTracked: twoTouching.length,
      trackedAsOther: [...asOther.entries()]
        .map(([address, v]) => ({
          address: tokenOf.get(address)?.address ?? address,
          symbol: name(address),
          ...v,
        }))
        .sort((a, b) => b.tvlUsd - a.tvlUsd || (a.address < b.address ? -1 : 1)),
      wouldAlsoBeNamed: [...wouldAlso].sort(),
      pools: twoTouching
        .map((p) => ({
          address: p.address,
          filedUnder: p.symbol,
          other: p.otherSymbol,
          venue: p.venue,
          reachable: p.reachable,
          tvlUsd: p.tvlUsd,
          inCut: inCut.has(p.address),
          filedUnderTracked: tracked.has(lower(p.asset)),
          otherTracked: tracked.has(p.other),
        }))
        .sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || (a.address < b.address ? -1 : 1)),
    },
    vsCollector: {
      collected: collected.length,
      tracked: set.assets.length,
      both: collected
        .filter((c) => tracked.has(lower(c.address)))
        .map((c) => c.symbol)
        .sort(),
      trackedNotCollected: set.assets
        .filter((a) => !collectedKeys.has(lower(a)))
        .map(name)
        .sort(),
      collectedNotTracked: collected
        .filter((c) => !tracked.has(lower(c.address)))
        .map((c) => {
          const t = tokenOf.get(lower(c.address));
          const r = rank.get(lower(c.address));
          return {
            address: c.address,
            symbol: c.symbol,
            why: !t
              ? ('not_in_the_registry' as const)
              : !t.priced
                ? ('not_priced' as const)
                : !r
                  ? ('no_pool_at_the_floor' as const)
                  : ('below_the_cut' as const),
            largestPoolUsd: r?.usd ?? null,
            rank: r?.rank ?? null,
            entersAtShare: r?.at ?? null,
          };
        })
        .sort((a, b) => (b.largestPoolUsd ?? -1) - (a.largestPoolUsd ?? -1)),
    },
  };
}
