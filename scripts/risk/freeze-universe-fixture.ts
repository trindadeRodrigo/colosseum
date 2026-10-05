// Freezes what the 80% rule reads of one chain's pool file. No chain read.
//   tsx freeze-universe-fixture.ts <registry.json>                      Solana (pnpm risk:registry)
//     →  fixtures/risk/universe/solana-registry-<stamp>.json.gz: pool address, asset, TVL
//   tsx freeze-universe-fixture.ts <discovery.json> --chain robinhood   an EVM chain (pnpm risk-evm:discover)
//     →  fixtures/risk/universe/<chain>-discovery-<stamp>.json.gz: the rows the cut reports on (scripts/risk-evm/cut.ts)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cutInput } from '../risk-evm/cut';
import type { DiscoveryFile } from '../risk-evm/discover-run';

const args = process.argv.slice(2);
const at = args.indexOf('--chain');
const chain = at >= 0 ? args[at + 1] : 'solana';
const file = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
if (!file || !chain)
  throw new Error(
    'usage: freeze-universe-fixture.ts <registry.json | discovery.json> [--chain <id>]',
  );
mkdirSync('fixtures/risk/universe', { recursive: true });

if (chain === 'solana') {
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
  const out = `fixtures/risk/universe/solana-registry-${stamp}.json.gz`;
  writeFileSync(out, gzipSync(JSON.stringify(fixture)));
  console.log(JSON.stringify({ out, pools: fixture.pools.length, fetched_at: fixture.fetched_at }));
} else {
  /** The rule's floor (DU1): an unmeasured row is kept when its stock side alone reaches it. */
  const MIN_POOL_USD = 1_000;
  const discovery = JSON.parse(readFileSync(file, 'utf8')) as DiscoveryFile;
  if (discovery.chain !== chain) throw new Error(`${file} is for ${discovery.chain}, not ${chain}`);
  const stamp = basename(file).match(/^discovery-[\w-]+-(\d{8}T\d{4})\.json$/)?.[1];
  if (!stamp) throw new Error(`not a discovery file name: ${file}`);
  const input = cutInput(discovery, `data/risk-evm/${basename(file)}`);
  // Tens of thousands of rows have no TVL and almost nothing on the stock side: the cut only counts
  // them. They are left out, and the fixture says how many.
  const pools = input.pools.filter(
    (p) =>
      p.tvlUsd !== null || p.otherIsStock || (p.tokenUsd !== null && p.tokenUsd >= MIN_POOL_USD),
  );
  const fixture = {
    ...input,
    provenance: 'fixture',
    fetched_at: input.fetchedAt,
    rowsLeftOut: {
      rule: `rows with no TVL, not a pool of two stocks, and under $${MIN_POOL_USD} on the stock side`,
      rows: input.pools.length - pools.length,
    },
    pools,
  };
  const out = `fixtures/risk/universe/${chain}-discovery-${stamp}.json.gz`;
  writeFileSync(out, gzipSync(JSON.stringify(fixture)));
  console.log(
    JSON.stringify({
      out,
      pools: pools.length,
      leftOut: fixture.rowsLeftOut.rows,
      fetched_at: fixture.fetched_at,
    }),
  );
}
