import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AssetList } from '@colosseum/schemas';
import { latestFile } from '../../risk-evm/registry';
import {
  cutForList,
  oraclesForList,
  pairMismatch,
  robinhoodList,
  solanaList,
  universeForList,
} from './list';

// The asset list of one chain (PLAN-UNIVERSE RU.4, DU2). Reads files, calls nothing.
//   pnpm risk:universe robinhood                 the newest cut, oracle map and token list in data/risk-evm/
//   pnpm risk:universe robinhood --cut <file> --oracles <file> --universe <file>
//   pnpm risk:universe robinhood --allow-old     a cut whose discovery is more than a day old
//   pnpm risk:universe solana                    the frozen registry of Oct 1 and the Scope table
// Writes scripts/risk/universe/<chain>.json, which is committed, and prints the same in words.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};
/** A file option; given with no value it is refused, never replaced by the newest file. */
const fileOption = (name: string) => {
  const v = option(name);
  if (flag(name) && (v === undefined || v === '' || v.startsWith('--')))
    stop(`${name} needs a file`);
  return v;
};
const readJson = (path: string) =>
  JSON.parse(
    path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString() : readFileSync(path, 'utf8'),
  );

/** A cut whose discovery is older than this is made again before the list is written from it. */
const MAX_AGE_HOURS = 24;
const OUT_DIR = 'scripts/risk/universe';
const SOLANA = {
  registry: 'fixtures/risk/universe/solana-registry-20261001T0139.json.gz',
  detail: 'fixtures/risk/universe/solana-registry-detail-20261001T0139.json.gz',
  scope: 'fixtures/solana-vault/scope-indexes.json',
};

/** The options that take a file; any other word that is not an option is the chain. */
const FILE_OPTIONS = ['--cut', '--oracles', '--universe'];
const chain = args.find((a, i) => !a.startsWith('--') && !FILE_OPTIONS.includes(args[i - 1] ?? ''));
let list: AssetList;
/** The issuer's name of each token, for the printout only. */
const nameOf = new Map<string, string>();

if (chain === 'robinhood') {
  const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
  const again =
    'run pnpm risk-evm:universe, pnpm risk-evm:discover, pnpm risk-evm:pareto and pnpm risk-evm:oracles first';
  const path = (name: string, prefix: string) =>
    fileOption(`--${name}`) ??
    latestFile(dir, prefix, 'robinhood') ??
    stop(`no ${prefix} file in ${dir}: ${again}`);
  const paths = {
    cut: path('cut', 'cut'),
    oracles: path('oracles', 'oracles'),
    universe: path('universe', 'universe'),
  };
  const cut = cutForList(readJson(paths.cut));
  const oracles = oraclesForList(readJson(paths.oracles));
  const universe = universeForList(readJson(paths.universe), cut.tracked);
  const ageHours = (Date.now() - Date.parse(cut.fetchedAt ?? '')) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0)
    stop(`${paths.cut} says it was fetched at "${cut.fetchedAt}", which is not a time in the past`);
  if (ageHours > MAX_AGE_HOURS && !flag('--allow-old'))
    stop(`${paths.cut} is ${ageHours.toFixed(1)} hours old: ${again}, or pass --allow-old`);
  const differs = pairMismatch(cut, oracles);
  if (differs.length > 0)
    stop(
      `${paths.oracles} is not the oracle map of ${paths.cut}, refused:\n  ${differs.join('\n  ')}\nrun pnpm risk-evm:oracles on this cut`,
    );
  for (const t of universe.tokens) nameOf.set(t.address.toLowerCase(), t.name);
  console.log(
    `${paths.cut} (${ageHours.toFixed(1)} hours old), ${paths.oracles}, ${paths.universe}`,
  );
  list = robinhoodList({
    cut,
    oracles,
    universe,
    names: {
      cut: basename(paths.cut),
      oracles: basename(paths.oracles),
      universe: basename(paths.universe),
    },
  });
} else if (chain === 'solana') {
  for (const f of Object.values(SOLANA)) if (!existsSync(f)) stop(`${f} is missing`);
  console.log(Object.values(SOLANA).join(', '));
  list = solanaList({
    registry: readJson(SOLANA.registry),
    detail: readJson(SOLANA.detail),
    scope: readJson(SOLANA.scope),
    names: SOLANA,
  });
} else {
  list = stop('usage: pnpm risk:universe <robinhood | solana>');
}

const out = join(OUT_DIR, `${list.chain}.json`);
writeFileSync(`${out}.tmp`, `${JSON.stringify(list, null, 2)}\n`);
renameSync(`${out}.tmp`, out);
// the repository's formatter has the last word on a committed file
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', out], { stdio: 'ignore' });

const say = (s = '') => console.log(s);
const usd = (v: number | null) =>
  v === null ? 'n/a' : `$${Math.round(v).toLocaleString('en-US')}`;
const c = list.counts;
say(
  `rule: ${(list.rule.share * 100).toFixed(0)}% of the money in pools of ${usd(list.rule.minPoolUsd)} or more; pools read at ${list.fetchedAt}`,
);
say();
say(
  `${c.assets} tracked stocks, ${c.rankedPools} ranked pools${c.reachablePools === null ? '' : `, ${c.reachablePools} of them reachable`}, ${c.twoStockPools} of them pools of two stocks (each counted once, under the stock it is filed under).`,
);
for (const a of list.assets) {
  const p = a.pools;
  const o = a.oracle ? `${a.oracle.kind} ${a.oracle.ref}` : `no oracle: ${a.oracleReason}`;
  say(
    `  ${a.symbol.padEnd(7)} ${a.cls.padEnd(12)} pools=${String(p.ranked).padStart(3)} in cut=${String(p.inCut).padStart(2)} reachable=${String(p.reachable ?? 'n/a').padStart(3)} two-stock=${String(p.twoStock).padStart(2)}(+${p.twoStockAsOther} as other)  ${usd(a.tvlUsd).padStart(12)} ${(a.share * 100).toFixed(1).padStart(5)}%  auto=${a.autoRebalance ? 'yes' : 'no '}  ${o}${a.autoRebalanceOpen ? `  OPEN: ${a.autoRebalanceOpen}` : ''}`,
  );
}
say();
say(
  `Class: ${list.assets.filter((a) => a.clsSource === 'class_table').length} rows from the table in list.ts (${
    list.assets
      .filter((a) => a.clsSource === 'class_table')
      .map((a) => `${a.symbol} ${a.cls}`)
      .join(', ') || 'none'
  }); the others are stock by default.`,
);
say();
say(
  `With an oracle: ${c.withOracle}. Without: ${c.withoutOracle}, never rebalanced automatically:`,
);
for (const a of list.assets.filter((a) => !a.oracle))
  say(
    `  ${a.symbol.padEnd(7)} ${a.address}  ${a.oracleReason}${nameOf.has(a.address) ? `  ${nameOf.get(a.address)}` : ''}`,
  );
const open = list.assets.filter((a) => a.autoRebalanceOpen);
if (open.length > 0) {
  say();
  say(
    'Written autoRebalance true by the rule (a confirmed oracle), with a question left to the vault stream:',
  );
  for (const a of open)
    say(
      `  ${a.symbol.padEnd(7)} ${a.autoRebalanceOpen} (oracle.prices: ${a.oracle?.prices ?? `null, ${a.oracle?.pricesReason}`})`,
    );
}
say();
for (const [k, v] of Object.entries(list.stated)) say(`${k}: ${v}`);
say();
say(
  JSON.stringify({
    wrote: out,
    assets: c.assets,
    withOracle: c.withOracle,
    withoutOracle: c.withoutOracleByReason,
  }),
);
