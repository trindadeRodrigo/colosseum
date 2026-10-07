import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { StoredQuote } from '../lib-routing-gap';
import solanaList from '../universe/solana.json';
import {
  type CutFilePool,
  cutPoolRows,
  type DiscoveryFilePool,
  type DiscoveryRow,
  type FlowRow,
  quoteLegs,
} from './lib';

// PLAN-UNIVERSE RU.13 — `pnpm risk:venues-freeze-fixtures`: real rows frozen under fixtures/risk/venues, so the tests
// recompute the table without the network, the collector's home or the database. It reads files and one table of the
// local database (a SELECT) and writes only under fixtures/risk/venues:
// - quotes-<from>-<to>.jsonl.gz: every stored Jupiter quote row of a window, line for line (default: the window of
//   RU.11's gap measurement);
// - quotes-cases.jsonl: the first stored row of each shape of route the shares have to get right;
// - registry-excluded-<stamp>.json: the collector's registry, the pools it excluded for their program;
// - discovery-dexscreener-<stamp>.json.gz: DexScreener's rows for the tracked stocks, each pair cut to the fields read;
// - robinhood-<stamp>.json.gz: the 28-day flow row of every Robinhood pool, and the cut's pools with what discovery
//   read of each.
const OUT = join('fixtures', 'risk', 'venues');
const RISK_HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const DATA = process.env.RISK_DATA_DIR ?? join('data', 'risk');
const EVM = process.env.RISK_EVM_DIR ?? join('data', 'risk-evm');
const args = process.argv.slice(2);
const flag = (name: string, otherwise: string) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? (args[at + 1] as string) : otherwise;
};
const from = flag('--from', '2026-10-06T21:15:00.000Z');
const to = flag('--to', '2026-10-07T01:10:00.000Z');
const stamp = (iso: string) => iso.slice(0, 16).replace(/[-:]/g, '');
const newest = (dir: string, prefix: string, ext: string) => {
  const n = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
        .sort()
        .at(-1)
    : undefined;
  if (!n) throw new Error(`no ${prefix}*${ext} under ${dir}`);
  return join(dir, n);
};
mkdirSync(OUT, { recursive: true });
const written: Record<string, number> = {};
const write = (name: string, body: string | Buffer) => {
  writeFileSync(join(OUT, name), body);
  written[name] = body.length;
};

// --- quotes: the window line for line, and one row of each shape ------------------------------------------------------
const quoteDir = join(RISK_HOME, 'quotes');
const lines = readdirSync(quoteDir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()
  .flatMap((f) =>
    readFileSync(join(quoteDir, f), 'utf8')
      .split('\n')
      .filter((l) => l.trim()),
  );
const parsed = lines.map((line) => ({ line, q: JSON.parse(line) as StoredQuote }));
const inWindow = parsed.filter(({ q }) => q.fetchedAt >= from && q.fetchedAt <= to);
write(
  `quotes-${stamp(from)}-${stamp(to)}.jsonl.gz`,
  gzipSync(`${inWindow.map((p) => p.line).join('\n')}\n`),
);

const shape = (q: StoredQuote) => {
  const legs = quoteLegs(q);
  if (!legs.resolved) return legs.reason;
  return legs.legs
    .map((l) => ({ direct: 'D', stock_hop: 'S', dollar_hop: '$', middle_hop: 'M' })[l.role])
    .join('');
};
const cases: Array<[string, (q: StoredQuote) => boolean]> = [
  ['a row Jupiter answered with an error', (q) => !q.route && !!q.error],
  ['a row with no reference price', (q) => q.error === 'no_ref_price'],
  ['one pool, a sale', (q) => q.side === 'sell' && shape(q) === 'D'],
  ['three pools, a purchase', (q) => q.side === 'buy' && shape(q) === 'DDD'],
  ['two hops, a sale', (q) => q.side === 'sell' && shape(q) === 'S$'],
  ['two hops, a purchase', (q) => q.side === 'buy' && shape(q) === '$S'],
  ['a direct leg and two hops', (q) => shape(q) === 'DS$'],
  ['three hops', (q) => shape(q) === 'SM$'],
  ['two stock legs into one dollar leg', (q) => shape(q) === 'SS$'],
  ['one stock leg into two dollar legs', (q) => shape(q) === 'S$$'],
  [
    'the dollar end not told apart',
    (q) => {
      const legs = quoteLegs(q);
      return (
        legs.resolved &&
        legs.legs.every((l) => l.dollarPct === null) &&
        legs.legs.some((l) => l.stockPct === null)
      );
    },
  ],
  ['a leg on Meteora DAMM v2', (q) => !!q.route?.some((h) => h.label === 'Meteora DAMM v2')],
  [
    'the whole stock amount through one market maker',
    (q) => q.route?.length === 1 && q.route[0]?.label === 'GoonFi V2',
  ],
];
const picked: string[] = [];
const missing: string[] = [];
for (const [name, is] of cases) {
  const hit = parsed.find(({ line, q }) => !picked.includes(line) && is(q));
  if (hit) picked.push(hit.line);
  else missing.push(name);
}
write('quotes-cases.jsonl', `${picked.join('\n')}\n`);

// --- the registry's excluded pools ------------------------------------------------------------------------------------
const reg = JSON.parse(readFileSync(join(RISK_HOME, 'registry.json'), 'utf8')) as {
  methodVersion: string;
  fetchedAt: string;
  minPoolTvlUsd?: number;
  excluded: Array<{ address: string; venue: string; reason: string }>;
};
write(
  `registry-excluded-${stamp(reg.fetchedAt)}.json`,
  `${JSON.stringify(
    {
      source:
        'RISK_HOME/registry.json (pnpm risk:registry: every candidate pool opened on chain; a pool of a program with no decoder is excluded with that program)',
      fetchedAt: reg.fetchedAt,
      method: reg.methodVersion,
      provenance: 'fixture',
      minPoolTvlUsd: reg.minPoolTvlUsd ?? null,
      excluded: reg.excluded,
    },
    null,
    2,
  )}\n`,
);

// --- DexScreener's rows for the tracked stocks ------------------------------------------------------------------------
const discoveryFile = newest(DATA, 'pools-dexscreener-', '.jsonl');
const tracked = new Set(solanaList.assets.map((a) => a.address));
const allRows = readFileSync(discoveryFile, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as DiscoveryRow);
const kept = allRows
  .filter((r) => tracked.has(r.assetMint))
  .map((r) => ({
    assetMint: r.assetMint,
    symbol: r.symbol,
    source: r.source,
    fetchedAt: r.fetchedAt,
    status: r.status,
    // a figure DexScreener did not give stays absent: it is not a zero
    pairs: (r.pairs ?? []).map((p) => ({
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      ...(p.labels ? { labels: p.labels } : {}),
      ...(p.liquidity ? { liquidity: { usd: p.liquidity.usd } } : {}),
      ...(p.volume ? { volume: { h24: p.volume.h24 } } : {}),
    })),
  }));
const discoveryStamp = discoveryFile.match(/(\d{8}T\d{4})/)?.[1] ?? 'unknown';
write(
  `discovery-dexscreener-${discoveryStamp}.json.gz`,
  gzipSync(
    JSON.stringify({
      source: `${discoveryFile.split('/').at(-1)} (pnpm risk:discover), the rows of the ${kept.length} tracked stocks, each pair cut to its address, DexScreener's name for the venue, its liquidity and its 24-hour volume`,
      provenance: 'fixture',
      tokensInTheFile: allRows.length,
      // every venue name the whole file carries, with its pairs: what DexScreener listed at all
      dexIdsInTheFile: allRows
        .flatMap((r) => r.pairs ?? [])
        .reduce<Record<string, number>>((m, p) => {
          m[p.dexId] = (m[p.dexId] ?? 0) + 1;
          return m;
        }, {}),
      rows: kept,
    }),
  ),
);

// --- Robinhood Chain: the cut's pools and their 28 days ---------------------------------------------------------------
const cutFile = newest(EVM, 'cut-robinhood-', '.json');
const cut = JSON.parse(readFileSync(cutFile, 'utf8')) as {
  source: string;
  method: string;
  fetchedAt: string;
  inputGaps: { dexscreenerAtCap: string[]; dexscreenerFailed: string[] };
  pools: CutFilePool[];
};
const disc = JSON.parse(
  readFileSync(cutFile.replace('cut-robinhood-', 'discovery-robinhood-'), 'utf8'),
) as { pools: DiscoveryFilePool[] };
const { createDb } = await import('@colosseum/db');
const { client } = createDb();
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
const flow: FlowRow[] = rows.map((r) => ({
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
write(
  `robinhood-${stamp(cut.fetchedAt)}.json.gz`,
  gzipSync(
    JSON.stringify({
      provenance: 'fixture',
      flow: {
        source: `risk_pool_flow of the local database, window 28d, every regime together: ${first?.source ?? ''} (${first?.method_version ?? ''}, imported ${first ? new Date(first.fetched_at).toISOString().slice(0, 16) : ''}Z)`,
        rows: flow,
      },
      cut: {
        source: `${cutFile.split('/').at(-1)} and its discovery file: ${cut.source}`,
        method: cut.method,
        fetchedAt: cut.fetchedAt,
        dexscreenerAtCap: cut.inputGaps.dexscreenerAtCap,
        pools: cutPoolRows(cut.pools, disc.pools),
      },
    }),
  ),
);

console.log(
  JSON.stringify(
    {
      out: OUT,
      quotes: { from, to, rows: inWindow.length, cases: picked.length, casesNotFound: missing },
      excluded: reg.excluded.length,
      discovery: { file: discoveryFile, rows: kept.length },
      robinhood: { cut: cutFile, pools: cut.pools.length, flowRows: flow.length },
      bytes: written,
    },
    null,
    1,
  ),
);
