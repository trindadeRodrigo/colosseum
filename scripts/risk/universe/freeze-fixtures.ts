// Freezes what the asset list reads of its inputs (PLAN-UNIVERSE RU.4). No chain read.
//   tsx freeze-fixtures.ts robinhood <cut.json> <oracles.json> <universe.json>
//     →  fixtures/risk/universe/robinhood-list-inputs-<cut stamp>.json.gz: the three files, each cut to
//        the fields list.ts reads (cutForList, oraclesForList, universeForList). No round and no price.
//   tsx freeze-fixtures.ts solana <registry.json>
//     →  fixtures/risk/universe/solana-registry-detail-<stamp>.json.gz: the mint, its decimals, the
//        quote mint, the venue and the way out of every pool at the rule's floor or more. It goes beside
//        RU.1's solana-registry-<stamp>.json.gz, which is the same file cut to what the rule reads.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cutForList, oraclesForList, RULE, universeForList } from './list';

const [chain, ...files] = process.argv.slice(2);
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const usage =
  'usage: freeze-fixtures.ts robinhood <cut.json> <oracles.json> <universe.json> | solana <registry.json>';
mkdirSync('fixtures/risk/universe', { recursive: true });

if (chain === 'robinhood' && files.length === 3) {
  const [cutPath, oraclesPath, universePath] = files as [string, string, string];
  const stamp = basename(cutPath).match(/^cut-robinhood-(\d{8}T\d{4})\.json$/)?.[1];
  if (!stamp) throw new Error(`not a cut file name: ${cutPath}`);
  const cut = cutForList(read(cutPath));
  const fixture = {
    chain: 'robinhood',
    provenance: 'fixture',
    names: {
      cut: basename(cutPath),
      oracles: basename(oraclesPath),
      universe: basename(universePath),
    },
    cut: { ...cut, provenance: 'fixture' },
    oracles: oraclesForList(read(oraclesPath)),
    universe: universeForList(read(universePath), cut.tracked),
  };
  const out = `fixtures/risk/universe/robinhood-list-inputs-${stamp}.json.gz`;
  writeFileSync(out, gzipSync(JSON.stringify(fixture)));
  console.log(JSON.stringify({ out, tracked: cut.tracked.length, pools: cut.pools.length, stamp }));
} else if (chain === 'solana' && files.length === 1) {
  const [file] = files as [string];
  const reg = read(file) as {
    methodVersion: string;
    fetchedAt: string;
    pools: Array<{
      address: string;
      assetMint: string;
      quoteMint: string;
      assetIsToken0: number;
      decimals0: number;
      decimals1: number;
      venue: string;
      exitPath: string;
      tvlUsd: number | null;
    }>;
  };
  const stamp = basename(file).match(/registry-(\w+)\.json$/)?.[1];
  if (!stamp) throw new Error(`not a registry file name: ${file}`);
  const pools = reg.pools.filter((p) => p.tvlUsd !== null && p.tvlUsd >= RULE.minPoolUsd);
  const fixture = {
    chain: 'solana',
    source: `data/risk/${basename(file)} (pnpm risk:registry: pool accounts and vault balances read on chain, priced in USD)`,
    fetched_at: reg.fetchedAt,
    method: reg.methodVersion,
    provenance: 'fixture',
    rowsLeftOut: {
      rule: `pools with no TVL or under $${RULE.minPoolUsd}: the list reads the detail of ranked pools only`,
      rows: reg.pools.length - pools.length,
    },
    pools: pools.map((p) => ({
      address: p.address,
      mint: p.assetMint,
      decimals: p.assetIsToken0 ? p.decimals0 : p.decimals1,
      quoteMint: p.quoteMint,
      venue: p.venue,
      exitPath: p.exitPath,
    })),
  };
  const out = `fixtures/risk/universe/solana-registry-detail-${stamp}.json.gz`;
  writeFileSync(out, gzipSync(JSON.stringify(fixture)));
  console.log(JSON.stringify({ out, pools: pools.length, leftOut: fixture.rowsLeftOut.rows }));
} else throw new Error(usage);
