// `pnpm risk:assets-backfill <series> [--count] | --fetch (--window <…> | --all)` (PLAN-ASSETS AS.8, the prompt's
// section 6.4, gate ASSET-HISTORY). Each series is counted before it is fetched: `--count` (the default) samples
// it and writes <out>/<chain>/<series>/count-<stamp>.json with the window, the estimate and how it was made, the
// bytes and hours and whether they fit the budget; `--fetch --window` fetches one window of it to measure the
// walker's rate; `--fetch --all` runs the whole series, and refuses unless the newest count fits the budget.
// The full ingestion is Rodrigo's to start (AS.8): this session never passes --all.
//
// The trading series (robinhood-logs, solana-swaps) take by default the pools of the shelf's tokens over the
// last 30 days (gate ASSET-HISTORY-2; the shelf of ASSET-SHELF: listed or candidate rows at or above --floor,
// default 100000 dollars, by the newest dex_volume_24h_usd reading in asset_observations, or --readings <file>);
// --scope list [--days <n>] is the list's scope of 2026-10-10. Counts and gates key on the scope (scopeKey).
//
//   robinhood-logs    --window <fromBlock>-<toBlock> [--pool <v3 pool | v4 id> | --token <address>] [--kind swaps|supply|liquidity]
//                     count: [--strata 16] [--window-blocks 100000]
//   chainlink-rounds  --feed <proxy>
//   solana-swaps      --pool <address> --window <fromISO>..<toISO> [--per-hour 30] [--before <signature>]
//   solana-mints      --mint <address> --window <fromISO>..<toISO>
//   external-daily    --coin <chain:address> | --protocol <slug>
//
// Files: <out> is ASSETS_DATA_DIR (default data/assets); every run appends a line to <out>/runs.jsonl. The
// budget (DA14, amended): at most 35 GB of new data under <out>, and never below 25 GB free on its disk; a fetch
// checks both before it starts and after every piece and stops, saying why. Inputs: the Robinhood Chain asset
// list (--list, default scripts/risk/assets/robinhood.json), RISK_EVM_DIR for RU.2's creation logs, RISK_DATA_DIR
// for Solana's registry, lending history and Step 5b; Solana calls go through SOLANA_RPC_URL (run with
// DOTENV_CONFIG_PATH pointing at the main checkout's .env; this file never reads it).
import 'dotenv/config';
// the backfill's own endpoints, set before any module below reads the RPC from the env (a side-effect
// import, which the import sorter does not move)
import './backfill-env';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDb } from '@colosseum/db';
import {
  type AnchoredPage,
  BACKFILL_METHOD_VERSION,
  BACKFILL_SERIES,
  type BackfillSeries,
  blockAtTime,
  cutShelf,
  estimateSampled,
  estimateSignatures,
  fitsBudget,
  GB,
  type Shelf,
  type ShelfListRow,
  shelfHash,
  type VolumeReading,
} from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import {
  ask,
  type Created,
  classifyPools,
  countLogs,
  type Deps,
  fetchLogs,
  LOG_KINDS,
  type LogKind,
  PoolResolver,
  seriesFilters,
  ZERO_ADDRESS,
} from '../../risk-evm/backfill-logs';
import { countRounds, fetchRounds } from '../../risk-evm/backfill-rounds';
import { CHAINS, type ChainConfig, rpcFor } from '../../risk-evm/config';
import { requestKey, rpcOver } from '../../risk-evm/replay';
import { createRpc, type Rpc, type RpcReply } from '../../risk-evm/rpc';
import { latestRegistryFile, type RegistryPool } from '../lib-history';
import { rpcStats, rpc as solRpc, stickyRpc } from '../lib-pools';
import { meteredBatch } from './backfill-cost';
import { BACKFILL_ENDPOINTS, KEEP_QUIET_MINUTES } from './backfill-env';
import {
  CHART_SPAN_DAYS,
  coinKey,
  dailyChart,
  firstPrices,
  protocolTvl,
  writeSeries,
} from './backfill-external';
import {
  type BackfillScope,
  BudgetStop,
  budgetGuard,
  gateWholeSeries,
  MAX_SAMPLE_WINDOW,
  newestCount,
  requireWindowInScope,
  scopeKey,
  scopeOptions,
  type TradingSeries,
  windowNeedsGate,
} from './backfill-gate';
import {
  type Anchor,
  anchoredPage,
  anchors,
  blockAnchors,
  dayPieces,
  exactWalk,
  fetchWindow,
  pool,
} from './backfill-solana';

const args = process.argv.slice(2);
const series = args[0] as BackfillSeries;
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
if (!BACKFILL_SERIES.includes(series)) {
  console.error(
    `usage: pnpm risk:assets-backfill <${BACKFILL_SERIES.join('|')}> [--count] | --fetch (--window … | --all)`,
  );
  process.exit(1);
}
const mode = has('--fetch') ? 'fetch' : 'count';
const all = has('--all');
const OUT = process.env.ASSETS_DATA_DIR ?? 'data/assets';
const RISK = process.env.RISK_DATA_DIR ?? 'data/risk';
const EVM = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const chainOf = (s: BackfillSeries) =>
  s === 'robinhood-logs' || s === 'chainlink-rounds' ? 'robinhood' : 'solana';
const seriesDir = join(OUT, chainOf(series), series);
mkdirSync(seriesDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const t0 = Date.now();
const events: Array<Record<string, unknown>> = [];
const log = (e: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), series, ...e });
  events.push(e);
  console.log(line.length > 600 ? `${line.slice(0, 600)}…` : line);
};

// ---------------------------------------------------------------------------------------------------------------
// The budget

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}
const freeBytes = () => {
  const s = statfsSync(OUT);
  return s.bavail * s.bsize;
};
const budgetNow = (estimateBytes: number) =>
  fitsBudget({ estimateBytes, usedBytes: dirBytes(OUT), freeBytes: freeBytes() });
/** The check before a fetch and after every piece or window (DA14): it throws BudgetStop, caught below. */
const fetchGuard = () => budgetGuard(dirBytes(OUT), freeBytes);
/** A whole series, or a window wider than a sample, only when the newest count of its scope fits. */
function requireCountThatFits(scope: string, why: string) {
  const g = gateWholeSeries({
    dir: seriesDir,
    scope,
    usedBytes: dirBytes(OUT),
    freeBytes: freeBytes(),
  });
  if (!g.ok) {
    console.error(`${why} refused: ${g.reasons.join('; ')}${g.count ? ` (count ${g.count})` : ''}`);
    finish({ refused: g.reasons, scope, count: g.count });
    process.exit(1);
  }
  log({ event: 'gate_passed', scope, count: g.count });
}
function finish(result: Record<string, unknown>) {
  const rec = opt('--record');
  if (rec)
    writeFileSync(
      rec,
      gzipSync(
        JSON.stringify({
          recordedAt: new Date().toISOString(),
          args,
          ...recordExtra,
          answers: recorded,
        }),
      ),
    );
  const line = {
    at: new Date().toISOString(),
    series,
    mode,
    args: args.slice(1),
    methodVersion: BACKFILL_METHOD_VERSION,
    seconds: Math.round((Date.now() - t0) / 1000),
    newDataBytes: dirBytes(OUT),
    freeGB: +(freeBytes() / GB).toFixed(1),
    ...result,
  };
  appendFileSync(join(OUT, 'runs.jsonl'), `${JSON.stringify(line)}\n`);
  return line;
}
function writeCount(body: Record<string, unknown>) {
  const file = join(seriesDir, `count-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(body, null, 1)}\n`);
  return file;
}
if (
  mode === 'fetch' &&
  !all &&
  !opt('--window') &&
  !opt('--feed') &&
  !opt('--coin') &&
  !opt('--protocol')
) {
  console.error(
    '--fetch needs a window (--window, --feed, --coin or --protocol); a whole series needs --all',
  );
  process.exit(1);
}
// ---------------------------------------------------------------------------------------------------------------
// Robinhood Chain

const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
// --record <file>: every request and its answer, for a fixture (replayed by scripts/risk-evm/replay.ts)
const recorded: Record<string, RpcReply> = {};
/** What a replay needs beside the answers (the feeds a count asked, the feed fetched). */
const recordExtra: Record<string, unknown> = {};
const evmDeps = (): Deps => {
  // one client a request: its timeout ends before the live loop's minutes, and it never retries by itself
  // (retries: 0), so every retry goes back through `ask` and its check of the clock
  const clientFor = (timeoutMs: number): Rpc => {
    const plain = createRpc(rpcFor(robinhood).url, { timeoutMs, retries: 0 });
    // a metered endpoint (Alchemy) is priced per request and stops at its cap (backfill-cost.ts)
    const inner = BACKFILL_ENDPOINTS.robinhood
      ? rpcOver(
          meteredBatch(plain.batch, {
            ledgerFile: join(OUT, 'robinhood', 'cost-ledger.json'),
            capUsd: Number(process.env.ROBINHOOD_BACKFILL_USD_CAP ?? 5),
            endpoint: BACKFILL_ENDPOINTS.robinhood,
          }),
          plain.stats,
        )
      : plain;
    return opt('--record')
      ? rpcOver(async (requests) => {
          const replies = await inner.batch(requests);
          requests.forEach((r, i) => {
            const a = replies[i];
            if (a && !a.error) recorded[requestKey(r)] = a;
          });
          return replies;
        }, inner.stats)
      : inner;
  };
  return {
    rpc: clientFor(120_000),
    rpcFor: clientFor,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    log,
    quietMinutes: KEEP_QUIET_MINUTES,
  };
};
type ListRow = {
  address: string;
  symbol: string;
  status: string;
  oracle: { kind: string; ref: string } | null;
};
function robinhoodList() {
  const file = opt('--list') ?? 'scripts/risk/assets/robinhood.json';
  const list = JSON.parse(readFileSync(file, 'utf8')) as { assets: ListRow[]; fetchedAt: string };
  const rows = list.assets.filter((a) => a.status !== 'excluded');
  return { file, list, rows };
}
/** The head, asked like every other read (after the live loop's minutes). */
async function head(deps: Deps) {
  const r = await ask(deps, { method: 'eth_blockNumber', params: [] });
  if (r.error || typeof r.result !== 'string')
    throw new Error(`eth_blockNumber: ${r.error?.message ?? 'no result'}`);
  return Number(BigInt(r.result));
}

/** The block nearest `days` before the head (the start of a trading window), read like every other request. */
async function blockDaysBack(deps: Deps, h: number, days: number) {
  const timeOf = async (b: number) => {
    const r = await ask(deps, {
      method: 'eth_getBlockByNumber',
      params: [`0x${b.toString(16)}`, false],
    });
    const ts = (r.result as { timestamp?: string } | null)?.timestamp;
    if (r.error || !ts) throw new Error(`header of block ${b}: ${r.error?.message ?? 'no result'}`);
    return Number(BigInt(ts));
  };
  const headT = await timeOf(h);
  const at = await blockAtTime(timeOf, h, headT - days * DAY, { blocksPerDay: 855_000 });
  log({
    event: 'window_start',
    days,
    block: at.block,
    time: new Date(at.time * 1000).toISOString(),
    reads: at.reads + 1,
  });
  return at;
}

async function robinhoodLogs() {
  const deps = evmDeps();
  const ctx = trading as TradingCtx;
  const { file: listFile, rows } = robinhoodList();
  // the list's rows (--scope list), or the shelf's tokens (the default)
  const tokens = ctx.tokens ?? new Set(rows.map((r) => r.address.toLowerCase()));
  const file = ctx.shelf?.list ?? listFile;
  const erc20 = [...tokens].filter((a) => a !== ZERO_ADDRESS);
  const creation = JSON.parse(readFileSync(join(EVM, 'creation-logs-robinhood.json'), 'utf8')) as {
    scannedTo: number;
    created: Created[];
  };
  const cls = classifyPools(creation.created, tokens);
  const resolver = new PoolResolver(robinhood, tokens, cls.classOf);
  const label = BACKFILL_ENDPOINTS.robinhood ?? rpcFor(robinhood).label;
  if (mode === 'count') {
    const h = await head(deps);
    const k = Number(opt('--strata') ?? 16);
    const size = Number(opt('--window-blocks') ?? 100_000);
    // whole life from the first pool of the list's (--scope list), else the block `days` before the head
    const from =
      ctx.days === null
        ? Number.isFinite(cls.firstBlock)
          ? cls.firstBlock
          : 0
        : (await blockDaysBack(deps, h, ctx.days)).block;
    // the shelf's tokens no pool of RU.2's creation logs holds: their pools are only those a log names and the
    // resolver ties to them (stated in the count)
    const inCreated = new Set(
      creation.created.flatMap((c) => [c.token0.toLowerCase(), c.token1.toLowerCase()]),
    );
    const noCreationPool = ctx.shelf
      ? ctx.shelf.tokens.filter((t) => !inCreated.has(t.address.toLowerCase()))
      : [];
    const res = await countLogs(deps, {
      chain: robinhood,
      filters: seriesFilters(robinhood, erc20),
      resolver,
      tokens,
      from,
      head: h,
      strata: k,
      window: size,
    });
    const t = res.estimate.totals;
    const sum = (re: RegExp) =>
      Object.entries(t)
        .filter(([key]) => re.test(key))
        .reduce((a, [, v]) => a + v, 0);
    const listLogs = {
      swaps: sum(/^v[34]_swap:(list_pool|unknown_pool)$/),
      supply: sum(/^(mint|burn):list_token$/),
      liquidity: sum(/^v[34]_liquidity:(list_pool|unknown_pool)$/),
      ofWhichUnknownPool: sum(/:unknown_pool$/),
      otherVenueNotRead: sum(/:other_venue$/),
    };
    const gzBytes = sum(/:gzBytes$/);
    const logsAll = sum(/^(v[34]_swap|mint|burn|v[34]_liquidity):(?!rowBytes|gzBytes)/);
    const queriesPerSample = res.measured.queries / Math.max(1, res.strata);
    const windows = Math.ceil((h - from + 1) / size);
    // the full walk asks the same filters over every window: the sample's queries and seconds a window, scaled
    // the live loop's minutes the count waited out are not the endpoint's time
    const quietS = events
      .filter((e) => e.event === 'quiet')
      .reduce((a, e) => a + Number(e.waitS ?? 0), 0);
    const hours = (((res.measured.rpcSeconds - quietS) / Math.max(1, res.strata)) * windows) / 3600;
    // the loop's minutes take a quarter of every hour
    const wallHours = hours / (46 / 60);
    const budget = budgetNow(gzBytes);
    const body = {
      series,
      scope: ctx.key,
      scopeOf: scopeOf(ctx),
      chain: 'robinhood',
      countedAt: new Date().toISOString(),
      methodVersion: BACKFILL_METHOD_VERSION,
      rpc: label,
      list: file,
      tokens: {
        [ctx.shelf ? 'shelfRows' : 'listRows']: tokens.size,
        erc20: erc20.length,
        ...(ctx.shelf
          ? {
              noPoolInCreationLogs: noCreationPool.map((t) => ({
                address: t.address,
                symbol: t.symbol,
                note: "no pool of RU.2's creation logs holds it: its pools are those the sampled logs name and the resolver ties to it (token0/token1/factory, the v4 position manager's poolKeys)",
              })),
            }
          : {}),
      },
      pools: {
        creationLogsTo: creation.scannedTo,
        created: creation.created.length,
        ofTheList: cls.listPools,
        firstBlock: from,
      },
      window: { fromBlock: from, head: h, blocks: h - from + 1, windows, windowBlocks: size },
      method: `stratified sample: ${res.strata} strata of the span, one ${size}-block window at the middle of each, every log of the six filters (v3 Swap and Mint/Burn by topic over every contract, v4 Swap and ModifyLiquidity of the pool manager, Transfer from and to the zero address of the ${ctx.shelf ? "shelf's" : "list's"} ${erc20.length} ERC-20 tokens), each stratum's count × its length ÷ the window's; a pool is counted when a token of the ${ctx.shelf ? 'shelf' : 'list'} is on either side`,
      estimate: {
        listLogs,
        allLogs: logsAll,
        gzBytes,
        gzGB: +(gzBytes / GB).toFixed(2),
        // collapsed strata (neighbours in pairs): the standard error, two either side, the largest stratum
        spread: {
          gzSEGB: +(res.estimate.bytesSpread.se / GB).toFixed(2),
          gzGBTwoSE: [
            +((gzBytes - 2 * res.estimate.bytesSpread.se) / GB).toFixed(2),
            +((gzBytes + 2 * res.estimate.bytesSpread.se) / GB).toFixed(2),
          ],
          largestStratumShare: +res.estimate.bytesSpread.largestShare.toFixed(3),
          byClass: res.estimate.spread,
        },
        totals: t,
      },
      sampledShare: res.estimate.sampledShare,
      measured: { ...res.measured, resolverCalls: resolver.calls },
      hours: {
        rpc: +hours.toFixed(2),
        wall: +wallHours.toFixed(2),
        queriesPerWindow: +queriesPerSample.toFixed(1),
      },
      budget,
      perStratum: res.estimate.perStratum,
    };
    const f = writeCount(body);
    return finish({
      count: f,
      scope: ctx.key,
      listLogs,
      gzGB: body.estimate.gzGB,
      gzSpread: {
        se: body.estimate.spread.gzSEGB,
        twoSE: body.estimate.spread.gzGBTwoSE,
        largest: body.estimate.spread.largestStratumShare,
      },
      hours: body.hours,
      fits: budget.fits,
    });
  }
  // fetch
  const kind = opt('--kind') as LogKind | undefined;
  if (kind && !LOG_KINDS.includes(kind))
    throw new Error(`--kind ${kind}: one of ${LOG_KINDS.join(', ')}`);
  const subject = opt('--pool') ?? opt('--token');
  const subjectKind = opt('--token')
    ? 'token'
    : subject
      ? subject.length === 66
        ? 'v4'
        : 'cl'
      : undefined;
  let from: number;
  let to: number;
  if (all) {
    to = await head(deps);
    // whole life (--scope list): the chain's first block, as a token's first mint can come before its first
    // pool; else the block `days` before the head
    from = ctx.days === null ? 0 : (await blockDaysBack(deps, to, ctx.days)).block;
  } else {
    const [a, b] = (opt('--window') as string).split('-').map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b) || (b as number) < (a as number))
      throw new Error('--window <fromBlock>-<toBlock>');
    from = a as number;
    to = b as number;
    // a window wider than a sample is a series run: the same gate as --all, and inside the counted scope
    if (windowNeedsGate('robinhood-logs', from, to)) {
      const what = `a window of ${to - from + 1} blocks (wider than ${MAX_SAMPLE_WINDOW['robinhood-logs'].size})`;
      requireCountThatFits(ctx.key, what);
      const start =
        ctx.days === null ? null : (await blockDaysBack(deps, await head(deps), ctx.days)).block;
      requireWindowInScope(from, start, what, ctx.key);
    }
  }
  const res = await fetchLogs(deps, {
    out: join(OUT, 'robinhood'),
    filters: seriesFilters(robinhood, erc20, { kind, subject, subjectKind }),
    // the list's every pool and token is `*`; the shelf's fetch is recorded under its own key, so a list-wide
    // fetch never takes the shelf's blocks as covered (the shelf's fetch takes the list's: the shelf is in it)
    scope: subject ? subject.toLowerCase() : ctx.shelf ? ctx.key : '*',
    guard: fetchGuard(),
    from,
    to,
    window: 100_000,
    prepare: subject ? undefined : (rows) => resolver.resolve(deps, rows),
    keep: (r) =>
      subject
        ? r.subject === subject.toLowerCase()
        : r.kind === 'supply'
          ? tokens.has(r.subject)
          : ['list_pool', 'unknown_pool'].includes(resolver.classOf(r.subject)),
    source: `${robinhood.name} eth_getLogs through ${label}: Swap, Mint/Burn, ModifyLiquidity and Transfer at the zero address (backfill-0.1)`,
  });
  return finish({
    fetched: res,
    scope: ctx.key,
    window: { from, to },
    subject: subject ?? null,
    kind: kind ?? 'all',
  });
}

async function chainlinkRounds() {
  const deps = evmDeps();
  const { file, rows } = robinhoodList();
  const tracked = JSON.parse(readFileSync('scripts/risk/universe/robinhood.json', 'utf8')) as {
    assets: Array<{ symbol: string; oracle: { kind: string; ref: string } | null }>;
  };
  const seen = new Set<string>();
  const feeds: Array<{ feed: string; symbol: string }> = [];
  for (const r of [...rows, ...tracked.assets])
    if (r.oracle?.kind === 'chainlink' && !seen.has(r.oracle.ref.toLowerCase())) {
      seen.add(r.oracle.ref.toLowerCase());
      feeds.push({ feed: r.oracle.ref.toLowerCase(), symbol: r.symbol });
    }
  const label = BACKFILL_ENDPOINTS.robinhood ?? rpcFor(robinhood).label;
  const counted = await countRounds(deps, robinhood, feeds);
  recordExtra.feeds = feeds;
  if (opt('--feed')) recordExtra.feed = opt('--feed')?.toLowerCase();
  if (mode === 'count') {
    const rounds = counted.feeds.reduce((a, f) => a + (f.rounds ?? 0), 0);
    // bytes a round: what the feeds fetched so far wrote (their manifests), else SGOV's 158 B of Oct 11
    const done = join(OUT, 'robinhood', 'chainlink');
    const manifests = existsSync(done)
      ? readdirSync(done)
          .map((f) => join(done, f, 'manifest.json'))
          .filter((f) => existsSync(f))
          .map((f) => JSON.parse(readFileSync(f, 'utf8')) as { rows: number; bytes: number })
      : [];
    const fetchedRows = manifests.reduce((a, m) => a + m.rows, 0);
    const perRoundGz = fetchedRows ? manifests.reduce((a, m) => a + m.bytes, 0) / fetchedRows : 158;
    const gzBytes = rounds * perRoundGz;
    const budget = budgetNow(gzBytes);
    const body = {
      series,
      scope: 'feeds',
      chain: 'robinhood',
      countedAt: new Date().toISOString(),
      methodVersion: BACKFILL_METHOD_VERSION,
      rpc: label,
      list: file,
      method:
        'phaseId() of each proxy, phaseAggregators(p) for p = 1 … phaseId, latestRound() of each phase aggregator, by Multicall3 at the head: the rounds are counted, not sampled',
      feeds: counted.feeds.length,
      rounds,
      calls: {
        multicallRequests: counted.requests,
        fetchCalls: rounds,
        fetchRequests: Math.ceil(rounds / 400),
      },
      estimate: {
        gzBytes,
        perRoundGzBytes: perRoundGz,
        perRoundSource: fetchedRows
          ? `the ${manifests.length} feeds fetched so far (${fetchedRows} rounds)`
          : 'SGOV, 2026-10-11',
      },
      budget,
      perFeed: counted.feeds,
    };
    const f = writeCount(body);
    return finish({ count: f, feeds: counted.feeds.length, rounds, fits: budget.fits });
  }
  const targets = all
    ? counted.feeds
    : counted.feeds.filter((f) => f.feed === opt('--feed')?.toLowerCase());
  if (!targets.length) throw new Error(`--feed ${opt('--feed')}: not a feed the lists name`);
  const results = [];
  const guardFn = fetchGuard();
  let writtenBytes = 0;
  let largest = 0;
  for (const f of targets) {
    guardFn({ nextBytes: largest, writtenBytes });
    results.push(
      await fetchRounds(
        deps,
        robinhood,
        f,
        join(OUT, 'robinhood', 'chainlink'),
        `${robinhood.name} Chainlink proxy ${f.feed} (${f.symbol}): getRoundData of every round of every phase by Multicall3 through ${label}`,
      ),
    );
    const last = results.at(-1) as { gzBytes: number };
    writtenBytes += last.gzBytes;
    largest = Math.max(largest, last.gzBytes);
  }
  guardFn({ nextBytes: 0, writtenBytes });
  return finish({ fetched: results });
}

// ---------------------------------------------------------------------------------------------------------------
// Solana

const SOL_LIMIT = Number(opt('--limit') ?? 250);
const DAY = 86_400;
type Reg = { pools: RegistryPool[] };
function solanaSubjects() {
  const regFile = opt('--registry') ?? latestRegistryFile(RISK);
  const reg = JSON.parse(readFileSync(regFile, 'utf8')) as Reg;
  const tracked = JSON.parse(readFileSync('scripts/risk/universe/solana.json', 'utf8')) as {
    assets: Array<{ address: string; symbol: string }>;
  };
  const trackedMints = new Set(tracked.assets.map((a) => a.address));
  const solList = opt('--sol-list') ?? 'scripts/risk/assets/solana.json';
  // the Solana asset list (AS.2) when it is committed; until then every stock token of the registry, the
  // tracked ones and the rest as candidates (DA16)
  const listed = existsSync(solList)
    ? new Set(
        (
          JSON.parse(readFileSync(solList, 'utf8')) as {
            assets: Array<{ address: string; status: string }>;
          }
        ).assets
          .filter((a) => a.status === 'listed' || a.status === 'candidate')
          .map((a) => a.address),
      )
    : null;
  const pools = reg.pools.filter(
    (p) => trackedMints.has(p.assetMint) || !listed || listed.has(p.assetMint),
  );
  const registryMints = new Set(pools.map((p) => p.assetMint));
  // the mints walked: every listed or candidate token of the list but USDC and USDT (DA15), else the
  // registry's stock tokens
  const mints = listed ? [...listed].filter((m) => !DA15_NOT_WALKED.has(m)) : [...registryMints];
  return { regFile, pools, mints, registryMints, trackedMints, list: listed ? solList : null };
}
/**
 * The pools of the trading scope: the list's (`--scope list`, as `solanaSubjects`), or the registry's pools of
 * the shelf's tokens, with the shelf's tokens that have no pool in the registry named.
 */
function solanaPools() {
  const sub = solanaSubjects();
  const ctx = trading as TradingCtx;
  if (!ctx.tokens) return { ...sub, noKnownPool: [] as Array<{ address: string; symbol: string }> };
  const reg = JSON.parse(readFileSync(sub.regFile, 'utf8')) as Reg;
  const shelf = ctx.tokens;
  const pools = reg.pools.filter((p) => shelf.has(p.assetMint));
  const withPool = new Set(pools.map((p) => p.assetMint));
  const noKnownPool = (ctx.shelf?.tokens ?? [])
    .filter((t) => !withPool.has(t.address))
    .map((t) => ({ address: t.address, symbol: t.symbol }));
  return { ...sub, pools, list: ctx.shelf?.list ?? sub.list, noKnownPool };
}

/** USDC and USDT on Solana: their supply comes from the external daily series, their mints are not walked (DA15). */
const DA15_NOT_WALKED = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

/**
 * The mint authorities of the list's listed and candidate tokens (not USDC, USDT): walking an authority's
 * signatures gives every mint and burn it signed for its tokens, where walking a mint gives every transfer.
 */
function authoritiesOf(file: string) {
  const list = JSON.parse(readFileSync(file, 'utf8')) as {
    assets: Array<{
      address: string;
      status: string;
      authorities?: { mint?: { holder: string | null } };
    }>;
  };
  const by = new Map<string, number>();
  for (const a of list.assets) {
    if (a.status !== 'listed' && a.status !== 'candidate') continue;
    if (DA15_NOT_WALKED.has(a.address)) continue;
    const h = a.authorities?.mint?.holder;
    if (h) by.set(h, (by.get(h) ?? 0) + 1);
  }
  return [...by.entries()].map(([holder, tokens]) => ({ holder, tokens }));
}

async function solanaCount(kind: 'swaps' | 'mints') {
  const { regFile, pools, mints, registryMints, trackedMints, list } = solanaSubjects();
  // the swaps' pools and window by the trading scope (the shelf's 30 days by default); the mints' as before
  const ctx = kind === 'swaps' ? (trading as TradingCtx) : null;
  const scoped = ctx ? solanaPools() : null;
  const windowDays = ctx?.days ?? (kind === 'mints' && mintShelf ? mintShelf.days : 90);
  const swapPools = scoped?.pools ?? pools;
  // the mints outside the registry's stock tokens are sampled one in `--mint-every` and scaled
  const mintEvery = Number(opt('--mint-every') ?? 10);
  const otherMints = mints.filter((m) => !registryMints.has(m));
  const nowT = Math.floor(Date.now() / 1000);
  // a scope without the sampled walk beyond its window (the shelf's 30 days) is anchored within its window only,
  // weekly: an anchor a year back sizes nothing it fetches, and a deep `before` on a busy pool can time out
  const inWindowOnly = (!!ctx && !ctx.beyond) || (kind === 'mints' && !!mintShelf);
  const anc = anchors(RISK, nowT, {
    windowDays,
    stepDays: Number(opt('--step-days') ?? (inWindowOnly ? 7 : 15)),
    oldest: inWindowOnly
      ? new Date((nowT - windowDays * DAY) * 1000).toISOString().slice(0, 10)
      : '2025-06-25',
  });
  const dustEvery = Number(opt('--dust-every') ?? 20);
  const live = swapPools.filter((p) => p.tier !== 'X');
  const dust = swapPools.filter((p) => p.tier === 'X');
  const dustSample = dust.filter((_, i) => i % dustEvery === 0);
  const subjects =
    kind === 'swaps'
      ? [
          ...live.map((p) => ({ address: p.address, group: 'live' as const, p })),
          ...dustSample.map((p) => ({ address: p.address, group: 'dust' as const, p })),
        ]
      : mintShelf
        ? mintShelf.mints.map((m) => ({ address: m, group: 'shelf' as const, p: null }))
        : opt('--via') === 'authority'
          ? authoritiesOf(opt('--sol-list') ?? 'scripts/risk/assets/solana.json').map((a) => ({
              address: a.holder,
              group: 'mint_authority' as const,
              p: null,
              tokens: a.tokens,
            }))
          : [
              ...mints
                .filter((m) => registryMints.has(m))
                .map((m) => ({
                  address: m,
                  group: trackedMints.has(m) ? ('tracked' as const) : ('registry_stock' as const),
                  p: null,
                })),
              ...otherMints
                .filter((_, i) => i % mintEvery === 0)
                .map((m) => ({ address: m, group: 'other_sampled' as const, p: null })),
            ];
  const parallel = Number(opt('--parallel') ?? 12);
  const jobs = subjects.flatMap((s) => anc.map((a) => ({ s, a })));
  const tc = Date.now();
  let pageBytes = 0;
  // a page the endpoint cannot answer (a deep `before` on a busy pool times out on some) is recorded and left
  // out: the address is estimated from its other pages, and the count file names every such page
  const pageFailures: Array<{ address: string; anchor: string; error: string }> = [];
  const pages = (
    await pool(jobs, parallel, async ({ s, a }) => {
      try {
        const got = await anchoredPage(solRpc as never, s.address, a, SOL_LIMIT);
        pageBytes += got.bytes;
        return { address: s.address, page: got.page };
      } catch (e) {
        pageFailures.push({
          address: s.address,
          anchor: a.at,
          error: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    })
  ).filter((x): x is { address: string; page: AnchoredPage } => x !== null);
  // an address older than the oldest anchor (no page reached its first transaction): quarterly anchors from
  // blocks, back from 2025-03 to 2020-04, until a page reaches it
  const reached = new Set(
    pages.filter((r) => r.page.exhausted || r.page.n === 0).map((r) => r.address),
  );
  // within its window only (the shelf's 30 days), an address is never followed back to its first transaction
  const older = inWindowOnly ? [] : subjects.filter((x) => !reached.has(x.address));
  const deepDates: number[] = [];
  for (
    let d = new Date('2025-03-15T12:00:00Z');
    d >= new Date('2020-04-15T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 3)
  )
    deepDates.push(Math.floor(d.getTime() / 1000));
  const lend = anc.find((a) => a.signature && a.from.startsWith('lending-history'));
  let deep: Anchor[] = [];
  if (older.length && lend) {
    const ref = await solRpc<Array<{ slot: number; blockTime: number }>>(
      'getSignaturesForAddress',
      [older[0]?.address, { limit: 1, before: lend.signature }],
    );
    const r0 = ref[0];
    if (r0)
      deep = await blockAnchors(solRpc as never, { slot: r0.slot, t: r0.blockTime }, deepDates);
  }
  await pool(older, parallel, async (x) => {
    for (const a of deep) {
      const got = await anchoredPage(solRpc as never, x.address, a, SOL_LIMIT);
      pageBytes += got.bytes;
      pages.push({ address: x.address, page: got.page });
      if (got.page.exhausted || got.page.n === 0) break;
    }
  });
  const callSeconds = (Date.now() - tc) / 1000;
  const byAddr = new Map<string, AnchoredPage[]>();
  for (const r of pages) byAddr.set(r.address, [...(byAddr.get(r.address) ?? []), r.page]);
  // the start of the window: day 90 of the list's scope, day 30 of the shelf's (the `…90` keys below hold the
  // window's figures, whatever its days: `window.days` names them)
  const d90 = nowT - windowDays * DAY;
  // Step 5b's measured bytes a transaction (decoded rows, data/risk/history-full/events), gzipped as the
  // fetch writes them: from three day files of different pools
  const sample = [
    '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE/2026-09-20.jsonl',
    'GYqHjuDzTiw7i52Xv1qohDE6eJr6eSZpsrBVikGZyaFV/2026-09-20.jsonl',
    'FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1/2026-09-20.jsonl',
  ];
  let sRows = 0;
  let sBytes = 0;
  let sGz = 0;
  for (const f of sample) {
    const p = join(RISK, 'history-full', 'events', f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    sRows += text.split('\n').filter(Boolean).length;
    sBytes += text.length;
    sGz += gzipSync(text).length;
  }
  const rowBytes = sRows ? sBytes / sRows : 330;
  const gzPerTx = sRows ? sGz / sRows : 110;
  const per = subjects.map((s) => {
    const ps = byAddr.get(s.address) ?? [];
    // the oldest time any page reached: an address no page saw begin is counted from there (said in the row)
    const lifeFrom = Math.min(...ps.map((p) => p.oldest ?? p.t));
    const w90 = estimateSignatures(ps, d90, nowT);
    const life = estimateSignatures(ps, lifeFrom, nowT);
    const beyond = estimateSignatures(ps, lifeFrom, d90);
    const first = life.firstSeen ?? Math.min(...anc.map((a) => a.t));
    const sampled =
      kind === 'swaps' && s.group !== 'mint_authority'
        ? estimateSampled(
            ps,
            Math.max(first, Math.min(...anc.map((a) => a.t))),
            d90,
            Number(opt('--per-hour') ?? 30),
          )
        : { fetched: 0, hours: 0 };
    return {
      address: s.address,
      group: s.group,
      symbol: s.p?.assetSymbol ?? null,
      venue: s.p?.venue ?? null,
      tier: s.p?.tier ?? null,
      firstSeen: life.firstSeen ? new Date(life.firstSeen * 1000).toISOString() : null,
      countedFrom: Number.isFinite(lifeFrom) ? new Date(lifeFrom * 1000).toISOString() : null,
      failedShare: +life.failedShare.toFixed(3),
      sigs90: Math.round(w90.signatures),
      sigsBeyond90: Math.round(beyond.signatures),
      sigsLife: Math.round(life.signatures),
      sampledBeyond90: Math.round(sampled.fetched),
      activeHoursBeyond90: sampled.hours,
      // the reads themselves, so the estimate can be made again without asking
      pages: ps.map((p) => [p.t, p.n, p.newest, p.oldest, p.failed, p.exhausted ? 1 : 0]),
    };
  });
  const scale = (g: string) =>
    g === 'dust'
      ? dustEvery
      : g === 'other_sampled'
        ? otherMints.length / Math.ceil(otherMints.length / mintEvery)
        : 1;
  const tot = (k: 'sigs90' | 'sigsBeyond90' | 'sigsLife' | 'sampledBeyond90', g?: string) =>
    per.filter((r) => !g || r.group === g).reduce((a, r) => a + r[k] * scale(r.group), 0);
  const ok = (k: 'sigs90' | 'sigsBeyond90' | 'sigsLife') =>
    per.reduce((a, r) => a + r[k] * (1 - r.failedShare) * scale(r.group), 0);
  // calibration: the 34 value pools' walk of Step 5b is exact over its own span; the same estimator over it
  const calib: Array<Record<string, unknown>> = [];
  const exactFile = opt('--exact');
  if (kind === 'swaps' && exactFile && existsSync(exactFile))
    for (const l of readFileSync(exactFile, 'utf8').split('\n').filter(Boolean)) {
      const [address, n, failed, oldest, newest] = l.trim().split(/\s+/);
      const ps = byAddr.get(address as string);
      if (!ps) continue;
      const est = estimateSignatures(ps, Number(oldest), Number(newest)).signatures;
      calib.push({
        address,
        exact: Number(n),
        failed: Number(failed),
        estimate: Math.round(est),
        ratio: +(est / Number(n)).toFixed(3),
      });
    }
  const ratios = calib.map((c) => c.ratio as number).sort((a, b) => a - b);
  const calibration = calib.length
    ? {
        pools: calib.length,
        exactTotal: calib.reduce((a, c) => a + (c.exact as number), 0),
        estimateTotal: calib.reduce((a, c) => a + (c.estimate as number), 0),
        medianRatio: ratios[Math.floor(ratios.length / 2)],
        p10: ratios[Math.floor(ratios.length * 0.1)],
        p90: ratios[Math.floor(ratios.length * 0.9)],
        perPool: calib,
      }
    : null;
  const tx90 = ok('sigs90');
  const txLife = ok('sigsLife');
  // the sampled walk beyond the window is the list's scope only (series 3b): the shelf's is out of the MVP depth
  const walkBeyond = !ctx || ctx.beyond;
  const sampledBeyond = walkBeyond ? tot('sampledBeyond90') : 0;
  const pagesBeyond = walkBeyond ? tot('sigsBeyond90') / 1000 : 0;
  // calls: signature pages of 1,000, and one getTransaction per successful signature fetched
  const calls =
    kind === 'swaps'
      ? {
          sigPages90: tot('sigs90') / 1000,
          getTransaction90: tx90,
          sigPagesBeyond90: pagesBeyond,
          getTransactionSampled: sampledBeyond,
        }
      : { sigPagesLife: tot('sigsLife') / 1000, getTransactionLife: txLife };
  const gzBytes = kind === 'swaps' ? (tx90 + sampledBeyond) * gzPerTx : txLife * gzPerTx;
  const txRate = Number(opt('--tx-rate') ?? 495);
  const pageRate = Number(opt('--page-rate') ?? 20);
  const hours =
    kind === 'swaps'
      ? {
          at: { txPerSecond: txRate, sigPagesPerSecond: pageRate },
          days90: (tx90 / txRate + tot('sigs90') / 1000 / pageRate) / 3600,
          beyond90: (sampledBeyond / txRate + pagesBeyond / pageRate) / 3600,
        }
      : {
          at: { txPerSecond: txRate, sigPagesPerSecond: pageRate },
          life: (txLife / txRate + tot('sigsLife') / 1000 / pageRate) / 3600,
        };
  const budget = budgetNow(gzBytes);
  const body = {
    series: kind === 'swaps' ? 'solana-swaps' : 'solana-mints',
    scope: ctx ? ctx.key : (mintShelf?.key ?? opt('--via') ?? 'mint'),
    ...(ctx
      ? {
          scopeOf: {
            ...scopeOf(ctx),
            beyondWindow: ctx.beyond ? 'sampled walk to inception' : 'not walked',
          },
          noKnownPool: (scoped?.noKnownPool ?? []).map((t) => ({
            ...t,
            note: 'no pool of the registry has it as its asset: not counted',
          })),
        }
      : {}),
    via: kind === 'mints' ? (opt('--via') ?? 'mint') : 'pool',
    chain: 'solana',
    countedAt: new Date().toISOString(),
    methodVersion: BACKFILL_METHOD_VERSION,
    rpc: BACKFILL_ENDPOINTS.solana
      ? BACKFILL_ENDPOINTS.solana
      : process.env.SOLANA_RPC_URL
        ? 'SOLANA_RPC_URL (the risk scripts’ RPC)'
        : 'the public mainnet-beta endpoint',
    registry: regFile,
    list:
      scoped?.list ??
      list ??
      'none committed: every stock token of the registry, tracked or candidate (DA16)',
    subjects: {
      pools:
        kind === 'swaps'
          ? {
              live: live.length,
              dust: dust.length,
              dustSampled: dustSample.length,
              dustScale: dustEvery,
            }
          : undefined,
      mints:
        kind === 'mints'
          ? {
              walked: mints.length,
              tracked: per.filter((r) => r.group === 'tracked').length,
              registryStocks: per.filter((r) => r.group === 'registry_stock').length,
              others: otherMints.length,
              othersSampled: per.filter((r) => r.group === 'other_sampled').length,
            }
          : undefined,
    },
    window: {
      now: new Date(nowT * 1000).toISOString(),
      day90: new Date(d90 * 1000).toISOString(),
      days: windowDays,
    },
    anchors: anc,
    deepAnchors: { subjects: older.length, anchors: deep },
    method: `anchored pages: getSignaturesForAddress(address, { before: <anchor>, limit: ${SOL_LIMIT} }) at ${anc.length} anchors (now, every ${Number(opt('--step-days') ?? (inWindowOnly ? 7 : 15))} days to day ${windowDays}${inWindowOnly ? ', none beyond the window' : ', monthly to 2025-06-25'}), each page's mean rate at the middle of what it covers, linear between pages, nothing before an exhausted page's oldest signature (estimateSignatures); the dust pools (tier X) sampled one in ${dustEvery} and the mints outside the registry's stock tokens one in ${mintEvery}, each scaled; successful transactions are the signatures less the pages' failed share; bytes are Step 5b's decoded rows gzipped (${rowBytes.toFixed(0)} B a row, ${gzPerTx.toFixed(0)} B gzipped, from three day files)`,
    estimate: {
      signatures90: Math.round(tot('sigs90')),
      transactions90: Math.round(tx90),
      signaturesBeyond90: Math.round(tot('sigsBeyond90')),
      sampledBeyond90: Math.round(sampledBeyond),
      signaturesLife: Math.round(tot('sigsLife')),
      transactionsLife: Math.round(txLife),
      byGroup: Object.fromEntries(
        [...new Set(per.map((r) => r.group))].map((g) => [
          g,
          { sigs90: Math.round(tot('sigs90', g)), sigsLife: Math.round(tot('sigsLife', g)) },
        ]),
      ),
      gzBytes,
      gzGB: +(gzBytes / GB).toFixed(2),
      bytesPerTx: { row: +rowBytes.toFixed(1), gz: +gzPerTx.toFixed(1) },
    },
    calls,
    hours,
    pageFailures,
    measured: {
      pages: pages.length,
      pageBytes,
      callSeconds,
      pagesPerSecond: +(pages.length / callSeconds).toFixed(1),
      rpc: rpcStats,
    },
    calibration,
    budget,
    perSubject: per.sort((a, b) => b.sigs90 - a.sigs90),
  };
  const f = writeCount(body);
  return finish({
    count: f,
    scope: body.scope,
    estimate: { ...body.estimate, byGroup: undefined },
    hours,
    calibration: calibration && { ...calibration, perPool: undefined },
    fits: budget.fits,
  });
}

/** One address over [a, b], a UTC day at a time newest first, the budget checked before and after each day. */
async function solanaPieces(inp: {
  kind: 'swaps' | 'mints';
  address: string;
  p?: RegistryPool;
  from: number;
  to: number;
  perHour?: number;
  before?: string;
  guard: ReturnType<typeof fetchGuard>;
  written: { bytes: number; largest: number };
  /** Stop at a day whose walk reached the address's first transaction (the sampled walk back to inception). */
  untilExhausted?: boolean;
}) {
  const results = [];
  let before = inp.before;
  // a resumed run skips a day the address's manifest already holds whole (a window with a failed fetch is never
  // marked covered, so it is asked again)
  const mf = join(OUT, 'solana', inp.kind, inp.address, 'manifest.json');
  const covered = existsSync(mf)
    ? (JSON.parse(readFileSync(mf, 'utf8')) as { covered: Array<{ from: number; to: number }> })
        .covered
    : [];
  for (const piece of dayPieces(inp.from, inp.to)) {
    if (!inp.perHour && covered.some((w) => w.from <= piece.from && w.to >= piece.to)) {
      log({ event: 'window_held', address: inp.address, from: piece.from });
      before = undefined;
      continue;
    }
    inp.guard({ nextBytes: inp.written.largest, writtenBytes: inp.written.bytes });
    // a window the endpoint fails (an error the RPC helper does not retry, such as a node's own memory limit) is
    // logged and left uncovered for the next run; it never ends the run (found 2026-10-13)
    let r: Awaited<ReturnType<typeof fetchWindow>>;
    try {
      r = await fetchWindow({
        // one endpoint for the whole window: its walk pages with `before` (stickyRpc)
        rpc: stickyRpc() as never,
        out: join(OUT, 'solana'),
        kind: inp.kind,
        address: inp.address,
        ...(inp.p ? { pool: inp.p } : {}),
        from: piece.from,
        to: piece.to,
        parallel: Number(opt('--parallel') ?? 32),
        ...(inp.perHour ? { perHour: inp.perHour } : {}),
        ...(before ? { startBefore: before } : {}),
        source: `Solana RPC getSignaturesForAddress and getTransaction (${BACKFILL_ENDPOINTS.solana ?? (process.env.SOLANA_RPC_URL ? 'SOLANA_RPC_URL' : 'public')})${inp.p ? `, decoded by @colosseum/risk's ${inp.p.venue} decoder` : ''}`,
        now: () => new Date(),
      });
    } catch (e) {
      log({
        event: 'window_failed',
        address: inp.address,
        from: new Date(piece.from * 1000).toISOString(),
        error: (e instanceof Error ? e.message : String(e))
          .replace(/https?:\/\/\S+/g, '<url>')
          .slice(0, 300),
      });
      before = undefined;
      continue;
    }
    before = r.lastSignature ?? before;
    inp.written.bytes += r.gzBytes;
    inp.written.largest = Math.max(inp.written.largest, r.gzBytes);
    results.push(r);
    log({
      event: 'window',
      address: inp.address,
      from: r.window.from,
      fetched: r.fetched,
      errors: r.errors,
      // the walk ended on a short or empty page: the address's first transaction, or an endpoint that lacked it
      exhausted: r.exhausted,
    });
    if (inp.untilExhausted && r.exhausted) break;
  }
  inp.guard({ nextBytes: 0, writtenBytes: inp.written.bytes });
  return results;
}

/** The exact pass over the 90 days of every pool: its count (scope pools-exact) replaces the sampled one. */
async function solanaExactCount() {
  const ctx = trading as TradingCtx;
  const { pools, regFile, list, noKnownPool } = solanaPools();
  const nowT = Math.floor(Date.now() / 1000);
  const d90 = nowT - (ctx.days ?? 90) * DAY;
  const t1 = Date.now();
  const walks = await exactWalk(
    solRpc as never,
    pools.map((p) => p.address),
    d90,
    Number(opt('--parallel') ?? 8),
    () => new Date(),
    (w) => log({ event: 'walked', address: w.address, signatures: w.signatures, pages: w.pages }),
  );
  const sigs = walks.reduce((a, w) => a + w.signatures, 0);
  const ok = walks.reduce((a, w) => a + w.signatures - w.failed, 0);
  // beyond the window the sampled count of the same scope stands (the exact pass does not walk it; the shelf's
  // scope takes nothing beyond it); Step 5b's bytes a row
  const sampled = newestCount(seriesDir, ctx.key);
  const sampledBody = sampled
    ? (JSON.parse(readFileSync(sampled.file, 'utf8')) as {
        estimate: { sampledBeyond90: number; bytesPerTx: { gz: number } };
      })
    : null;
  const gzPerTx = sampledBody?.estimate.bytesPerTx.gz ?? 109.2;
  const beyond = ctx.beyond ? (sampledBody?.estimate.sampledBeyond90 ?? 0) : 0;
  const gzBytes = (ok + beyond) * gzPerTx;
  const body = {
    series,
    scope: ctx.exactKey as string,
    scopeOf: scopeOf(ctx),
    noKnownPool,
    chain: 'solana',
    countedAt: new Date().toISOString(),
    methodVersion: BACKFILL_METHOD_VERSION,
    registry: regFile,
    list,
    window: { from: new Date(d90 * 1000).toISOString(), to: new Date(nowT * 1000).toISOString() },
    method: `exact: every signature of every pool from the head back to day ${ctx.days ?? 90}, getSignaturesForAddress 1,000 a page, counted by day and failed or not (history-full-measure.ts walk, counting only); ${ctx.beyond ? 'beyond it the sampled count stands' : 'nothing beyond it'}`,
    estimate: {
      signatures90: sigs,
      transactions90: ok,
      sampledBeyond90: beyond,
      gzBytes,
      gzGB: +(gzBytes / GB).toFixed(2),
    },
    measured: { pages: walks.reduce((a, w) => a + w.pages, 0), seconds: (Date.now() - t1) / 1000 },
    budget: budgetNow(gzBytes),
    perPool: walks,
  };
  return { file: writeCount(body), body };
}

async function solanaFetch(kind: 'swaps' | 'mints') {
  const ctx = kind === 'swaps' ? (trading as TradingCtx) : null;
  const { pools } = kind === 'swaps' ? solanaPools() : solanaSubjects();
  const guardFn = fetchGuard();
  const written = { bytes: 0, largest: 0 };
  if (all) {
    if (kind === 'mints' && !has('--decided'))
      throw new Error(
        '--all on Solana mints is Rodrigo’s call (182M transactions, 18.6 GB over 30 days, counted 2026-10-13): pass --decided <gate> once docs/GATES.md records it',
      );
    if (kind === 'mints' && !(mintShelf && has('--skip-exact')))
      throw new Error(
        "--all on Solana mints takes the shelf's mints (--shelf --skip-exact); the list's whole mints or their authorities are Rodrigo’s choice (DA20); fetch a mint with --mint and --window",
      );
    const nowT = Math.floor(Date.now() / 1000);
    const d90 = nowT - (ctx?.days ?? (kind === 'mints' && mintShelf ? mintShelf.days : 90)) * DAY;
    // the shelf's scope with --skip-exact: gated on the sampled count of the same scope (the budget is checked
    // after every day all the same), and fetched in passes over time, the newest days of every pool first, so a
    // run cut short (an endpoint's trial ending) leaves every pool its most recent days (stated, not chosen)
    const passScope: {
      key: string;
      subjects: Array<{ address: string; p?: RegistryPool }>;
    } | null =
      kind === 'swaps' && ctx && !ctx.beyond
        ? { key: ctx.key, subjects: pools.map((p) => ({ address: p.address, p })) }
        : kind === 'mints' && mintShelf
          ? {
              key: mintShelf.key,
              subjects: mintShelf.mints.map((m) => ({ address: m, p: undefined })),
            }
          : null;
    if (has('--skip-exact') && passScope) {
      requireCountThatFits(passScope.key, '--all --skip-exact (the sampled count of the scope)');
      const passDays = Number(opt('--pass-days') ?? 7);
      const windows: Array<[number, number]> = [];
      for (let end = nowT; end > d90; end -= passDays * DAY)
        windows.push([Math.max(d90, end - passDays * DAY + 1), end]);
      const lastSig = new Map<string, string | undefined>();
      let piecesDone = 0;
      // pools fetched `--pool-parallel` at a time (default 6). With --no-barrier each slot walks one pool through
      // every pass, newest first, the pools busiest first by the count's own figures, so a pool that holds a
      // quarter of the scope (JTO/SOL, about 1.6M signatures a day) starts at once and no slot waits for it at a
      // pass's end (found 2026-10-13: the passes' barrier left most slots idle behind one pool). Without it, the
      // passes as before: every pool's week, then the week before.
      const poolParallel = Number(opt('--pool-parallel') ?? 6);
      const walkPool = async (
        p: (typeof passScope.subjects)[number],
        ws: Array<[number, [number, number]]>,
      ) => {
        for (const [i, [from, to]] of ws) {
          const before = lastSig.get(p.address);
          const r = await solanaPieces({
            kind,
            address: p.address,
            ...(p.p ? { p: p.p } : {}),
            from,
            to,
            ...(before ? { before } : {}),
            guard: guardFn,
            written,
          });
          lastSig.set(p.address, r.at(-1)?.lastSignature ?? undefined);
          piecesDone++;
          log({
            event: 'pass_pool_done',
            pass: i + 1,
            of: windows.length,
            address: p.address,
            piecesDone,
            writtenBytes: written.bytes,
          });
        }
      };
      if (has('--no-barrier')) {
        const countFile = newestCount(
          join(OUT, 'solana', kind === 'swaps' ? 'solana-swaps' : 'solana-mints'),
          passScope.key,
        )?.file;
        const per = countFile
          ? ((
              JSON.parse(readFileSync(countFile, 'utf8')) as {
                perSubject?: Array<{ address: string; sigs90?: number }>;
              }
            ).perSubject ?? [])
          : [];
        const sigsOf = new Map(per.map((x) => [x.address, x.sigs90 ?? 0]));
        const order = [...passScope.subjects].sort(
          (a, b) => (sigsOf.get(b.address) ?? 0) - (sigsOf.get(a.address) ?? 0),
        );
        await pool(order, poolParallel, (p) =>
          walkPool(
            p,
            windows.map((w, i) => [i, w] as [number, [number, number]]),
          ),
        );
      } else
        for (const [i, w] of windows.entries()) {
          await pool(passScope.subjects, poolParallel, (p) => walkPool(p, [[i, w]]));
          log({
            event: 'pass_done',
            pass: i + 1,
            of: windows.length,
            from: new Date(w[0] * 1000).toISOString(),
            writtenBytes: written.bytes,
          });
        }
      return finish({
        subjects: passScope.subjects.length,
        passes: windows.length,
        writtenBytes: written.bytes,
        rpc: rpcStats,
      });
    }
    // step 1, the exact pass, then the gate on its count, then the fetch
    const exact = await solanaExactCount();
    log({ event: 'exact_pass', count: exact.file, estimate: exact.body.estimate });
    requireCountThatFits(ctx?.exactKey as string, '--all after the exact pass');
    const order = [...exact.body.perPool].sort((x, y) => y.signatures - x.signatures);
    let done = 0;
    for (const w of order) {
      const p = pools.find((x) => x.address === w.address) as RegistryPool;
      const recent = await solanaPieces({
        kind,
        address: p.address,
        p,
        from: d90,
        to: nowT,
        guard: guardFn,
        written,
      });
      const below = recent.at(-1)?.lastSignature ?? undefined;
      // the sampled walk from day 91 back to the pool's first transaction, 30 transactions an hour (the
      // list's scope only: the shelf's is its window)
      if (ctx?.beyond && !recent.at(-1)?.exhausted)
        await solanaPieces({
          kind,
          address: p.address,
          p,
          from: Date.parse('2025-06-01T00:00:00Z') / 1000,
          to: d90 - 1,
          perHour: Number(opt('--per-hour') ?? 30),
          ...(below ? { before: below } : {}),
          guard: guardFn,
          written,
          untilExhausted: true,
        });
      done++;
      log({
        event: 'pool_done',
        address: p.address,
        done,
        of: order.length,
        writtenBytes: written.bytes,
      });
    }
    return finish({ pools: done, writtenBytes: written.bytes, rpc: rpcStats });
  }
  const address = opt(kind === 'swaps' ? '--pool' : '--mint');
  if (!address) throw new Error(`--${kind === 'swaps' ? 'pool' : 'mint'} <address> is needed`);
  const [a, b] = (opt('--window') as string)
    .split('..')
    .map((x) => Math.floor(Date.parse(x) / 1000));
  if (!a || !b || b <= a) throw new Error('--window <fromISO>..<toISO>');
  const series2 = kind === 'swaps' ? 'solana-swaps' : 'solana-mints';
  if (windowNeedsGate(series2, a, b)) {
    const what = `a window of ${((b - a + 1) / DAY).toFixed(1)} days (wider than ${MAX_SAMPLE_WINDOW[series2].size / DAY})`;
    requireCountThatFits(kind === 'swaps' ? (ctx?.exactKey as string) : 'mint', what);
    // inside the counted scope: its last `days`, back from now
    if (ctx && ctx.days !== null)
      requireWindowInScope(a, Math.floor(Date.now() / 1000) - ctx.days * DAY, what, ctx.key);
  }
  const p = pools.find((x) => x.address === address);
  if (kind === 'swaps' && !p)
    throw new Error(`${address} is not a registry pool of the scope (${ctx?.key})`);
  const res = await solanaPieces({
    kind,
    address,
    ...(p ? { p } : {}),
    from: a,
    to: b,
    ...(opt('--per-hour') ? { perHour: Number(opt('--per-hour')) } : {}),
    // a signature just after the window (from a walk on disk), so the walk starts there and not at the head
    ...(opt('--before') ? { before: opt('--before') } : {}),
    guard: guardFn,
    written,
  });
  const sum = (
    k: 'signatures' | 'successful' | 'fetched' | 'errors' | 'gzBytes' | 'fetchSeconds',
  ) => res.reduce((x, r) => x + (r[k] as number), 0);
  return finish({
    fetched: {
      address,
      windows: res.length,
      signatures: sum('signatures'),
      successful: sum('successful'),
      fetched: sum('fetched'),
      errors: sum('errors'),
      gzBytes: sum('gzBytes'),
      txPerSecond: sum('fetched') / Math.max(0.001, sum('fetchSeconds')),
      perWindow: res,
    },
    rpc: rpcStats,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// External daily series

async function externalDaily() {
  const { rows: rh } = robinhoodList();
  const { mints } = solanaSubjects();
  if (mode === 'count') {
    // a sample of every kind of row: Solana's stock tokens and its two dollars and two others; Robinhood
    // Chain's rows, by DefiLlama's two spellings of the chain
    const { registryMints, trackedMints } = solanaSubjects();
    const stockSample = [...trackedMints].slice(0, 8);
    const registryOnly = [...registryMints].filter((m) => !trackedMints.has(m)).slice(0, 6);
    const others = mints.filter((m) => !registryMints.has(m));
    const otherSample = others
      .filter((_, i) => i % Math.max(1, Math.floor(others.length / 10)) === 0)
      .slice(0, 10);
    const solKeys = [
      ...[...stockSample, ...registryOnly, ...otherSample].map((m) => coinKey('solana', m)),
      coinKey('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      coinKey('solana', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
    ];
    const rhSample = rh.slice(0, 25);
    const rhKeys = [
      ...rhSample.map((r) => coinKey('robinhood', r.address)),
      ...rhSample.map((r) => coinKey('robinhood-chain', r.address)),
    ];
    const first = await firstPrices([...solKeys, ...rhKeys]);
    const found = Object.entries(first.coins).filter(([, v]) => v.first);
    // depth: one daily chart from the first price for two Solana tokens
    const depth = [];
    for (const k of [solKeys[0], solKeys.at(-3), rhKeys[0]].filter((x): x is string => !!x)) {
      const f = first.coins[k]?.first;
      if (!f) continue;
      const start = Math.floor(Date.parse(f) / 1000);
      const days = Math.ceil((Date.now() / 1000 - start) / DAY);
      const c = await dailyChart(k, start, days);
      const text = c.prices.map((x) => JSON.stringify(x)).join('\n');
      depth.push({
        key: k,
        first: f,
        days,
        points: c.prices.length,
        requests: c.requests,
        bytes: c.bytes,
        gzBytesPerPoint: c.prices.length ? gzipSync(text).length / c.prices.length : null,
        ms: c.ms,
      });
    }
    const protocols = [];
    for (const slug of ['kamino-lend', 'jupiter-lend', 'maple', 'ondo-finance', 'mellow-lrt']) {
      const r = await protocolTvl(slug);
      protocols.push({ ...r, tvl: undefined });
    }
    // per row of the lists: the share of the sample with a price, its mean days since the first price, the
    // measured gzip bytes a point, and one request every CHART_SPAN_DAYS days
    const share = found.length / Math.max(1, Object.keys(first.coins).length);
    const nowS = Date.now() / 1000;
    const meanDays =
      found.reduce((a, [, v]) => a + (nowS - Date.parse(v.first as string) / 1000) / DAY, 0) /
      Math.max(1, found.length);
    const gzPerPoint =
      depth
        .filter((d) => d.gzBytesPerPoint !== null)
        .reduce((a, d) => a + (d.gzBytesPerPoint as number), 0) /
      Math.max(1, depth.filter((d) => d.gzBytesPerPoint !== null).length);
    const rowsTotal = mints.length + rh.length;
    const points = rowsTotal * share * meanDays;
    const gzBytes = points * gzPerPoint;
    const chartRequests = rowsTotal * share * Math.ceil(meanDays / CHART_SPAN_DAYS);
    const body = {
      series,
      scope: 'rows',
      countedAt: new Date().toISOString(),
      methodVersion: BACKFILL_METHOD_VERSION,
      method:
        'DefiLlama, free and without a key: /prices/first for a sample of every kind of row (when its first price is), /chart from it at period=1d for two rows (how many daily points), /protocol/<slug> for five protocols (TVL points and first date)',
      sample: {
        asked: Object.keys(first.coins).length,
        withPrice: found.length,
        solana: found.filter(([k]) => k.startsWith('solana:')).map(([k, v]) => ({ key: k, ...v })),
        robinhood: found
          .filter(([k]) => !k.startsWith('solana:'))
          .map(([k, v]) => ({ key: k, ...v })),
        robinhoodAsked: rhKeys.length,
      },
      depth,
      protocols,
      rows: { solana: mints.length, robinhood: rh.length },
      estimate: {
        rows: rowsTotal,
        withPriceShare: +share.toFixed(3),
        meanDaysSinceFirstPrice: Math.round(meanDays),
        points: Math.round(points),
        gzBytesPerPoint: +gzPerPoint.toFixed(1),
        gzBytes,
        requests: Math.round(chartRequests + rowsTotal / 50),
        hoursAtOneRequestASecond: +((chartRequests + rowsTotal / 50) / 3600).toFixed(2),
        note: 'a first price far older than the chain is the price of the token the row is mapped to (DefiLlama prices a bridged or wrapped token by its source), not of the row itself',
      },
      budget: budgetNow(gzBytes),
      requests: first.requests + depth.reduce((a, d) => a + d.requests, 0) + protocols.length,
    };
    const f = writeCount(body);
    return finish({
      count: f,
      withPrice: found.length,
      asked: Object.keys(first.coins).length,
      protocols: protocols.map((p) => ({
        slug: p.slug,
        status: p.status,
        points: p.points,
        first: p.first,
      })),
    });
  }
  fetchGuard()({ nextBytes: 0, writtenBytes: 0 });
  const out = join(OUT, 'external');
  const at = new Date().toISOString();
  const coin = opt('--coin');
  const protocol = opt('--protocol');
  if (coin) {
    const f = (await firstPrices([coin])).coins[coin]?.first;
    if (!f) throw new Error(`${coin}: no price at DefiLlama`);
    const start = Math.floor(Date.parse(f) / 1000);
    const c = await dailyChart(coin, start, Math.ceil((Date.now() / 1000 - start) / DAY));
    const w = writeSeries(
      out,
      coin,
      c.prices,
      `DefiLlama coins ${coin} /chart period=1d`,
      { from: start, to: Math.floor(Date.now() / 1000) },
      at,
    );
    return finish({ fetched: { coin, first: f, ...w, ms: c.ms } });
  }
  if (protocol) {
    const r = await protocolTvl(protocol);
    const w = writeSeries(
      out,
      `protocol:${protocol}`,
      r.tvl,
      `DefiLlama /protocol/${protocol} tvl`,
      { from: Date.parse(r.first ?? at) / 1000, to: Date.parse(r.last ?? at) / 1000 },
      at,
    );
    return finish({ fetched: { protocol, first: r.first, last: r.last, ...w, ms: r.ms } });
  }
  if (!all) throw new Error('--coin or --protocol, or --all for the whole series');
  // the whole series: every row of both lists that DefiLlama prices, from its first price, and the protocols'
  // TVL. Resumable: a subject whose manifest was written today is not asked again.
  const today = at.slice(0, 10);
  const doneToday = (subject: string) => {
    const f = join(out, subject.replace(/[^A-Za-z0-9_.-]/g, '_'), 'manifest.json');
    return (
      existsSync(f) &&
      (JSON.parse(readFileSync(f, 'utf8')) as { updatedAt: string }).updatedAt.slice(0, 10) ===
        today
    );
  };
  const keys = [
    ...mints.map((m) => coinKey('solana', m)),
    ...rh.map((r) => coinKey('robinhood', r.address)),
  ];
  const todo = keys.filter((k) => !doneToday(k));
  const first = await firstPrices(todo);
  const guard = fetchGuard();
  let written = 0;
  const done: string[] = [];
  const noPrice: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const k of todo) {
    const f = first.coins[k]?.first;
    if (!f) {
      noPrice.push(k);
      continue;
    }
    guard({ nextBytes: 200_000, writtenBytes: written });
    try {
      const start = Math.floor(Date.parse(f) / 1000);
      const c = await dailyChart(k, start, Math.ceil((Date.now() / 1000 - start) / DAY));
      const w = writeSeries(
        out,
        k,
        c.prices,
        `DefiLlama coins ${k} /chart period=1d`,
        { from: start, to: Math.floor(Date.now() / 1000) },
        at,
      );
      written += w.gzBytes;
      done.push(k);
    } catch (e) {
      failed.push({ key: k, error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const protocols: string[] = [];
  for (const slug of ['kamino-lend', 'jupiter-lend', 'maple', 'ondo-finance', 'mellow-lrt']) {
    if (doneToday(`protocol:${slug}`)) continue;
    try {
      const r = await protocolTvl(slug);
      writeSeries(
        out,
        `protocol:${slug}`,
        r.tvl,
        `DefiLlama /protocol/${slug} tvl`,
        { from: Date.parse(r.first ?? at) / 1000, to: Date.parse(r.last ?? at) / 1000 },
        at,
      );
      protocols.push(slug);
    } catch (e) {
      failed.push({ key: `protocol:${slug}`, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return finish({
    fetched: {
      subjects: keys.length,
      skippedDoneToday: keys.length - todo.length,
      written: done.length,
      noPrice: noPrice.length,
      failed,
      protocols,
      gzBytes: written,
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The scope of the trading series (gate ASSET-HISTORY-2) and the gates

/**
 * The trading series' scope: by default the pools of the shelf's tokens (ASSET-SHELF: the list's `listed` and
 * `candidate` rows whose newest DexScreener 24 h volume reading is at least `--floor`, default $100,000) over the
 * last `--days` (30); `--scope list` is the scope of 2026-10-10 (every row of the list, whole life on Robinhood
 * Chain, 90 days and the sampled walk beyond on Solana), `--days` narrowing it. The readings come from
 * `asset_observations` in the local database, or from `--readings <file>` (a JSON array of
 * { chain?, address, value, observedAt }), and the count file names their time.
 */
type TradingCtx = {
  scope: BackfillScope;
  key: string;
  /** Solana: the key of the exact pass's count. */
  exactKey: string | null;
  days: number | null;
  /** The list's whole scope on Solana walks beyond the window, sampled (series 3b); the shelf never does. */
  beyond: boolean;
  shelf: (Shelf & { list: string; readingsFrom: string }) | null;
  /** The tokens whose pools the series takes (EVM addresses in lower case). */
  tokens: Set<string> | null;
};
async function volumeReadings(chain: 'robinhood' | 'solana'): Promise<VolumeReading[]> {
  const file = opt('--readings');
  if (file)
    return (
      JSON.parse(readFileSync(file, 'utf8')) as Array<VolumeReading & { chain?: string }>
    ).filter((r) => !r.chain || r.chain === chain);
  const { db, client } = createDb();
  try {
    const r = (await db.execute(
      sql`select distinct on (address) address, value, observed_at from asset_observations where chain = ${chain} and metric = 'dex_volume_24h_usd' order by address, observed_at desc`,
    )) as unknown as Array<{ address: string; value: number | null; observed_at: Date | string }>;
    return [...r].map((x) => ({
      address: x.address,
      value: x.value === null ? null : Number(x.value),
      observedAt: new Date(x.observed_at).toISOString(),
    }));
  } finally {
    await client.end();
  }
}
async function tradingScope(s: TradingSeries): Promise<TradingCtx> {
  const o = scopeOptions(s, { scope: opt('--scope'), days: opt('--days'), floor: opt('--floor') });
  if (o.kind === 'list') {
    const scope: BackfillScope = { kind: 'list', days: o.days };
    return {
      scope,
      key: scopeKey(s, scope),
      exactKey: s === 'solana-swaps' ? scopeKey(s, scope, true) : null,
      days: o.days,
      beyond: s === 'solana-swaps',
      shelf: null,
      tokens: null,
    };
  }
  const chain = chainOf(s) as 'robinhood' | 'solana';
  const evm = chain === 'robinhood';
  const key = (a: string) => (evm ? a.toLowerCase() : a);
  const listFile = (evm ? opt('--list') : opt('--sol-list')) ?? `scripts/risk/assets/${chain}.json`;
  const rows = (JSON.parse(readFileSync(listFile, 'utf8')) as { assets: ShelfListRow[] }).assets;
  const cut = cutShelf(rows, await volumeReadings(chain), o.floorUsd, key);
  if (!cut.tokens.length)
    throw new Error(
      `the shelf of ${chain} is empty: no listed or candidate row of ${listFile} has a dex_volume_24h_usd reading of at least ${o.floorUsd} (${JSON.stringify(cut.counts)})`,
    );
  const scope: BackfillScope = {
    kind: 'shelf',
    days: o.days,
    floorUsd: o.floorUsd,
    tokensHash: shelfHash(
      cut.tokens.map((t) => t.address),
      key,
    ),
  };
  return {
    scope,
    key: scopeKey(s, scope),
    exactKey: s === 'solana-swaps' ? scopeKey(s, scope, true) : null,
    days: o.days,
    beyond: false,
    shelf: {
      ...cut,
      list: listFile,
      readingsFrom:
        opt('--readings') ?? 'asset_observations (local database), metric dex_volume_24h_usd',
    },
    tokens: new Set(cut.tokens.map((t) => key(t.address))),
  };
}
const trading: TradingCtx | null =
  series === 'robinhood-logs' || series === 'solana-swaps' ? await tradingScope(series) : null;
/**
 * `solana-mints --shelf`: the mints of the shelf's Solana tokens over the shelf's days (AS.8 step 5, gate
 * ASSET-HISTORY-2), walked by mint (DA20's choice of mint over authority: stated, not chosen). The cash tokens and
 * wrapped SOL are not walked: their transfers are most of the chain's, and their supply comes from the daily
 * series (DA15 for USDC and USDT, the same reason for the rest).
 */
const WSOL = 'So11111111111111111111111111111111111111112';
const mintShelf: { key: string; days: number; mints: string[] } | null =
  series === 'solana-mints' && has('--shelf')
    ? await (async () => {
        const ctx = await tradingScope('solana-swaps');
        const list = JSON.parse(
          readFileSync(opt('--sol-list') ?? 'scripts/risk/assets/solana.json', 'utf8'),
        ) as { assets: Array<{ address: string; cls: string | null }> };
        const cash = new Set(list.assets.filter((a) => a.cls === 'cash').map((a) => a.address));
        const mints = [...(ctx.tokens ?? [])].filter((m) => !cash.has(m) && m !== WSOL).sort();
        return { key: `mints-${ctx.key}`, days: ctx.days ?? 30, mints };
      })()
    : null;
/** What the count file of a trading series says of its scope. */
const scopeOf = (ctx: TradingCtx) => ({
  key: ctx.key,
  kind: ctx.scope.kind,
  days: ctx.days,
  ...(ctx.shelf
    ? {
        shelf: {
          rule: 'ASSET-SHELF: listed or candidate rows of the list at or above the floor by the newest dex_volume_24h_usd reading',
          list: ctx.shelf.list,
          floorUsd: ctx.shelf.floorUsd,
          reading: ctx.shelf.reading,
          readingsFrom: ctx.shelf.readingsFrom,
          counts: ctx.shelf.counts,
          tokensHash: (ctx.scope as { tokensHash: string }).tokensHash,
          tokens: ctx.shelf.tokens,
        },
      }
    : {}),
});

/** The scope of the count a whole series of this run needs (see backfill-gate.ts). */
const gateScope = (): string =>
  ({
    'robinhood-logs': trading?.key ?? 'logs',
    'chainlink-rounds': 'feeds',
    // the sampled count first; --all then runs the exact pass and gates again on its count
    'solana-swaps': trading?.key ?? 'pools',
    'solana-mints': mintShelf?.key ?? opt('--via') ?? 'mint',
    'external-daily': 'rows',
  })[series];
if (mode === 'fetch' && all) requireCountThatFits(gateScope(), '--all');
// a window wider than a sample is a series run: the same gate as --all, before anything is read or asked
if (mode === 'fetch' && !all && opt('--window')) {
  const w = opt('--window') as string;
  if (series === 'robinhood-logs') {
    const [a, b] = w.split('-').map(Number);
    if (
      Number.isInteger(a) &&
      Number.isInteger(b) &&
      windowNeedsGate(series, a as number, b as number)
    )
      requireCountThatFits(
        trading?.key ?? 'logs',
        `a window of ${(b as number) - (a as number) + 1} blocks (wider than ${MAX_SAMPLE_WINDOW[series].size})`,
      );
  }
  if (series === 'solana-swaps' || series === 'solana-mints') {
    const [a, b] = w.split('..').map((x) => Math.floor(Date.parse(x) / 1000));
    if (a && b && windowNeedsGate(series, a, b)) {
      const what = `a window of ${((b - a + 1) / 86_400).toFixed(1)} days (wider than ${MAX_SAMPLE_WINDOW[series].size / 86_400})`;
      requireCountThatFits(
        series === 'solana-swaps' ? (trading?.exactKey ?? 'pools-exact') : 'mint',
        what,
      );
      if (series === 'solana-swaps' && trading && trading.days !== null)
        requireWindowInScope(
          a,
          Math.floor(Date.now() / 1000) - trading.days * 86_400,
          what,
          trading.key,
        );
    }
  }
}

const run = {
  'robinhood-logs': robinhoodLogs,
  'chainlink-rounds': chainlinkRounds,
  'solana-swaps': () =>
    mode === 'count'
      ? has('--exact-walk')
        ? solanaExactCount().then((x) =>
            finish({ count: x.file, estimate: x.body.estimate, fits: x.body.budget.fits }),
          )
        : solanaCount('swaps')
      : solanaFetch('swaps'),
  'solana-mints': () => (mode === 'count' ? solanaCount('mints') : solanaFetch('mints')),
  'external-daily': externalDaily,
}[series];
try {
  const r = await run();
  console.log(JSON.stringify(r).slice(0, 4000));
} catch (e) {
  if (e instanceof BudgetStop) {
    // the budget would be crossed by the next piece: everything written so far is recorded and resumable
    log({ event: 'stopped_by_budget', reasons: e.reasons });
    console.log(JSON.stringify(finish({ stopped: e.reasons })));
    process.exit(2);
  }
  const r = finish({ error: e instanceof Error ? e.message : String(e) });
  console.error(JSON.stringify(r));
  process.exit(1);
}
