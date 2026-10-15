// PLAN-ASSETS AS.13: the readers of the backfill's swap files (AS.8) for `pnpm risk:assets-bars <chain> --source
// backfill`. They give the same pool bars as bars-read.ts (the same `@colosseum/risk` bar, the same `bars-0.1`),
// from the files under ASSETS_DATA_DIR, and read a day file only when the fetch's own records hold its UTC day
// whole (`wholeDaysOfSeconds`, `wholeDaysOfBlocks`): a day still being written is never opened.
//
//   Solana     <dir>/solana/swaps/<pool>/<day>.jsonl.gz and manifest.json; the pools and which side is the asset
//              from the shelf's registry (--registry). A token's day is built only when every registry pool of
//              the token holds the day whole, so its 'asset' row has all its pools and a re-run never finds a
//              day half built. Quote in dollars: USDC at par, else implied from the asset's USDC pool in the
//              hour (`solanaQuoteUsd`), else none.
//   Robinhood  <dir>/robinhood/swaps/<pool>/<day>.jsonl.gz, fetched.json (the blocks asked per filter and
//              scope) and every subject's manifest (which day each of its pieces fell on); the pools' tokens from
//              RU.2's creation logs (RISK_EVM_DIR, read-only), the shelf from the scope's count file, decimals
//              from the asset list. Quote in dollars: hourlyRows of scripts/risk-evm/history.ts over the day
//              (USDG at par, another token at its own USDG pool's price, ETH and WETH at the chain's median).
//
// Each day is built from that day's files alone (a price is carried only inside the day), so a day's bars do
// not depend on which other days were read: the import writes them once and a later run adds new days only.
// Read-only: no RPC, no database, no write.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  addBarSwap,
  type BarHour,
  type BarSwap,
  carriedPrice,
  fileEvmPool,
  type HourVwaps,
  hourOf,
  intersectRanges,
  isReopened,
  type Manifest,
  mergeRanges,
  nativeMedianByHour,
  newPoolBars,
  type PoolBar,
  poolBars,
  type QuoteRank,
  type Regime,
  solanaQuoteUsd,
  USDC_MINT,
  WSOL_MINT,
  wholeDaysOfBlocks,
  wholeDaysOfSeconds,
} from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import type { LogRow, PoolTokens } from '../../risk-evm/backfill-logs';
import { CHAINS, type ChainConfig } from '../../risk-evm/config';
import { ZERO_ADDRESS } from '../../risk-evm/discovery';
import {
  accumulateHour,
  DEFAULT_HEADER_STEP,
  decodeV3Swap,
  decodeV4Swap,
  type HistoryPool,
  hourIso,
  hourlyRows,
  newHourAccumulator,
  type PoolDecimals,
  poolDecimals,
  type SwapRow,
} from '../../risk-evm/history';
import { evmBarSwap, LAYER, type PoolBars, type SolanaPoolMeta, solanaBarSwaps } from './bars-read';
import { gzLines as gzBufferLines } from './gz-lines';

type Provenance = 'live' | 'prior_dataset';
/** Pool bars that also name, per hour, the day file the bar came from. */
export type BackfillPoolBars = PoolBars & { sourceOf: (hour: string) => string };
export type BackfillRead = {
  pools: BackfillPoolBars[];
  /** The first and last UTC day of the day files on disk: the range a run withdraws its stale rows in. */
  daysOnDisk: { first: string; last: string } | null;
  summary: Record<string, unknown>;
};

const readJson = <T>(f: string): T | null => {
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    // a manifest being rewritten at this moment: not used
    return null;
  }
};
/** The lines of a gzip day file (one gzip member per piece the fetch appended), never one string. */
export function* gzLines(file: string): Generator<string> {
  yield* gzBufferLines(readFileSync(file));
}
const hoursOfDay = (day: string) => {
  const s = Date.parse(`${day}T00:00:00Z`) / 1000;
  return Array.from({ length: 24 }, (_, k) => s + k * 3600);
};

// ---------------------------------------------------------------------------------------------------------------
// Solana

export type SolanaRegistryPool = SolanaPoolMeta & {
  venue: string;
  quoteSymbol: string | null;
  tvlUsd: number;
};
type SolRow = {
  s: string;
  q: number;
  sl: number;
  t: number;
  ev: Parameters<typeof solanaBarSwaps>[0]['ev'];
};

export function solanaRegistryPools(file: string): SolanaRegistryPool[] {
  const j = JSON.parse(readFileSync(file, 'utf8')) as {
    pools: Array<{
      address: string;
      venue: string;
      assetMint: string;
      assetSymbol: string;
      quoteMint: string;
      quoteSymbol: string | null;
      assetIsToken0: number | boolean;
      decimals0: number;
      decimals1: number;
      tvlUsd: number;
    }>;
  };
  return j.pools.map((p) => ({
    address: p.address,
    venue: p.venue,
    assetMint: p.assetMint,
    assetSymbol: p.assetSymbol,
    quoteMint: p.quoteMint,
    quoteSymbol: p.quoteSymbol,
    assetIsToken0: p.assetIsToken0 === 1 || p.assetIsToken0 === true,
    decimals0: p.decimals0,
    decimals1: p.decimals1,
    tvlUsd: p.tvlUsd,
  }));
}

/** The whole days a Solana subject's manifest holds; none without a manifest. */
export function solanaWholeDays(dataDir: string, pool: string): string[] {
  const m = readJson<Manifest>(join(dataDir, 'solana', 'swaps', pool, 'manifest.json'));
  return m ? wholeDaysOfSeconds(m.covered.filter((w) => w.unit === 'second')) : [];
}

export function readSolanaBackfill(inp: {
  dataDir: string;
  registry: SolanaRegistryPool[];
  registryFile: string;
  regimeOfT: (t: number) => Regime;
}): BackfillRead {
  const dir = join(inp.dataDir, 'solana', 'swaps');
  const byToken = new Map<string, SolanaRegistryPool[]>();
  for (const p of inp.registry) byToken.set(p.assetMint, [...(byToken.get(p.assetMint) ?? []), p]);
  const whole = new Map(
    inp.registry.map((p) => [p.address, new Set(solanaWholeDays(inp.dataDir, p.address))]),
  );
  const regimeOf = (hour: string) => inp.regimeOfT(Date.parse(hour) / 1000);
  // a token's days: those every one of its registry pools holds whole
  const tokenDays = new Map<string, string[]>();
  let poolDaysWhole = 0;
  for (const [token, pools] of byToken) {
    const sets = pools.map((p) => whole.get(p.address) as Set<string>);
    for (const x of sets) poolDaysWhole += x.size;
    tokenDays.set(
      token,
      [...(sets[0] ?? new Set<string>())].filter((d) => sets.every((x) => x.has(d))).sort(),
    );
  }
  const usdcOrderOf = new Map(
    [...byToken].map(([token, pools]) => [
      token,
      pools
        .filter((p) => p.quoteMint === USDC_MINT)
        .sort((a, b) => b.tvlUsd - a.tvlUsd || (a.address < b.address ? -1 : 1)),
    ]),
  );
  const out = new Map<string, BackfillPoolBars & { bars: PoolBar[] }>();
  const mtime = new Map<string, Date>();
  const tally = new Map<string, { days: number; swaps: number }>();
  const methods: Record<string, number> = {};
  let poolDaysBuilt = 0;
  let swaps = 0;
  let duplicates = 0;
  const allDays = [...new Set([...tokenDays.values()].flat())].sort();
  for (const day of allDays) {
    // every pool of every token whose day is whole: its swaps, its VWAP and its swaps per hour
    const tokens = [...byToken.keys()].filter((t) => tokenDays.get(t)?.includes(day)).sort();
    const swapsOf = new Map<string, BarSwap[]>();
    const vwapOf = new Map<string, HourVwaps>();
    const countOf = new Map<string, Map<string, number>>();
    for (const token of tokens)
      for (const p of byToken.get(token) as SolanaRegistryPool[]) {
        const f = join(dir, p.address, `${day}.jsonl.gz`);
        const list: BarSwap[] = [];
        if (existsSync(f)) {
          mtime.set(`${p.address}|${day}`, statSync(f).mtime);
          const seen = new Set<string>();
          for (const l of gzLines(f)) {
            if (!l.includes('"kind":"swap"')) continue;
            const row = JSON.parse(l) as SolRow;
            if (seen.has(row.s)) {
              duplicates++;
              continue;
            }
            seen.add(row.s);
            list.push(...solanaBarSwaps(row, p));
          }
        }
        swapsOf.set(p.address, list);
        const q = new Map<string, [number, number]>();
        const n = new Map<string, number>();
        for (const x of list) {
          const h = hourOf(x.t);
          if (x.side !== null) n.set(h, (n.get(h) ?? 0) + 1);
          if (x.quote === null || !(x.tokens > 0) || !(x.quote > 0)) continue;
          const a = q.get(h) ?? [0, 0];
          a[0] += x.quote;
          a[1] += x.tokens;
          q.set(h, a);
        }
        vwapOf.set(p.address, new Map([...q].map(([h, [qq, tt]]) => [h, qq / tt])));
        countOf.set(p.address, n);
      }
    const usdcPoolsOf = (token: string) =>
      (usdcOrderOf.get(token) ?? [])
        .filter((p) => vwapOf.has(p.address))
        .map((p) => ({ pool: p.address, vwap: vwapOf.get(p.address) as HourVwaps }));
    // SOL's median: each SOL-quoted pool of the day whose asset has a dollar price in the hour
    const samples = new Map<string, Array<{ v: number; w: number }>>();
    for (const token of tokens)
      for (const p of byToken.get(token) as SolanaRegistryPool[]) {
        if (p.quoteMint !== WSOL_MINT) continue;
        for (const [hour, own] of vwapOf.get(p.address) ?? []) {
          const usd = carriedPrice(usdcPoolsOf(token), hour);
          const w = countOf.get(p.address)?.get(hour) ?? 0;
          if (!usd || !(own > 0) || !w) continue;
          samples.set(hour, [...(samples.get(hour) ?? []), { v: usd.usd / own, w }]);
        }
      }
    const solUsd = nativeMedianByHour(samples);
    for (const token of tokens) {
      const pools = byToken.get(token) as SolanaRegistryPool[];
      const usdcPools = usdcPoolsOf(token);
      for (const p of pools) {
        const list = swapsOf.get(p.address) as BarSwap[];
        poolDaysBuilt++;
        if (!list.length) continue;
        const own = new Map<string, number>();
        for (const h of new Set(list.map((x) => hourOf(x.t))))
          own.set(h, vwapOf.get(p.address)?.get(h) ?? Number.NaN);
        const quoteUsdOf = (hour: string) => {
          if (p.quoteMint === WSOL_MINT) return solUsd.get(hour) ?? null;
          // a quote that is an asset of the registry, whole this day: its own USDC pools
          const r = tokens.includes(p.quoteMint)
            ? carriedPrice(usdcPoolsOf(p.quoteMint), hour)
            : null;
          return r
            ? {
                usd: r.usd,
                method: `implied_from_${r.pool}${r.carriedHours ? `_carried_${r.carriedHours}h` : ''}`,
                carriedHours: r.carriedHours,
              }
            : null;
        };
        const hours = solanaQuoteUsd({
          quoteMint: p.quoteMint,
          own,
          usdcPools,
          quoteUsdOf,
          regimeOf,
        });
        for (const h of hours.values()) {
          const k = (h.method ?? 'none').replace(/_of_\d+_pools.*/, '').replace(/_from_.*/, '');
          methods[k] = (methods[k] ?? 0) + 1;
        }
        const acc = newPoolBars();
        for (const x of list) addBarSwap(acc, x, hours.get(hourOf(x.t)), inp.regimeOfT);
        swaps += list.length;
        const t = tally.get(token) ?? { days: 0, swaps: 0 };
        t.swaps += list.length;
        tally.set(token, t);
        const bars = poolBars(acc, LAYER);
        const have = out.get(p.address);
        if (have) have.bars.push(...bars);
        else
          out.set(p.address, {
            pool: p.address,
            address: p.assetMint,
            symbol: p.assetSymbol,
            quoteAddress: p.quoteMint,
            bars,
            source: '',
            sourceOf: (hour) =>
              `<ASSETS_DATA_DIR>/solana/swaps/${p.address}/${hour.slice(0, 10)}.jsonl.gz (backfill-0.1: Solana RPC getSignaturesForAddress and getTransaction, decoded by @colosseum/risk's ${p.venue} decoder; the day held whole by its manifest) with the pools of ${inp.registryFile.split('/').at(-1)}; quote in dollars: USDC at par, else implied from the asset's USDC pool in the hour (VWAP over VWAP, carried at most 24 h inside the day), else the quote's own USDC pool, else for SOL the hour's native median`,
            fetchedAtOf: (hour) => mtime.get(`${p.address}|${hour.slice(0, 10)}`) as Date,
            provenanceOf: (): Provenance => 'live',
          });
      }
    }
  }
  for (const p of out.values()) p.bars.sort((a, b) => a.hour.localeCompare(b.hour));
  const perToken = [...byToken]
    .map(([token, pools]) => ({
      symbol: pools[0]?.assetSymbol,
      pools: pools.length,
      poolsWithFolder: pools.filter((p) => existsSync(join(dir, p.address))).length,
      daysBuilt: tokenDays.get(token)?.length ?? 0,
      first: tokenDays.get(token)?.[0] ?? null,
      last: tokenDays.get(token)?.at(-1) ?? null,
      swaps: tally.get(token)?.swaps ?? 0,
      usdcPools: usdcOrderOf.get(token)?.length ?? 0,
    }))
    .filter((t) => t.daysBuilt > 0 || t.poolsWithFolder > 0);
  const onDisk = inp.registry
    .flatMap((p) =>
      existsSync(join(dir, p.address))
        ? readdirSync(join(dir, p.address)).filter((f) => f.endsWith('.jsonl.gz'))
        : [],
    )
    .map((f) => f.slice(0, 10))
    .sort();
  return {
    pools: [...out.values()],
    daysOnDisk: onDisk.length
      ? { first: onDisk[0] as string, last: onDisk.at(-1) as string }
      : null,
    summary: {
      dir,
      registry: inp.registryFile,
      registryPools: inp.registry.length,
      poolsWithFolder: inp.registry.filter((p) => existsSync(join(dir, p.address))).length,
      registryTokens: byToken.size,
      // a manifest its owner reopened (a failed recheck_/rewalk_/verify_days_ check): only its covered windows
      // count, and the reopen emptied the ones it uncovered; counted apart here
      manifestsReopened: inp.registry.filter((p) =>
        isReopened(readJson<Manifest>(join(dir, p.address, 'manifest.json'))?.checks),
      ).length,
      tokensWithADay: perToken.filter((t) => t.daysBuilt > 0).length,
      poolDaysWhole,
      poolDaysBuilt,
      poolDaysWholeButTokenIncomplete: poolDaysWhole - poolDaysBuilt,
      swaps,
      duplicates,
      poolHoursByMethod: methods,
      perToken,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Robinhood Chain

type Created = { kind: 'cl' | 'v4'; id: string; token0: string; token1: string };
type Range = { from: number; to: number };

/** The blocks both swap filters were fetched over, for the list (`*`) and the given scope. */
export function swapCoverage(
  fetched: { covered: Record<string, Range[]> },
  scope: string,
): Range[] {
  const of = (f: string) =>
    mergeRanges([
      ...(fetched.covered[`${f}:*`] ?? []),
      ...(fetched.covered[`${f}:${scope}`] ?? []),
    ]);
  return intersectRanges(of('v3_swap'), of('v4_swap'));
}

/** Every subject manifest of the Robinhood Chain logs (swaps, supply, liquidity): pieces and days. */
export function robinhoodManifests(
  root: string,
): Array<{ covered: Range[]; days: string[]; checks: Manifest['checks'] }> {
  const out: Array<{ covered: Range[]; days: string[]; checks: Manifest['checks'] }> = [];
  for (const kind of ['swaps', 'supply', 'liquidity']) {
    const d = join(root, kind);
    if (!existsSync(d)) continue;
    for (const s of readdirSync(d)) {
      const m = readJson<Manifest>(join(d, s, 'manifest.json'));
      if (!m) continue;
      out.push({
        covered: m.covered.filter((w) => w.unit === 'block'),
        days: Object.keys(m.days),
        checks: m.checks ?? [],
      });
    }
  }
  return out;
}

/** A backfill log row of a swap as the walk's SwapRow (the same decoders). */
export function swapRowOf(r: LogRow): SwapRow {
  const log = {
    address: r.address,
    topics: r.topics,
    data: r.data,
    blockNumber: `0x${r.block.toString(16)}`,
    transactionHash: r.tx,
    logIndex: `0x${r.logIndex.toString(16)}`,
  };
  return r.filter === 'v4_swap' ? decodeV4Swap(log, r.t) : decodeV3Swap(log, r.t);
}

export type RobinhoodTokens = {
  decimals: Map<string, number>;
  symbol: Map<string, string>;
  rank: (address: string) => QuoteRank;
  wrapped: string | null;
};

/** Decimals, symbols and quote ranks from the asset list. */
export function robinhoodTokens(list: AssetList, chain: ChainConfig): RobinhoodTokens {
  const decimals = new Map<string, number>();
  const symbol = new Map<string, string>();
  const cat = new Map<string, string>();
  let wrapped: string | null = null;
  for (const a of list.assets as Array<{
    address: string;
    decimals: number;
    symbol: string;
    category?: string;
  }>) {
    const k = a.address.toLowerCase();
    decimals.set(k, a.decimals);
    symbol.set(k, a.symbol);
    cat.set(k, a.category ?? '');
    if (a.category === 'wrapped_eth' && a.symbol === 'WETH') wrapped = k;
  }
  const dollar = chain.dollar.address.toLowerCase();
  const rank = (address: string): QuoteRank => {
    const a = address.toLowerCase();
    if (a === dollar) return 0;
    if ((cat.get(a) ?? '').startsWith('stablecoin')) return 1;
    if (a === ZERO_ADDRESS || a === wrapped) return 2;
    return 3;
  };
  return { decimals, symbol, rank, wrapped };
}

export function readRobinhoodBackfill(inp: {
  dataDir: string;
  creation: Created[];
  list: AssetList;
  shelf: string[];
  scope: string;
  regimeOfT: (t: number) => Regime;
  /** Pools resolved from the chain (resolve-pools.ts's file), by pool. */
  resolved?: Record<
    string,
    { kind: 'cl' | 'v4'; token0: string | null; token1: string | null; uniswap: boolean | null }
  >;
}): BackfillRead {
  const chain = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
  const root = join(inp.dataDir, 'robinhood');
  const fetched = readJson<{ covered: Record<string, Range[]> }>(join(root, 'fetched.json')) ?? {
    covered: {},
  };
  const covered = swapCoverage(fetched, inp.scope);
  const manifests = robinhoodManifests(root);
  // a row's time is interpolated between headers DEFAULT_HEADER_STEP blocks apart: the margin of the day rule
  const days = wholeDaysOfBlocks(covered, manifests, DEFAULT_HEADER_STEP);
  const tokens = robinhoodTokens(inp.list, chain);
  // the shelf's tokens that are still rows of the list (a row the list dropped since the cut, PONS after
  // SHELF-CRYPTO-1, has no decimals here and gets no bar)
  const shelfAll = inp.shelf.map((a) => a.toLowerCase());
  const shelf = new Set(shelfAll.filter((a) => tokens.decimals.has(a)));
  const created = new Map(inp.creation.map((c) => [c.id.toLowerCase(), c]));
  // pools the creation logs do not name, resolved from the chain (resolve-pools.ts): a Uniswap pool with its two
  // tokens is filed like any other; another venue's contract (D4) or an id the chain did not know is not
  let resolvedFromChain = 0;
  let otherVenue = 0;
  let unknownToChain = 0;
  for (const [id, t] of Object.entries(inp.resolved ?? {})) {
    const k = id.toLowerCase();
    if (created.has(k)) continue;
    if (!t.token0 || !t.token1) unknownToChain++;
    else if (t.kind === 'cl' && t.uniswap !== true) otherVenue++;
    else {
      created.set(k, { kind: t.kind, id: k, token0: t.token0, token1: t.token1 });
      resolvedFromChain++;
    }
  }
  const swapsDir = join(root, 'swaps');
  const subjects = existsSync(swapsDir) ? readdirSync(swapsDir).sort() : [];
  const dollar = chain.dollar.address.toLowerCase();
  const out = new Map<string, BackfillPoolBars & { bars: PoolBar[] }>();
  const mtime = new Map<string, Date>();
  const perDay: Array<Record<string, unknown>> = [];
  const filed = new Map<string, ReturnType<typeof fileEvmPool>>();
  for (const s of subjects) {
    const c = created.get(s);
    if (!c) continue;
    filed.set(
      s,
      fileEvmPool(c.token0, c.token1, tokens.rank, (a) => shelf.has(a)),
    );
  }
  for (const day of days) {
    const files = subjects
      .map((s) => ({ s, f: join(swapsDir, s, `${day}.jsonl.gz`) }))
      .filter((x) => existsSync(x.f));
    const stat = {
      files: files.length,
      swaps: 0,
      unresolvedPools: 0,
      unresolvedSwaps: 0,
      notShelfPools: 0,
      notShelfSwaps: 0,
      duplicates: 0,
    };
    // first pass: the pools filed, their swap counts, and each hour's last swap for hourlyRows
    const pools: Array<HistoryPool & { n: number; file: string }> = [];
    const acc = newHourAccumulator();
    const rowsOf = (f: string) => {
      const seen = new Set<number>();
      const list: SwapRow[] = [];
      for (const l of gzLines(f)) {
        const r = JSON.parse(l) as LogRow;
        if (r.kind !== 'swaps') continue;
        const k = r.block * 1_000_000 + r.logIndex;
        if (seen.has(k)) {
          stat.duplicates++;
          continue;
        }
        seen.add(k);
        list.push(swapRowOf(r));
      }
      return list;
    };
    for (const { s, f } of files) {
      const fp = filed.get(s);
      if (!fp || 'reason' in fp) {
        const n = rowsOf(f).length;
        if (!fp) {
          stat.unresolvedPools++;
          stat.unresolvedSwaps += n;
        } else {
          stat.notShelfPools++;
          stat.notShelfSwaps += n;
        }
        continue;
      }
      const c = created.get(s) as Created;
      const rows = rowsOf(f);
      for (const r of rows) accumulateHour(acc, r);
      mtime.set(`${s}|${day}`, statSync(f).mtime);
      pools.push({
        address: s,
        kind: c.kind,
        asset: fp.asset,
        symbol: tokens.symbol.get(fp.asset) ?? fp.asset,
        venue: c.kind === 'v4' ? 'uniswap-v4' : 'uniswap-v3',
        other: fp.quote,
        otherSymbol:
          fp.quote === ZERO_ADDRESS
            ? 'native'
            : fp.quote === tokens.wrapped
              ? 'wrapped native'
              : (tokens.symbol.get(fp.quote) ?? null),
        otherIsStock: false,
        tvlUsd: null,
        reachable: true,
        assetIsToken0: fp.assetIsToken0,
        n: rows.length,
        file: f,
      });
    }
    // the asset's USDG pool is its pool with the most swaps that day (dollarPoolOf keeps the first of equal TVL)
    pools.sort((a, b) => b.n - a.n || (a.address < b.address ? -1 : 1));
    const withDollarPool = new Set(pools.filter((p) => p.other === dollar).map((p) => p.asset));
    for (const p of pools)
      p.otherIsStock =
        p.other !== dollar &&
        p.otherSymbol !== 'native' &&
        p.otherSymbol !== 'wrapped native' &&
        withDollarPool.has(p.other);
    const decimals = new Map<string, PoolDecimals>();
    for (const p of pools) {
      const d = poolDecimals(p, chain, (a) => tokens.decimals.get(a.toLowerCase()));
      if (d) decimals.set(p.address, d);
    }
    const hourly = hourlyRows({ pools, decimals, swaps: acc, hours: hoursOfDay(day), dollar });
    const byPool = new Map<string, Map<string, BarHour>>();
    for (const h of hourly) {
      let m = byPool.get(h.pool);
      if (!m) {
        m = new Map();
        byPool.set(h.pool, m);
      }
      m.set(h.hour, {
        regime: inp.regimeOfT(Date.parse(h.hour) / 1000),
        quoteUsd: h.quoteUsd,
        method: h.quoteUsdMethod,
      });
    }
    // second pass: the bars, as bars-read.ts builds them
    for (const p of pools) {
      const d = decimals.get(p.address) ?? null;
      const assetDecimals = tokens.decimals.get(p.asset) as number;
      const hs = byPool.get(p.address) ?? new Map<string, BarHour>();
      const bars = newPoolBars();
      for (const s of rowsOf(p.file)) {
        stat.swaps++;
        const b = evmBarSwap(s, p, d, assetDecimals);
        addBarSwap(
          bars,
          b,
          d ? hs.get(hourIso(s.t)) : undefined,
          inp.regimeOfT,
          d !== null && b.side !== null,
        );
      }
      const pb = poolBars(bars, LAYER);
      const have = out.get(p.address);
      if (have) have.bars.push(...pb);
      else {
        const pool = p.address;
        const venue = p.venue;
        out.set(pool, {
          pool,
          address: p.asset,
          symbol: p.symbol,
          quoteAddress: p.other,
          bars: pb,
          source: '',
          sourceOf: (hour) =>
            `<ASSETS_DATA_DIR>/robinhood/swaps/${pool}/${hour.slice(0, 10)}.jsonl.gz (backfill-0.1: Swap events of ${venue} by eth_getLogs on ${chain.name}; the day held whole by fetched.json and the subjects' manifests) priced by hourlyRows of scripts/risk-evm/history.ts over that day (USDG at par; another token at its own USDG pool's price; ETH and WETH at the chain's median)`,
          fetchedAtOf: (hour) => mtime.get(`${pool}|${hour.slice(0, 10)}`) as Date,
          provenanceOf: (): Provenance => 'live',
        });
      }
    }
    perDay.push({ day, poolsFiled: pools.length, ...stat });
  }
  for (const p of out.values()) p.bars.sort((a, b) => a.hour.localeCompare(b.hour));
  const presentDays = new Set<string>();
  for (const s of subjects)
    for (const f of readdirSync(join(swapsDir, s)))
      if (f.endsWith('.jsonl.gz')) presentDays.add(f.slice(0, 10));
  const sortedDays = [...presentDays].sort();
  return {
    pools: [...out.values()],
    daysOnDisk: sortedDays.length
      ? { first: sortedDays[0] as string, last: sortedDays.at(-1) as string }
      : null,
    summary: {
      root,
      scope: inp.scope,
      shelfTokens: shelf.size,
      shelfTokensNotInList: shelfAll.filter((a) => !shelf.has(a)),
      covered,
      wholeDays: days,
      daysSkippedNotWhole: [...presentDays].filter((d) => !days.includes(d)).sort(),
      subjects: subjects.length,
      manifests: manifests.length,
      manifestsReopened: manifests.filter((m) => isReopened(m.checks)).length,
      dayRuleMarginBlocks: DEFAULT_HEADER_STEP,
      poolsResolvedFromChain: resolvedFromChain,
      resolvedButOtherVenue: otherVenue,
      resolvedButUnknownToChain: unknownToChain,
      subjectsWithoutTokens: subjects.filter((s) => !created.has(s)).length,
      swaps: perDay.reduce((a, d) => a + (d.swaps as number), 0),
      perDay,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The pools resolved from the chain (resolve-pools.ts)

export const POOL_TOKENS_FILE = 'pool-tokens.json';
export type PoolTokensFile = {
  chain: 'robinhood';
  source: string;
  method: string;
  provenance: 'live';
  updatedAt: string;
  pools: Record<string, PoolTokens & { resolvedAt: string }>;
};

/** The resolved pools under `<dataDir>/robinhood`, or none. */
export function readPoolTokens(dataDir: string): PoolTokensFile['pools'] {
  const f = join(dataDir, 'robinhood', POOL_TOKENS_FILE);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as PoolTokensFile).pools : {};
}
