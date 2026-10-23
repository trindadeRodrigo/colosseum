import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetObservations, type Db, marketBars } from '@colosseum/db';
import {
  type AssetFigure,
  type BarRow,
  barCoverage,
  defaultFactsParams,
  type FigureUnit,
  isMidsVersion,
  type LendingMarketRow,
  largestLendingMarkets,
  lendingFigures,
  type ObservationRow,
  oneAnHour,
  type PoolBarRow,
  poolFigures,
  priceHistoryFigures,
  profileFigures,
  WINDOW_HOURS,
  windowStart,
} from '@colosseum/risk';
import {
  type AssetFacts,
  type BasketAsset,
  type ChainId,
  finiteFacts,
  type Provenance,
  type UniverseAsset,
  VaultAgentSource,
} from '@colosseum/schemas';
import { and, desc, eq, gte, inArray, like, lt, ne, notLike, sql } from 'drizzle-orm';
import { projectSheet } from './agent-analytics';
import { loadAssetFacts } from './facts';
import { lendingMarketsOf } from './lending-facts';
import { type ExitTwin, twinSymbols } from './model-exits';
import type {
  AssetLookups,
  LookupAnswer,
  LookupFact,
  LookupMissing,
  LookupQuery,
  LookupWindow,
} from './orders/lookups';
import {
  type AnalyticsFigure,
  analyticsId,
  analyticsLabel,
  analyticsMethod,
  LOWER_BOUND,
} from './orders/vault-agent';
import { resolveExitTwins } from './plan-inputs';
import { keeper, limiter, stored, within } from './read-cache';

export type {
  AssetLookups,
  LookupAnswer,
  LookupFact,
  LookupMissing,
  LookupPart,
  LookupQuery,
  LookupWindow,
} from './orders/lookups';

// The asset lookups (gate FIGURES-BY-REFERENCE as amended 2026-10-14, ledger API-AGENT-LOOKUPS-1): one
// read-only service over the data the server holds of one listed asset, for the conversations (in process)
// and for outside agents (`GET /v1/assets/{id}/facts`). Five parts: the newest reading of each metric
// (`asset_observations`), the price history over a window (the `asset` bars of `market_bars`, in dollars),
// the pools by dollars held, the lending markets (the lending report's sheets) and Bearing's figures
// (`projectSheet`, as the conversations are handed them). The figures are built in packages/risk
// (assets/facts-of.ts); here they are read, kept and named.
//
// Each read is kept by key for ten minutes, runs under one limit on reads at once and a time limit, and is
// waited for at most 2.5 s: a later answer fills the cache and this one says `reading`; a failed read says
// `failed`. A lookup never throws. A test-network token reads the facts of the mainnet token it models (the
// twins of the plan inputs), labelled sandbox with the model named; a chain on the mock labels them mock.
//
// Outside the /v1 route table: Bearing's sheets read the risk layer's fixtures from files, which no file the
// /v1 routes reach may do (apps/api/src/orders/orders.test.ts). The route is handed this reader.

/** An hour, as the analytics: the collectors write hourly at most. */
const TTL_MS = 60 * 60_000;
/** Reads at once across every lookup: each holds one of the pool's connections. */
const CONCURRENCY = 3;
const WAIT_MS = 2_500;
/** Reads waiting or running at once; past it a read answers `failed` and a later ask reads again. */
const MAX_PENDING = 60;
/** A read with no answer after this long is given up. */
const READ_MS = 30_000;
/** The longest window's hours, the bound of the chain's collected hours a read asks for. */
const WINDOW_SPAN_MS = WINDOW_HOURS['30d'] * 3_600_000;

/** How each unit is written beside a figure, as the conversation's resolver reads it (vault-figures.ts). */
const DISPLAY_UNITS: Record<FigureUnit, string> = {
  usd: 'USD',
  tokens: 'tokens',
  fraction: 'fraction',
  count: 'count',
  ratio: 'ratio',
  hours: 'hours',
};

// -------------------------------------------------------------------------------------------------- labels
// What each figure measures, in words. No label holds a digit: the model is handed the label, and a digit in
// it is a number it could repeat.

const WINDOW_WORDS: Record<LookupWindow, string> = {
  '24h': 'the last day',
  '7d': 'the last week',
  '30d': 'the last month',
};

const PROFILE_LABELS: Record<string, string> = {
  supply_total: 'Total supply of the token, in tokens',
  supply_issuer: 'Supply of the token its issuer reports, in tokens',
  holders_top20_share: "Share of the token's supply held by its twenty largest token accounts",
  pool_tvl_usd: "Dollars held in the token's DEX pools (pool TVL)",
  dex_volume_24h_usd: "DEX volume of the token over the last day, by DexScreener's figure",
  protocol_tvl_usd: 'TVL of the protocol behind the token',
  exchange_rate: 'Exchange rate of the token: units of its underlying per token',
  yield_quoted: 'Quoted yield of the token a year, at the last reading; a past figure',
  yield_realised_30d:
    "Yield the token's price realised over the last month, as a yearly rate; a past figure",
};

/** Words of a name without its digits ("uniswap-v4" is "uniswap"), or null when none are left. */
function wordsOnly(name: string): string | null {
  const words = name
    .replace(/[\s_-]*v?\d+[\p{L}.]*/giu, '')
    .replace(/_/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return words ? words.slice(0, 60) : null;
}

function profileLabel(metric: string): string {
  const known = PROFILE_LABELS[metric];
  if (known) return known;
  const words = wordsOnly(metric.replace(/^yield_/u, '')) ?? 'reading';
  return metric.startsWith('yield_')
    ? `Yield reading of the token (${words}); a past figure`
    : `Reading of the token (${wordsOnly(metric) ?? 'metric'})`;
}

const BAR_LABELS: Record<string, (window: string) => string> = {
  close: (w) => `Latest hourly closing price in dollars across the asset's DEX pools, in ${w}`,
  high: (w) => `Highest price in dollars across the asset's DEX pools over ${w}`,
  low: (w) => `Lowest price in dollars across the asset's DEX pools over ${w}`,
  change: (w) => `Change in price over ${w}, first close to last; a past figure`,
  volume: (w) => `Volume traded in dollars across the asset's DEX pools over ${w}`,
  // the entry and exit sides, as Bearing's market terms say: the product never writes "buy" (WORDS-VAULT-DEPOSIT)
  buyvol: (w) =>
    `Dollars of the asset traded on the entry side (swaps into the asset) on its DEX pools over ${w}`,
  sellvol: (w) =>
    `Dollars of the asset traded on the exit side (swaps out of the asset) on its DEX pools over ${w}`,
  swaps: (w) => `Number of swaps of the asset on its DEX pools over ${w}`,
  gaps: (w) => `Hours over ${w} with no priced swap of the asset`,
};
// A window with an hour built from the collector's mid prices (Solana's hourly bars, gate HOURLY-BARS): its prices
// are a pool's mid where no swap was collected, and its volumes, swaps and gaps answer not collected.
const MID_BAR_LABELS: Record<string, (window: string) => string> = {
  close: (w) =>
    `Latest hourly closing price in dollars of the asset in ${w}: its DEX swaps, or the mid price of its deepest USDC pool where no swap was collected`,
  high: (w) =>
    `Highest price in dollars of the asset over ${w}: its DEX swaps, or the mid price of its deepest USDC pool where no swap was collected`,
  low: (w) =>
    `Lowest price in dollars of the asset over ${w}: its DEX swaps, or the mid price of its deepest USDC pool where no swap was collected`,
};

const ORDINALS = ['largest', 'second largest', 'third largest', 'fourth largest', 'fifth largest'];
const POOL_LABELS: Record<string, (rank: string, venue: string) => string> = {
  tvl: (rank, venue) => `Dollars held in the asset's ${rank} pool by dollars held, on ${venue}`,
  volume: (rank, venue) =>
    `Volume traded in dollars over the last day in the asset's ${rank} pool, on ${venue}`,
  share: (rank, venue) =>
    `Share of the dollars in the asset's pools held in its ${rank} pool, on ${venue}`,
};

/** The market's name in words; a market named only by its address is named by its venue. */
function marketWords(market: string, venue: string): string {
  const named = /\s/u.test(market) || market.length < 32 ? wordsOnly(market) : null;
  return named ?? wordsOnly(venue) ?? 'lending';
}
/** A venue as people name it. */
const VENUE_NAMES: Record<string, string> = {
  jupiter_lend: 'Jupiter Lend',
  kamino: 'Kamino',
  kamino_vault: 'Kamino',
};
/** The market in words: a Jupiter Lend vault by what it takes as collateral, any other by its name. */
function marketPlace(
  market: { role: string | null; market: string; venue: string },
  collateral: string | null,
): string {
  if (market.role === 'vault')
    return `the ${VENUE_NAMES[market.venue] ?? wordsOnly(market.venue) ?? 'lending'} vault that takes ${collateral ?? 'another token'} as collateral`;
  const name = marketWords(market.market, market.venue);
  return `the ${name}${/market$/iu.test(name) ? '' : ' market'}`;
}

/**
 * What a lending figure measures, naming the token whose rate or supply it is (`lent`: the token the market
 * lends, which is the asset the figure is served under) and the market.
 */
export function lendLabel(
  key: string,
  market: { role: string | null; market: string; venue: string },
  tokens: { lent: string | null; collateral: string | null },
): string {
  const lent = tokens.lent ?? 'the lent token';
  const where = marketPlace(market, tokens.collateral);
  return {
    supply: `Supply rate of ${lent} a year in ${where}, at the last report; a past figure`,
    borrow: `Borrow rate of ${lent} a year in ${where}, at the last report; a past figure`,
    util: `Share of ${lent} supplied that is lent out in ${where}`,
    withdrawable: `Dollars of ${lent} a lender can withdraw now from ${where}`,
  }[key] as string;
}

// ------------------------------------------------------------------------------------------------- answers

type Named = { id: string; label: string; figure: AssetFigure };
type Built = { facts: LookupFact[]; missing: LookupMissing[] };

/** Figures with their ids and labels as an answer: each measured one a valid evidence, or missing. */
export function answerOf(assetId: string, named: readonly Named[]): Built {
  const facts: LookupFact[] = [];
  const missing: LookupMissing[] = [];
  const taken = new Set<string>();
  for (const { id, label, figure } of named) {
    if (taken.has(id)) continue;
    taken.add(id);
    if (figure.value === null) {
      missing.push({
        id,
        assetId,
        label,
        reason: figure.reason,
        ...(figure.missingHours === undefined ? {} : { missingHours: figure.missingHours }),
      });
      continue;
    }
    const parsed = VaultAgentSource.safeParse({
      id,
      assetId,
      label: `${label}${figure.lowerBound ? LOWER_BOUND : ''}`,
      value: figure.value,
      unit: DISPLAY_UNITS[figure.unit],
      source: figure.source,
      method: figure.method,
      fetchedAt: figure.fetchedAt,
      provenance: figure.provenance,
    });
    // A stored figure that does not make a valid evidence is not measured: it never fails the answer.
    if (!parsed.success) {
      missing.push({ id, assetId, label, reason: 'not_a_number' });
      continue;
    }
    facts.push({
      ...parsed.data,
      assetId,
      label: parsed.data.label as string,
      value: figure.value,
      unit: parsed.data.unit as string,
      ...(figure.lowerBound ? { lowerBound: true as const } : {}),
      ...(figure.staleAgeSec === undefined ? {} : { staleAgeSec: figure.staleAgeSec }),
      ...(figure.missingHours === undefined || figure.windowHours === undefined
        ? {}
        : { missingHours: figure.missingHours, windowHours: figure.windowHours }),
    });
  }
  return { facts, missing };
}

/**
 * On a chain that is not live, no fact says live: a test-network token's facts are its mainnet model's,
 * labelled sandbox with the model named in the source; a chain on the mock labels them mock.
 */
function relabel(
  built: Built,
  provenance: Provenance | undefined,
  twin: ExitTwin | undefined,
): Built {
  if (!provenance || provenance === 'live') return built;
  return {
    ...built,
    facts: built.facts.map((fact) => ({
      ...fact,
      provenance: fact.provenance === 'live' ? provenance : fact.provenance,
      source: twin
        ? `${fact.source}; mainnet ${twin.twinSymbol} figures applied to the test-network token ${twin.symbol}`
        : fact.source,
    })),
  };
}

export function profileAnswer(assetId: string, rows: ObservationRow[], now: Date): Built {
  return answerOf(
    assetId,
    profileFigures(rows, now).map((figure) => ({
      id: `profile:${assetId}:${figure.key}`,
      label: profileLabel(figure.key),
      figure,
    })),
  );
}

export function priceHistoryAnswer(
  assetId: string,
  read: BarsRead,
  window: LookupWindow,
  now: Date,
): Built {
  const start = windowStart(window, now).getTime();
  const mids = oneAnHour(read.rows.filter((row) => Date.parse(row.hour) >= start)).some((row) =>
    isMidsVersion(row.methodVersion),
  );
  return answerOf(
    assetId,
    priceHistoryFigures(
      read.rows,
      read.before,
      window,
      now,
      read.chainHours,
      read.midChainHours ?? [],
    ).map((figure) => ({
      id: `bars:${assetId}:${window}:${figure.key}`,
      label: (
        (mids ? MID_BAR_LABELS[figure.key] : undefined) ??
        (BAR_LABELS[figure.key] as (w: string) => string)
      )(WINDOW_WORDS[window]),
      figure,
    })),
  );
}

export function poolsAnswer(
  assetId: string,
  read: {
    reading: ObservationRow | null;
    poolBars: PoolBarRow[];
    day: BarsRead;
  },
  now: Date,
): Built {
  // the pools' volume is swaps: the day is covered by the token's swap-built bars alone, never its mid bars
  const day = barCoverage(
    read.day.rows.filter(
      (row) =>
        Date.parse(row.hour) >= windowStart('24h', now).getTime() &&
        !isMidsVersion(row.methodVersion),
    ),
    read.day.before,
    '24h',
    now,
    read.day.chainHours,
  );
  const { pools, missing } = poolFigures(read.reading, read.poolBars, day, now);
  if (missing)
    return answerOf(assetId, [
      {
        id: `pool:${assetId}:1:tvl`,
        label: (POOL_LABELS.tvl as (r: string, v: string) => string)('largest', 'its venue'),
        figure: missing,
      },
    ]);
  return answerOf(
    assetId,
    pools.flatMap((pool) =>
      pool.figures.map((figure) => ({
        id: `pool:${assetId}:${pool.rank}:${figure.key}`,
        label: (POOL_LABELS[figure.key] as (r: string, v: string) => string)(
          ORDINALS[pool.rank - 1] ?? 'next',
          wordsOnly(pool.venue) ?? 'its venue',
        ),
        // which pool it is: an address is a figure of its own kind, so it goes in the pin
        figure:
          figure.value === null
            ? figure
            : { ...figure, method: `${figure.method}; pool ${pool.pool} on ${pool.venue}` },
      })),
    ),
  );
}

/**
 * Where a market only takes the asset as collateral: what it lends and where to ask for its rates, in words.
 * No figure: the market's rates are the lent token's, never this asset's.
 */
export function collateralLabel(
  market: { role: string | null; market: string; venue: string },
  tokens: { lent: string | null; collateral: string | null },
  asset: string,
): string {
  // no digit in a label: a symbol that holds one is not named
  const symbol = /\p{N}/u.test(asset) ? 'this asset' : asset;
  const lent = market.role === 'vault' ? tokens.lent : null;
  return lent
    ? `${symbol} is accepted as collateral in the ${VENUE_NAMES[market.venue] ?? wordsOnly(market.venue) ?? 'lending'} vault that lends ${lent}: its rates are ${lent}'s, never ${symbol}'s; ask for ${lent}'s lending markets for them`
    : `${symbol} is accepted as collateral in ${marketPlace(market, symbol)}: its rates are those of the tokens it lends, never ${symbol}'s; ask for their lending markets for them`;
}

/**
 * The lending part of one asset (FIGURES-BY-REFERENCE as amended 2026-10-14): a lending figure is the figure
 * of the token the market lends. So the asset's rates, share lent out and withdrawable dollars come only from
 * the markets that lend it (`lends`), at most five, the largest by what a lender can withdraw now
 * (`largestLendingMarkets`), each under `lend:<asset>:<account>:<metric>`. A market that only takes the asset
 * as collateral gives no figure under it: it is one missing entry, `lend:<asset>:<account>:collateral`,
 * `not_applicable`, whose label says what the market lends and to ask for that token's markets.
 */
export function lendingAnswer(
  assetId: string,
  markets: LendingMarketRow[],
  now: Date,
  symbol = assetId.split(':').at(-1) ?? assetId,
): Built {
  const all = lendingFigures(markets, now);
  const lent = largestLendingMarkets(all);
  const collateral = all.filter((market) => !market.lends).slice(0, MAX_COLLATERAL_NOTES);
  return answerOf(assetId, [
    ...lent.flatMap((market) =>
      market.figures.map((figure) => ({
        id: `lend:${assetId}:${market.account}:${figure.key}`,
        label: lendLabel(figure.key, market, market),
        figure:
          figure.value === null
            ? figure
            : {
                ...figure,
                method: `${figure.method}; ${market.venue} pool ${market.account} in ${market.market}`,
              },
      })),
    ),
    ...collateral.map((market) => ({
      id: `lend:${assetId}:${market.account}:collateral`,
      label: collateralLabel(market, market, symbol),
      figure: { key: 'collateral', value: null, reason: 'not_applicable' as const },
    })),
  ]);
}
/** At most this many markets that only take the asset as collateral are named. */
const MAX_COLLATERAL_NOTES = 5;

/** Bearing's figures at the reference size, under the ids and words the conversations already use. */
export function bearingAnswer(assetId: string, figures: AnalyticsFigure[] | null): Built {
  if (!figures)
    return {
      facts: [],
      missing: [
        {
          id: `exit:${assetId}:worst`,
          assetId,
          label: 'Exit cost at the reference size, worst measured regime',
          reason: 'not_collected',
        },
      ],
    };
  return answerOf(
    assetId,
    figures.map((figure) => ({
      id: analyticsId(figure, assetId),
      label: analyticsLabel(figure, 'the reference size'),
      figure:
        figure.value === null
          ? { key: figure.metric, value: null, reason: figure.reason }
          : // a unit the answer cannot carry (Bearing's `seconds`) is not served as a figure without one
            !Object.hasOwn(DISPLAY_UNITS, figure.unit)
            ? { key: figure.metric, value: null, reason: 'not_a_number' }
            : {
                key: figure.metric,
                value: figure.value,
                unit: figure.unit as FigureUnit,
                source: figure.source,
                method: analyticsMethod(figure),
                fetchedAt: figure.fetchedAt,
                provenance: figure.provenance,
                ...(figure.lowerBound ? { lowerBound: true as const } : {}),
              },
    })),
  );
}

// --------------------------------------------------------------------------------------------------- reads

const iso = (at: Date | string) => (typeof at === 'string' ? at : at.toISOString());

/**
 * The `asset` bars of a token from a window's first hour on, the hour of its latest bar before that, and the
 * hours from that first hour on in which any asset of the chain has a bar built from swaps (the hours the swap
 * collector ran). A bar of the collector's mid prices (`mids-*`, gate HOURLY-BARS) is not a chain hour: it says
 * the mids of that token's pool were read, not that any other token's swaps were collected, so a token's own
 * stale swap bars are never made current by other tokens' mid bars. A token's own mid bars still count as its
 * own collected hours (`barCoverage`); the chain's mid hours (`midChainHours`) count only for a token with mid
 * bars of its own in the window, whose own newest bar must then be current (`priceHistoryFigures`).
 */
export type BarsRead = {
  rows: BarRow[];
  before: string | null;
  chainHours: string[];
  /** The hours in which any asset of the chain has a mid bar: read only for a token with mid bars of its own. */
  midChainHours?: string[];
};

/** What the lookups read; injected, so a test hands in its own rows. */
export type LookupReads = {
  observations(db: Db, chain: string, address: string): Promise<ObservationRow[]>;
  /** The token's `asset` bars from `from` on, its latest before it, and the chain's collected hours. */
  bars(db: Db, chain: string, address: string, from: Date): Promise<BarsRead>;
  /** The newest `pool_tvl_usd` reading, with the pools it lists. */
  poolReading(db: Db, chain: string, address: string): Promise<ObservationRow | null>;
  poolBars(
    db: Db,
    chain: string,
    address: string,
    pools: string[],
    from: Date,
  ): Promise<PoolBarRow[]>;
  lending(db: Db, chain: string, address: string): Promise<LendingMarketRow[]>;
  sheet(db: Db, address: string, sizeUsd: number): Promise<AssetFacts | null>;
};

const observationCols = {
  metric: assetObservations.metric,
  value: assetObservations.value,
  unit: assetObservations.unit,
  nullReason: assetObservations.nullReason,
  observedAt: assetObservations.observedAt,
  fetchedAt: assetObservations.fetchedAt,
  source: assetObservations.source,
  method: assetObservations.method,
  methodVersion: assetObservations.methodVersion,
  provenance: assetObservations.provenance,
};
type ObservationSelect = {
  [K in keyof typeof observationCols]: unknown;
};
const observationOf = (
  row: ObservationSelect & { detail?: unknown },
  detail: Record<string, unknown> | undefined,
): ObservationRow => ({
  metric: row.metric as string,
  value: row.value as number | null,
  unit: row.unit as string,
  nullReason: row.nullReason as string | null,
  observedAt: iso(row.observedAt as Date),
  fetchedAt: iso(row.fetchedAt as Date),
  source: row.source as string,
  method: row.method as string,
  methodVersion: row.methodVersion as string,
  provenance: row.provenance as Provenance,
  ...(detail ? { detail } : {}),
});

// Only the dollar columns of a bar: the quote-token prices are the pool's own and are never read here.
const barCols = {
  hour: marketBars.hour,
  closeUsd: marketBars.closeUsd,
  highUsd: marketBars.highUsd,
  lowUsd: marketBars.lowUsd,
  swaps: marketBars.swaps,
  volumeUsd: marketBars.volumeUsd,
  buyVolumeUsd: marketBars.buyVolumeUsd,
  sellVolumeUsd: marketBars.sellVolumeUsd,
  quoteUsdMethod: marketBars.quoteUsdMethod,
  methodVersion: marketBars.methodVersion,
  source: marketBars.source,
  method: marketBars.method,
  fetchedAt: marketBars.fetchedAt,
  provenance: marketBars.provenance,
};
const barOf = <T extends { hour: Date; fetchedAt: Date; provenance: string }>(row: T) => ({
  ...row,
  hour: iso(row.hour),
  fetchedAt: iso(row.fetchedAt),
  provenance: row.provenance as Provenance,
});

/** The server's reads, each filtered by chain and token so it stays on the tables' keys. */
export const dbLookupReads: LookupReads = {
  async observations(db, chain, address) {
    const rows = await db
      .selectDistinctOn([assetObservations.metric], {
        ...observationCols,
        // only the flag a reading carries of a sum that left a pool out, never the whole detail
        lowerBound: sql<boolean | null>`(${assetObservations.detail}->>'lowerBound')::boolean`,
      })
      .from(assetObservations)
      .where(and(eq(assetObservations.chain, chain), eq(assetObservations.address, address)))
      .orderBy(
        assetObservations.metric,
        desc(assetObservations.observedAt),
        desc(assetObservations.fetchedAt),
      )
      .limit(200);
    return rows.map((row) =>
      observationOf(row, row.lowerBound === true ? { lowerBound: true } : undefined),
    );
  },
  async bars(db, chain, address, from) {
    const where = [
      eq(marketBars.chain, chain),
      eq(marketBars.address, address),
      eq(marketBars.pool, 'asset'),
    ];
    const hoursOf = (mids: boolean) =>
      db
        .selectDistinct({ hour: marketBars.hour })
        .from(marketBars)
        .where(
          and(
            eq(marketBars.chain, chain),
            eq(marketBars.pool, 'asset'),
            mids
              ? like(marketBars.methodVersion, 'mids-%')
              : notLike(marketBars.methodVersion, 'mids-%'),
            gte(marketBars.hour, from),
            lt(marketBars.hour, new Date(from.getTime() + WINDOW_SPAN_MS)),
          ),
        )
        .orderBy(marketBars.hour)
        .limit(1_000);
    const [rows, before, chainHours, midChainHours] = await Promise.all([
      db
        .select(barCols)
        .from(marketBars)
        .where(and(...where, gte(marketBars.hour, from)))
        .orderBy(marketBars.hour)
        .limit(5_000),
      db
        .select({ hour: marketBars.hour })
        .from(marketBars)
        .where(and(...where, lt(marketBars.hour, from)))
        .orderBy(desc(marketBars.hour))
        .limit(1),
      // the hours the chain's swap collector ran: any asset's swap-built bar (market_bars_hour_idx), and apart
      // the hours of any asset's mid bar (see BarsRead); a window's hours at most
      hoursOf(false),
      hoursOf(true),
    ]);
    return {
      rows: rows.map(barOf),
      before: before[0] ? iso(before[0].hour) : null,
      chainHours: chainHours.map((row) => iso(row.hour)),
      midChainHours: midChainHours.map((row) => iso(row.hour)),
    };
  },
  async poolReading(db, chain, address) {
    const [row] = await db
      .select({ ...observationCols, detail: assetObservations.detail })
      .from(assetObservations)
      .where(
        and(
          eq(assetObservations.chain, chain),
          eq(assetObservations.address, address),
          eq(assetObservations.metric, 'pool_tvl_usd'),
        ),
      )
      .orderBy(desc(assetObservations.observedAt), desc(assetObservations.fetchedAt))
      .limit(1);
    return row ? observationOf(row, row.detail as Record<string, unknown>) : null;
  },
  async poolBars(db, chain, address, pools, from) {
    if (!pools.length) return [];
    const rows = await db
      .select({ ...barCols, pool: marketBars.pool })
      .from(marketBars)
      .where(
        and(
          eq(marketBars.chain, chain),
          eq(marketBars.address, address),
          ne(marketBars.pool, 'asset'),
          inArray(marketBars.pool, pools),
          gte(marketBars.hour, from),
        ),
      )
      .orderBy(marketBars.hour)
      .limit(5_000);
    return rows.map(barOf);
  },
  lending: lendingMarketsOf,
  sheet: (db, address, sizeUsd) => loadAssetFacts(db, address, { sizeUsd }),
};

/** The addresses of the pools a `pool_tvl_usd` reading lists. */
function listedPools(reading: ObservationRow | null): string[] {
  const pools = reading?.detail?.pools;
  if (!Array.isArray(pools)) return [];
  return pools.flatMap((entry) => {
    const p = entry as Record<string, unknown>;
    const address =
      typeof p.address === 'string' ? p.address : typeof p.id === 'string' ? p.id : null;
    return address ? [address] : [];
  });
}

// ---------------------------------------------------------------------------------------- universe twins
// A test-network token whose model has no twin in Bearing's registry (resolveExitTwins: its pool registry
// and the seeded rows; never the cash token) reads its model's facts from the chain's asset universe list
// (gate ASSET-UNIVERSE, `scripts/risk/assets/<chain>.json`), where every mainnet token of the chain we track
// has its address. Only rows that are listed or candidates: a held-out or excluded row is never a model.

/** The columns of a universe row the fallback reads. */
export type UniverseRow = Pick<UniverseAsset, 'id' | 'symbol' | 'address'> & {
  status: 'listed' | 'candidate';
};

const REPO_ROOT = process.env.REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

/** The listed and candidate rows of a chain's universe list; none when the file is missing or unreadable. */
export function readUniverse(root: string, chain: string): UniverseRow[] {
  if (!/^[a-z0-9-]+$/u.test(chain)) return [];
  try {
    const file = JSON.parse(
      readFileSync(join(root, 'scripts', 'risk', 'assets', `${chain}.json`), 'utf8'),
    ) as { assets?: unknown };
    if (!Array.isArray(file.assets)) return [];
    return file.assets.flatMap((entry) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      return typeof r.id === 'string' &&
        typeof r.symbol === 'string' &&
        typeof r.address === 'string' &&
        (r.status === 'listed' || r.status === 'candidate')
        ? [{ id: r.id, symbol: r.symbol, address: r.address, status: r.status }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * The universe row a test-network token's model is: by the names its twin is looked for under in Bearing's
 * registry (`twinSymbols`), then its exact `underlying`, a listed row before a candidate; where no row goes by
 * those names, the row of the token's own id (the Solana test network keeps the mainnet ids: its cash token,
 * whose `underlying` is the currency USD, is `solana:usdc`).
 */
export function universeTwin(
  asset: Pick<BasketAsset, 'id' | 'symbol' | 'address' | 'underlying'>,
  rows: readonly UniverseRow[],
): ExitTwin | undefined {
  if (!asset.underlying) return undefined;
  const evm = EVM_ADDRESS.test(asset.address);
  const same = (a: string, b: string) => (evm ? a.toLowerCase() === b.toLowerCase() : a === b);
  const twin = (row: UniverseRow): ExitTwin => ({
    id: asset.id,
    symbol: asset.symbol,
    twinSymbol: row.symbol,
    twinMint: row.address,
  });
  for (const name of new Set([...twinSymbols(asset), asset.underlying])) {
    const named = rows.filter((row) => same(row.symbol, name));
    const hit = named.find((row) => row.status === 'listed') ?? named[0];
    if (hit) return twin(hit);
  }
  const own = rows.find((row) => row.id === asset.id);
  return own ? twin(own) : undefined;
}

// ------------------------------------------------------------------------------------------------- service

export function createAssetLookups(
  deps: {
    reads?: Partial<LookupReads>;
    twins?: typeof resolveExitTwins;
    /** Where the chains' universe lists are read from (`scripts/risk/assets/<chain>.json` under it). */
    universeRoot?: string;
    concurrency?: number;
    ttlMs?: number;
    waitMs?: number;
    maxPending?: number;
    readMs?: number;
    now?: () => number;
  } = {},
): AssetLookups {
  const reads: LookupReads = { ...dbLookupReads, ...deps.reads };
  const twins = deps.twins ?? resolveExitTwins;
  const ttl = deps.ttlMs ?? TTL_MS;
  const now = deps.now ?? Date.now;
  const readMs = deps.readMs ?? READ_MS;
  const maxPending = deps.maxPending ?? MAX_PENDING;
  const limit = limiter(deps.concurrency ?? CONCURRENCY);
  const kept = keeper<unknown>(ttl, now);
  const { refSizeUsd } = defaultFactsParams();
  let pending = 0;

  /** One read, kept by key, under the limit and the time limit. */
  const read = <T>(key: string, load: () => Promise<T>): Promise<T> =>
    kept(key, () => {
      if (pending >= maxPending) return Promise.reject(new Error('busy'));
      pending += 1;
      return limit(() => within(readMs, load())).finally(() => {
        pending -= 1;
      });
    }) as Promise<T>;

  // each chain's universe list, read once, on the first token that needs it
  const universeRoot = deps.universeRoot ?? REPO_ROOT;
  const universes = new Map<ChainId, UniverseRow[]>();
  const universeOf = (chain: ChainId): UniverseRow[] => {
    let rows = universes.get(chain);
    if (!rows) {
      rows = readUniverse(universeRoot, chain);
      universes.set(chain, rows);
    }
    return rows;
  };

  /**
   * The mainnet token a test-network token reads: its twin in Bearing's registry, else its model in the
   * chain's universe list. The cash token has no registry twin, and reads its model only where it answers
   * (`cash`: its lending part).
   */
  const twinOf = (q: LookupQuery, cash: boolean): Promise<ExitTwin | undefined> =>
    read(`twin|${q.chain}|${q.provenance ?? ''}|${q.asset.id}`, () =>
      twins(q.db, [q.asset], q.provenance),
    ).then(
      (found) =>
        found.find((twin) => twin.id === q.asset.id) ??
        (q.provenance === 'sandbox' &&
        q.asset.provenance === 'sandbox' &&
        (q.asset.cls !== 'cash' || cash)
          ? universeTwin(q.asset, universeOf(q.chain))
          : undefined),
    );

  /**
   * One part: the twin, then the rows, each read at most once however many ask, built into figures when
   * they are in. Waits `waitMs` at most; never throws.
   */
  const answer = async <T>(
    q: LookupQuery,
    part: string,
    load: (address: string, at: Date) => { key: string; read: () => Promise<T> },
    build: (rows: T, at: Date) => Built,
    /** The cash token has only its lending markets: the rest of its parts answer nothing. */
    cash = false,
  ): Promise<LookupAnswer> => {
    if (q.asset.cls === 'cash' && !cash) return { facts: [], missing: [], modelledOn: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), q.waitMs ?? deps.waitMs ?? WAIT_MS);
    });
    try {
      const work = twinOf(q, cash).then((twin) => {
        // a test-network token reads its model's rows; an EVM address as the collectors store it
        const address = stored(twin?.twinMint ?? q.asset.address);
        const at = new Date(now());
        const { key, read: loadRows } = load(address, at);
        return read(`${part}|${q.chain}|${address}|${key}`, loadRows).then((rows) => ({
          twin,
          rows,
        }));
      });
      // its failure is handled where it is raced; this only keeps it from going unhandled
      work.catch(() => {});
      const got = await Promise.race([work, late]);
      if (got === 'late') return { facts: [], missing: [], modelledOn: null, unread: 'reading' };
      const built = relabel(build(got.rows, new Date(now())), q.provenance, got.twin);
      return { ...built, modelledOn: got.twin?.twinSymbol ?? null };
    } catch {
      return { facts: [], missing: [], modelledOn: null, unread: 'failed' };
    } finally {
      clearTimeout(timer);
    }
  };

  /** The `asset` bars of a window, kept by the window's first hour. */
  const barsLoad = (q: LookupQuery, address: string, window: LookupWindow, at: Date) => {
    const from = windowStart(window, at);
    return {
      key: `${window}|${from.toISOString()}`,
      read: () => reads.bars(q.db, q.chain, address, from),
    };
  };

  return {
    profile: (q) =>
      answer(
        q,
        'profile',
        (address) => ({ key: '', read: () => reads.observations(q.db, q.chain, address) }),
        (rows, at) => profileAnswer(q.asset.id, rows, at),
      ),
    priceHistory: (q) =>
      answer(
        q,
        'bars',
        (address, at) => barsLoad(q, address, q.window, at),
        (rows, at) => priceHistoryAnswer(q.asset.id, rows, q.window, at),
      ),
    pools: (q) =>
      answer(
        q,
        'pools',
        (address, at) => {
          const day = barsLoad(q, address, '24h', at);
          return {
            key: day.key,
            read: async () => {
              const reading = await reads.poolReading(q.db, q.chain, address);
              const from = windowStart('24h', at);
              const [poolBars, bars] = await Promise.all([
                reads.poolBars(q.db, q.chain, address, listedPools(reading), from),
                day.read(),
              ]);
              return { reading, poolBars, day: bars };
            },
          };
        },
        (rows, at) => poolsAnswer(q.asset.id, rows, at),
      ),
    lending: (q) =>
      answer(
        q,
        'lending',
        (address) => ({ key: '', read: () => reads.lending(q.db, q.chain, address) }),
        (rows, at) => lendingAnswer(q.asset.id, rows, at, q.asset.symbol),
        true,
      ),
    bearing: (q) =>
      answer(
        q,
        'bearing',
        (address) => ({
          key: String(refSizeUsd),
          read: async () => {
            const sheet = await reads.sheet(q.db, address, refSizeUsd);
            return sheet ? projectSheet(finiteFacts(sheet)) : null;
          },
        }),
        (figures) => bearingAnswer(q.asset.id, figures),
      ),
  };
}

/** The server's reader: one cache and one limit on reads for every lookup. */
export const serverAssetLookups = createAssetLookups();
