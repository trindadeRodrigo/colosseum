import 'dotenv/config';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { defaultRegimeParams } from '@colosseum/risk';
import { CHAINS, rpcFor } from './config';
import { DIRECTORY_URL, type OracleRow, runOracles, type Wanted } from './feeds';
import { latestFile, readUniverse, stamp } from './registry';
import { createRpc } from './rpc';

// The oracle map of a chain (PLAN-UNIVERSE RU.5): a Chainlink feed for each tracked stock of the newest
// cut, confirmed on chain at one block, or the reason there is none. Read-only: one public GET and
// eth_call.
//   pnpm risk-evm:oracles                   the newest cut file of Robinhood Chain
//   pnpm risk-evm:oracles --cut <file>      another cut file
//   pnpm risk-evm:oracles --universe <file> another token list
//   pnpm risk-evm:oracles --allow-old       use a cut whose discovery is more than a day old
// Writes data/risk-evm/oracles-<chain>-<stamp>.json. Nothing here is read by the hourly collector.

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

/** A cut whose discovery is older than this is made again before its stocks are given an oracle. */
const MAX_AGE_HOURS = 24;
const CALENDAR = process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json';

const dir = process.env.RISK_EVM_DIR ?? 'data/risk-evm';
const chainId = option('--chain') ?? 'robinhood';
const chain = CHAINS.find((c) => c.id === chainId) ?? stop(`"${chainId}" is not in config.ts`);
const directoryUrl = DIRECTORY_URL[chain.id] ?? stop(`no Chainlink directory for "${chain.id}"`);

const again = 'run pnpm risk-evm:universe, pnpm risk-evm:discover and pnpm risk-evm:pareto first';
const cutPath =
  option('--cut') ?? latestFile(dir, 'cut', chain.id) ?? stop(`no cut file in ${dir}: ${again}`);
const universePath =
  option('--universe') ??
  latestFile(dir, 'universe', chain.id) ??
  stop(`no universe file in ${dir}: ${again}`);

const cut = JSON.parse(readFileSync(cutPath, 'utf8')) as {
  chainId?: number;
  fetchedAt?: string;
  tracked?: Array<Partial<Wanted>>;
};
if (cut.chainId !== chain.chainId)
  stop(`${cutPath} is for chain ${cut.chainId}, not ${chain.chainId}`);
const isAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const tracked = (cut.tracked ?? []).map((t): Wanted => {
  if (!isAddress(t.address) || typeof t.symbol !== 'string' || t.symbol === '')
    return stop(`${cutPath}: a tracked stock has no address or no symbol`);
  return { address: t.address, symbol: t.symbol };
});
if (tracked.length === 0) stop(`${cutPath} names no tracked stock`);
const ageHours = (Date.now() - Date.parse(cut.fetchedAt ?? '')) / 3_600_000;
if (!Number.isFinite(ageHours) || ageHours < 0)
  stop(`${cutPath} says it was fetched at "${cut.fetchedAt}", which is not a time in the past`);
if (ageHours > MAX_AGE_HOURS && !flag('--allow-old'))
  stop(`${cutPath} is ${ageHours.toFixed(1)} hours old: ${again}, or pass --allow-old`);

const universe = readUniverse(universePath);
if (universe.chainId !== chain.chainId)
  stop(`${universePath} is for chain ${universe.chainId}, not ${chain.chainId}`);
// a tracked stock the token list does not hold could share its symbol with a token unseen
const unlisted = tracked.filter(
  (t) => !universe.tokens.some((u) => u.address.toLowerCase() === t.address.toLowerCase()),
);
if (unlisted.length > 0)
  stop(
    `${universePath} does not list ${unlisted.map((t) => t.symbol).join(', ')} of ${cutPath}: the two files are not of the same run`,
  );

const { url: rpcUrl, label } = rpcFor(chain);
const file = await runOracles(
  chain,
  {
    rpc: createRpc(rpcUrl),
    fetchJson: async (url) => {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the directory answered HTTP ${res.status}`);
      return res.json();
    },
    now: Date.now,
  },
  {
    directoryUrl,
    tracked,
    collected: chain.tokens,
    registry: universe.tokens,
    regime: defaultRegimeParams(JSON.parse(readFileSync(CALENDAR, 'utf8'))),
    rpcLabel: label,
    inputs: {
      cut: basename(cutPath),
      universe: basename(universePath),
      collected: 'scripts/risk-evm/config.ts',
      calendar: CALENDAR,
    },
  },
);

mkdirSync(dir, { recursive: true });
const out = join(dir, `oracles-${chain.id}-${stamp(new Date(file.fetchedAt))}.json`);
writeFileSync(`${out}.tmp`, `${JSON.stringify(file, null, 1)}\n`);
renameSync(`${out}.tmp`, out);

const say = (s = '') => console.log(s);
const age = (seconds: number) =>
  seconds < 5_400 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
const line = (r: OracleRow) =>
  r.feed
    ? `  ${r.symbol.padEnd(6)} ${r.feed.address}  "${r.feed.description}"  ${r.feed.decimals} dec  ${r.feed.round.price.padStart(16)}  ${age(r.feed.ageSeconds).padStart(8)} old`
    : `  ${r.symbol.padEnd(6)} no feed: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`;
const c = file.counts;
say(`${cutPath} (${ageHours.toFixed(1)} hours old), ${universePath}`);
say(
  `${file.directory.url}: ${file.directory.feeds} feeds${file.directory.skipped.length > 0 ? `, ${file.directory.skipped.length} left out (${file.directory.skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})` : ''}`,
);
say(
  `read at block ${file.block} (${file.fetchedAt}), ${file.session.inSession ? 'in session' : 'off session'} (${file.session.atBlock})`,
);
say();
for (const [k, v] of Object.entries(file.stated)) say(`${k}: ${v}\n`);
say(`Tracked stocks (${c.tracked}): ${c.trackedWithFeed} with a confirmed feed`);
for (const r of file.tracked) say(line(r));
say();
say(`Collected by config.ts and not tracked (${c.collectedNotTracked}):`);
for (const r of file.collectedNotTracked) say(line(r));
say();
say('Funds and the treasury token (nothing adjusted):');
for (const f of file.funds)
  say(
    `  ${f.symbol.padEnd(6)} ${f.tracked ? 'tracked' : 'not tracked'}  feed=${f.hasFeed ? 'yes' : 'no'}  prices=${f.prices ?? `unknown (${f.pricesReason})`}  directory: product=${f.productTypeCode ?? 'none'}, attribute=${f.attributeType ?? 'none'}, hours=${f.marketHours ?? 'none'}  registry multiplier=${f.registryMultiplier ?? 'none'}`,
  );
say();
say(
  `Of the confirmed feeds: ${c.feedsOlderThanTheVaultLimit} older than the vault's 26 hours, ${c.feedsOlderThanTheirHeartbeat} older than their heartbeat, ${c.aggregatorsNotAnsweringDirectly} whose aggregator does not answer a direct call. None is refused for it.`,
);
say(
  `Feeds naming a registry token outside both lists (${file.feedsOfOtherTokens.length}): ${file.feedsOfOtherTokens.map((f) => f.symbol).join(' ') || 'none'}`,
);
say();
say(
  `TRACKED STOCKS WITHOUT A CONFIRMED FEED: ${c.trackedWithoutFeed} of ${c.tracked}${c.trackedWithoutFeed > 0 ? `: ${file.trackedWithoutFeed.map((t) => `${t.symbol} (${t.reason})`).join(', ')}` : ''}`,
);
say(JSON.stringify({ wrote: out, block: file.block, ...c, rpc: file.rpc }));
