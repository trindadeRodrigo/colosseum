import type { StoredQuote } from '../lib-routing-gap';
import {
  type ByrealProbe,
  type ClassifyContext,
  classifyPool,
  classKey,
  DECODED_PROGRAMS,
  DEXSCREENER_PAIR_CAP,
  type DiscoveryMoney,
  type DiscoveryPair,
  type DiscoveryRow,
  type DiscoveryTable,
  discoveryMoney,
  discoveryTable,
  type ExcludedPool,
  type ForkPoolMoney,
  forkPoolMoney,
  type GapAccount,
  type KnownPool,
  poolMints,
  type RegistryPool,
  type RobinhoodTable,
  type RoutedShares,
  type RoutePoolsFile,
  routedShares,
  type ShareCell,
  SIDES,
  type Side,
  VENUES_METHOD,
} from './lib';
import { VENUE_FACTS, type VenueFact } from './venue-facts';

// PLAN-UNIVERSE RU.13 — the two tables and the ranking, put together from the pieces of lib.ts, and their text for
// the plan. Pure: the callers read the files.

/** A pool of the collector's registry, with what the registry run measured. */
export type RegistryRow = RegistryPool & {
  program: string;
  assetMint: string;
  assetSymbol: string;
  tvlUsd: number | null;
};

export type SolanaInputs = {
  /** The tracked stocks: mint to symbol. */
  tracked: ReadonlyMap<string, string>;
  quotes: readonly StoredQuote[];
  quotesSource: string;
  routePools: RoutePoolsFile;
  registry: {
    source: string;
    fetchedAt: string;
    minPoolTvlUsd: number | null;
    pools: readonly RegistryRow[];
    excluded: readonly ExcludedPool[];
  };
  /** Every pool the registry run found, dust included. */
  known: { source: string; fetchedAt: string; pools: readonly KnownPool[] };
  /** Null when no discovery file was given. */
  discovery: readonly DiscoveryRow[] | null;
};

/** Money figures of one kind for a row: how many pools, and the dollars. */
export type Money = { pools: number; usd: number };

export type SolanaRow = {
  key: string;
  /**
   * `unread`: a program we have no decoder for. `outside_the_router`: pools on a program we decode that the router
   * does not use, a registry or routing matter. `router`: the pools the router uses. `other_market`: pools on a
   * program we decode that hold no tracked stock, seen on onward hops.
   */
  group: 'unread' | 'outside_the_router' | 'router' | 'other_market';
  name: string;
  program: string | null;
  fact: VenueFact | null;
  /** Pools of this row on the stored routes, and those among them that carried a stock leg. Measured. */
  onRoutes: { pools: number; withAStockLeg: number };
  /**
   * What the pools of this row held, measured on chain: at the registry run for the pools the registry knows, at the
   * chain read for the pools of a Raydium-sized fork seen on routes. Its reason when nobody measured it.
   */
  measured:
    | (Money & {
        at: string;
        what: string;
        /** Of `usd`, the dollars themselves, where the two sides were told apart: the rest is the stock, at the pool's price. */
        dollarUsd?: number;
      })
    | { none: string };
  /** DexScreener's figures for the pairs it listed, and its name for them: estimates, at most 30 pairs a token. */
  discovery: (DiscoveryMoney & { dex: string[] }) | { none: string };
  /** By side, then by size in dollars. */
  routed: Record<Side, Record<string, ShareCell>>;
  /** The quoted stocks with a stock leg in a pool of this row. */
  stocks: string[];
};

export type SolanaTable = {
  method: string;
  tracked: { stocks: string[]; quoted: string[]; notQuoted: string[] };
  quotes: {
    source: string;
    provenance: string;
    first: string | null;
    last: string | null;
    rows: number;
    withARoute: number;
    resolved: number;
    notResolved: Record<string, number>;
    sizes: number[];
    quotesBySideAndSize: Record<Side, Record<string, number>>;
    onwardLegsWithoutAShare: number;
    /** The check of the stock end against the chain: stock legs whose pool was read, and those not holding the stock. */
    stockLegsChecked: number;
    stockLegsInPoolsWithoutTheStock: number;
  };
  chainRead: { source: string; fetchedAt: string; slot: number; provenance: string; pools: number };
  registry: { source: string; fetchedAt: string; pools: number; excluded: number; known: number };
  discovery: DiscoveryTable | null;
  discoveryNone: string | null;
  rows: SolanaRow[];
  /** At each size and side, the percent of each quoted stock's amount in each row with 1% or more for some stock. */
  byStock: Array<{
    side: Side;
    notionalUsd: number;
    rows: Array<{ key: string; name: string; pct: Record<string, number> }>;
  }>;
  shares: RoutedShares;
  forkMoney: ForkPoolMoney[];
};

/** Why a venue has no discovery figure: DexScreener listed no pair of it. The text above the table says what that leaves open. */
export const NO_PAIR_LISTED = 'no pair of it listed';
/** Why a venue has no measured money: nothing here decodes its accounts. */
export const ACCOUNTS_NOT_DECODED = 'its accounts are not decoded';

const EXIT_PATH_NAMES: Record<string, string> = {
  direct_usd: 'stock against USDC or USDT',
  via_sol: 'stock against SOL',
  via_xstock: 'stock against another stock token (two hops, switched off: RU.11)',
  other: 'stock against another token (collected and listed, not routed)',
};

const sum = (xs: readonly number[]) => xs.reduce((t, x) => t + x, 0);

/** The Solana table: one row per class of pool on Jupiter's routes or in discovery, unread venues first. */
export function solanaTable(inp: SolanaInputs): SolanaTable {
  const registry = new Map(inp.registry.pools.map((p) => [p.address, p]));
  const known = new Map(inp.known.pools.map((p) => [p.address, p]));
  const excluded = new Map(inp.registry.excluded.map((e) => [e.address, e]));
  const routePools = new Map(inp.routePools.pools.map((p) => [p.address, p]));
  const trackedMints = new Set(inp.tracked.keys());
  const trackedSymbols = new Set(inp.tracked.values());
  const ctx: ClassifyContext = { registry, known, routePools, tracked: trackedMints };
  const keyOf = (pool: string) => classKey(classifyPool(pool, ctx));
  const mintsOf = (pool: string) => {
    const row = routePools.get(pool);
    return row ? poolMints(row) : null;
  };
  const shares = routedShares(inp.quotes, keyOf, mintsOf);
  const discovery = inp.discovery
    ? discoveryTable(inp.discovery, inp.tracked, { registry, known, excluded })
    : null;

  const labels = inp.routePools.programLabels.labels;
  const cells = (key: string) => {
    const out = { sell: {}, buy: {} } as Record<Side, Record<string, ShareCell>>;
    for (const g of shares.groups)
      out[g.side][String(g.notionalUsd)] = g.byClass[key] ?? {
        stockPct: 0,
        onwardPct: 0,
        quotes: 0,
      };
    return out;
  };
  const onRoutes = (key: string) => {
    const mine = shares.pools.filter((p) => p.key === key);
    return { pools: mine.length, withAStockLeg: mine.filter((p) => p.stockLegs > 0).length };
  };
  const stocksOf = (key: string) =>
    [
      ...new Set(
        shares.groups.flatMap((g) =>
          Object.entries(g.byAsset)
            .filter(([, a]) => (a.byClass[key]?.stockPct ?? 0) > 0)
            .map(([asset]) => asset),
        ),
      ),
    ].sort();

  // the pools of a Raydium-sized fork seen on routes that pair a tracked stock with dollars: what they held
  const forkMoney = inp.routePools.pools
    .filter((p) => p.data && p.owner && !(p.owner in DECODED_PROGRAMS))
    .map((p) => forkPoolMoney(p, inp.routePools.vaults, inp.tracked));
  const moneyOfProgram = (program: string): SolanaRow['measured'] => {
    const pools = inp.routePools.pools.filter((p) => p.owner === program).map((p) => p.address);
    const valued = forkMoney.filter(
      (m): m is Extract<ForkPoolMoney, { stock: string }> =>
        pools.includes(m.pool) && m.tvlUsd !== null,
    );
    if (!valued.length)
      return {
        none: inp.routePools.pools.some((p) => p.owner === program && p.data)
          ? 'no pool of it on a stored route pairs a tracked stock with dollars'
          : ACCOUNTS_NOT_DECODED,
      };
    return {
      pools: valued.length,
      usd: sum(valued.map((m) => m.tvlUsd)),
      dollarUsd: sum(valued.map((m) => m.dollarUsd)),
      at: inp.routePools.fetchedAt,
      what: 'the two vault balances of the pools on stored routes that pair a tracked stock with USDC or USDT, the stock side at the pool’s own price, wherever in the pool’s range it sits: a lower bound, pools Jupiter did not use are not in it',
    };
  };

  const rows: SolanaRow[] = [];
  // --- programs we do not read: those on a route, and those the registry run excluded for a pair of a tracked stock
  const pairs = discovery?.pairs ?? [];
  const pairsOf = (addresses: readonly string[]) => {
    const want = new Set(addresses);
    return pairs.filter((p) => want.has(p.address));
  };
  const cellOf = (mine: readonly DiscoveryPair[], none: string): SolanaRow['discovery'] =>
    !discovery
      ? { none: 'no discovery file was read' }
      : mine.length
        ? { ...discoveryMoney(mine), dex: [...new Set(mine.map((p) => p.dex))].sort() }
        : { none };
  const unreadPrograms = new Set<string>([
    ...shares.pools.filter((p) => p.key.startsWith('unread:')).map((p) => p.key.slice(7)),
    ...pairs
      .filter((p) => p.program && !(p.program in DECODED_PROGRAMS))
      .map((p) => p.program as string),
  ]);
  const noDiscovery = discovery ? NO_PAIR_LISTED : 'no discovery file was read';
  for (const program of unreadPrograms) {
    const key = `unread:${program}`;
    const listed = pairs.filter((p) => p.program === program);
    rows.push({
      key,
      group: 'unread',
      name: labels[program] ?? VENUE_FACTS[program]?.name ?? program,
      program,
      fact: VENUE_FACTS[program] ?? null,
      onRoutes: onRoutes(key),
      measured: moneyOfProgram(program),
      discovery: cellOf(listed, noDiscovery),
      routed: cells(key),
      stocks: stocksOf(key),
    });
  }

  // --- pools on programs we decode: what the registry run measured, and DexScreener's figures for those it listed
  const ofTracked = inp.registry.pools.filter((p) => trackedSymbols.has(p.assetSymbol));
  const listedAmong = (addresses: readonly string[]) =>
    cellOf(pairsOf(addresses), 'DexScreener listed none of these pools');
  const registryRow = (exitPath: string, group: SolanaRow['group']): SolanaRow => {
    const mine = ofTracked.filter((p) => p.exitPath === exitPath);
    const key = `read:${exitPath}`;
    return {
      key,
      group,
      name: `Raydium, Orca and Meteora: ${EXIT_PATH_NAMES[exitPath] ?? exitPath}`,
      program: null,
      fact: null,
      onRoutes: onRoutes(key),
      measured: {
        pools: mine.length,
        usd: sum(mine.map((p) => p.tvlUsd ?? 0)),
        at: inp.registry.fetchedAt,
        what:
          exitPath === 'other'
            ? 'pools of the tracked stocks in the collector’s registry; the registry prices the stock side only, so this is the stock in the pool, a lower bound'
            : 'pools of the tracked stocks in the collector’s registry, vault balances priced at the registry run',
      },
      discovery: listedAmong(mine.map((p) => p.address)),
      routed: cells(key),
      stocks: stocksOf(key),
    };
  };
  rows.push(registryRow('other', 'outside_the_router'));
  rows.push(registryRow('via_xstock', 'outside_the_router'));
  const dust = inp.known.pools.filter(
    (p) => trackedSymbols.has(p.asset) && !registry.has(p.address),
  );
  rows.push({
    key: 'registry:dust_at_the_registry_run',
    group: 'outside_the_router',
    name: `Raydium, Orca and Meteora: pools the registry run found under its floor${inp.registry.minPoolTvlUsd === null ? '' : ` of $${inp.registry.minPoolTvlUsd.toLocaleString('en-US')}`} (not collected)`,
    program: null,
    fact: null,
    onRoutes: onRoutes('registry:dust_at_the_registry_run'),
    measured: {
      pools: dust.length,
      usd: sum(dust.map((p) => p.tvlUsd ?? 0)),
      at: inp.known.fetchedAt,
      what: 'every pool of the tracked stocks the registry run found on the four programs and left out as dust, vault balances priced then',
    },
    discovery: listedAmong(dust.map((p) => p.address)),
    routed: cells('registry:dust_at_the_registry_run'),
    stocks: stocksOf('registry:dust_at_the_registry_run'),
  });
  rows.push({
    key: 'registry:not_found_by_the_registry_run',
    group: 'outside_the_router',
    name: 'Raydium, Orca and Meteora: pools of a tracked stock the registry run did not find (created after it)',
    program: null,
    fact: null,
    onRoutes: onRoutes('registry:not_found_by_the_registry_run'),
    measured: { none: 'not in the registry: nothing measured what they hold' },
    discovery: { none: 'discovery is older than these pools' },
    routed: cells('registry:not_found_by_the_registry_run'),
    stocks: stocksOf('registry:not_found_by_the_registry_run'),
  });
  rows.push(registryRow('direct_usd', 'router'));
  rows.push(registryRow('via_sol', 'router'));

  // --- pools on programs we decode that hold no tracked stock: the second hop's own market
  for (const key of new Set(
    shares.pools.filter((p) => p.key.startsWith('other_market:')).map((p) => p.key),
  )) {
    const program = key.slice('other_market:'.length);
    rows.push({
      key,
      group: 'other_market',
      name: `${labels[program] ?? program}: pools that hold no tracked stock (SOL, a gold token or another issuer’s stock token against dollars or SOL)`,
      program,
      fact: null,
      onRoutes: onRoutes(key),
      measured: {
        none: 'not pools of a tracked stock: not in the registry, nothing measured here',
      },
      discovery: { none: 'not pairs of a tracked stock: discovery does not ask for them' },
      routed: cells(key),
      stocks: [],
    });
  }

  // --- a pool the chain read does not hold, or that it could not read: its share is shown, never dropped
  for (const key of new Set(
    shares.pools.filter((p) => p.key.startsWith('unknown:')).map((p) => p.key),
  ))
    rows.push({
      key,
      group: 'unread',
      name: `not identified (${key.slice('unknown:'.length)}): run pnpm risk:venues-freeze-pools again`,
      program: null,
      fact: null,
      onRoutes: onRoutes(key),
      measured: { none: 'the pool was not read' },
      discovery: { none: 'the pool was not read' },
      routed: cells(key),
      stocks: stocksOf(key),
    });

  const top = (r: SolanaRow) =>
    Math.max(...SIDES.flatMap((s) => Object.values(r.routed[s]).map((c) => c.stockPct)), 0);
  const groupOrder = ['unread', 'outside_the_router', 'router', 'other_market'];
  rows.sort(
    (a, b) =>
      groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
      top(b) - top(a) ||
      b.onRoutes.pools - a.onRoutes.pools ||
      a.name.localeCompare(b.name),
  );

  const byStock = shares.groups.map((g) => ({
    side: g.side,
    notionalUsd: g.notionalUsd,
    rows: rows
      .filter((r) => Object.values(g.byAsset).some((a) => (a.byClass[r.key]?.stockPct ?? 0) >= 1))
      .map((r) => ({
        key: r.key,
        name: r.name,
        pct: Object.fromEntries(
          Object.entries(g.byAsset)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([asset, a]) => [asset, a.byClass[r.key]?.stockPct ?? 0]),
        ),
      })),
  }));

  const quoted = shares.assets;
  const bySideAndSize = { sell: {}, buy: {} } as Record<Side, Record<string, number>>;
  for (const g of shares.groups) bySideAndSize[g.side][String(g.notionalUsd)] = g.resolved;
  return {
    method: VENUES_METHOD,
    tracked: {
      stocks: [...trackedSymbols].sort(),
      quoted,
      notQuoted: [...trackedSymbols].filter((s) => !quoted.includes(s)).sort(),
    },
    quotes: {
      source: inp.quotesSource,
      provenance: [...new Set(inp.quotes.map((q) => q.provenance ?? 'not_stated'))]
        .sort()
        .join(', '),
      first: shares.first,
      last: shares.last,
      rows: shares.rows,
      withARoute: shares.rows - shares.withoutARoute,
      resolved: sum(shares.groups.map((g) => g.resolved)),
      notResolved: shares.notResolved,
      sizes: [...new Set(shares.groups.map((g) => g.notionalUsd))].sort((a, b) => a - b),
      quotesBySideAndSize: bySideAndSize,
      onwardLegsWithoutAShare: sum(shares.groups.map((g) => g.onwardLegsWithoutAShare)),
      stockLegsChecked: shares.stockLegsChecked,
      stockLegsInPoolsWithoutTheStock: shares.stockLegsInPoolsWithoutTheStock,
    },
    chainRead: {
      source: inp.routePools.source,
      fetchedAt: inp.routePools.fetchedAt,
      slot: inp.routePools.slot,
      provenance: inp.routePools.provenance,
      pools: inp.routePools.pools.length,
    },
    registry: {
      source: inp.registry.source,
      fetchedAt: inp.registry.fetchedAt,
      pools: inp.registry.pools.length,
      excluded: inp.registry.excluded.length,
      known: inp.known.pools.length,
    },
    discovery,
    discoveryNone: discovery ? null : 'no discovery file was read',
    rows,
    byStock,
    shares,
    forkMoney,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The ranking
// ---------------------------------------------------------------------------------------------------------------------

export type SolanaRank = {
  key: string;
  name: string;
  program: string | null;
  /** Percent of the stock amount at the largest size quoted, sales and purchases. */
  sharePct: Record<Side, number>;
  stocks: string[];
  /** Whether a decoder could reproduce its price from accounts at all; a row that cannot is listed, never ranked. */
  decodable: VenueFact['decodable'] | 'registry_matter';
  /**
   * What its legs, taken as Jupiter used them, close of the gap to Jupiter at that size, in basis points of the
   * median and of the mean. Null without captures.
   */
  closesBp: Record<Side, { median: number; mean: number } | null>;
};

/**
 * Which decoder would be worth building first: the unread programs and the registry rows with a share of the stock
 * amount at the largest size, largest first. A venue whose price cannot be reproduced from accounts keeps its place
 * in the list and is marked: no share makes it buildable.
 */
export function solanaRanking(table: SolanaTable, gap: readonly GapAccount[] | null): SolanaRank[] {
  const size = Math.max(...table.quotes.sizes);
  const closeOf = (key: string, side: Side) =>
    gap?.find((g) => g.side === side && g.notionalUsd === size)?.rows.find((r) => r.key === key)
      ?.asJupiterUsedIt?.closesBp ?? (gap ? { median: 0, mean: 0 } : null);
  return table.rows
    .filter((r) => r.group === 'unread' || r.group === 'outside_the_router')
    .map(
      (r): SolanaRank => ({
        key: r.key,
        name: r.name,
        program: r.program,
        sharePct: {
          sell: r.routed.sell[String(size)]?.stockPct ?? 0,
          buy: r.routed.buy[String(size)]?.stockPct ?? 0,
        },
        stocks: r.stocks,
        decodable:
          r.group === 'unread' ? (r.fact?.decodable ?? 'not_established') : 'registry_matter',
        closesBp: { sell: closeOf(r.key, 'sell'), buy: closeOf(r.key, 'buy') },
      }),
    )
    .filter((r) => r.sharePct.sell > 0 || r.sharePct.buy > 0)
    .sort((a, b) => b.sharePct.sell + b.sharePct.buy - (a.sharePct.sell + a.sharePct.buy));
}

// ---------------------------------------------------------------------------------------------------------------------
// The text for the plan
// ---------------------------------------------------------------------------------------------------------------------

const usd = (x: number) =>
  x >= 1e9
    ? `$${(x / 1e9).toFixed(2)}B`
    : x >= 1e6
      ? `$${(x / 1e6).toFixed(2)}M`
      : `$${Math.round(x).toLocaleString('en-US')}`;
const pct = (x: number) => (x === 0 ? '0' : x < 0.005 ? '<0.01' : x.toFixed(2));
const bp = (x: number | null) => (x === null ? 'n/a' : x.toFixed(2));
const day = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')}Z` : 'n/a');
const short = (address: string | null) => (address ? `\`${address.slice(0, 6)}…\`` : '');
const count = (n: number, one: string) =>
  `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`;

const DECODABLE_TEXT: Record<VenueFact['decodable'], string> = {
  from_accounts: 'yes',
  maker_quotes: 'only its maker’s quote of that instant',
  not_from_accounts: 'no',
  not_established: 'not established',
};

function shareCells(row: SolanaRow, side: Side, sizes: readonly number[], n: number): string {
  const cells = sizes.map((s) => row.routed[side][String(s)]);
  if (!cells.some((c) => (c?.quotes ?? 0) > 0))
    return `on none of the ${n.toLocaleString('en-US')} routes`;
  if (!cells.some((c) => (c?.stockPct ?? 0) > 0)) return 'no stock leg';
  return cells.map((c) => pct(c?.stockPct ?? 0)).join(' / ');
}

/** DexScreener's figures for a row: an estimate, a figure it did not give said as such and never as zero. */
function discoveryCell(d: SolanaRow['discovery']): string {
  if ('none' in d) return `no data: ${d.none}`;
  const money = (sum: number | null, without: number) =>
    sum === null ? 'no figure' : `${usd(sum)}${without ? ` (${without} with no figure)` : ''}`;
  return `${d.pools} · ${money(d.liquidityUsd, d.withoutLiquidity)} · ${money(d.volume24hUsd, d.withoutVolume)} (${count(d.stocks.length, 'stock')}; DexScreener: ${d.dex.join(', ')})`;
}

/** The Solana tables as Markdown, for section 6 of the plan. Every figure's source and date is in the lines above it. */
export function solanaMarkdown(t: SolanaTable, probe: ByrealProbe | null): string {
  const sizes = t.quotes.sizes;
  const sizeText = sizes.map((s) => `$${s / 1000}k`).join(' / ');
  const n = (side: Side) => sum(Object.values(t.quotes.quotesBySideAndSize[side]));
  const lines: string[] = [];
  const d = t.discovery;
  const notResolved = sum(Object.values(t.quotes.notResolved));
  lines.push(
    `**Sources.** *Measured:* Jupiter’s quotes stored by the collector (${t.quotes.source}; provenance ${t.quotes.provenance}), ${day(t.quotes.first)} to ${day(t.quotes.last)}: ${t.quotes.rows.toLocaleString('en-US')} rows, ${t.quotes.withARoute.toLocaleString('en-US')} with a route, ${notResolved === 0 ? 'every one' : `${t.quotes.resolved.toLocaleString('en-US')} of them`} with the stock’s own legs told apart, for ${t.tracked.quoted.length} of the ${t.tracked.stocks.length} stocks (${t.tracked.quoted.join(', ')}); not quoted: ${t.tracked.notQuoted.join(', ')}. The owner program of each of the ${t.chainRead.pools} pools on those routes: one chain read, ${day(t.chainRead.fetchedAt)}, slot ${t.chainRead.slot}; ${t.quotes.stockLegsChecked.toLocaleString('en-US')} stock legs sit in a pool whose two mints that read gives, and ${t.quotes.stockLegsInPoolsWithoutTheStock} of them in a pool that does not hold the stock. The registry: ${t.registry.source}, ${day(t.registry.fetchedAt)}: ${t.registry.pools} pools collected, ${t.registry.known.toLocaleString('en-US')} found, ${t.registry.excluded} excluded for their program.`,
  );
  if (d) {
    const notAtCap = t.tracked.stocks.filter((s) => !d.atCap.includes(s));
    const hours = (from: string | null, to: string | null) =>
      (Date.parse(to ?? '') - Date.parse(from ?? '')) / 3_600_000;
    lines.push(
      `*Estimates:* DexScreener (${d.source}), ${day(d.first) === day(d.last) ? day(d.first) : `${day(d.first)} to ${day(d.last)}`}: at most ${d.capPairsPerToken} pairs a token, and not the ${d.capPairsPerToken} largest; ${d.pairs.length} pairs for the ${t.tracked.stocks.length} stocks, ${d.atCap.length} of them at the cap (${notAtCap.length ? `all but ${notAtCap.join(', ')}` : 'all'}). Its liquidity and 24-hour volume are its own figures, taken ${hours(d.last, t.quotes.first).toFixed(1)} hours before the first quote and ${(hours(d.last, t.quotes.last) / 24).toFixed(1)} days before the last.`,
    );
  } else lines.push(`*Estimates:* ${t.discoveryNone}.`);
  lines.push('');
  const big = String(Math.max(...sizes));
  lines.push(
    `**Table 1. Solana: the venues we do not read.** Share = percent of the stock amount Jupiter traded there, a mean over the quotes of that side and size (${sizeText}). Onward = percent of the amount that crossed the venue on a hop that does not trade the stock, at $${Number(big) / 1000}k, sales / purchases; a path counts once for each pool it crosses, so onward figures are not added to shares.`,
  );
  if (d)
    lines.push(
      `"No data: ${NO_PAIR_LISTED}" means that none of DexScreener’s ${d.pairs.length} pairs for the ${t.tracked.stocks.length} stocks is on that program; with ${d.atCap.length} stocks at the cap of ${d.capPairsPerToken}, pairs beyond it are not listed, so it is not a statement that the venue holds nothing. "No data: ${ACCOUNTS_NOT_DECODED}" means that what the venue holds for a stock was not read. "On none of the routes" is measured: the venue is on no stored route of that side.`,
    );
  lines.push('');
  lines.push(
    `| Venue (Jupiter’s label) | Program | What it is · can a decoder reproduce its price | Discovery, estimate: pools · liquidity · 24 h volume | Pools on the routes (with a stock leg) · money measured | Sales: share at ${sizeText} | Purchases: share at ${sizeText} | Onward | Stocks |`,
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  const onward = (r: SolanaRow) =>
    `${pct(r.routed.sell[big]?.onwardPct ?? 0)} / ${pct(r.routed.buy[big]?.onwardPct ?? 0)}`;
  for (const r of t.rows.filter((x) => x.group === 'unread')) {
    const measured =
      'none' in r.measured
        ? `no data: ${r.measured.none}`
        : `${usd(r.measured.usd)} in ${r.measured.pools}${r.measured.dollarUsd === undefined ? '' : `, ${usd(r.measured.dollarUsd)} of it dollars`} (${day(r.measured.at)})`;
    const what = r.fact
      ? `${r.fact.kind} · ${DECODABLE_TEXT[r.fact.decodable]}`
      : 'not established · not established';
    lines.push(
      `| ${r.name} | ${short(r.program)} | ${what} | ${discoveryCell(r.discovery)} | ${r.onRoutes.pools} (${r.onRoutes.withAStockLeg}) · ${measured} | ${shareCells(r, 'sell', sizes, n('sell'))} | ${shareCells(r, 'buy', sizes, n('buy'))} | ${onward(r)} | ${r.stocks.join(', ') || 'none'} |`,
    );
  }
  lines.push('');
  lines.push(
    '**Table 2. Solana: pools on the programs we decode.** The first four rows are pools the router does not use: a registry or routing matter, not a decoder. The next two are what it uses. The last are pools that hold no tracked stock, on a second hop.',
  );
  lines.push('');
  lines.push(
    `| Pools | Measured on chain: pools · money | Discovery, estimate: pools · liquidity · 24 h volume | Pools on the routes (with a stock leg) | Sales: share at ${sizeText} | Purchases: share at ${sizeText} | Onward | Stocks |`,
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of t.rows.filter((x) => x.group !== 'unread')) {
    const measured =
      'none' in r.measured
        ? `no data: ${r.measured.none}`
        : `${r.measured.pools.toLocaleString('en-US')} · ${usd(r.measured.usd)} (${day(r.measured.at)})`;
    lines.push(
      `| ${r.name} | ${measured} | ${discoveryCell(r.discovery)} | ${r.onRoutes.pools} (${r.onRoutes.withAStockLeg}) | ${shareCells(r, 'sell', sizes, n('sell'))} | ${shareCells(r, 'buy', sizes, n('buy'))} | ${onward(r)} | ${r.stocks.join(', ') || 'none'} |`,
    );
  }
  for (const g of t.byStock.filter((x) => String(x.notionalUsd) === big)) {
    const assets = t.tracked.quoted;
    lines.push('');
    lines.push(
      `**Table 3 (${g.side === 'sell' ? 'sales' : 'purchases'}). Solana, by stock at $${g.notionalUsd / 1000}k:** percent of each stock’s amount, for the rows with 1% or more of some stock.`,
    );
    lines.push('');
    lines.push(`| Pools | ${assets.join(' | ')} |`);
    lines.push(`|---|${assets.map(() => '---').join('|')}|`);
    for (const r of g.rows)
      lines.push(`| ${r.name} | ${assets.map((a) => (r.pct[a] ?? 0).toFixed(1)).join(' | ')} |`);
  }
  if (probe) {
    lines.push('');
    lines.push(byrealMarkdown(probe));
  }
  return lines.join('\n');
}

export function byrealMarkdown(p: ByrealProbe): string {
  const a = p.array;
  const c = p.children;
  return [
    `**The Byreal probe** (pool ${short(p.pool.address)}): \`decodeClmmPool\` ${p.pool.decodes ? `decodes the pool account (tick spacing ${p.pool.tickSpacing}, current tick ${p.pool.tickCurrent})` : 'does not decode the pool account'}.`,
    `The program holds ${c.count} accounts for the pool where Raydium keeps its tick arrays: ${c.raydiumFixed} of Raydium’s size (10,240 bytes), ${c.headerAndTicks} of 216 bytes plus a whole number of 168-byte ticks, ${c.bitmapExtensionSize} of the bitmap extension’s size, ${c.other} other. Of the ${c.headerAndTicks}, \`decodeClmmTickArray\` returns null for ${c.decoderReturnsNull} (too short) and misreads ${c.decoderMisreads}.`,
    a
      ? `The array holding the current tick (${short(a.address)}, ${a.space.toLocaleString('en-US')} bytes, first tick ${a.startTickIndex}): read as Raydium’s layout it gives ${a.asRaydium.ticks === null ? 'null' : `${a.asRaydium.ticks} ticks, ${a.asRaydium.offGridOrOutOfRange} of them off the spacing grid or outside the array`}.${a.asHeaderAndTicks ? ` Read as a 216-byte header with a 60-slot table and then 168-byte ticks, ${a.asHeaderAndTicks.ticksInPlace} of ${a.asHeaderAndTicks.allocated} slots hold the tick their place says and ${a.asHeaderAndTicks.initialized} carry liquidity, the header’s own count being ${a.asHeaderAndTicks.initializedInHeader}: ${a.asHeaderAndTicks.fits ? 'the layout fits this array' : 'the layout does not fit'}.` : ''}`
      : 'No array holding the current tick was found.',
    `The liquidity invariant with the Raydium decoders as they are: **${p.invariantWithRaydiumDecoders === 'cannot_hold' ? 'cannot hold' : 'not refuted by this array'}** (${p.why}).`,
  ].join(' ');
}

const FIT_TEXT: Record<string, string> = {
  reached: 'reached by the vault’s swap path',
  hook: 'Uniswap v4 with a hook: left out by the path',
  v3_interface:
    'answers Uniswap v3’s reads and logs its swap: a fork, which needs a factory address, not a decoder',
  v3_reads_other_swap_log: 'answers Uniswap v3’s reads; the walk decoded none of its swaps',
  cl_other_interface: 'concentrated liquidity with another interface: `slot0()` does not answer',
  not_cl: 'not concentrated liquidity: none of the reads answers',
};

/** The Robinhood table as Markdown. */
export function robinhoodMarkdown(
  t: RobinhoodTable,
  sources: { flow: string; cut: string },
): string {
  const lines: string[] = [];
  lines.push(
    `**Sources.** *Measured:* ${sources.flow}, ${day(t.dataFrom)} to ${day(t.dataTo)}; the money in a pool and what it answers: ${sources.cut}. *Estimates:* DexScreener’s liquidity and 24-hour volume for the pools it listed, from the same discovery, at most ${DEXSCREENER_PAIR_CAP} pairs a token. ${t.pools} pools of the ${t.stocks.length} tracked stocks; ${usd(t.volume28dUsd)} of swaps valued in 28 days, ${t.reachedVolumeSharePct.toFixed(1)}% of it on venues the vault’s swap path reaches.`,
  );
  lines.push('');
  lines.push(
    '**Table 5. Robinhood Chain, by venue.** The first rows are reached by the vault’s swap path; the rest are not.',
  );
  lines.push('');
  lines.push(
    '| Venue (factory) | Reached | Pools (stocks) | Money measured by discovery | 28-day volume, measured · share · swaps | DexScreener, estimate: pools · liquidity · 24 h volume | What it is to the code we have |',
  );
  lines.push('|---|---|---|---|---|---|---|');
  for (const v of t.venues) {
    const volume =
      v.volume28dUsd === null
        ? 'no data: the walk decoded no swap of its pools'
        : `${usd(v.volume28dUsd)} · ${(v.volumeSharePct as number).toFixed(2)}% · ${v.swaps.toLocaleString('en-US')}${v.unpricedSwaps ? ` (${v.unpricedSwaps.toLocaleString('en-US')} not valued)` : ''}`;
    const name = /^0x[0-9a-f]{40}$/i.test(v.venue) ? 'a factory with no name' : v.venue;
    lines.push(
      `| ${name}${v.factories.length ? ` (${v.factories.map((f) => short(f)).join(', ')})` : ''} | ${v.reached ? 'yes' : 'no'} | ${v.pools} (${v.stocks.length}) | ${usd(v.tvlUsd)}${v.poolsWithoutTvl ? ` (${v.poolsWithoutTvl} not measured)` : ''} | ${volume} | ${v.dexscreener.pools} · ${usd(v.dexscreener.liquidityUsd)} · ${usd(v.dexscreener.volume24hUsd)} | ${FIT_TEXT[v.fit] ?? v.fit} |`,
    );
  }
  return lines.join('\n');
}

/** The gap to Jupiter and what each row accounts for, as Markdown. */
export function gapMarkdown(
  gap: readonly GapAccount[],
  nameOf: (key: string) => string,
  source: string,
): string {
  const lines: string[] = [];
  lines.push(
    `**Table 4. The gap to Jupiter, and what each row accounts for** (${source}). Gap = (Jupiter ÷ our router − 1) × 10,000, positive when Jupiter returns more. *With its legs as Jupiter used them:* our router routes the amount Jupiter did not send through the row, and the row’s own legs are added as Jupiter quoted them; the column is the gap that leaves and, after the arrow, what that closes of the median and of the mean. It is Jupiter’s split at the quote’s own moment, not a route our router chose.`,
  );
  lines.push('');
  lines.push(
    '| Side, size | Pairs | Gap, median / mean (bp) | Jupiter inside the pools the router uses: pairs · gap median / mean | Row | Pairs using it | Its share where used / over all pairs (%) | Gap where used, median / mean | With its legs as Jupiter used them: gap median / mean → closes |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const g of gap) {
    const head = `| ${g.side === 'sell' ? 'Sales' : 'Purchases'}, $${g.notionalUsd / 1000}k | ${g.pairs} | ${bp(g.gapBp.median)} / ${bp(g.gapBp.mean)} | ${g.withinRoutedPools.pairs} · ${bp(g.withinRoutedPools.median)} / ${bp(g.withinRoutedPools.mean)} |`;
    if (!g.rows.length) lines.push(`${head} none | | | | |`);
    [...g.rows]
      .sort((x, y) => y.meanSharePct - x.meanSharePct)
      .forEach((r, i) => {
        const replay = r.asJupiterUsedIt
          ? `${bp(r.asJupiterUsedIt.gapBp.median)} / ${bp(r.asJupiterUsedIt.gapBp.mean)} → ${bp(r.asJupiterUsedIt.closesBp.median)} / ${bp(r.asJupiterUsedIt.closesBp.mean)}${r.asJupiterUsedIt.pairsNotReplayed ? ` (${r.asJupiterUsedIt.pairsNotReplayed} not replayed)` : ''}`
          : 'not replayed';
        lines.push(
          `${i === 0 ? head : '| | | | |'} ${nameOf(r.key)} | ${r.pairs} | ${pct(r.meanSharePctWhereUsed ?? 0)} / ${pct(r.meanSharePct)} | ${bp(r.gapWhereUsed.median)} / ${bp(r.gapWhereUsed.mean)} | ${replay} |`,
        );
      });
  }
  return lines.join('\n');
}

/**
 * The gap of each stock at one size, and what each row closes of it: one line a stock, sales and purchases. A stock
 * has about ten pairs a side here, so a line is an indication and its mean moves with one pair.
 */
export function gapByStockMarkdown(
  byStock: ReadonlyArray<{ asset: string; account: readonly GapAccount[] }>,
  nameOf: (key: string) => string,
  all: string,
): string {
  const lines: string[] = [];
  const size = byStock[0]?.account[0]?.notionalUsd ?? 0;
  lines.push(
    `**Table 4b. The same at $${size / 1000}k, by stock:** pairs · gap median → the gap median with everything outside the router’s pools taken as Jupiter used it; then what each row closes of the stock’s mean gap, in bp.`,
  );
  lines.push('');
  lines.push('| Stock | Sales | Sales: what closes it | Purchases | Purchases: what closes it |');
  lines.push('|---|---|---|---|---|');
  for (const { asset, account } of byStock) {
    const cell = (side: Side): [string, string] => {
      const g = account.find((x) => x.side === side);
      if (!g) return ['no pair', ''];
      const whole = g.rows.find((r) => r.key === all)?.asJupiterUsedIt;
      const parts = g.rows
        .filter((r) => r.key !== all && r.asJupiterUsedIt)
        .sort(
          (x, y) =>
            (y.asJupiterUsedIt?.closesBp.mean ?? 0) - (x.asJupiterUsedIt?.closesBp.mean ?? 0),
        )
        .map((r) => `${nameOf(r.key)} ${bp(r.asJupiterUsedIt?.closesBp.mean ?? null)}`);
      return [
        `${g.pairs} · ${bp(g.gapBp.median)} → ${whole ? bp(whole.gapBp.median) : 'nothing outside'}`,
        parts.join('; ') || 'nothing outside',
      ];
    };
    const [sell, sellParts] = cell('sell');
    const [buy, buyParts] = cell('buy');
    lines.push(`| ${asset} | ${sell} | ${sellParts} | ${buy} | ${buyParts} |`);
  }
  return lines.join('\n');
}
