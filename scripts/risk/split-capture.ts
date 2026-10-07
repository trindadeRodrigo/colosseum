import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { multipleAccounts, RISK_HOME } from './lib-lending';
import { rpcStats } from './lib-pools';
import { readSplitCapture, SOL, saveCapture, selectSplitPools } from './lib-split';
import solanaList from './universe/solana.json';

// PLAN-UNIVERSE RU.11 — `pnpm risk:split-capture <out.json.gz> [--two-hop] [--only SYMBOL,…]`: freezes what one split
// snapshot reads (the registry rows, the pool, config and child accounts, the SOL price) into one file, so the router
// can be run again on the same pools: by `RISK_SPLIT_REPLAY` in `pnpm risk:split-snapshot`, by
// `pnpm risk:routing-gap --router`, and by the tests (fixtures/risk/route). Read-only: getMultipleAccounts and one
// public GET. Writes the one file named and nothing else. RISK_SPLIT_TWO_HOP=1 is taken as `--two-hop`.
// `--only` keeps the pools of the stocks named and, with `--two-hop`, the pools that pair them with another stock and
// that stock's dollar and SOL pools: a small file for a fixture. The file records the stocks named (`only`): the
// partners it pulls in come with part of their stock-to-stock pools, so two hops are measured for the named stocks
// only.
const USAGE =
  'usage: split-capture.ts <out.json.gz> [--two-hop] [--only SYMBOL,…] (RISK_SPLIT_TWO_HOP=1 in place of --two-hop)';
const args = process.argv.slice(2);
// an option it does not know, or --only given twice, is a mistake in the command, not something to pass over
if (
  args.some((a) => a.startsWith('--') && a !== '--two-hop' && a !== '--only') ||
  args.filter((a) => a === '--only').length > 1
)
  throw new Error(USAGE);
const twoHop = args.includes('--two-hop') || process.env.RISK_SPLIT_TWO_HOP === '1';
const onlyAt = args.indexOf('--only');
const onlyValue = onlyAt >= 0 ? (args[onlyAt + 1] ?? '') : null;
const only =
  onlyValue === null
    ? null
    : new Set(onlyValue.startsWith('--') ? [] : onlyValue.split(',').filter(Boolean));
if (only && !only.size) throw new Error(USAGE);
// the output file is the first argument that is neither an option nor the value of --only
const out = args.find((a, i) => !a.startsWith('--') && (onlyAt < 0 || i !== onlyAt + 1));
if (!out) throw new Error(USAGE);

const reg = JSON.parse(readFileSync(join(RISK_HOME, 'registry.json'), 'utf8')) as {
  fetchedAt?: string;
  methodVersion?: string;
  pools: Parameters<typeof selectSplitPools>[0];
};
const cache = JSON.parse(readFileSync(join(RISK_HOME, 'cache.json'), 'utf8')) as {
  children: Record<string, string[]>;
};
const tracked = twoHop ? solanaList.assets.map((a) => a.address) : [];
let sel = selectSplitPools(reg.pools, { twoHop, tracked: new Set(tracked) });
if (only) {
  const pairs = sel.twoHop.filter((p) => only.has(p.assetSymbol) || only.has(p.quoteSymbol ?? ''));
  const partners = new Set(pairs.flatMap((p) => [p.assetMint, p.quoteMint]));
  sel = {
    direct: sel.direct.filter((p) => only.has(p.assetSymbol) || partners.has(p.assetMint)),
    twoHop: pairs,
    listed: sel.listed,
  };
}
const capture = await readSplitCapture(
  sel,
  cache.children,
  {
    twoHop,
    only: only ? [...only] : null,
    tracked,
    trackedSource: twoHop ? 'scripts/risk/universe/solana.json' : null,
    registry: { fetchedAt: reg.fetchedAt ?? null, methodVersion: reg.methodVersion ?? null },
  },
  {
    read: multipleAccounts,
    solUsd: () =>
      fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, { signal: AbortSignal.timeout(20_000) })
        .then((r) => r.json() as Promise<Record<string, { usdPrice?: number }>>)
        .then((r) => r[SOL]?.usdPrice ?? null)
        .catch(() => null),
    now: () => new Date(),
    rpcCalls: () => rpcStats.calls,
  },
);
saveCapture(out, capture);
const got = Object.values(capture.accounts).filter(Boolean).length;
console.log(
  JSON.stringify({
    file: out,
    fetchedAt: capture.fetchedAt,
    twoHop,
    only: capture.only ?? null,
    directPools: capture.direct.length,
    twoHopPools: capture.twoHopPools.length,
    accounts: Object.keys(capture.accounts).length,
    accountsMissing: Object.keys(capture.accounts).length - got,
    slotHeads: capture.slotHeads,
    slot: capture.slot,
    solUsd: capture.solUsd,
    rpcCalls: capture.rpc.calls,
    seconds: capture.rpc.seconds,
    retries429: rpcStats.retries429,
    errors: rpcStats.errors,
  }),
);
