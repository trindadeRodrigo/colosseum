import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROUTE_CHUNKS } from '@colosseum/risk';
import { gapOf, isGap, PAIR_WINDOW_MS, pairQuotes, type StoredQuote } from '../lib-routing-gap';
import {
  FROZEN,
  type FrozenRobinhood,
  frozenByreal,
  frozenRobinhood,
  frozenSolana,
  readFrozen,
  readQuotes,
  trackedStocks,
} from './frozen';
import {
  type ByrealProbeFile,
  byrealProbe,
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
import { gapShareOf, OUTSIDE } from './replay';
import {
  gapByStockMarkdown,
  gapMarkdown,
  type RegistryRow,
  robinhoodMarkdown,
  type SolanaInputs,
  solanaMarkdown,
  solanaRanking,
  solanaTable,
} from './table';

// PLAN-UNIVERSE RU.13 — what `pnpm risk:venues` prints, as a function: the options are in report.ts. It reads files,
// and one table of the local database (a SELECT) unless Robinhood Chain is given as a file or left out; it writes
// nothing and calls no network. `env` names the folders, as the command's environment does.
export async function venuesReport(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const args = argv.filter((a) => a !== '--');
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return null;
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} takes a value`);
    return value;
  };
  const fromFixtures = args.includes('--fixtures');
  const FIXTURES = join('fixtures', 'risk', 'venues');
  /**
   * The classes of pool the router uses: a stock against dollars or SOL, in the collector's registry. The registry
   * read below keeps tiers A and B only, as the router's own selection does (`selectSplitPools`).
   */
  const ROUTED = (key: string) => key === 'read:direct_usd' || key === 'read:via_sol';
  const RISK_HOME = env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
  const DATA = env.RISK_DATA_DIR ?? join('data', 'risk');
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

  // --- Solana ----------------------------------------------------------------------------------------------------------
  const frozen = fromFixtures ? frozenSolana() : null;
  const tracked = trackedStocks();

  // quotes: the frozen window, or the collector's day files (or the file or folder named)
  const quotesAt = flag('--quotes') ?? (frozen ? null : join(RISK_HOME, 'quotes'));
  const quoteFiles = !quotesAt
    ? []
    : statSync(quotesAt).isDirectory()
      ? readdirSync(quotesAt)
          .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))
          .sort()
          .map((f) => join(quotesAt, f))
      : [quotesAt];
  // --until: quotes fetched after it are left out, so a table can be made again from files that keep growing
  const until = flag('--until');
  if (until && Number.isNaN(Date.parse(until))) throw new Error(`--until ${until}: not a time`);
  const quotes: StoredQuote[] = (
    quotesAt ? quoteFiles.flatMap(readQuotes) : (frozen as SolanaInputs).quotes
  ).filter((q) => !until || Date.parse(q.fetchedAt) <= Date.parse(until));
  const quotesSource = `${
    quotesAt
      ? `${tilde(quotesAt)}, ${quoteFiles.length} file(s), written by scripts/risk/collector/quotes.ts from https://api.jup.ag/swap/v1/quote`
      : (frozen as SolanaInputs).quotesSource
  }${until ? `, rows fetched up to ${until}` : ''}`;

  // the registry: the frozen run, or the collector's file with the full list of the same run beside it
  let registry: SolanaInputs['registry'];
  let known: SolanaInputs['known'];
  const registryFile = flag('--registry') ?? (frozen ? null : join(RISK_HOME, 'registry.json'));
  if (registryFile) {
    const reg = readFrozen<{
      methodVersion: string;
      fetchedAt: string;
      minPoolTvlUsd?: number;
      pools: Array<RegistryRow & { tier: string }>;
      excluded: ExcludedPool[];
    }>(registryFile);
    const knownFile = flag('--known') ?? FROZEN.known;
    const knownRaw = readFrozen<{
      fetched_at?: string;
      fetchedAt?: string;
      source?: string;
      pools: Array<{
        address: string;
        asset?: string;
        assetSymbol?: string;
        tvlUsd: number | null;
      }>;
    }>(knownFile);
    const knownAt = knownRaw.fetched_at ?? knownRaw.fetchedAt ?? '';
    // "found by the run and under its floor" against "not found by the run" only means something for one and the same run
    if (knownAt !== reg.fetchedAt)
      throw new Error(
        `${knownFile} is the registry run of ${knownAt}; the registry is the run of ${reg.fetchedAt}. Name that run's full registry with --known.`,
      );
    registry = {
      source: `${tilde(registryFile)} (${reg.methodVersion})`,
      fetchedAt: reg.fetchedAt,
      minPoolTvlUsd: reg.minPoolTvlUsd ?? null,
      // tiers A and B are what the collector reads and the router selects from; any other tier is known, not read
      pools: reg.pools.filter((p) => p.tier === 'A' || p.tier === 'B'),
      excluded: reg.excluded,
    };
    known = {
      source: knownRaw.source ?? knownFile,
      fetchedAt: knownAt,
      pools: knownRaw.pools.map(
        (p): KnownPool => ({
          address: p.address,
          asset: p.asset ?? p.assetSymbol ?? '',
          tvlUsd: p.tvlUsd,
        }),
      ),
    };
  } else {
    registry = (frozen as SolanaInputs).registry;
    known = (frozen as SolanaInputs).known;
  }

  const poolsFile =
    flag('--pools') ?? (frozen ? FROZEN.routePools : newest(FIXTURES, 'route-pools-', '.json'));
  if (!poolsFile)
    throw new Error('no chain read of the route pools: run pnpm risk:venues-freeze-pools');
  const routePools = readFrozen<RoutePoolsFile>(poolsFile);

  // discovery: a `.jsonl` of the discovery run (one token a line), or the frozen file (the rows under `rows`)
  const discoveryFile =
    flag('--discovery') ?? (frozen ? null : newest(DATA, 'pools-dexscreener-', '.jsonl'));
  const discovery: readonly DiscoveryRow[] | null = !discoveryFile
    ? (frozen?.discovery ?? null)
    : discoveryFile.endsWith('.jsonl')
      ? readFileSync(discoveryFile, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as DiscoveryRow)
      : readFrozen<{ rows: DiscoveryRow[] }>(discoveryFile).rows;

  const inputs: SolanaInputs = {
    tracked,
    quotes,
    quotesSource,
    routePools,
    registry,
    known,
    discovery,
  };
  const solana = solanaTable(inputs);

  const byrealFile =
    flag('--byreal') ?? (frozen ? FROZEN.byreal : newest(FIXTURES, 'byreal-', '.json'));
  const byrealRaw = byrealFile
    ? fromFixtures && !flag('--byreal')
      ? frozenByreal()
      : readFrozen<ByrealProbeFile>(byrealFile)
    : null;
  const byreal = byrealRaw ? byrealProbe(byrealRaw) : null;

  // --- the gap to Jupiter, on captures of the pools the router reads ---------------------------------------------------
  const capturesAt = flag('--captures');
  let gap: ReturnType<typeof gapAccount> | null = null;
  let gapSource: string | null = null;
  let gapByStock: Array<{ asset: string; account: ReturnType<typeof gapAccount> }> = [];
  if (capturesAt) {
    const { buildSplit, loadCapture } = await import('../lib-split');
    const ctx = {
      registry: new Map(registry.pools.map((p) => [p.address, p])),
      known: new Map(known.pools.map((p) => [p.address, p])),
      routePools: new Map(routePools.pools.map((p) => [p.address, p])),
      tracked: new Set(tracked.keys()),
    };
    const keyOf = (pool: string) => classKey(classifyPool(pool, ctx));
    const captures: Array<{ file: string; fetchedAt: string; twoHop: boolean }> = [];
    for (const name of readdirSync(capturesAt)
      .filter((n) => n.endsWith('.json.gz'))
      .sort())
      try {
        const c = loadCapture(join(capturesAt, name));
        captures.push({ file: join(capturesAt, name), fetchedAt: c.fetchedAt, twoHop: c.twoHop });
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
      capturesUsed++;
      const capture = loadCapture(cap.file);
      const built = buildSplit(capture);
      for (const { quote } of own) {
        const g = gapOf(quote, capture, built);
        const legs = quoteLegs(quote);
        if (!isGap(g) || !legs.resolved) continue;
        rows.push(
          gapShareOf(
            quote,
            legs.legs,
            g.gapOneHopBp,
            built.byAsset.get(quote.assetMint)?.pools ?? [],
            keyOf,
            ROUTED,
            ROUTE_CHUNKS,
          ),
        );
      }
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
    const frozenFile = flag('--robinhood') ?? (fromFixtures ? FROZEN.robinhood : null);
    let cut: CutPoolRow[];
    let flow: FlowRow[];
    if (frozenFile) {
      const f = flag('--robinhood') ? readFrozen<FrozenRobinhood>(frozenFile) : frozenRobinhood();
      cut = f.cut.pools;
      flow = f.flow.rows;
      robinhoodSources = {
        flow: `${frozenFile}: ${f.flow.source}`,
        cut: `the same file: ${f.cut.source.split(':')[0]} (${f.cut.method}, ${f.cut.fetchedAt.slice(0, 16)}Z)`,
      };
    } else {
      const evmDir = env.RISK_EVM_DIR ?? join('data', 'risk-evm');
      const cutFile = flag('--cut') ?? newest(evmDir, 'cut-robinhood-', '.json');
      if (!cutFile)
        throw new Error(`no cut-robinhood-*.json under ${evmDir}: set RISK_EVM_DIR or --cut`);
      const cutRaw = readFrozen<{ fetchedAt: string; method: string; pools: CutFilePool[] }>(
        cutFile,
      );
      const disc = readFrozen<{ pools: DiscoveryFilePool[] }>(
        cutFile.replace(/cut-robinhood-/, 'discovery-robinhood-'),
      );
      cut = cutPoolRows(cutRaw.pools, disc.pools);
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
      const first = rows[0];
      robinhoodSources = {
        flow: `risk_pool_flow of the local database, window 28d, every regime together: ${first?.source ?? 'no row'} (${first?.method_version ?? ''}, imported ${first ? new Date(first.fetched_at).toISOString().slice(0, 16) : ''}Z)`,
        cut: `${cutFile.split('/').at(-1)} (${cutRaw.method}, ${cutRaw.fetchedAt.slice(0, 16)}Z) and its discovery file`,
      };
    }
    robinhood = robinhoodTable(flow, cut);
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
    return `${parts.join('\n\n')}\n`;
  }
  const { shares, ...table } = solana;
  return `${JSON.stringify(
    {
      method: VENUES_METHOD,
      note: 'Measured figures: Jupiter’s stored quotes, the chain read of the route pools, the registry run, Robinhood Chain’s swaps. Estimates: every DexScreener figure, at most 30 pairs a token. A figure nobody has is null or says "none" with its reason.',
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
  )}\n`;
}
