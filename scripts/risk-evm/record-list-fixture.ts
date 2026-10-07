import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AssetList } from '@colosseum/schemas';
import { CHAINS } from './config';
import { type CutForCollector, listRun } from './listed';
import type { PoolCache } from './pools';
import { requestKey, rpcOver } from './replay';
import { createRpc, type RpcReply, type RpcRequest } from './rpc';
import { collectOnce } from './run';

// Records the fixture behind tests/risk-evm-list.test.ts: two real runs of the collector for two tracked
// stocks of Robinhood Chain at one block, with every answer of the endpoint kept as it came. The first
// is a list run (every reachable pool of the cut), the second the same tokens with their three deepest
// pools, as the hand list is collected. Read-only. It needs the asset list and its cut on this machine.
// The tests replay it; none calls the network.
//   pnpm exec tsx scripts/risk-evm/record-list-fixture.ts

const OUT = 'fixtures/risk-evm/robinhood-list-run.json.gz';
/** One stock collected before the list (the comparison needs it) and one the list adds. */
const SYMBOLS = ['NVDA', 'GME'];
const LIST = 'scripts/risk/universe/robinhood.json';
const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';

const robinhood = CHAINS.find((c) => c.id === 'robinhood');
if (!robinhood) throw new Error('no robinhood chain in config.ts');
const list = AssetList.parse(JSON.parse(readFileSync(LIST, 'utf8')));
const cutName = list.inputs.cut ?? '';
const fullCut = JSON.parse(readFileSync(join(dir, cutName), 'utf8')) as CutForCollector;

// the list and the cut, cut to the two stocks and to the fields a list run reads
const assets = list.assets.filter((a) => SYMBOLS.includes(a.symbol));
const addresses = new Set(assets.map((a) => a.address));
const cut: CutForCollector = {
  chain: fullCut.chain,
  fetchedAt: fullCut.fetchedAt,
  tracked: fullCut.tracked
    .filter((t) => addresses.has(t.address.toLowerCase()))
    .map(({ address, symbol }) => ({ address, symbol })),
  pools: fullCut.pools
    .filter((p) => addresses.has(p.asset.toLowerCase()))
    .map((p) => ({
      address: p.address,
      asset: p.asset,
      kind: p.kind,
      venue: p.venue,
      other: p.other,
      otherSymbol: p.otherSymbol,
      otherIsStock: p.otherIsStock,
      reachable: p.reachable,
      tvlUsd: p.tvlUsd,
    })),
};
const fixtureList = { chain: list.chain, inputs: { cut: cutName }, assets };
const { tokens, listed } = listRun(robinhood, fixtureList, cut, {
  list: LIST,
  cut: cutName,
});
const chain = { ...robinhood, tokens };

const real = createRpc(robinhood.rpcDefault, { retries: 5, timeoutMs: 60_000 });
const answers: Record<string, RpcReply> = {};
/** Both runs are held to the first block the endpoint gives. */
let head: RpcReply | null = null;
const isHead = (r: RpcRequest) =>
  r.method === 'eth_getBlockByNumber' && (r.params as unknown[])[0] === 'latest';
const batch = async (requests: RpcRequest[]) => {
  const replies = await real.batch(requests);
  for (const [i, r] of requests.entries()) {
    if (isHead(r)) {
      head ??= replies[i] as RpcReply;
      replies[i] = head;
    }
    answers[requestKey(r)] = replies[i] as RpcReply;
  }
  return replies;
};
const rpc = rpcOver(batch, real.stats);
const common = {
  minLiquidityUsd: 10_000,
  poolsMaxAgeHours: 24,
  rediscover: false,
  rpc,
  log: (e: Record<string, unknown>) => console.error(JSON.stringify(e)),
};

const allDir = mkdtempSync(join(tmpdir(), 'risk-evm-list-'));
const all = await collectOnce(chain, {
  ...common,
  dir: allDir,
  maxPools: Number.MAX_SAFE_INTEGER,
  listed,
});
const confirmed = JSON.parse(
  readFileSync(join(allDir, 'pools-robinhood-list.json'), 'utf8'),
) as PoolCache;

// the same tokens with the three deepest of their confirmed pools, at the same block
const threePools: PoolCache = {
  ...confirmed,
  maxPools: 3,
  cut: undefined,
  tokens: Object.fromEntries(
    Object.entries(confirmed.tokens).map(([s, t]) => [s, { ...t, pools: t.pools.slice(0, 3) }]),
  ),
};
const threeDir = mkdtempSync(join(tmpdir(), 'risk-evm-three-'));
writeFileSync(join(threeDir, 'pools-robinhood.json'), JSON.stringify(threePools));
const three = await collectOnce(chain, { ...common, dir: threeDir, maxPools: 3 });
if (three.block !== all.block || three.poolsRediscovered)
  throw new Error('the two runs are not at one block from one pool list');

const fixture = {
  provenance: 'fixture',
  chain: 'robinhood',
  chainId: robinhood.chainId,
  source: `two runs of collectOnce for ${SYMBOLS.join(' and ')} at block ${all.block} on Robinhood Chain through ${robinhood.rpcDefault}: every reachable pool of ${cutName}, then the three deepest; recorded by scripts/risk-evm/record-list-fixture.ts`,
  method: 'recorded_rpc_answers',
  fetchedAt: all.blockTime,
  block: all.block,
  names: { list: LIST, cut: cutName },
  list: fixtureList,
  cut,
  threePools,
  recorded: {
    // the file name is this machine's temporary folder: left out
    all: { rows: all.rows, rpcCalls: all.rpcCalls, list: { ...all.list, poolsFile: undefined } },
    three: { rows: three.rows },
  },
  answers,
};
mkdirSync('fixtures/risk-evm', { recursive: true });
writeFileSync(OUT, gzipSync(JSON.stringify(fixture)));
console.log(
  JSON.stringify({
    out: OUT,
    block: all.block,
    answers: Object.keys(answers).length,
    all: all.list,
    threeRows: three.rows,
  }),
);
