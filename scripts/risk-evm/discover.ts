import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, rpcFor } from './config';
import { type LogCache, runDiscovery } from './discover-run';
import { discover as collectorPools } from './pools';
import { latestFile, readUniverse, stamp } from './registry';
import { createRpc } from './rpc';

// Every pool of every token of the universe file (PLAN-UNIVERSE RU.2). Read-only: eth_getLogs,
// eth_call and public GETs. See README.md, "The token list and every pool".
//   pnpm risk-evm:discover                     every token of the newest universe file
//   pnpm risk-evm:discover --only NVDA,SPY     these symbols only
//   pnpm risk-evm:discover --no-logs           skip the creation events (the fallback, with its gaps)
//   pnpm risk-evm:discover --rescan            read the creation events from the first block again
//   pnpm risk-evm:discover --check-collector   also compare with the pools the hourly collector would keep
//   pnpm risk-evm:discover --universe <file> --band 0.5 --min-ref-usd 1000 --min-side-usd 100
// Writes data/risk-evm/discovery-<chain>-<stamp>.json and keeps the events in creation-logs-<chain>.json,
// so a later run reads only the blocks since.
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number) => {
  const v = Number(option(name));
  return option(name) !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback;
};

/**
 * Half-width of the band a v4 pool's positions are read in: from price / 1.5 to price × 1.5. A setting
 * of the measurement, not a price; README.md says what it leaves out.
 */
const BAND = 0.5;
/** A dollar pool prices its token only if it holds this many dollars: DU1's floor for a pool that counts. */
const MIN_REF_USD = 1_000;
/** Below this on the stock side, the other token of a pool is not worth a price lookup. */
const MIN_SIDE_USD = 100;

const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const chainId = option('--chain') ?? 'robinhood';
const chain = CHAINS.find((c) => c.id === chainId);
if (!chain) {
  console.error(`"${chainId}" is not in config.ts`);
  process.exit(1);
}
const universePath = option('--universe') ?? latestFile(dir, 'universe', chain.id);
if (!universePath) {
  console.error(`no universe file in ${dir}: run pnpm risk-evm:universe first`);
  process.exit(1);
}
const universe = readUniverse(universePath);
if (universe.chainId !== chain.chainId) {
  console.error(`${universePath} is for chain ${universe.chainId}, not ${chain.chainId}`);
  process.exit(1);
}
const only = option('--only')
  ?.split(',')
  .map((s) => s.trim());
const tokens = only ? universe.tokens.filter((t) => only.includes(t.symbol)) : universe.tokens;
if (tokens.length === 0) {
  console.error('no token to discover');
  process.exit(1);
}

const log = (event: Record<string, unknown>) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), ...event }));
const cachePath = join(dir, `creation-logs-${chain.id}.json`);
let logCache: LogCache | null = null;
if (!flag('--rescan') && existsSync(cachePath)) {
  try {
    logCache = JSON.parse(readFileSync(cachePath, 'utf8')) as LogCache;
  } catch {
    logCache = null;
  }
}

const { url, label } = rpcFor(chain);
// more patience than an hourly run: the scan is long and a refusal for rate passes
const rpc = createRpc(url, { retries: 5, timeoutMs: 60_000 });
const startedAt = new Date();
const { file, logCache: newCache } = await runDiscovery(
  chain,
  {
    rpc,
    fetchJson: async (u) => {
      const res = await fetch(u, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    log,
  },
  {
    tokens,
    universe: { file: universePath, fetchedAt: universe.fetchedAt },
    rpcLabel: label,
    band: num('--band', BAND),
    minRefUsd: num('--min-ref-usd', MIN_REF_USD),
    minSideUsd: num('--min-side-usd', MIN_SIDE_USD),
    fromBlock: num('--from-block', 0),
    logs: flag('--no-logs') ? 'off' : 'auto',
    logCache,
    logBatch: 10,
    logPauseMs: 1_000,
    dexPauseMs: 250,
  },
);

const write = (path: string, value: unknown, pretty: boolean) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, pretty ? 1 : undefined)}\n`);
  renameSync(`${path}.tmp`, path);
};
// a run on some tokens only must not replace the events kept for all of them
if (newCache && !only && num('--from-block', 0) === 0) write(cachePath, newCache, false);

/** The item's check: the pools the hourly collector would keep today are among those found. */
let collectorCheck: Record<string, unknown> | null = null;
if (flag('--check-collector')) {
  const kept = await collectorPools(chain, rpc, {
    maxPools: 3,
    minLiquidityUsd: 10_000,
    candidateLimit: 12,
    blockTag: 'latest',
    previous: null,
    log,
  });
  const found = new Set(file.pools.map((p) => p.id));
  const reachable = new Set(file.pools.filter((p) => p.reachable).map((p) => p.id));
  const missing: string[] = [];
  const notReachable: string[] = [];
  let pools = 0;
  for (const [symbol, t] of Object.entries(kept.tokens))
    for (const p of t.pools) {
      pools++;
      if (!found.has(p.id.toLowerCase())) missing.push(`${symbol} ${p.id}`);
      else if (!reachable.has(p.id.toLowerCase())) notReachable.push(`${symbol} ${p.id}`);
    }
  collectorCheck = {
    tokens: Object.keys(kept.tokens).length,
    of: chain.tokens.length,
    pools,
    missing,
    notReachable,
  };
}

const out = join(dir, `discovery-${chain.id}-${stamp(startedAt)}.json`);
// the head indented, then one pool a line: tens of thousands of rows stay greppable and half the size
const { pools, ...head } = file;
const headText = JSON.stringify(collectorCheck ? { ...head, collectorCheck } : head, null, 1);
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${out}.tmp`,
  `${headText.slice(0, -2)},\n "pools": [\n${pools.map((p) => JSON.stringify(p)).join(',\n')}\n ]\n}\n`,
);
renameSync(`${out}.tmp`, out);

const usd = (v: number | null) =>
  v === null ? 'n/a' : `$${Math.round(v).toLocaleString('en-US')}`;
const top = [...file.tokens].sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1)).slice(0, 10);
for (const t of top)
  console.log(
    `${t.symbol.padEnd(6)} pools=${String(t.pools).padStart(5)} reachable=${String(t.reachable).padStart(4)} tvl=${usd(t.tvlUsd).padStart(13)} unmeasured=${t.tvlUnmeasured}`,
  );
for (const s of file.rpc.steps)
  console.log(
    `${s.step.padEnd(20)} calls=${String(s.rpcCalls).padStart(6)} http=${String(s.httpRequests).padStart(5)} ${s.seconds.toFixed(1)}s`,
  );
console.log(
  JSON.stringify({
    wrote: out,
    counts: file.counts,
    sources: file.sources,
    bandCheck: file.bandCheck,
    collectorCheck,
    rpc: {
      rpcCalls: file.rpc.rpcCalls,
      httpRequests: file.rpc.httpRequests,
      seconds: file.rpc.seconds,
    },
  }),
);
if (collectorCheck && (collectorCheck.missing as string[]).length > 0) process.exitCode = 1;
