import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ByrealForCapture, type ByrealPoolsFile, byrealForCapture } from './byreal/lib';
import { listByrealChildAddresses, mintTransferFeeBps } from './byreal/read';
import { multipleAccounts, RISK_HOME } from './lib-lending';
import { rpcStats } from './lib-pools';
import { readSplitCapture, SOL, saveCapture, selectSplitPools } from './lib-split';
import { selectRawArrayPools } from './raw-arrays/lib';
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
// `--raw-arrays` (PLAN-UNIVERSE RU.12) freezes what the raw-arrays job reads instead: every concentrated-liquidity
// pool of the tracked stocks that the pool collector does not record itself, whatever its exit path, with `--only`
// keeping the pools filed under the stocks named. It is the same file kind, its pools in `direct`; it cannot be
// combined with two hops.
// `--byreal <table.json>` (PLAN-UNIVERSE RU.15; off unless given) adds Byreal's pools to the capture: the pools of a
// table written by `pnpm risk:byreal-pools` that pair a tracked stock with a dollar token, hold $1,000 or more and
// have a fee their own accounts give, with every account each of them owns. They go in `direct` after the registry's
// pools, and the capture's `byreal` key names them and the pools left out, each with its reason. It costs two batch
// reads, one read of the mints and one getProgramAccounts a pool taken, before the capture's own read; no oracle
// account is read. Nothing routes those pools unless asked (`pnpm risk:routing-gap --router --byreal`,
// RISK_SPLIT_BYREAL=<table.json> in `pnpm risk:split-snapshot`). It cannot be combined with `--raw-arrays`. Without the option
// the requests sent and the file written are what they were.
const USAGE =
  'usage: split-capture.ts <out.json.gz> [--two-hop | --raw-arrays] [--only SYMBOL,…] (RISK_SPLIT_TWO_HOP=1 in place of --two-hop)\n       [--byreal <table.json>] adds Byreal’s pools from a table of `pnpm risk:byreal-pools` (not with --raw-arrays)';
const args = process.argv.slice(2);
// an option it does not know, or one that takes a value given twice, is a mistake in the command, not something to
// pass over
if (
  args.some(
    (a) =>
      a.startsWith('--') &&
      a !== '--two-hop' &&
      a !== '--only' &&
      a !== '--raw-arrays' &&
      a !== '--byreal',
  ) ||
  args.filter((a) => a === '--only').length > 1 ||
  args.filter((a) => a === '--byreal').length > 1
)
  throw new Error(USAGE);
const twoHop = args.includes('--two-hop') || process.env.RISK_SPLIT_TWO_HOP === '1';
const rawArrays = args.includes('--raw-arrays');
if (rawArrays && twoHop) throw new Error(USAGE);
const onlyAt = args.indexOf('--only');
const onlyValue = onlyAt >= 0 ? (args[onlyAt + 1] ?? '') : null;
const only =
  onlyValue === null
    ? null
    : new Set(onlyValue.startsWith('--') ? [] : onlyValue.split(',').filter(Boolean));
if (only && !only.size) throw new Error(USAGE);
const byrealAt = args.indexOf('--byreal');
const byrealTable = byrealAt >= 0 ? (args[byrealAt + 1] ?? '') : null;
if (byrealTable !== null && (!byrealTable || byrealTable.startsWith('--') || rawArrays))
  throw new Error(USAGE);
// the output file is the first argument that is neither an option nor the value of one
const out = args.find(
  (a, i) =>
    !a.startsWith('--') && (onlyAt < 0 || i !== onlyAt + 1) && (byrealAt < 0 || i !== byrealAt + 1),
);
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
if (rawArrays) {
  const raw = selectRawArrayPools(reg.pools, {
    tracked: new Set(solanaList.assets.map((a) => a.address)),
  });
  sel = {
    direct: raw.read.filter((p) => !only || only.has(p.assetSymbol)),
    twoHop: [],
    listed: null,
  };
} else if (only) {
  const pairs = sel.twoHop.filter((p) => only.has(p.assetSymbol) || only.has(p.quoteSymbol ?? ''));
  const partners = new Set(pairs.flatMap((p) => [p.assetMint, p.quoteMint]));
  sel = {
    direct: sel.direct.filter((p) => only.has(p.assetSymbol) || partners.has(p.assetMint)),
    twoHop: pairs,
    listed: sel.listed,
  };
}
let byreal: ByrealForCapture | null = null;
if (byrealTable !== null) {
  const table = JSON.parse(readFileSync(byrealTable, 'utf8')) as ByrealPoolsFile;
  byreal = await byrealForCapture(
    { ...table, file: byrealTable },
    { only },
    {
      read: multipleAccounts,
      transferFeeBps: mintTransferFeeBps,
      listChildren: listByrealChildAddresses,
      rpcCalls: () => rpcStats.calls,
    },
  );
  sel = { ...sel, direct: [...sel.direct, ...byreal.pools] };
}
const capture = await readSplitCapture(
  sel,
  byreal ? { ...cache.children, ...byreal.children } : cache.children,
  {
    twoHop,
    only: only ? [...only] : null,
    tracked,
    trackedSource: twoHop ? 'scripts/risk/universe/solana.json' : null,
    registry: { fetchedAt: reg.fetchedAt ?? null, methodVersion: reg.methodVersion ?? null },
    ...(byreal ? { byreal: byreal.meta } : {}),
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
    rawArrays,
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
    ...(capture.byreal
      ? {
          byreal: {
            pools: capture.byreal.pools.length,
            leftOut: capture.byreal.leftOut.map((l) => `${l.pool.slice(0, 6)}: ${l.reason}`),
            accounts: capture.byreal.pools.reduce(
              (n, p) => n + 1 + (capture.children[p]?.length ?? 0),
              0,
            ),
            slot: capture.byreal.slot,
            rpcCalls: capture.byreal.rpcCalls,
          },
        }
      : {}),
  }),
);
