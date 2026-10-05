import 'dotenv/config';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, rpcFor } from './config';
import { multicall } from './multicall';
import {
  confirmTokens,
  parseRegistry,
  REGISTRY_URL,
  stamp,
  tokenChecks,
  UNIVERSE_METHOD,
  type UniverseFile,
} from './registry';
import { createRpc } from './rpc';

// The token list of a chain (PLAN-UNIVERSE RU.2): every token of the issuer's registry, with the
// chain's own decimals() and symbol() beside the registry's. Read-only: one public GET and eth_call.
//   pnpm risk-evm:universe                  Robinhood Chain
//   pnpm risk-evm:universe --chain <id>     another chain of config.ts that has a registry
// Writes data/risk-evm/universe-<chain>-<stamp>.json. Nothing here is read by the hourly collector.
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const chainId = option('--chain') ?? 'robinhood';
const chain = CHAINS.find((c) => c.id === chainId);
const url = REGISTRY_URL[chainId];
if (!chain || !url) {
  console.error(`no registry for chain "${chainId}"`);
  process.exit(1);
}

const startedAt = Date.now();
const res = await fetch(url, {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) throw new Error(`the registry answered HTTP ${res.status}`);
const registryFetchedAt = new Date();
const raw = (await res.json()) as { assets?: unknown[] };
const { tokens, skipped } = parseRegistry(raw, chain.chainId);

const { url: rpcUrl, label } = rpcFor(chain);
const rpc = createRpc(rpcUrl);
const head = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
  'latest',
  false,
]);
const checked = confirmTokens(
  tokens,
  await multicall(rpc, chain.multicall3, tokenChecks(tokens), head.number),
);
const confirmed = checked.filter((t) => t.confirmed).length;

const file: UniverseFile = {
  chain: chain.id,
  chainId: chain.chainId,
  provenance: 'live',
  source: `${url}, then decimals() and symbol() of each address by eth_call at block ${Number(head.number)} on ${chain.name} (chain ${chain.chainId}) through ${label}`,
  method: UNIVERSE_METHOD,
  fetchedAt: new Date(Number(head.timestamp) * 1000).toISOString(),
  block: Number(head.number),
  registry: {
    url,
    fetchedAt: registryFetchedAt.toISOString(),
    assets: Array.isArray(raw.assets) ? raw.assets.length : 0,
  },
  counts: {
    tokens: checked.length,
    confirmed,
    notConfirmed: checked.length - confirmed,
    skipped: skipped.length,
  },
  rpc: { ...rpc.stats(), seconds: (Date.now() - startedAt) / 1000 },
  tokens: checked,
  skipped,
};
mkdirSync(dir, { recursive: true });
const path = join(dir, `universe-${chain.id}-${stamp(registryFetchedAt)}.json`);
writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
renameSync(`${path}.tmp`, path);

for (const t of checked.filter((x) => !x.confirmed))
  console.log(
    `not confirmed: ${t.symbol} ${t.address} ${t.reason} (chain says ${JSON.stringify(t.onchain)})`,
  );
for (const s of skipped) console.log(`left out: ${s.symbol} ${s.reason}`);
console.log(JSON.stringify({ wrote: path, block: file.block, ...file.counts, rpc: file.rpc }));
