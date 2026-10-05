import { trackedSet } from '@colosseum/risk';
import {
  type AssetClass,
  AssetList,
  type TrackedAsset,
  type TrackedOracle,
} from '@colosseum/schemas';

// The asset list of one chain (PLAN-UNIVERSE RU.4, gate UNIVERSE): one row per tracked stock, keyed on
// the token address, written from files already made. No I/O, no clock, no chain read: the same inputs
// give the same list. What is copied and what is derived here is said in STATED, which goes in the file.

export const LIST_METHOD = 'universe-list-0.1';

/** Gate UNIVERSE and DU1. The Solana list applies them; the Robinhood list refuses a cut made by another rule. */
export const RULE = { share: 0.8, minPoolUsd: 1_000 };

/**
 * DU7: funds and the treasury token are ranked with the stocks and their class is set on the row.
 * Neither chain's inputs carry a class the vault's `AssetClass` can take (the issuer's registry has a
 * name only; Chainlink's directory files GLD as "Crypto" and says nothing for SGOV), so the class is
 * this table, by the underlying's ticker. A token whose underlying is not here is `stock`.
 */
export const CLASS_BY_UNDERLYING: Record<string, AssetClass> = {
  SPY: 'etf',
  QQQ: 'etf',
  GLD: 'gold',
  SLV: 'commodity',
  USO: 'commodity',
  SGOV: 'dollar_yield',
};

const ISSUER = { robinhood: 'Robinhood', solana: 'Backed (xStocks)' } as const;

export const STATED = {
  rows: 'One row per tracked stock, keyed on the token address. The tracked stocks are the ones the cut names at the rule in `rule`; every row of one run has inCut true.',
  identity:
    'id is the chain and the symbol in lower case; underlying is the symbol (on Solana without the trailing x); issuer and session (us_equity) are set here for every row, by chain. decimals is copied: on Robinhood Chain from the token list, where the contract confirmed it; on Solana from the registry.',
  cls: 'DU7: funds and the treasury token are ranked with the stocks. cls comes from a table in scripts/risk/universe/list.ts keyed on the underlying (SPY and QQQ etf, GLD gold, SLV and USO commodity, SGOV dollar_yield); every other token is stock. clsSource says which. No input file carries a class.',
  pools:
    'pools.ranked is every pool of the stock with a measured TVL at the floor or more; dust and unmeasured are the ones left out, and an unmeasured pool is never counted as zero. The pools themselves are not in this file.',
  reach:
    'DU3: a pool the vault cannot reach (a hooked v4 pool, another venue) is counted in ranked and in byVenue, and left out of reachable and reachableUsd; nothing is dropped. On Solana reach is not recorded per pool, so reachable is null with its reason and byExitPath says how a seller reaches dollars.',
  twoStockPools:
    "A pool of two stocks is one pool, counted once, under the stock its chain files it (token0 on Robinhood Chain, the registry asset on Solana): it is in that row's ranked, tvlUsd and twoStock. The stock on the other side has it in twoStockAsOther only, and not in its money. Whether such a pool should count for both is not decided here.",
  money:
    'tvlUsd, cutUsd and reachableUsd are copied from the cut (Solana: summed from the registry by the same rule). share is derived here: tvlUsd over rankedUsd, the money in every ranked pool of the chain.',
  oracle:
    'oracle.ref is the address or index the vault would read. On Robinhood Chain it is the proxy the oracle map confirmed on chain, copied; a stock whose feed that map refused carries its reason, and no_feed means the directory lists none. On Solana it is the Scope entry of the frozen Kamino reserves; a stock with no entry is no_scope_entry. No price is stored and nothing is compared with a pool price (ORACLE-VS-DEX).',
  prices:
    'oracle.prices is what the oracle map says the feed prices, copied; the map says it for the funds and the treasury token only, and for the others it is null with that reason. No multiplier is applied to anything.',
  autoRebalance:
    "Derived here by the rule alone: true when the row has a confirmed oracle, false with the oracle's reason when it has none. Where the oracle is confirmed and what it prices is in question (a price taken from the pools; a feed whose directory entry does not say what it prices) the row is still written true, and autoRebalanceOpen names the question. Whether such a stock may be rebalanced automatically is for the vault stream; this file does not decide it.",
  later:
    'The list is written from one run of its inputs. What happens to a stock that leaves the cut on a later run is not decided: no rule keeps or removes a row, and a new run writes the file again from scratch.',
  provenance:
    "source, fetchedAt, method and provenance on a row are the cut's (the time is the pool read's); on an oracle they are the oracle input's. They are copied, so a list written from frozen inputs says fixture.",
};

type Stamped = { source: string; fetchedAt: string; method: string; provenance: string };

const fail = (message: string): never => {
  throw new Error(`asset list: ${message}`);
};
const add = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};
const sortKeys = <V>(m: Record<string, V>): Record<string, V> =>
  Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function counts(assets: TrackedAsset[]) {
  const byReason: Record<string, number> = {};
  for (const a of assets) if (a.oracleReason) add(byReason, a.oracleReason);
  const reach = assets.map((a) => a.pools.reachable);
  return {
    assets: assets.length,
    withOracle: assets.filter((a) => a.oracle).length,
    withoutOracle: assets.filter((a) => !a.oracle).length,
    withoutOracleByReason: sortKeys(byReason),
    autoRebalance: assets.filter((a) => a.autoRebalance).length,
    rankedPools: assets.reduce((s, a) => s + a.pools.ranked, 0),
    reachablePools: reach.some((r) => r === null)
      ? null
      : reach.reduce((s: number, r) => s + (r as number), 0),
    twoStockPools: assets.reduce((s, a) => s + a.pools.twoStock, 0),
  };
}

/** The rule's last word on a row: true only with an oracle, false with the reason. */
const rebalance = (oracle: TrackedOracle | null, oracleReason: string | null) => ({
  autoRebalance: oracle !== null,
  autoRebalanceReason: oracle !== null ? null : oracleReason,
});

// ───────────────────────────── Robinhood Chain ─────────────────────────────

/** What the list reads of a cut file (pnpm risk-evm:pareto). */
export type ListCut = Stamped & {
  chain: string;
  rule: { share: number; minPoolUsd: number };
  counts: { ranked: number; rankedUsd: number };
  tracked: Array<{
    address: string;
    symbol: string;
    poolsInCut: number;
    cutUsd: number;
    pools: number;
    poolsUsd: number;
    reachablePools: number;
    reachableUsd: number;
    byVenue: Record<string, number>;
    dustPools: number;
    unmeasuredPools: number;
  }>;
  /** Every ranked pool of the tracked stocks. */
  pools: Array<{
    address: string;
    asset: string;
    other: string;
    otherIsStock: boolean;
    venue: string;
    reachable: boolean;
  }>;
};

/** What the list reads of an oracle map (pnpm risk-evm:oracles). No round, no price. */
export type ListOracles = Stamped & {
  chain: string;
  block: number;
  inputs: { cut: string; universe: string };
  tracked: Array<
    Stamped & {
      address: string;
      symbol: string;
      feed: { address: string; description: string; decimals: number } | null;
      reason: string | null;
    }
  >;
  funds: Array<{
    address: string;
    symbol: string;
    prices: 'token_with_multiplier' | 'token_from_pools' | null;
    pricesReason: string | null;
  }>;
};

/** What the list reads of the issuer's token list (pnpm risk-evm:universe): the tracked tokens only. */
export type ListUniverse = Stamped & {
  chain: string;
  tokens: Array<{
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    confirmed: boolean;
  }>;
};

const stamp = (s: Stamped): Stamped => ({
  source: s.source,
  fetchedAt: s.fetchedAt,
  method: s.method,
  provenance: s.provenance,
});

export const cutForList = (c: ListCut): ListCut => ({
  chain: c.chain,
  ...stamp(c),
  rule: { share: c.rule.share, minPoolUsd: c.rule.minPoolUsd },
  counts: { ranked: c.counts.ranked, rankedUsd: c.counts.rankedUsd },
  tracked: c.tracked.map((t) => ({
    address: t.address,
    symbol: t.symbol,
    poolsInCut: t.poolsInCut,
    cutUsd: t.cutUsd,
    pools: t.pools,
    poolsUsd: t.poolsUsd,
    reachablePools: t.reachablePools,
    reachableUsd: t.reachableUsd,
    byVenue: t.byVenue,
    dustPools: t.dustPools,
    unmeasuredPools: t.unmeasuredPools,
  })),
  pools: c.pools.map((p) => ({
    address: p.address,
    asset: p.asset,
    other: p.other,
    otherIsStock: p.otherIsStock,
    venue: p.venue,
    reachable: p.reachable,
  })),
});

export const oraclesForList = (o: ListOracles): ListOracles => ({
  chain: o.chain,
  ...stamp(o),
  block: o.block,
  inputs: { cut: o.inputs.cut, universe: o.inputs.universe },
  tracked: o.tracked.map((r) => ({
    address: r.address,
    symbol: r.symbol,
    feed: r.feed
      ? { address: r.feed.address, description: r.feed.description, decimals: r.feed.decimals }
      : null,
    reason: r.reason,
    ...stamp(r),
  })),
  funds: o.funds.map((f) => ({
    address: f.address,
    symbol: f.symbol,
    prices: f.prices,
    pricesReason: f.pricesReason,
  })),
});

export const universeForList = (u: ListUniverse, tracked: Array<{ address: string }>) => {
  const want = new Set(tracked.map((t) => t.address.toLowerCase()));
  return {
    chain: u.chain,
    ...stamp(u),
    tokens: u.tokens
      .filter((t) => want.has(t.address.toLowerCase()))
      .map((t) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        confirmed: t.confirmed,
      })),
  };
};

export type ListInputs = {
  cut: ListCut;
  oracles: ListOracles;
  universe: ListUniverse;
  /** The three files by name, for the list's `inputs`. */
  names: { cut: string; oracles: string; universe: string };
};

/**
 * The cut and the oracle map must be of one run: the same token addresses, each under the same symbol.
 * Returns what differs, in words; empty when they agree.
 */
export function pairMismatch(cut: ListCut, oracles: ListOracles): string[] {
  const out: string[] = [];
  const inCut = new Map(cut.tracked.map((t) => [t.address.toLowerCase(), t.symbol]));
  const inMap = new Map(oracles.tracked.map((t) => [t.address.toLowerCase(), t.symbol]));
  if (inMap.size !== oracles.tracked.length) out.push('the oracle map names a token address twice');
  if (inCut.size !== cut.tracked.length) out.push('the cut names a token address twice');
  for (const [address, symbol] of inCut) {
    if (!inMap.has(address)) out.push(`${symbol} (${address}) is in the cut and not in the map`);
    else if (inMap.get(address) !== symbol)
      out.push(`${address} is ${symbol} in the cut and ${inMap.get(address)} in the map`);
  }
  for (const [address, symbol] of inMap)
    if (!inCut.has(address)) out.push(`${symbol} (${address}) is in the map and not in the cut`);
  return out;
}

/** What is asked of the vault stream when a confirmed feed's price is not plainly the token's. */
const openQuestion = (fund: ListOracles['funds'][number] | undefined): string | null =>
  !fund
    ? null
    : fund.prices === 'token_from_pools'
      ? 'oracle_prices_from_pools'
      : fund.prices === null
        ? 'what_the_oracle_prices_is_not_stated'
        : null;

export function robinhoodList(input: ListInputs): AssetList {
  const { cut, oracles, universe, names } = input;
  for (const f of [cut, oracles, universe])
    if (f.chain !== 'robinhood') fail(`an input is for "${f.chain}", not robinhood`);
  if (cut.rule.share !== RULE.share || cut.rule.minPoolUsd !== RULE.minPoolUsd)
    fail(
      `the cut was made at ${cut.rule.share} and $${cut.rule.minPoolUsd}, not the rule's ${RULE.share} and $${RULE.minPoolUsd}`,
    );
  if (cut.tracked.length === 0) fail('the cut names no tracked stock');
  const differs = pairMismatch(cut, oracles);
  if (differs.length > 0) fail(`the oracle map is not of this cut, refused: ${differs.join('; ')}`);
  if (!(cut.counts.rankedUsd > 0)) fail('the cut ranks no money');

  const lower = (s: string) => s.toLowerCase();
  const token = new Map(universe.tokens.map((t) => [lower(t.address), t]));
  const feedOf = new Map(oracles.tracked.map((r) => [lower(r.address), r]));
  const fundOf = new Map(oracles.funds.map((f) => [lower(f.address), f]));
  const poolsOf = new Map<string, ListCut['pools']>();
  const asOther: Record<string, number> = {};
  const trackedAddresses = new Set(cut.tracked.map((t) => lower(t.address)));
  for (const p of cut.pools) {
    const k = lower(p.asset);
    if (!trackedAddresses.has(k)) fail(`pool ${p.address} is filed under an untracked token`);
    poolsOf.set(k, [...(poolsOf.get(k) ?? []), p]);
    if (p.otherIsStock) add(asOther, lower(p.other));
  }

  const ids = new Set<string>();
  const assets = cut.tracked.map((t): TrackedAsset => {
    const address = lower(t.address);
    const id = `robinhood:${lower(t.symbol)}`;
    if (ids.has(id)) fail(`two tracked tokens are called ${t.symbol}: the id would not be unique`);
    ids.add(id);
    const listed = token.get(address) ?? fail(`${t.symbol} is not in the token list`);
    if (!listed.confirmed || listed.symbol !== t.symbol)
      fail(`${t.symbol}: the token list does not confirm it (${listed.symbol})`);

    // the per-venue reach is counted from the pools and must agree with what the cut says of the stock
    const pools = poolsOf.get(address) ?? [];
    const byVenue: Record<string, { pools: number; reachable: number }> = {};
    for (const p of pools) {
      const v = byVenue[p.venue] ?? { pools: 0, reachable: 0 };
      v.pools++;
      if (p.reachable) v.reachable++;
      byVenue[p.venue] = v;
    }
    const reachable = pools.filter((p) => p.reachable).length;
    const sameVenues =
      Object.keys(t.byVenue).length === Object.keys(byVenue).length &&
      Object.entries(t.byVenue).every(([v, n]) => byVenue[v]?.pools === n);
    if (pools.length !== t.pools || reachable !== t.reachablePools || !sameVenues)
      fail(`${t.symbol}: the cut's pools do not add up to what it says of the stock`);

    const row = feedOf.get(address) as ListOracles['tracked'][number];
    if (!row.feed && !row.reason) fail(`${t.symbol}: the oracle map gives no feed and no reason`);
    const fund = fundOf.get(address);
    const oracle: TrackedOracle | null = row.feed
      ? {
          kind: 'chainlink',
          ref: lower(row.feed.address),
          account: null,
          twapRef: null,
          description: row.feed.description,
          decimals: row.feed.decimals,
          prices: fund ? fund.prices : null,
          pricesReason: fund
            ? fund.prices === null
              ? (fund.pricesReason ?? 'not_stated_in_directory')
              : null
            : 'oracle_map_says_it_for_funds_only',
          ...(stamp(row) as Pick<TrackedOracle, 'source' | 'fetchedAt' | 'method' | 'provenance'>),
        }
      : null;
    const oracleReason = oracle ? null : row.reason;
    const cls = CLASS_BY_UNDERLYING[t.symbol];
    return {
      id,
      chain: 'robinhood',
      address,
      symbol: t.symbol,
      decimals: listed.decimals,
      cls: cls ?? 'stock',
      clsSource: cls ? 'class_table' : 'default_stock',
      underlying: t.symbol,
      issuer: ISSUER.robinhood,
      session: 'us_equity',
      inCut: t.poolsInCut > 0,
      pools: {
        ranked: t.pools,
        inCut: t.poolsInCut,
        reachable: t.reachablePools,
        reachableReason: null,
        byVenue: sortKeys(byVenue),
        twoStock: pools.filter((p) => p.otherIsStock).length,
        twoStockAsOther: asOther[address] ?? 0,
        dust: t.dustPools,
        unmeasured: t.unmeasuredPools,
      },
      tvlUsd: t.poolsUsd,
      cutUsd: t.cutUsd,
      reachableUsd: t.reachableUsd,
      share: t.poolsUsd / cut.counts.rankedUsd,
      oracle,
      oracleReason,
      ...rebalance(oracle, oracleReason),
      autoRebalanceOpen: oracle ? openQuestion(fund) : null,
      source: `${names.cut} (pnpm risk-evm:pareto) of ${cut.source}`,
      fetchedAt: cut.fetchedAt,
      method: cut.method,
      provenance: cut.provenance as TrackedAsset['provenance'],
    };
  });

  return AssetList.parse({
    chain: 'robinhood',
    source: `${names.cut}, ${names.oracles} and ${names.universe} (pnpm risk-evm:pareto, pnpm risk-evm:oracles, pnpm risk-evm:universe); no chain read`,
    fetchedAt: cut.fetchedAt,
    method: LIST_METHOD,
    provenance: cut.provenance,
    inputs: names,
    rule: cut.rule,
    rankedUsd: cut.counts.rankedUsd,
    counts: counts(assets),
    stated: STATED,
    assets,
  });
}

// ────────────────────────────────── Solana ──────────────────────────────────

/** The frozen registry of RU.1: pool, the stock it is filed under (by symbol), TVL. */
export type SolanaRegistry = {
  chain: string;
  source: string;
  fetched_at: string;
  method: string;
  provenance: string;
  pools: Array<{ address: string; asset: string; tvlUsd: number | null }>;
};

/** The same registry file, cut to what a row needs beyond the rule: the mint, its decimals, the venue, the way out. */
export type SolanaDetail = {
  chain: string;
  source: string;
  fetched_at: string;
  method: string;
  provenance: string;
  pools: Array<{
    address: string;
    mint: string;
    decimals: number;
    quoteMint: string;
    venue: string;
    exitPath: string;
  }>;
};

/** fixtures/solana-vault/scope-indexes.json. */
export type ScopeIndexes = Stamped & {
  priceAccount: string;
  assets: Array<
    Partial<Stamped> & {
      symbol: string;
      mint: string;
      decimals: number;
      priceIndex: number;
      twapIndex: number;
    }
  >;
};

export type SolanaInputs = {
  registry: SolanaRegistry;
  detail: SolanaDetail;
  scope: ScopeIndexes;
  names: { registry: string; detail: string; scope: string };
};

/** The registry's word for a pool whose other side is another stock token. */
const VIA_STOCK = 'via_xstock';

export function solanaList(input: SolanaInputs): AssetList {
  const { registry, detail, scope, names } = input;
  if (registry.chain !== 'solana' || detail.chain !== 'solana')
    fail("the registry is not Solana's");
  if (registry.fetched_at !== detail.fetched_at || registry.method !== detail.method)
    fail('the two registry files are not of the same read');
  const t = trackedSet(registry.pools, RULE);
  const detailOf = new Map(detail.pools.map((p) => [p.address, p]));
  const inCut = new Set(t.cut.map((p) => p.address));

  // the mint of each tracked stock: every ranked pool of the stock must name the same one
  const mintOf = new Map<string, { mint: string; decimals: number }>();
  for (const p of t.pools) {
    const d = detailOf.get(p.address) ?? fail(`pool ${p.address} has no row in ${names.detail}`);
    const seen = mintOf.get(p.asset);
    if (seen && (seen.mint !== d.mint || seen.decimals !== d.decimals))
      fail(`${p.asset} has two mints or two decimals in the registry`);
    mintOf.set(p.asset, { mint: d.mint, decimals: d.decimals });
  }
  const symbolOfMint = new Map([...mintOf].map(([symbol, m]) => [m.mint, symbol]));
  if (symbolOfMint.size !== mintOf.size) fail('two tracked stocks share a mint');
  const scopeOf = new Map(scope.assets.map((a) => [a.mint, a]));
  if (scopeOf.size !== scope.assets.length) fail('the Scope table names a mint twice');

  const rowStamp = {
    source: `${names.registry} and ${names.detail}: ${registry.source}`,
    fetchedAt: registry.fetched_at,
    method: registry.method,
    provenance: registry.provenance as TrackedAsset['provenance'],
  };
  const assets = t.assets.map((symbol): TrackedAsset => {
    const { mint, decimals } = mintOf.get(symbol) as { mint: string; decimals: number };
    const all = registry.pools.filter((p) => p.asset === symbol);
    const ranked = t.pools.filter((p) => p.asset === symbol);
    const rankedIds = new Set(ranked.map((p) => p.address));
    const cutPools = ranked.filter((p) => inCut.has(p.address));
    const byVenue: Record<string, { pools: number; reachable: null }> = {};
    const byExitPath: Record<string, number> = {};
    for (const p of ranked) {
      const d = detailOf.get(p.address) as SolanaDetail['pools'][number];
      byVenue[d.venue] = { pools: (byVenue[d.venue]?.pools ?? 0) + 1, reachable: null };
      add(byExitPath, d.exitPath);
    }
    const entry = scopeOf.get(mint);
    if (entry && (entry.symbol !== symbol || entry.decimals !== decimals))
      fail(`${symbol}: the Scope table calls its mint ${entry.symbol}, ${entry.decimals} decimals`);
    const oracle: TrackedOracle | null = entry
      ? {
          kind: 'scope',
          ref: String(entry.priceIndex),
          account: scope.priceAccount,
          twapRef: String(entry.twapIndex),
          description: null,
          decimals: null,
          prices: null,
          pricesReason: 'not_reported_by_the_scope_table',
          source: `${names.scope}: ${entry.source ?? scope.source}`,
          fetchedAt: entry.fetchedAt ?? scope.fetchedAt,
          method: entry.method ?? scope.method,
          provenance: scope.provenance as TrackedOracle['provenance'],
        }
      : null;
    const oracleReason = oracle ? null : 'no_scope_entry';
    const underlying = symbol.replace(/x$/, '');
    const cls = CLASS_BY_UNDERLYING[underlying];
    const tvlUsd = ranked.reduce((s, p) => s + (p.tvlUsd as number), 0);
    return {
      id: `solana:${symbol.toLowerCase()}`,
      chain: 'solana',
      address: mint,
      symbol,
      decimals,
      cls: cls ?? 'stock',
      clsSource: cls ? 'class_table' : 'default_stock',
      underlying,
      issuer: ISSUER.solana,
      session: 'us_equity',
      inCut: cutPools.length > 0,
      pools: {
        ranked: ranked.length,
        inCut: cutPools.length,
        reachable: null,
        reachableReason: 'reach_is_not_recorded_per_pool_on_solana',
        byVenue: sortKeys(byVenue),
        twoStock: byExitPath[VIA_STOCK] ?? 0,
        twoStockAsOther: t.pools.filter(
          (p) => p.asset !== symbol && detailOf.get(p.address)?.quoteMint === mint,
        ).length,
        byExitPath: sortKeys(byExitPath),
        dust: all.filter((p) => !rankedIds.has(p.address) && p.tvlUsd !== null).length,
        unmeasured: all.filter((p) => p.tvlUsd === null).length,
      },
      tvlUsd,
      cutUsd: cutPools.reduce((s, p) => s + (p.tvlUsd as number), 0),
      reachableUsd: null,
      share: tvlUsd / t.rankedUsd,
      oracle,
      oracleReason,
      ...rebalance(oracle, oracleReason),
      autoRebalanceOpen: null,
      ...rowStamp,
    };
  });

  return AssetList.parse({
    chain: 'solana',
    source: `${names.registry}, ${names.detail} and ${names.scope}, through trackedSet of packages/risk; no chain read`,
    fetchedAt: registry.fetched_at,
    method: LIST_METHOD,
    provenance: registry.provenance,
    inputs: names,
    rule: { share: t.share, minPoolUsd: t.minPoolUsd },
    rankedUsd: t.rankedUsd,
    counts: counts(assets),
    stated: STATED,
    assets,
  });
}
