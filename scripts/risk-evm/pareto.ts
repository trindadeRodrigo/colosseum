import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHAINS } from './config';
import { cutInput, cutReport, failedTokens, SHARES } from './cut';
import type { DiscoveryFile } from './discover-run';
import { latestFile } from './registry';

// The 80% rule on the newest discovery file (PLAN-UNIVERSE RU.3). Reads one file, calls nothing.
//   pnpm risk-evm:pareto                        the newest discovery file of Robinhood Chain
//   pnpm risk-evm:pareto --discovery <file>     another file
//   pnpm risk-evm:pareto --share 0.8 --min-pool-usd 1000
//   pnpm risk-evm:pareto --allow-gaps           use a file in which DexScreener failed for a token
//   pnpm risk-evm:pareto --allow-old            use a file more than a day old
// Writes data/risk-evm/cut-<chain>-<stamp>.json, the stamp being the discovery file's own. A cut by
// another share or floor is written beside it, with the rule in its name.
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
/** A number option; a value that is not a number of 0 or more is refused, never replaced by the default. */
const num = (name: string, fallback: number) => {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) {
    console.error(`write "${name} <value>", not "${eq}"`);
    process.exit(1);
  }
  if (!flag(name)) return fallback;
  const v = Number(option(name));
  if (option(name) === undefined || option(name) === '' || !Number.isFinite(v) || v < 0) {
    console.error(`${name} needs a number of 0 or more, got "${option(name) ?? ''}"`);
    process.exit(1);
  }
  return v;
};

/** Gate UNIVERSE: the pools holding this share of the money name the tracked stocks. */
const SHARE = 0.8;
/** DU1: a pool counts from this many dollars. */
const MIN_POOL_USD = 1_000;
/** A discovery older than this is run again before it is cut. */
const MAX_AGE_HOURS = 24;

const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const chainId = option('--chain') ?? 'robinhood';
const chain = CHAINS.find((c) => c.id === chainId);
if (!chain) {
  console.error(`"${chainId}" is not in config.ts`);
  process.exit(1);
}
const path = option('--discovery') ?? latestFile(dir, 'discovery', chain.id);
if (!path) {
  console.error(
    `no discovery file in ${dir}: run pnpm risk-evm:universe and pnpm risk-evm:discover first`,
  );
  process.exit(1);
}
const file = JSON.parse(readFileSync(path, 'utf8')) as DiscoveryFile;
if (file.chainId !== chain.chainId) {
  console.error(`${path} is for chain ${file.chainId}, not ${chain.chainId}`);
  process.exit(1);
}
const ageHours = (Date.now() - Date.parse(file.fetchedAt)) / 3_600_000;
if (!Number.isFinite(ageHours) || ageHours < 0) {
  console.error(
    `${path} says it was fetched at "${file.fetchedAt}", which is not a time in the past`,
  );
  process.exit(1);
}
if (ageHours > MAX_AGE_HOURS && !flag('--allow-old')) {
  console.error(
    `${path} is ${ageHours.toFixed(1)} hours old: run pnpm risk-evm:universe and pnpm risk-evm:discover again, or pass --allow-old`,
  );
  process.exit(1);
}
const input = cutInput(file, basename(path));
const failed = failedTokens(input);
if (failed.length > 0) {
  console.error(
    `DexScreener failed for ${failed.join(', ')} in ${path}: pools of other venues may be missing for them`,
  );
  if (!flag('--allow-gaps')) {
    console.error('refused: run pnpm risk-evm:discover again, or pass --allow-gaps');
    process.exit(1);
  }
}

const report = cutReport(input, {
  share: num('--share', SHARE),
  minPoolUsd: num('--min-pool-usd', MIN_POOL_USD),
  shares: SHARES,
  collected: chain.tokens,
});

const stampOf = basename(path).match(/-(\w+)\.json$/)?.[1] ?? 'unknown';
// a cut by another rule never takes the name of the rule's own file
const { share, minPoolUsd } = report.rule;
const other =
  share === SHARE && minPoolUsd === MIN_POOL_USD ? '' : `-share${share}-min${minPoolUsd}`;
const out = join(dir, `cut-${chain.id}-${stampOf}${other}.json`);
// the head indented, then one pool a line, as the discovery file is written
const { cut, pools, ...head } = report;
const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join(',\n');
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${out}.tmp`,
  `${JSON.stringify(head, null, 1).slice(0, -2)},\n "cut": [\n${lines(cut)}\n ],\n "pools": [\n${lines(pools)}\n ]\n}\n`,
);
renameSync(`${out}.tmp`, out);

const usd = (v: number | null) =>
  v === null ? 'n/a' : `$${Math.round(v).toLocaleString('en-US')}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const say = (s = '') => console.log(s);
const c = report.counts;
say(
  `${path} (${ageHours.toFixed(1)} hours old, blocks ${file.blocks.stateFirst} to ${file.blocks.stateLast})`,
);
say(
  `rule: ${pct(report.rule.share)} of the money in pools of ${usd(report.rule.minPoolUsd)} or more`,
);
say(`mapping: ${report.rule.mapping}`);
say();
say(
  `${c.rows} rows of ${c.tokens} tokens: ${c.ranked} ranked (${usd(c.rankedUsd)}), ${c.measuredBelowFloor} measured below the floor, ${c.unmeasured} with no TVL (left out and counted, never zero)`,
);
for (const [reason, n] of Object.entries(c.unmeasuredByReason)) say(`  no TVL, ${reason}: ${n}`);
say();
const table = (rows: typeof report.shares) => {
  for (const s of rows)
    say(
      `  ${pct(s.share).padStart(6)}  pools=${String(s.pools).padStart(4)}  stocks=${String(s.stocks).padStart(3)}  money=${usd(s.cutUsd).padStart(12)}  all ranked pools of those stocks=${s.poolsOfTheStocks}`,
    );
};
say('The cut, v3 and v4 pools in one list:');
table(report.shares);
say();
say(`Tracked stocks at ${pct(report.rule.share)} (${report.tracked.length}):`);
for (const t of report.tracked)
  say(
    `  ${t.symbol.padEnd(6)} in cut=${String(t.poolsInCut).padStart(2)} ${usd(t.cutUsd).padStart(12)}  ranked pools=${String(t.pools).padStart(3)} ${usd(t.poolsUsd).padStart(12)}  reachable=${String(t.reachablePools).padStart(3)} ${usd(t.reachableUsd).padStart(12)}  dust=${t.dustPools} no TVL=${t.unmeasuredPools}`,
  );
say();
const w = report.withoutV4;
if (w.sameStocksAtShare) {
  say(
    `Without the v4 pools (${w.rankedPools} pools, ${usd(w.rankedUsd)}) the cut names the same stocks.`,
  );
} else {
  say(
    `Without the v4 pools (${w.rankedPools} pools, ${usd(w.rankedUsd)}) the cut names different stocks:`,
  );
  table(w.shares);
  say(`  tracked only with v4:    ${w.onlyWithV4.join(', ') || 'none'}`);
  say(`  tracked only without v4: ${w.onlyWithoutV4.join(', ') || 'none'}`);
}
say();
const u = report.unpricedTokens;
say(`${u.count} of ${c.tokens} tokens have no price, so their pools cannot enter the cut:`);
say(`  ${u.tokens.map((t) => t.symbol).join(' ')}`);
say();
const h = report.unrankedHoldingStock;
say(
  `${h.rows} rows with no TVL hold ${usd(h.floorUsd)} or more on the stock side: ${usd(h.tokenUsd)} of stock tokens in all. Not ranked.`,
);
for (const [k, v] of Object.entries(h.byReason)) say(`  ${k}: ${v.rows} rows, ${usd(v.tokenUsd)}`);
for (const [k, v] of Object.entries(h.byVenue).sort((a, b) => b[1].tokenUsd - a[1].tokenUsd))
  say(`  venue ${k}: ${v.rows} rows, ${usd(v.tokenUsd)}`);
say(`  of tracked stocks: ${h.ofTrackedStocks.rows} rows, ${usd(h.ofTrackedStocks.tokenUsd)}`);
say(
  `  by stock: ${h.byStock
    .slice(0, 12)
    .map((s) => `${s.symbol}${s.tracked ? '*' : ''} ${s.rows}/${usd(s.tokenUsd)}`)
    .join(
      ', ',
    )}${h.byStock.length > 12 ? `, and ${h.byStock.length - 12} more in the file` : ''} (* tracked)`,
);
say();
const t2 = report.twoStockPools;
say(
  `${t2.rows} pools pair two stocks (filed under token0): ${t2.ranked} ranked, ${t2.inCut} in the cut, ${t2.touchingTracked} touch a tracked stock. Whether they count for both is not decided here.`,
);
say(
  `  tracked stocks that are the other side: ${t2.trackedAsOther.map((s) => `${s.symbol} ${s.pools}/${usd(s.tvlUsd)}`).join(', ') || 'none'}`,
);
say(
  `  stocks that would also be named if a cut pool counted for both: ${t2.wouldAlsoBeNamed.join(', ') || 'none'}`,
);
for (const p of t2.pools.filter((p) => p.inCut))
  say(`  in the cut: ${p.filedUnder}/${p.other} ${p.venue} ${usd(p.tvlUsd)}`);
say();
const v = report.vsCollector;
say(
  `Against the ${v.collected} tokens the collector reads today (config.ts): ${v.tracked} tracked.`,
);
say(`  both (${v.both.length}): ${v.both.join(' ')}`);
say(
  `  tracked, not collected (${v.trackedNotCollected.length}): ${v.trackedNotCollected.join(' ') || 'none'}`,
);
say(`  collected, not tracked (${v.collectedNotTracked.length}):`);
for (const x of v.collectedNotTracked)
  say(
    `    ${x.symbol.padEnd(6)} ${x.why}${x.rank === null ? '' : `: largest pool ${usd(x.largestPoolUsd)}, rank ${x.rank}, named by a cut above ${pct(x.entersAtShare as number)}`}`,
  );
say();
if (report.inputGaps.dexscreenerFailed.length > 0)
  say(
    `LET THROUGH WITH A GAP: DexScreener failed for ${report.inputGaps.dexscreenerFailed.join(', ')}`,
  );
say(
  `DexScreener was at its cap of 30 pairs for ${report.inputGaps.dexscreenerAtCap.length} tokens (other venues may have more): ${report.inputGaps.dexscreenerAtCap.join(' ')}`,
);
say(
  JSON.stringify({
    wrote: out,
    cut: cut.length,
    pools: pools.length,
    stocks: report.tracked.length,
  }),
);
