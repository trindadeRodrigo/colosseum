// Freezes a pool registry (pnpm risk:registry) down to what the 80% rule reads: pool address, asset, TVL.
// No chain read. Usage: tsx freeze-universe-fixture.ts <registry.json>  →  fixtures/risk/universe/solana-registry-<stamp>.json.gz
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) throw new Error('usage: freeze-universe-fixture.ts <registry.json>');
const reg = JSON.parse(readFileSync(file, 'utf8')) as {
  methodVersion: string;
  fetchedAt: string;
  pools: Array<{ address: string; assetSymbol: string; tvlUsd: number | null }>;
};
const stamp = basename(file).match(/registry-(\w+)\.json$/)?.[1];
if (!stamp) throw new Error(`not a registry file name: ${file}`);
const fixture = {
  chain: 'solana',
  source: `data/risk/${basename(file)} (pnpm risk:registry: pool accounts and vault balances read on chain, priced in USD)`,
  fetched_at: reg.fetchedAt,
  method: reg.methodVersion,
  provenance: 'fixture',
  pools: reg.pools.map((p) => ({
    address: p.address,
    asset: p.assetSymbol,
    tvlUsd: p.tvlUsd ?? null,
  })),
};
mkdirSync('fixtures/risk/universe', { recursive: true });
const out = `fixtures/risk/universe/solana-registry-${stamp}.json.gz`;
writeFileSync(out, gzipSync(JSON.stringify(fixture)));
console.log(JSON.stringify({ out, pools: fixture.pools.length, fetched_at: fixture.fetched_at }));
