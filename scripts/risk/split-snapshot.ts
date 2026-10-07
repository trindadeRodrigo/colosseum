import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { multipleAccounts, RISK_HOME, SPLIT_DIR } from './lib-lending';
import { rpcStats } from './lib-pools';
import {
  buildSplit,
  loadCapture,
  nearestCollectorRows,
  notRoutedSummary,
  oneHopRows,
  oneHopView,
  readSplitCapture,
  SOL,
  type SplitCapture,
  selectSplitPools,
  type TwoHopRowOut,
  twoHopAssets,
  twoHopRowsOf,
} from './lib-split';
import solanaList from './universe/solana.json';

// PLAN-ANALYTICS item 4, DA7 (a) — `pnpm risk:split-snapshot`: our own read-only snapshot of every asset's dollar and
// SOL exit pools, routed with routeTrade so each row stores what the collector's rows lack: the amount sent to each
// pool and the cost split (pool fee, transfer fee, basis, impact). Reads the collector's registry and cached child
// accounts (no getProgramAccounts, DA3); one getMultipleAccounts batch of 100 at a time; the SOL price from Jupiter's
// public price API, as the collector does. Writes SPLIT_DIR/<day>.jsonl (data/risk/split unless RISK_DATA_DIR is
// set), rows `split-0.1`. Sends no transaction.
// Each asset is compared with the collector's routed row nearest in time (`vsCollector`), which measures the drift
// between the two snapshots, not an error of either.
//
// The selection, the read, the pools and the rows are functions of scripts/risk/lib-split.ts; this file holds the
// reader, the clock and the files. The summary's `accounts` is the number of distinct accounts read: the same number
// as before RU.11 unless one address is both a pool and a child account. The `split-0.1` rows of a run are appended
// in one write once every asset is routed, so a failure while routing leaves no row for that run (before RU.11, the
// assets already routed were kept).
//
// RISK_SPLIT_TWO_HOP=1 (PLAN-UNIVERSE RU.11; off unless set to exactly 1): the run also reads the pools that pair a
// tracked stock (scripts/risk/universe/solana.json) with another stock token, in the same batches. The `split-0.1`
// rows are routed over the dollar and SOL pools only, as with the setting off, and are written first. Then each asset
// with such a pool is routed again with two hops offered (stock → other stock → dollars), and those rows (`split-0.2`,
// each beside the one-hop answer of the same snapshot) go to SPLIT_DIR/two-hop/<day>.jsonl. That is a folder so that
// no reader of the split rows sees them: the cost breakdown (scripts/risk/facts/cost-breakdown.ts), the fixture
// freezer and the API route read only the *.jsonl files directly inside SPLIT_DIR. The summary gains one key,
// `twoHop`, and its `accounts` and `failures` then count the stock-to-stock pools as well. If the two-hop rows fail,
// the `split-0.1` rows are already written, the error is in the summary and the exit code is 1.
// A hand run with the setting on should name RISK_DATA_DIR: in a checkout whose data/risk/split is still a real
// folder its two-hop rows leave a two-hop/ folder there, and scripts/risk/jobs/install.sh will then refuse to replace
// data/risk/split with its link.
//
// RISK_SPLIT_REPLAY=<file>: no RPC and no fetch. The inputs are a file frozen by `pnpm risk:split-capture`; the day in
// the file names is the capture's, and the summary's `seconds` is the time the capture's read took. Two hops are
// routed only when the setting is on and the capture was taken with them (the setting on a capture without them is an
// error); with the setting off, a capture taken with two hops is replayed as a one-hop run. A capture cut to some
// stocks (`--only`) gives two-hop rows for those stocks only, and the summary's `twoHop.only` names them. The
// collector's file under RISK_HOME is still read for `vsCollector` when it exists.
// A replay writes rows like a live run: the same lines, to the same file names. So it must be told where: with
// RISK_DATA_DIR not set it stops before writing anything, and it never appends to a day file that already exists
// (the job's, or an earlier replay's), whatever names the folder. The default folder is the one the hourly job, the
// cost breakdown and GET /risk/assets/:id/split share (the job's install makes data/risk/split a link to it), and
// rows replayed there would be read as the job's, twice if replayed twice.
const twoHop = process.env.RISK_SPLIT_TWO_HOP === '1';
const replay = process.env.RISK_SPLIT_REPLAY;
if (replay && !process.env.RISK_DATA_DIR)
  throw new Error(
    "a replay writes rows: name a folder with RISK_DATA_DIR, and not the hourly job's",
  );

let t0 = 0;
let capture: SplitCapture;
if (replay) {
  const frozen = loadCapture(replay);
  if (twoHop && !frozen.twoHop)
    throw new Error(
      `RISK_SPLIT_TWO_HOP=1, but ${replay} was captured without two hops: capture it with --two-hop or unset the setting`,
    );
  capture = twoHop ? frozen : oneHopView(frozen);
} else {
  const reg = JSON.parse(readFileSync(join(RISK_HOME, 'registry.json'), 'utf8')) as {
    fetchedAt?: string;
    methodVersion?: string;
    pools: Parameters<typeof selectSplitPools>[0];
  };
  const cache = JSON.parse(readFileSync(join(RISK_HOME, 'cache.json'), 'utf8')) as {
    children: Record<string, string[]>;
  };
  const tracked = twoHop ? solanaList.assets.map((a) => a.address) : [];
  t0 = Date.now();
  capture = await readSplitCapture(
    selectSplitPools(reg.pools, { twoHop, tracked: new Set(tracked) }),
    cache.children,
    {
      twoHop,
      tracked,
      trackedSource: twoHop ? 'scripts/risk/universe/solana.json' : null,
      registry: { fetchedAt: reg.fetchedAt ?? null, methodVersion: reg.methodVersion ?? null },
    },
    {
      read: multipleAccounts,
      solUsd: () =>
        fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, {
          signal: AbortSignal.timeout(20_000),
        })
          .then((r) => r.json() as Promise<Record<string, { usdPrice?: number }>>)
          .then((r) => r[SOL]?.usdPrice ?? null)
          .catch(() => null),
      now: () => new Date(),
      rpcCalls: () => rpcStats.calls,
    },
  );
}
const built = buildSplit(capture);

// the collector's routed row nearest in time, per asset, for the drift comparison
const day = capture.fetchedAt.slice(0, 10);
const collectorFile = join(RISK_HOME, 'assets', `${day}.jsonl`);
const collector = existsSync(collectorFile)
  ? nearestCollectorRows(readFileSync(collectorFile, 'utf8'), capture.fetchedAt)
  : undefined;

const jsonl = (rs: readonly object[]) => rs.map((r) => `${JSON.stringify(r)}\n`).join('');
mkdirSync(SPLIT_DIR, { recursive: true });
const file = join(SPLIT_DIR, `${day}.jsonl`);
const twoHopDayFile = join(SPLIT_DIR, 'two-hop', `${day}.jsonl`);
if (replay)
  for (const f of capture.twoHop ? [file, twoHopDayFile] : [file])
    if (existsSync(f))
      throw new Error(
        `a replay never appends: ${f} exists. Name an empty folder with RISK_DATA_DIR, and not the hourly job's`,
      );
const { rows, drift } = oneHopRows(built, capture, { collector });
if (rows.length) appendFileSync(file, jsonl(rows));
drift.sort((a, b) => a - b);

// the two-hop rows, after the rows every reader depends on are on disk
let twoHopSummary: Record<string, unknown> | null = null;
if (capture.twoHop) {
  const twoHopFile = twoHopDayFile;
  let twoHopRows: TwoHopRowOut[] = [];
  let error: string | null = null;
  const r0 = Date.now();
  try {
    twoHopRows = twoHopRowsOf(built, capture, rows);
    if (twoHopRows.length) {
      mkdirSync(join(SPLIT_DIR, 'two-hop'), { recursive: true });
      appendFileSync(twoHopFile, jsonl(twoHopRows));
    }
  } catch (e) {
    twoHopRows = [];
    error = String(e).slice(0, 200);
    process.exitCode = 1;
  }
  twoHopSummary = {
    file: twoHopFile,
    poolsRead: capture.twoHopPools.length,
    // the stocks a capture was cut to, or null for a whole run: the only ones that get two-hop rows
    only: capture.only ?? null,
    assetsWithTwoHop: twoHopAssets(built, capture).length,
    rows: twoHopRows.length,
    usedRows: twoHopRows.filter((r) => r.twoHopUsed > 0).length,
    notRouted: notRoutedSummary(built),
    listed: capture.listed,
    // the whole read as the capture counted and timed it, and the accounts the stock-to-stock pools added to it
    rpcCalls: capture.rpc.calls,
    seconds: capture.rpc.seconds,
    accountsAdded:
      Object.keys(capture.accounts).length - Object.keys(oneHopView(capture).accounts).length,
    // this process routing the two-hop rows and writing them
    routeSeconds: (Date.now() - r0) / 1000,
    ...(error ? { error } : {}),
  };
}

console.log(
  JSON.stringify({
    file,
    fetchedAt: capture.fetchedAt,
    seconds: replay ? Math.round(capture.rpc.seconds) : Math.round((Date.now() - t0) / 1000),
    accounts: Object.keys(capture.accounts).length,
    pools: [...built.byAsset.values()].reduce((s, a) => s + a.pools.length, 0),
    assets: built.byAsset.size,
    rows: rows.length,
    solUsd: capture.solUsd,
    failures: built.failures.length,
    failureSample: built.failures.slice(0, 3),
    vsCollectorSellUpTo250k: drift.length
      ? {
          n: drift.length,
          medianAbsPp: drift[Math.floor(drift.length / 2)],
          p90AbsPp: drift[Math.floor(drift.length * 0.9)],
        }
      : null,
    ...(twoHopSummary ? { twoHop: twoHopSummary } : {}),
  }),
);
