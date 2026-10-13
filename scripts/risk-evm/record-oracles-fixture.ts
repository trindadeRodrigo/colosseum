import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { defaultRegimeParams } from '@colosseum/risk';
import { CHAINS } from './config';
import { DIRECTORY_URL, runOracles, type Wanted } from './feeds';
import { latestFile, readUniverse } from './registry';
import { requestKey, rpcOver } from './replay';
import { createRpc, type RpcReply, type RpcRequest } from './rpc';

// Records the fixture behind tests/risk-evm-oracles.test.ts: one real pass of `pnpm risk-evm:oracles`
// on Robinhood Chain, with Chainlink's directory and every answer of the endpoint kept as they came.
// Read-only. It needs the cut and the token list on this machine (data/risk-evm/). The tests replay
// it; none calls the network.
//   pnpm exec tsx scripts/risk-evm/record-oracles-fixture.ts

const OUT = 'fixtures/risk-evm/robinhood-oracles.json.gz';
const CALENDAR = 'fixtures/risk/us-market-holidays.json';
const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';

const chain = CHAINS.find((c) => c.id === 'robinhood');
const directoryUrl = DIRECTORY_URL.robinhood;
const cutPath = latestFile(dir, 'cut', 'robinhood');
const universePath = latestFile(dir, 'universe', 'robinhood');
if (!chain || !directoryUrl || !cutPath || !universePath)
  throw new Error(`no robinhood chain in config.ts, or no cut and token list in ${dir}`);

const tracked = (JSON.parse(readFileSync(cutPath, 'utf8')) as { tracked: Wanted[] }).tracked.map(
  ({ address, symbol }) => ({ address, symbol }),
);
// the token list cut to what the oracle map reads of it
const registry = readUniverse(universePath).tokens.map(({ address, symbol, multiplier }) => ({
  address,
  symbol,
  multiplier,
}));

const real = createRpc(chain.rpcDefault, { retries: 5, timeoutMs: 60_000 });
const answers: Record<string, RpcReply> = {};
const batch = async (requests: RpcRequest[]) => {
  const replies = await real.batch(requests);
  for (const [i, r] of requests.entries()) answers[requestKey(r)] = replies[i] as RpcReply;
  return replies;
};

// the directory, cut to the fields read
let directory: unknown[] = [];
const fetchJson = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  directory = ((await res.json()) as Array<Record<string, unknown>>).map((f) => {
    const docs = (f.docs ?? {}) as Record<string, unknown>;
    return {
      name: f.name,
      path: f.path,
      proxyAddress: f.proxyAddress,
      contractAddress: f.contractAddress,
      secondaryProxyAddress: f.secondaryProxyAddress,
      decimals: f.decimals,
      heartbeat: f.heartbeat,
      assetName: f.assetName,
      docs: {
        baseAsset: docs.baseAsset,
        marketHours: docs.marketHours,
        productTypeCode: docs.productTypeCode,
        attributeType: docs.attributeType,
        assetClass: docs.assetClass,
      },
    };
  });
  return directory;
};

// the clock stands still, so the replay writes the same file
const now = Date.now();
const inputs = {
  cut: basename(cutPath),
  universe: basename(universePath),
  collected: 'scripts/risk-evm/config.ts',
  calendar: CALENDAR,
};
const file = await runOracles(
  chain,
  { rpc: rpcOver(batch, real.stats), fetchJson, now: () => now },
  {
    directoryUrl,
    tracked,
    collected: chain.tokens,
    registry,
    regime: defaultRegimeParams(JSON.parse(readFileSync(CALENDAR, 'utf8'))),
    rpcLabel: chain.rpcDefault,
    inputs,
  },
);

const fixture = {
  provenance: 'fixture',
  source: file.source,
  method:
    'scripts/risk-evm/record-oracles-fixture.ts: the directory cut to the fields read, every answer of the endpoint as it came, keyed by a hash of the request; the tracked stocks of the cut and the token list cut to address, symbol and multiplier; gzipped',
  fetchedAt: file.fetchedAt,
  block: file.block,
  now,
  inputs,
  directoryUrl,
  directory,
  tracked,
  // the collector's tokens and the endpoint's name as they were at the recording: config.ts moves on
  collected: chain.tokens.map(({ address, symbol }) => ({ address, symbol })),
  rpcLabel: chain.rpcDefault,
  registry,
  answers,
  // what the pass came to when it was recorded: the replay must come to the same
  file,
};
mkdirSync('fixtures/risk-evm', { recursive: true });
writeFileSync(OUT, gzipSync(`${JSON.stringify(fixture)}\n`, { level: 9 }));
console.log(
  JSON.stringify({ wrote: OUT, block: fixture.block, counts: file.counts, rpc: real.stats() }),
);
