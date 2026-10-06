// A collector run on the asset list (PLAN-UNIVERSE RU.6): the tokens are the tracked stocks of
// scripts/risk/universe/<chain>.json, and each token's pools are every pool the cut ranks for it that the
// vault reaches, confirmed on chain as before. Beside the asset row (evmq-0.1, unchanged) every such
// pool gets a row of its own (evmq-pools-0.1). No I/O here.
import type { AssetList } from '@colosseum/schemas';
import type { ChainConfig, TokenConfig } from './config';
import { costPct, GRID_USD, outUsdOf, type PoolQuotes, type Side } from './curve';
import type { ListedFeed } from './oracle';
import type { Candidate, PoolRef } from './pools';

export const POOLS_METHOD_VERSION = 'evmq-pools-0.1';
export const POOLS_METHOD = 'each_pool_exact_in_vs_own_pool_mid';

/** One ranked pool of a tracked stock, as the cut file has it. */
export type ListedPool = {
  id: string;
  kind: 'cl' | 'v4';
  venue: string;
  /** The other side of the pair, lower case, and its symbol where the cut knows it. */
  other: string;
  otherSymbol: string | null;
  otherIsStock: boolean;
  reachable: boolean;
  /** As the cut measured it, at the cut's time. Used to order the pools, and carried on the pool row. */
  tvlUsd: number | null;
};

/** What a list run reads of a cut file. */
export type CutForCollector = {
  chain: string;
  fetchedAt: string;
  tracked: Array<{ address: string; symbol: string }>;
  pools: Array<{
    address: string;
    asset: string;
    kind: 'cl' | 'v4';
    venue: string;
    other: string;
    otherSymbol: string | null;
    otherIsStock: boolean;
    reachable: boolean;
    tvlUsd: number | null;
  }>;
};

/** What a list run reads of an asset list. */
export type ListForCollector = Pick<AssetList, 'chain' | 'inputs' | 'assets'>;

export type ListRun = {
  /** The asset list and the cut it names, by file name. */
  list: string;
  cut: string;
  cutFetchedAt: string;
  /** Every ranked pool of each token, by symbol, deepest first. */
  pools: Record<string, ListedPool[]>;
  /**
   * The Chainlink feed of each token that has one, by symbol, as the list carries it (RU.7). A stock
   * with no oracle is not here and has no oracle row.
   */
  feeds: Record<string, ListedFeed>;
  /** Tokens of the hand list in config.ts that the asset list does not track: not read in a list run. */
  handListNotTracked: string[];
};

const lower = (s: string) => s.toLowerCase();
const fail = (message: string): never => {
  throw new Error(`list run: ${message}`);
};

/**
 * The tokens and pools of a list run. The cut must be the one the list was written from, and must name
 * every row of the list: anything else is refused, since the list holds counts and the cut the pools.
 * A token's address is written as the cut spells it (the issuer registry's mixed case), which is the
 * spelling config.ts uses for the tokens collected before the list.
 */
export function listRun(
  chain: ChainConfig,
  list: ListForCollector,
  cut: CutForCollector,
  names: { list: string; cut: string },
): { tokens: TokenConfig[]; listed: ListRun } {
  if (list.chain !== chain.id || cut.chain !== chain.id)
    fail(`the list is for ${list.chain} and the cut for ${cut.chain}, not ${chain.id}`);
  if (list.inputs.cut !== names.cut)
    fail(`${names.list} was written from ${list.inputs.cut}, not from ${names.cut}: refused`);
  const inCut = new Map(cut.tracked.map((t) => [lower(t.address), t]));
  const pools: Record<string, ListedPool[]> = {};
  const feeds: Record<string, ListedFeed> = {};
  const tokens = list.assets.map((a): TokenConfig => {
    const t =
      inCut.get(a.address) ?? fail(`${a.symbol} of the list is not tracked in ${names.cut}`);
    if (t.symbol !== a.symbol)
      fail(`${a.address} is ${a.symbol} in the list and ${t.symbol} in the cut`);
    const mine = cut.pools
      .filter((p) => lower(p.asset) === a.address)
      .map(
        (p): ListedPool => ({
          id: p.address,
          kind: p.kind,
          venue: p.venue,
          other: lower(p.other),
          otherSymbol: p.otherSymbol,
          otherIsStock: p.otherIsStock,
          reachable: p.reachable,
          tvlUsd: p.tvlUsd,
        }),
      )
      .sort((x, y) => (y.tvlUsd ?? 0) - (x.tvlUsd ?? 0) || (x.id < y.id ? -1 : 1));
    if (
      mine.length !== a.pools.ranked ||
      mine.filter((p) => p.reachable).length !== a.pools.reachable
    )
      fail(`${a.symbol}: the cut's pools are not the ${a.pools.ranked} the list counts`);
    pools[a.symbol] = mine;
    if (a.oracle?.kind === 'chainlink') {
      if (a.oracle.decimals === null) fail(`${a.symbol}: the list gives its feed no decimals`);
      feeds[a.symbol] = { address: a.oracle.ref, decimals: a.oracle.decimals as number };
    }
    return { symbol: a.symbol, address: t.address, decimals: a.decimals };
  });
  if (tokens.length !== cut.tracked.length)
    fail(`${names.cut} tracks ${cut.tracked.length} stocks and the list has ${tokens.length} rows`);
  const tracked = new Set(tokens.map((t) => lower(t.address)));
  return {
    tokens,
    listed: {
      list: names.list,
      cut: names.cut,
      cutFetchedAt: cut.fetchedAt,
      pools,
      feeds,
      handListNotTracked: chain.tokens
        .filter((t) => !tracked.has(lower(t.address)))
        .map((t) => t.symbol),
    },
  };
}

/** Whether a listed pool can be asked for a price in dollars in one hop: it pairs the token with the dollar token. */
const againstDollar = (chain: Pick<ChainConfig, 'dollar'>, p: ListedPool) =>
  p.other === lower(chain.dollar.address);

/**
 * The pools of one token that go to the on-chain confirmation: reachable (DU3: a pool the vault cannot
 * reach is never quoted) and against the dollar token, deepest first.
 */
export const listCandidates = (
  chain: Pick<ChainConfig, 'dollar'>,
  pools: ListedPool[],
): Candidate[] =>
  pools
    .filter((p) => p.reachable && againstDollar(chain, p))
    .map((p) => ({ kind: p.kind, id: p.id, dex: p.venue, liquidityUsd: p.tvlUsd ?? 0 }));

export type PoolPoint = {
  notionalUsd: number;
  /** Null = the pool gave no quote at this size. */
  outUsd: number | null;
  costPct: number | null;
  unfilledShare: number | null;
};

/** Why a reachable pool of a tracked stock has no quote in a run. */
export type NoQuoteReason =
  | 'not_against_the_dollar_token'
  | 'not_confirmed_on_chain'
  | 'beyond_the_pool_limit'
  | 'no_price_at_the_block'
  | 'mid_far_from_the_median'
  | 'no_quote_at_any_size';

/** One reachable pool of one tracked stock at one block. */
export type PoolSnapshotRow = {
  pool: string;
  assetMint: string;
  asset: string;
  fetchedAt: string;
  slot: number;
  kind: 'cl' | 'v4';
  venue: string;
  /** Null where the pool was not confirmed on chain, so its key was not read. */
  fee: number | null;
  tickSpacing: number | null;
  other: string;
  otherSymbol: string | null;
  otherIsStock: boolean;
  /** The cut's TVL of the pool and the time it was measured: not read in this run. */
  listTvlUsd: number | null;
  listTvlAt: string;
  /** The pool's own mid at the block, dollars per whole token. Null where it was not read. */
  midUsd: number | null;
  quoted: boolean;
  /** Null when quoted; otherwise why not. Never a zero in place of a missing quote. */
  reason: NoQuoteReason | null;
  /** One point per grid size, or null when the pool was not asked. */
  sell: PoolPoint[] | null;
  buy: PoolPoint[] | null;
  methodVersion: typeof POOLS_METHOD_VERSION;
  method: typeof POOLS_METHOD;
  source: string;
  provenance: 'live';
};

export type PoolRowsInput = {
  chain: Pick<ChainConfig, 'dollar'>;
  token: TokenConfig;
  listed: ListRun;
  blockTime: Date;
  blockNumber: number;
  /** The pools the chain confirmed for the token, and the ones of them the run asked (the pool limit). */
  confirmed: PoolRef[];
  asked: PoolRef[];
  /** The pools that gave a price at the block, and the ones within the median band that were asked for quotes. */
  priced: Array<{ ref: PoolRef; midUsd: number }>;
  quotes: PoolQuotes[];
  source: string;
  grid?: number[];
};

function points(
  side: Side,
  q: PoolQuotes,
  decimals: { token: number; dollar: number },
  grid: number[],
): PoolPoint[] {
  return grid.map((notionalUsd, i) => {
    const quote = q[side][i];
    if (!quote) return { notionalUsd, outUsd: null, costPct: null, unfilledShare: null };
    const outUsd = outUsdOf(side, quote, q.midUsd, decimals.token, decimals.dollar);
    const sent = (side === 'sell' ? q.sellIn : q.buyIn)[i] ?? 0n;
    return {
      notionalUsd,
      outUsd,
      costPct: costPct(notionalUsd, outUsd),
      unfilledShare: sent === 0n ? 0 : Math.max(0, 1 - Number(quote.filledIn) / Number(sent)),
    };
  });
}

/** One row per reachable pool the list counts for the token: its own quote at every size, or the reason there is none. */
export function poolRows(r: PoolRowsInput): PoolSnapshotRow[] {
  const grid = r.grid ?? GRID_USD;
  const decimals = { token: r.token.decimals, dollar: r.chain.dollar.decimals };
  const confirmed = new Map(r.confirmed.map((p) => [lower(p.id), p]));
  const asked = new Set(r.asked.map((p) => lower(p.id)));
  const priced = new Map(r.priced.map((p) => [lower(p.ref.id), p.midUsd]));
  const quotes = new Map(r.quotes.map((q) => [lower(q.pool), q]));
  return (r.listed.pools[r.token.symbol] ?? [])
    .filter((p) => p.reachable)
    .map((p): PoolSnapshotRow => {
      const ref = confirmed.get(lower(p.id));
      const q = quotes.get(lower(p.id));
      const sell = q ? points('sell', q, decimals, grid) : null;
      const buy = q ? points('buy', q, decimals, grid) : null;
      const any = [...(sell ?? []), ...(buy ?? [])].some((x) => x.outUsd !== null);
      const reason: NoQuoteReason | null = !againstDollar(r.chain, p)
        ? 'not_against_the_dollar_token'
        : !ref
          ? 'not_confirmed_on_chain'
          : !asked.has(lower(p.id))
            ? 'beyond_the_pool_limit'
            : !priced.has(lower(p.id))
              ? 'no_price_at_the_block'
              : !q
                ? 'mid_far_from_the_median'
                : !any
                  ? 'no_quote_at_any_size'
                  : null;
      return {
        pool: p.id,
        assetMint: r.token.address,
        asset: r.token.symbol,
        fetchedAt: r.blockTime.toISOString(),
        slot: r.blockNumber,
        kind: p.kind,
        venue: p.venue,
        fee: ref?.fee ?? null,
        tickSpacing: ref?.tickSpacing ?? null,
        other: p.other,
        otherSymbol: p.otherSymbol,
        otherIsStock: p.otherIsStock,
        listTvlUsd: p.tvlUsd,
        listTvlAt: r.listed.cutFetchedAt,
        midUsd: priced.get(lower(p.id)) ?? null,
        quoted: reason === null,
        reason,
        sell,
        buy,
        methodVersion: POOLS_METHOD_VERSION,
        method: POOLS_METHOD,
        source: r.source,
        provenance: 'live',
      };
    });
}
