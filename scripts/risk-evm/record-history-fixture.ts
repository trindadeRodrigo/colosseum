// Re-records fixtures/risk-evm/robinhood-history.json.gz: one short walk (a quarter of a day, three
// windows) of seven pools of the cut, every answer the endpoint gave keyed by request, plus the two
// halves of the newest window so a test can make the walk halve. Read-only on the chain. Run it from a
// checkout that has the cut file the asset list names in RISK_EVM_DIR.
//
//   pnpm exec tsx scripts/risk-evm/record-history-fixture.ts
import 'dotenv/config';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AssetList } from '@colosseum/schemas';
import { CHAINS, type ChainConfig, rpcFor } from './config';
import type { CutRow } from './cut';
import { blockWindows } from './discovery';
import {
  DEFAULT_HEADER_STEP,
  DEFAULT_WINDOW,
  dollarPoolOf,
  type HistoryPool,
  historyPools,
  logQuery,
  swapFilters,
} from './history';
import { runHistory } from './history-run';
import { requestKey, rpcOver } from './replay';
import { createRpc, type Rpc, type RpcReply, type RpcRequest } from './rpc';

const chain = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const list = JSON.parse(readFileSync('scripts/risk/universe/robinhood.json', 'utf8')) as AssetList;
const cutName = list.inputs.cut as string;
const cut = JSON.parse(readFileSync(join(dir, cutName), 'utf8')) as {
  chain: string;
  pools: CutRow[];
};
const all = historyPools(cut, chain);
const dollar = chain.dollar.address.toLowerCase();
const deepest = (pick: (p: HistoryPool) => boolean) =>
  all.filter(pick).sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1))[0];
const dollarPools = dollarPoolOf(all, dollar);

/**
 * Seven pools: NVDA against the dollar (v3), the wrapped native (v3), the native (v4) and a token the
 * registry does not know (unknown decimals); META against the dollar (v4); one pool of two stocks and
 * the dollar pool of its other stock, which prices it.
 */
const nvda = (p: HistoryPool) => p.symbol === 'NVDA';
const twoStocks = all.find((p) => p.otherIsStock && dollarPools.has(p.other));
const chosen = [
  deepest((p) => nvda(p) && p.kind === 'cl' && p.other === dollar),
  deepest((p) => nvda(p) && p.kind === 'cl' && p.otherSymbol === 'wrapped native'),
  deepest((p) => nvda(p) && p.kind === 'v4' && p.otherSymbol === 'native'),
  deepest((p) => nvda(p) && p.otherSymbol === null),
  deepest((p) => p.symbol === 'META' && p.kind === 'v4' && p.other === dollar),
  twoStocks,
  twoStocks ? dollarPools.get(twoStocks.other) : undefined,
].filter((p): p is HistoryPool => p !== undefined);
const seen = new Set<string>();
const pools = chosen.filter((p) => !seen.has(p.address) && seen.add(p.address));

const answers: Record<string, RpcReply> = {};
const real = createRpc(rpcFor(chain).url, { timeoutMs: 120_000 });
const record = async (requests: RpcRequest[]) => {
  const replies = await real.batch(requests);
  for (const [i, r] of requests.entries()) answers[requestKey(r)] = replies[i] as RpcReply;
  return replies;
};
const rpc: Rpc = rpcOver(record, real.stats);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(join(tmpdir(), 'risk-evm-history-record-'));
const opts = { days: 0.25, window: DEFAULT_WINDOW, headerStep: DEFAULT_HEADER_STEP, probeEvery: 5 };
const recordedAt = new Date();
const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
const summary = await runHistory(
  { rpc, sleep, log, now: () => recordedAt },
  chain,
  pools,
  root,
  opts,
);

// the halves of the newest window, for the test that makes the walk halve a refused window
const cursor = JSON.parse(readFileSync(join(root, 'cursor.json'), 'utf8')) as {
  head: number;
  from: number;
};
const newest = blockWindows(cursor.from, cursor.head, opts.window).at(-1) as [number, number];
const mid = newest[0] + Math.floor((newest[1] - newest[0]) / 2);
const halves: RpcRequest[] = swapFilters(chain, pools).flatMap((f) => [
  logQuery(f, newest[0], mid),
  logQuery(f, mid + 1, newest[1]),
]);
await sleep(1_000);
await record(halves);

const out = {
  recordedAt: recordedAt.toISOString(),
  chain: chain.id,
  cut: cutName,
  pools,
  opts,
  summary,
  newestWindow: { from: newest[0], to: newest[1], mid },
  answers,
};
const file = 'fixtures/risk-evm/robinhood-history.json.gz';
writeFileSync(file, gzipSync(JSON.stringify(out)));
console.log(
  JSON.stringify({
    file,
    pools: pools.map((p) => `${p.symbol}/${p.otherSymbol ?? p.other.slice(0, 8)} ${p.kind}`),
    answers: Object.keys(answers).length,
    bytes: gzipSync(JSON.stringify(out)).length,
    root,
  }),
);
