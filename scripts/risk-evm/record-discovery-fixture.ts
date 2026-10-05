import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { addressWord, TOPIC, word } from './abi';
import { CHAINS } from './config';
import { runDiscovery } from './discover-run';
import { blockWindows, type RawLog } from './discovery';
import { multicall } from './multicall';
import { confirmTokens, parseRegistry, REGISTRY_URL, tokenChecks } from './registry';
import { requestKey, rpcOver } from './replay';
import { createRpc, type RpcReply, type RpcRequest } from './rpc';

// Records the fixture behind the discovery tests of tests/risk-evm-universe.test.ts: one real pass of
// `pnpm risk-evm:universe` and `pnpm risk-evm:discover` for two tokens on Robinhood Chain over the
// last blocks of the chain, with every answer of the endpoint and of the two public APIs kept as it
// came. Read-only. The tests replay it; none calls the network.
//   pnpm exec tsx scripts/risk-evm/record-discovery-fixture.ts
const OUT = 'fixtures/risk-evm/robinhood-discovery.json.gz';
const SYMBOLS = ['NVDA', 'SPY'];
/** Blocks of creation events recorded: two windows of the span the endpoint allows a token list. */
const LOG_BLOCKS = 200_000;
const OPTIONS = { band: 0.5, minRefUsd: 1_000, minSideUsd: 100 };

const chain = CHAINS.find((c) => c.id === 'robinhood');
const registryUrl = REGISTRY_URL.robinhood;
if (!chain || !registryUrl) throw new Error('no robinhood chain in config.ts');

const real = createRpc(chain.rpcDefault, { retries: 5, timeoutMs: 60_000 });
const answers: Record<string, RpcReply> = {};
// a question already answered is not asked again: "latest" stays the first block it named, so the
// two passes below and the token checks all read one block
const batch = async (requests: RpcRequest[]) => {
  const fresh = requests.filter((r) => !(requestKey(r) in answers));
  const replies = await real.batch(fresh);
  for (const [i, r] of fresh.entries()) answers[requestKey(r)] = replies[i] as RpcReply;
  return requests.map((r) => answers[requestKey(r)] as RpcReply);
};
const rpc = rpcOver(batch, real.stats);

// the registry, cut to the two tokens, and the chain's word on them
const registry = (await (await fetch(registryUrl)).json()) as {
  assets: Array<{ tokenSymbol: string }>;
};
const cut = { assets: registry.assets.filter((a) => SYMBOLS.includes(a.tokenSymbol)) };
const { tokens } = parseRegistry(cut, chain.chainId);
const head = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
  'latest',
  false,
]);
const checkReplies = await multicall(rpc, chain.multicall3, tokenChecks(tokens), head.number);
const universe = confirmTokens(tokens, checkReplies);

// DexScreener's answers, cut to the fields the discovery reads
const gets: Record<string, unknown> = {};
const fetchJson = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const pairs = (await res.json()) as Array<Record<string, unknown>>;
  const kept = pairs.map((p) => ({
    chainId: p.chainId,
    dexId: p.dexId,
    labels: p.labels,
    pairAddress: p.pairAddress,
    baseToken: { address: (p.baseToken as { address?: string })?.address },
    quoteToken: { address: (p.quoteToken as { address?: string })?.address },
    liquidity: { usd: (p.liquidity as { usd?: number })?.usd },
    volume: { h24: (p.volume as { h24?: number })?.h24 },
  }));
  gets[url] = kept;
  return kept;
};

// the clock stands still, so the whole pass reads one block and the replay asks the same questions
const now = Date.now();
const fromBlock = Number(head.number) - LOG_BLOCKS;
const deps = {
  rpc,
  fetchJson,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  now: () => now,
  log: () => {},
};
const options = {
  tokens: universe,
  universe: { file: 'fixture', fetchedAt: new Date(Number(head.timestamp) * 1000).toISOString() },
  rpcLabel: chain.rpcDefault,
  ...OPTIONS,
  fromBlock,
  logCache: null,
  logBatch: 10,
  logPauseMs: 1_000,
  dexPauseMs: 250,
};
const { file } = await runDiscovery(chain, deps, { ...options, logs: 'auto' });
// and once without the creation events, so the fallback's own questions are in the recording too
const { file: fallback } = await runDiscovery(chain, deps, { ...options, logs: 'off' });

// the two pools of the collector's own fixture (robinhood-nvda-quotes.json), as the chain announced
// them: one value per topic, so the endpoint allows ten million blocks a query
const KNOWN_V4 = '0xdf5c0bcd967d54774c139a4ef803ec994779736346fb4c21b50ed241b1fd2682';
const nvda = universe.find((t) => t.symbol === 'NVDA');
const factory = chain.clFactories[0];
if (!nvda || !factory || !chain.v4?.poolManager)
  throw new Error('NVDA or the contracts are missing');
const topic = (a: string) => `0x${addressWord(a)}`;
const known = async (address: string, topics: string[]): Promise<RawLog> => {
  for (const [a, b] of blockWindows(0, Number(head.number), 10_000_000)) {
    const logs = await real.call<RawLog[]>('eth_getLogs', [
      { address, topics, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` },
    ]);
    if (logs[0]) return logs[0];
  }
  throw new Error(`no creation event found at ${address}`);
};
const knownLogs = {
  // token0 is the lower address: the dollar token, then NVDA, at the 0.05% tier
  v3: await known(factory.address, [
    TOPIC.v3PoolCreated,
    topic(chain.dollar.address),
    topic(nvda.address),
    `0x${word(500)}`,
  ]),
  v4: await known(chain.v4.poolManager, [TOPIC.v4Initialize, KNOWN_V4]),
};

// what the two endpoints answer to a log query they refuse, word for word (the plan's probe)
const refusalOf = async (
  from: string,
  when: string,
  client: { batch: typeof real.batch },
  filter: Record<string, unknown>,
) => {
  const [r] = await client.batch([{ method: 'eth_getLogs', params: [filter] }]);
  if (!r?.error?.message) throw new Error(`${from} did not refuse: ${when}`);
  return { from, when, message: r.error.message };
};
const pm = chain.v4.poolManager;
const latest = { address: pm, topics: [TOPIC.v4Initialize], toBlock: head.number };
const host = new URL(chain.rpcDefault).host;
const refusals = {
  wholeLife: await refusalOf(
    host,
    'every Initialize event of the pool manager, block 0 to the head',
    real,
    {
      ...latest,
      fromBlock: '0x0',
    },
  ),
  tooManyLogs: await refusalOf(
    host,
    'every Initialize event of the first ten million blocks',
    real,
    {
      ...latest,
      fromBlock: '0x0',
      toBlock: `0x${(9_999_999).toString(16)}`,
    },
  ),
  tokenList: await refusalOf(
    host,
    'Initialize events with two tokens listed in one topic, over a million blocks',
    real,
    {
      ...latest,
      topics: [TOPIC.v4Initialize, null, [topic(nvda.address), topic(chain.dollar.address)]],
      fromBlock: `0x${(Number(head.number) - 1_000_000).toString(16)}`,
    },
  ),
  drpc: await refusalOf(
    'robinhood.drpc.org',
    'every Initialize event of the last 20,000 blocks',
    // one plain request: this endpoint answers a refusal with HTTP 400, which the client treats as fatal
    {
      batch: async (requests) => {
        const res = await fetch('https://robinhood.drpc.org', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...requests[0] }),
        });
        return [(await res.json()) as RpcReply];
      },
    },
    { ...latest, toBlock: 'latest', fromBlock: `0x${(Number(head.number) - 20_000).toString(16)}` },
  ),
};

const fixture = {
  provenance: 'fixture',
  source: `${registryUrl}, https://api.dexscreener.com/token-pairs/v1/robinhood/{token}, and eth_getLogs and eth_call at block ${file.blocks.stateLast} on ${chain.name} (chain ${chain.chainId}) through ${chain.rpcDefault}`,
  method:
    'scripts/risk-evm/record-discovery-fixture.ts: every answer as it came, keyed by a hash of the request; the registry cut to two tokens, DexScreener cut to the fields read, creation events from the last 200,000 blocks only; gzipped',
  fetchedAt: file.fetchedAt,
  block: file.blocks.stateLast,
  fromBlock,
  options: OPTIONS,
  registry: cut,
  tokenChecks: checkReplies,
  gets,
  answers,
  knownLogs,
  refusals,
  // what the pass came to when it was recorded: the replay must come to the same
  counts: file.counts,
  fallbackCounts: fallback.counts,
  bandCheck: file.bandCheck,
};
mkdirSync('fixtures/risk-evm', { recursive: true });
writeFileSync(OUT, gzipSync(`${JSON.stringify(fixture)}\n`, { level: 9 }));
console.log(
  JSON.stringify({ wrote: OUT, block: fixture.block, counts: file.counts, rpc: real.stats() }),
);
