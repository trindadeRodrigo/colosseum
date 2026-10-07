import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ROUTE_CHUNKS } from '@colosseum/risk';
import type { StoredQuote } from '../lib-routing-gap';
import { gapOf, isGap, PAIR_WINDOW_MS, pairQuotes, parseQuotes } from '../lib-routing-gap';
import solanaList from '../universe/solana.json';
import {
  type ByrealProbeFile,
  byrealProbe,
  type ClassifyContext,
  type CutFilePool,
  type CutPoolRow,
  classifyPool,
  classKey,
  cutPoolRows,
  type DiscoveryFilePool,
  type DiscoveryRow,
  type ExcludedPool,
  type FlowRow,
  type GapShare,
  gapAccount,
  type KnownPool,
  quoteLegs,
  type RoutePoolsFile,
  robinhoodTable,
  VENUES_METHOD,
} from './lib';
import { gapWithLegs } from './replay';
import {
  gapByStockMarkdown,
  gapMarkdown,
  type RegistryRow,
  robinhoodMarkdown,
  solanaMarkdown,
  solanaRanking,
  solanaTable,
} from './table';

// PLAN-UNIVERSE RU.13 — `pnpm risk:venues [--md] [options]`: the venues we do not read, one table per chain and the
// ranking. It reads files, and one table of the local database (a SELECT); it writes nothing and calls no network.
//
//   --quotes <file|folder>   Jupiter's stored quotes (default: RISK_HOME/quotes, the collector's)
//   --until <time>           leave out the quotes fetched after it (the collector's files keep growing)
//   --registry <file>        the collector's registry (default: RISK_HOME/registry.json)
//   --known <file>           every pool the registry run found (default: the frozen copy under fixtures/risk/universe)
//   --discovery <file>       DexScreener's pairs (default: the newest pools-dexscreener-*.jsonl of RISK_DATA_DIR)
//   --pools <file>           the chain read of the pools on the routes (default: the newest fixtures/risk/venues/route-pools-*.json)
//   --byreal <file>          the Byreal probe (default: the newest fixtures/risk/venues/byreal-*.json)
//   --captures <folder>      captures of pnpm risk:split-capture --two-hop: adds the gap to Jupiter by venue
//   --cut <file>             Robinhood Chain's cut (default: the newest cut-robinhood-*.json of RISK_EVM_DIR), read with
//                            the discovery file of the same stamp; a file already joined (fixtures) is taken as it is
//   --flow <file>            the 28-day flow rows as a file (default: SELECT from risk_pool_flow)
//   --no-robinhood           the Solana table only
//   --md                     the tables as Markdown, as they stand in PLAN-UNIVERSE section 6
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} takes a value`);
  return value;
};
const FIXTURES = join('fixtures', 'risk', 'venues');
/** The classes of pool the router uses: a stock against dollars or SOL, in the collector's registry. */
const ROUTED = (key: string) => key === 'read:direct_usd' || key === 'read:via_sol';
/** Every class the router does not use, taken together: one more row of the gap table. */
const OUTSIDE = 'outside:all';
const RISK_HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const DATA = process.env.RISK_DATA_DIR ?? join('data', 'risk');
const newest = (dir: string, prefix: string, ext: string): string | null => {
  if (!existsSync(dir)) return null;
  const n = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
    .sort()
    .at(-1);
  return n ? join(dir, n) : null;
};
/** A path as the documents write it: the home folder as `~`. */
const tilde = (path: string) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
const readJson = <T>(file: string): T =>
  JSON.parse(
    file.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString() : readFileSync(file, 'utf8'),
  ) as T;

// --- Solana ----------------------------------------------------------------------------------------------------------
const quotesAt = flag('--quotes') ?? join(RISK_HOME, 'quotes');
const quoteFiles = statSync(quotesAt).isDirectory()
  ? readdirSync(quotesAt)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => join(quotesAt, f))
  : [quotesAt];
// --until: quotes fetched after it are left out, so a table can be made again from files that keep growing
const until = flag('--until');
if (until && Number.isNaN(Date.parse(until))) throw new Error(`--until ${until}: not a time`);
const quotes: StoredQuote[] = quoteFiles
  .flatMap((f) => parseQuotes(readFileSync(f, 'utf8')))
  .filter((q) => !until || Date.parse(q.fetchedAt) <= Date.parse(until));

const registryFile = flag('--registry') ?? join(RISK_HOME, 'registry.json');
const reg = readJson<{
  methodVersion: string;
  fetchedAt: string;
  minPoolTvlUsd?: number;
  pools: RegistryRow[];
  excluded: ExcludedPool[];
}>(registryFile);
const knownFile =
  flag('--known') ?? join('fixtures', 'risk', 'universe', 'solana-registry-20261001T0139.json.gz');
const knownRaw = readJson<{
  fetched_at?: string;
  fetchedAt?: string;
  source?: string;
  pools: Array<{ address: string; asset?: string; assetSymbol?: string; tvlUsd: number | null }>;
}>(knownFile);
const knownAt = knownRaw.fetched_at ?? knownRaw.fetchedAt ?? '';
// "found by the run and under its floor" against "not found by the run" only means something for one and the same run
if (knownAt !== reg.fetchedAt)
  throw new Error(
    `${knownFile} is the registry run of ${knownAt}; the collector's registry is the run of ${reg.fetchedAt}. Name that run's full registry with --known.`,
  );
const known: KnownPool[] = knownRaw.pools.map((p) => ({
  address: p.address,
  asset: p.asset ?? p.assetSymbol ?? '',
  tvlUsd: p.tvlUsd,
}));

const poolsFile = flag('--pools') ?? newest(FIXTURES, 'route-pools-', '.json');
if (!poolsFile)
  throw new Error('no chain read of the route pools: run pnpm risk:venues-freeze-pools');
const routePools = readJson<RoutePoolsFile>(poolsFile);

const discoveryFile = flag('--discovery') ?? newest(DATA, 'pools-dexscreener-', '.jsonl');
const discovery: DiscoveryRow[] | null = discoveryFile
  ? readFileSync(discoveryFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DiscoveryRow)
  : null;

const tracked = new Map(solanaList.assets.map((a) => [a.address, a.symbol]));
const solana = solanaTable({
  tracked,
  quotes,
  quotesSource: `${tilde(quotesAt)}, ${quoteFiles.length} day file(s)${until ? `, rows fetched up to ${until}` : ''}, written by scripts/risk/collector/quotes.ts from https://api.jup.ag/swap/v1/quote`,
  routePools,
  registry: {
    source: `${tilde(registryFile)} (${reg.methodVersion})`,
    fetchedAt: reg.fetchedAt,
    minPoolTvlUsd: reg.minPoolTvlUsd ?? null,
    pools: reg.pools,
    excluded: reg.excluded,
  },
  known: { source: knownRaw.source ?? knownFile, fetchedAt: knownAt, pools: known },
  discovery,
});

const byrealFile = flag('--byreal') ?? newest(FIXTURES, 'byreal-', '.json');
const byrealRaw = byrealFile ? readJson<ByrealProbeFile>(byrealFile) : null;
const byreal = byrealRaw ? byrealProbe(byrealRaw) : null;

// --- the gap to Jupiter, on captures of the pools the router reads ---------------------------------------------------
const capturesAt = flag('--captures');
let gap: ReturnType<typeof gapAccount> | null = null;
let gapSource: string | null = null;
let gapByStock: Array<{ asset: string; account: ReturnType<typeof gapAccount> }> = [];
if (capturesAt) {
  const { buildSplit, loadCapture } = await import('../lib-split');
  const ctx: ClassifyContext = {
    registry: new Map(reg.pools.map((p) => [p.address, p])),
    known: new Map(known.map((p) => [p.address, p])),
    routePools: new Map(routePools.pools.map((p) => [p.address, p])),
    tracked: new Set(tracked.keys()),
  };
  const files = readdirSync(capturesAt)
    .filter((n) => n.endsWith('.json.gz'))
    .sort()
    .map((n) => join(capturesAt, n));
  const captures: Array<{ file: string; fetchedAt: string; twoHop: boolean }> = [];
  for (const file of files)
    try {
      const c = loadCapture(file);
      captures.push({ file, fetchedAt: c.fetchedAt, twoHop: c.twoHop });
    } catch {
      // a file of another kind in the folder is passed over
    }
  const usable = captures.filter((c) => c.twoHop);
  const paired = pairQuotes(quotes, usable, PAIR_WINDOW_MS);
  const rows: GapShare[] = [];
  let capturesUsed = 0;
  for (const cap of usable) {
    const own = paired.pairs.filter((p) => p.capture === cap);
    if (!own.length) continue;
    const capture = loadCapture(cap.file);
    const built = buildSplit(capture);
    for (const { quote } of own) {
      const g = gapOf(quote, capture, built);
      const legs = quoteLegs(quote);
      if (!isGap(g) || !legs.resolved) continue;
      const stockPctByClass: Record<string, number> = {};
      const legsOfClass = new Map<string, number[]>();
      legs.legs.forEach((leg, i) => {
        if (leg.stockPct === null) return;
        const key = classKey(classifyPool(leg.pool, ctx));
        stockPctByClass[key] = (stockPctByClass[key] ?? 0) + leg.stockPct;
        legsOfClass.set(key, [...(legsOfClass.get(key) ?? []), i]);
      });
      // each class the router does not use, with its legs as Jupiter quoted them and the rest routed our way
      const pools = built.byAsset.get(quote.assetMint)?.pools ?? [];
      const gapWithClassBp: Record<string, number | null> = {};
      for (const [key, indexes] of legsOfClass) {
        if (ROUTED(key)) continue;
        const replay = gapWithLegs(quote, legs.legs, indexes, pools, ROUTE_CHUNKS);
        // the replay's own plain gap is the report's, or the two were not run on the same pools
        if (replay && Math.abs(replay.baseGapBp - g.gapOneHopBp) > 1e-6)
          throw new Error(`${quote.asset}: the replay's gap is not the router report's`);
        gapWithClassBp[key] = replay ? replay.gapBp : null;
      }
      // and every such class at once: all that Jupiter traded outside the pools the router uses
      const outside = [...legsOfClass].filter(([key]) => !ROUTED(key));
      if (outside.length) {
        const all = gapWithLegs(
          quote,
          legs.legs,
          outside.flatMap(([, indexes]) => indexes),
          pools,
          ROUTE_CHUNKS,
        );
        stockPctByClass[OUTSIDE] = outside.reduce((t, [key]) => t + (stockPctByClass[key] ?? 0), 0);
        gapWithClassBp[OUTSIDE] = all ? all.gapBp : null;
      }
      rows.push({
        asset: g.asset,
        side: g.side,
        notionalUsd: g.notionalUsd,
        gapBp: g.gapOneHopBp,
        stockPctByClass,
        gapWithClassBp,
      });
    }
    capturesUsed++;
  }
  gap = gapAccount(rows, ROUTED);
  // the largest size by stock: where one venue matters for one stock
  const largest = Math.max(...rows.map((r) => r.notionalUsd));
  gapByStock = [...new Set(rows.map((r) => r.asset))].sort().map((asset) => ({
    asset,
    account: gapAccount(
      rows.filter((r) => r.asset === asset && r.notionalUsd === largest),
      ROUTED,
    ),
  }));
  const times = usable.map((c) => c.fetchedAt).sort();
  gapSource = `${rows.length} stored quotes against routeTrade (one hop, the router’s own chunks) on ${capturesUsed} captures of ${tilde(capturesAt)}, ${times[0]?.slice(0, 16)}Z to ${times.at(-1)?.slice(0, 16)}Z, a quote at most ${PAIR_WINDOW_MS / 60_000} minutes from its capture; method routing-gap-router-0.1 (RU.11)`;
}
const ranking = solanaRanking(solana, gap);

// --- Robinhood Chain ---------------------------------------------------------------------------------------------------
let robinhood: ReturnType<typeof robinhoodTable> | null = null;
let robinhoodSources: { flow: string; cut: string } | null = null;
if (!args.includes('--no-robinhood')) {
  const evmDir = process.env.RISK_EVM_DIR ?? join('data', 'risk-evm');
  const cutFile = flag('--cut') ?? newest(evmDir, 'cut-robinhood-', '.json');
  if (!cutFile)
    throw new Error(`no cut-robinhood-*.json under ${evmDir}: set RISK_EVM_DIR or --cut`);
  const cutRaw = readJson<{
    source: string;
    fetchedAt: string;
    method: string;
    pools: Array<CutFilePool | CutPoolRow>;
  }>(cutFile);
  let cut: CutPoolRow[];
  if (cutRaw.pools.every((p) => 'answers' in p)) cut = cutRaw.pools as CutPoolRow[];
  else {
    const discFile = cutFile.replace(/cut-robinhood-/, 'discovery-robinhood-');
    const disc = readJson<{ pools: DiscoveryFilePool[] }>(discFile);
    cut = cutPoolRows(cutRaw.pools as CutFilePool[], disc.pools);
  }
  const flowFile = flag('--flow');
  let flow: FlowRow[];
  let flowSource: string;
  if (flowFile) {
    const f = readJson<{ source: string; rows: FlowRow[] }>(flowFile);
    flow = f.rows;
    flowSource = f.source;
  } else {
    const { createDb } = await import('@colosseum/db');
    const { client } = createDb();
    // a SELECT, nothing else: the 28-day row of every Robinhood pool, every regime together
    const rows = await client<
      Array<{
        pool: string;
        asset_symbol: string;
        venue: string | null;
        swaps: number;
        unpriced_swaps: number;
        sell_usd: number;
        buy_usd: number;
        data_from: Date | string;
        data_to: Date | string;
        source: string;
        method_version: string;
        fetched_at: Date | string;
      }>
    >`select pool, asset_symbol, venue, swaps, unpriced_swaps, sell_usd, buy_usd, data_from, data_to, source, method_version, fetched_at
      from risk_pool_flow where "window" = '28d' and regime = 'all' and pool like '0x%' order by pool`;
    await client.end();
    flow = rows.map((r) => ({
      pool: r.pool,
      assetSymbol: r.asset_symbol,
      venue: r.venue,
      swaps: r.swaps,
      unpricedSwaps: r.unpriced_swaps,
      sellUsd: r.sell_usd,
      buyUsd: r.buy_usd,
      dataFrom: new Date(r.data_from).toISOString(),
      dataTo: new Date(r.data_to).toISOString(),
    }));
    flowSource = `risk_pool_flow of the local database, window 28d, every regime together: ${rows[0]?.source ?? 'no row'} (${rows[0]?.method_version ?? ''}, imported ${rows[0] ? new Date(rows[0].fetched_at).toISOString().slice(0, 16) : ''}Z)`;
  }
  robinhood = robinhoodTable(flow, cut);
  robinhoodSources = {
    flow: flowSource,
    cut: `${cutFile.split('/').at(-1)} (${cutRaw.method}, ${cutRaw.fetchedAt.slice(0, 16)}Z) and its discovery file`,
  };
}

if (args.includes('--md')) {
  const nameOf = (key: string) =>
    key === OUTSIDE
      ? '**Everything outside the pools the router uses, together**'
      : (solana.rows.find((r) => r.key === key)?.name ?? key);
  const parts = [solanaMarkdown(solana, byreal)];
  if (gap && gapSource) {
    parts.push(gapMarkdown(gap, nameOf, gapSource));
    // short names for the by-stock lines
    const shortName = (key: string) =>
      key === 'read:other'
        ? 'pools against another token'
        : key === 'read:via_xstock'
          ? 'pools against another stock'
          : key.startsWith('registry:')
            ? 'pools outside the registry'
            : nameOf(key);
    parts.push(gapByStockMarkdown(gapByStock, shortName, OUTSIDE));
  }
  if (robinhood && robinhoodSources) parts.push(robinhoodMarkdown(robinhood, robinhoodSources));
  process.stdout.write(`${parts.join('\n\n')}\n`);
} else {
  const { shares, ...table } = solana;
  process.stdout.write(
    `${JSON.stringify(
      {
        method: VENUES_METHOD,
        note: 'Measured figures: Jupiter’s stored quotes, the chain read of the route pools, the registry run, Robinhood Chain’s swaps. Estimates: every DexScreener figure, at most 30 pairs a token. A figure nobody has is null or says "none" with its reason. Nothing here reads an oracle.',
        solana: { ...table, routePoolsSeen: shares.pools },
        byreal:
          byreal && byrealRaw
            ? {
                file: byrealFile,
                fetchedAt: byrealRaw.fetchedAt,
                source: byrealRaw.source,
                ...byreal,
              }
            : null,
        gap: gap
          ? { source: gapSource, bySideAndSize: gap, largestSizeByStock: gapByStock }
          : { none: 'no captures given (--captures)' },
        ranking: { solana: ranking },
        robinhood: robinhood ? { sources: robinhoodSources, ...robinhood } : null,
      },
      null,
      1,
    )}\n`,
  );
}
