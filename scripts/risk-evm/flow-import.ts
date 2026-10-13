// `pnpm risk-evm:flow-import [--chain robinhood]` (PLAN-UNIVERSE RU.14): the swaps a walk wrote
// (history-run.ts) into risk_pool_flow, one row per pool, regime ('all' too) and window, under
// `flow-0.1`, so an EVM stock's fact sheet answers its `flow` block. Reads the walk's folder and the
// newest universe file of the chain (the stocks' decimals); writes the hourly file beside the swaps for
// the record, then inserts. No RPC. Idempotent: the key is (pool, regime, window, data_to).
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb } from '@colosseum/db';
import { defaultRegimeParams, type Regime, regimeAt } from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { CHAINS } from './config';
import type { CutRow } from './cut';
import { insertFlowRows } from './flow-insert';
import {
  type HistoryPool,
  historyPools,
  type PoolDecimals,
  poolDecimals,
  type SwapRow,
} from './history';
import { buildFlowRows } from './history-flow';
import type { Cursor } from './history-run';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const LIST_DIR = process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe';
const chainId = option('--chain') ?? 'robinhood';
const chain = CHAINS.find((c) => c.id === chainId);
if (!chain) {
  console.error(`"${chainId}" is not in config.ts`);
  process.exit(1);
}
const root = join(dir, 'history', chain.id);
const cursorFile = join(root, 'cursor.json');
if (!existsSync(cursorFile)) {
  console.error(`${cursorFile} is absent: run pnpm risk-evm:history first`);
  process.exit(1);
}
const cursor = JSON.parse(readFileSync(cursorFile, 'utf8')) as Cursor;

const list = JSON.parse(readFileSync(join(LIST_DIR, `${chain.id}.json`), 'utf8')) as AssetList;
const cut = JSON.parse(readFileSync(join(dir, list.inputs.cut ?? ''), 'utf8')) as {
  chain: string;
  pools: CutRow[];
};
const pools: HistoryPool[] = historyPools(cut, chain);

// the stocks' decimals: the newest universe file of the chain (the issuer registry, confirmed on chain)
const universeFile = readdirSync(dir)
  .filter((f) => f.startsWith(`universe-${chain.id}-`) && f.endsWith('.json'))
  .sort()
  .at(-1);
if (!universeFile) {
  console.error(`no universe-${chain.id}-*.json in ${dir}: run pnpm risk-evm:universe first`);
  process.exit(1);
}
const universe = JSON.parse(readFileSync(join(dir, universeFile), 'utf8')) as {
  tokens: Array<{ address: string; decimals: number }>;
};
const decimalsByAddress = new Map(
  universe.tokens.map((t) => [t.address.toLowerCase(), t.decimals]),
);
const decimals = new Map<string, PoolDecimals>();
for (const p of pools) {
  const d = poolDecimals(p, chain, (a) => decimalsByAddress.get(a));
  if (d) decimals.set(p.address, d);
}

// each pool's swaps are read from its day files when the builder asks, twice, one pool at a time
const swapsDir = join(root, 'swaps');
let files = 0;
const dayFiles = (pool: string) => {
  const d = join(swapsDir, pool);
  return existsSync(d)
    ? readdirSync(d)
        .filter((x) => x.endsWith('.jsonl'))
        .sort()
        .map((f) => join(d, f))
    : [];
};
for (const p of pools) files += dayFiles(p.address).length;
function* swapsOf(pool: string): Generator<SwapRow> {
  for (const f of dayFiles(pool)) {
    const text = readFileSync(f, 'utf8');
    let i = 0;
    while (i < text.length) {
      const j = text.indexOf('\n', i);
      const end = j < 0 ? text.length : j;
      if (end > i) yield JSON.parse(text.slice(i, end)) as SwapRow;
      i = end + 1;
    }
  }
}

const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const regimeOfT = (t: number): Regime => regimeAt(new Date(t * 1000), P);
// a walk still in progress is imported from the oldest block it has: its hourly rows start there, so `hours` says so
const span = { fromT: cursor.complete ? cursor.fromT : cursor.oldestDoneT, headT: cursor.headT };
const built = buildFlowRows({
  chain,
  pools,
  decimals,
  swapsOf,
  span,
  regimeAt: regimeOfT,
  fetchedAt: new Date(),
});

mkdirSync(join(root, 'hourly'), { recursive: true });
for (const p of pools) {
  const mine = built.hourly.filter((h) => h.pool === p.address);
  writeFileSync(
    join(root, 'hourly', `${p.address}.jsonl`),
    `${mine.map((h) => JSON.stringify(h)).join('\n')}\n`,
  );
}

const { db, client } = createDb();
const ins = await insertFlowRows(db, built.rows);
await client.end();

console.table(
  built.perPool
    .filter((r) => r.swaps > 0)
    .sort((a, b) => b.volume28dUsd - a.volume28dUsd)
    .slice(0, 40),
);
const unpriced = built.perPool.filter((r) => r.unpriced > 0);
console.log(
  JSON.stringify({
    chain: chain.id,
    cursor: {
      head: cursor.head,
      from: cursor.from,
      complete: cursor.complete,
      maxTimeErrorS: cursor.maxTimeErrorS,
    },
    span: {
      from: new Date(span.fromT * 1000).toISOString(),
      to: new Date(span.headT * 1000).toISOString(),
    },
    dataTo: built.dataTo,
    pools: pools.length,
    poolsWithSwaps: built.perPool.filter((r) => r.swaps > 0).length,
    withoutSide: built.perPool.reduce((a, r) => a + r.withoutSide, 0),
    poolsWithoutDecimals: pools.length - decimals.size,
    swapFiles: files,
    swaps: built.perPool.reduce((a, r) => a + r.swaps, 0),
    duplicatesDropped: built.perPool.reduce((a, r) => a + r.duplicates, 0),
    unpricedSwaps: unpriced.reduce((a, r) => a + r.unpriced, 0),
    unpricedByReason: unpriced.reduce<Record<string, number>>((a, r) => {
      const k = r.unpricedReason ?? 'unknown';
      a[k] = (a[k] ?? 0) + r.unpriced;
      return a;
    }, {}),
    rows: built.rows.length,
    inserted: ins.inserted,
    alreadyThere: built.rows.length - ins.inserted,
  }),
);
