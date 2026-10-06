import 'dotenv/config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskPoolFlow, riskPools } from '@colosseum/db';
import {
  addSwap,
  defaultRegimeParams,
  FLOW_METHOD_VERSION,
  type FlowBucket,
  type FlowHour,
  type FlowPoolMeta,
  type PoolEvent,
  poolFlow,
  type Regime,
  regimeAt,
  swapsOfRow,
} from '@colosseum/risk';
import { inArray } from 'drizzle-orm';

// PLAN-ANALYTICS item 16, part 1 — `pnpm risk:flow-import`: swap flow of the 34 value pools from the Step 5b history
// on disk (data/risk/history-full/events/<pool>/<day>.jsonl, successful transactions only, and hourly/<pool>.jsonl)
// into risk_pool_flow: per pool, regime ('all' too) and window (the last 24 h, 7 d and 28 d of the history, ending at
// its newest event). No RPC. Reads only days with a `.done` marker. Writes aggregates only: no signature, no wallet.
// Idempotent: a second run on the same history inserts nothing (keyed by pool, regime, window and data_to).
const HISTORY = join(process.env.RISK_DATA_DIR ?? 'data/risk', 'history-full');
const EVENTS = join(HISTORY, 'events');
const SOURCE =
  'Step 5b history (history-full-0.1: decoded swap events of successful transactions) priced by its hourly reconstruction (history-replay-0.1)';
const METHOD =
  "successful swap events of the pool; USD = quote-leg amount × the hour's quoteUsd (USDC at par, other quotes implied from the asset's USDC pool)";
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const regimeOfT = (t: number): Regime => regimeAt(new Date(t * 1000), P);

const addresses = readdirSync(EVENTS);
const { db, client } = createDb();
const meta = await db.select().from(riskPools).where(inArray(riskPools.address, addresses));
const missingMeta = addresses.filter((a) => !meta.some((m) => m.address === a));
if (missingMeta.length) throw new Error(`pools not in risk_pools: ${missingMeta.join(', ')}`);

const doneDays = (pool: string) =>
  readdirSync(join(EVENTS, pool))
    .filter(
      (f) => f.endsWith('.jsonl') && existsSync(join(EVENTS, pool, f.replace('.jsonl', '.done'))),
    )
    .sort();
/** Every line of a day file, without holding an array of them. */
function* lines(file: string): Generator<string> {
  const text = readFileSync(file, 'utf8');
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf('\n', i);
    const end = j < 0 ? text.length : j;
    if (end > i) yield text.slice(i, end);
    i = end + 1;
  }
}
type Row = { t: number; ev: PoolEvent[] | null };

// the history's newest event: the window end of every pool
let newest = 0;
for (const a of addresses) {
  const last = doneDays(a).at(-1);
  if (!last) continue;
  for (const l of lines(join(EVENTS, a, last))) {
    const t = (JSON.parse(l) as Row).t;
    if (t > newest) newest = t;
  }
}
const to = new Date(newest * 1000).toISOString();
const fetchedAt = new Date();

const summary: Array<Record<string, unknown>> = [];
let written = 0;
let skippedDays = 0;
for (const m of meta) {
  const pm: FlowPoolMeta = {
    pool: m.address,
    assetIsToken0: m.assetIsToken0 === 1,
    decimals0: m.decimals0,
    decimals1: m.decimals1,
  };
  const hourly = new Map<string, FlowHour>();
  const hf = join(HISTORY, 'hourly', `${m.address}.jsonl`);
  let provenance: 'live' | 'prior_dataset' = 'live';
  if (existsSync(hf))
    for (const l of lines(hf)) {
      const h = JSON.parse(l);
      if (h.provenance && h.provenance !== 'live') provenance = 'prior_dataset';
      hourly.set(h.hour, {
        hour: h.hour,
        regime: h.regime,
        quoteUsd: typeof h.quoteUsd === 'number' ? h.quoteUsd : null,
        depth2pctSellUsd: typeof h.depth2pctSellUsd === 'number' ? h.depth2pctSellUsd : null,
      });
    }
  const buckets = new Map<string, FlowBucket>();
  const days = doneDays(m.address);
  skippedDays +=
    readdirSync(join(EVENTS, m.address)).filter((f) => f.endsWith('.jsonl')).length - days.length;
  let rows = 0;
  for (const d of days)
    for (const l of lines(join(EVENTS, m.address, d))) {
      if (!l.includes('"kind":"swap"')) continue;
      rows++;
      for (const s of swapsOfRow(JSON.parse(l) as Row, pm)) addSwap(buckets, s, hourly, regimeOfT);
    }
  const aggs = poolFlow(buckets.values(), hourly.values(), to);
  const ins = await db
    .insert(riskPoolFlow)
    .values(
      aggs.map((g) => ({
        pool: m.address,
        assetMint: m.assetMint,
        assetSymbol: m.assetSymbol,
        regime: g.regime,
        window: g.window,
        swaps: g.swaps,
        sellSwaps: g.sellSwaps,
        buySwaps: g.buySwaps,
        unpricedSwaps: g.unpricedSwaps,
        sellUsd: g.sellUsd,
        buyUsd: g.buyUsd,
        hours: g.hours,
        medianDepthSellUsd: g.medianDepthSellUsd,
        dataFrom: new Date(g.from),
        dataTo: new Date(g.to),
        methodVersion: FLOW_METHOD_VERSION,
        venue: m.venue,
        quoteSymbol: m.quoteSymbol,
        quoteMint: m.quoteMint,
        source: SOURCE,
        method: METHOD,
        fetchedAt,
        provenance,
      })),
    )
    .onConflictDoNothing()
    .returning({ p: riskPoolFlow.pool });
  written += ins.length;
  const all = aggs.find((g) => g.regime === 'all' && g.window === '28d');
  summary.push({
    asset: m.assetSymbol,
    pool: m.address.slice(0, 6),
    quote: m.quoteSymbol ?? m.quoteMint.slice(0, 6),
    days: days.length,
    txRows: rows,
    swaps28d: all?.swaps,
    unpriced: all?.unpricedSwaps,
    volume28dUsd: Math.round((all?.sellUsd ?? 0) + (all?.buyUsd ?? 0)),
    hours: all?.hours,
  });
}
await client.end();
console.table(summary.sort((a, b) => (b.volume28dUsd as number) - (a.volume28dUsd as number)));
console.log(
  JSON.stringify({ dataTo: to, pools: meta.length, rows: meta.length * 15, written, skippedDays }),
);
