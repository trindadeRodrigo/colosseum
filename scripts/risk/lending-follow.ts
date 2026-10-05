import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  defaultLendingReportParams,
  type FollowContext,
  type FollowRow,
  followSummary,
  KNOWN_SWAP_PROGRAMS,
  type MoveOut,
  outflow,
  type RpcTx,
  seizedReceipt,
} from '@colosseum/risk';
import { LENDING_HISTORY_DIR, RISK_HOME } from './lib-lending';
import { rpc } from './lib-pools';

// PLAN-ANALYTICS item 13 — `pnpm risk:lending-follow`: for each liquidation whose transaction did not sell the seized
// collateral in a registry pool (item 9's `not_followed`), where the collateral went. The liquidation transaction is
// read from the lending history's raw bodies (no fetch). When the liquidator kept the units, its receiving token
// account is followed for `followHours`: getSignaturesForAddress pages back to the liquidation, then getTransaction in
// time order until the first outflow. Read-only, at most 2 requests at a time, no getProgramAccounts (DA3).
// Transactions are cached in follow/tx-cache.jsonl, so a re-run fetches only what is new.
// Writes follow/rows-<stamp>.jsonl (local: it names accounts and signatures) and follow/summary.json (by asset and
// outcome: counts, seized USD, median hours, realised price against the oracle; no wallet, DA4). The lending report
// reads summary.json.
const P = defaultLendingReportParams();
const DIR = join(LENDING_HISTORY_DIR, 'follow');
mkdirSync(DIR, { recursive: true });
const CONCURRENCY = 2;
const MAX_PAGES = 20;
const MAX_TX_PER_LIQ = 40;

type Liq = {
  s: string;
  slot: number;
  time: string;
  venue: string;
  liquidator: string;
  collateralMint: string;
  collateralSeized: string;
  collateralPrice: number | null;
  priceUnit: string;
  debtMint: string;
  sales: unknown[];
};
const liqs = readFileSync(join(LENDING_HISTORY_DIR, 'decoded', 'liquidations.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Liq)
  .filter((l) => l.sales.length === 0);

const registry = (
  JSON.parse(readFileSync(join(RISK_HOME, 'registry.json'), 'utf8')) as {
    pools: Array<{
      address: string;
      program: string;
      vault0: string;
      vault1: string;
      assetMint: string;
      assetSymbol: string;
    }>;
  }
).pools;
const symbolOf = new Map(registry.map((p) => [p.assetMint, p.assetSymbol]));
// lending collateral that is not a stock (USDC, cbBTC) takes the lending registry's symbol
for (const r of (
  JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
    rows: Array<{ mint?: string; symbol?: string | null }>;
  }
).rows)
  if (r.mint && r.symbol && !symbolOf.has(r.mint)) symbolOf.set(r.mint, r.symbol);
const ctx: FollowContext = {
  registryVaults: new Map(
    registry.flatMap((p) => [[p.vault0, p.address] as const, [p.vault1, p.address] as const]),
  ),
  swapPrograms: new Set([...registry.map((p) => p.program), ...KNOWN_SWAP_PROGRAMS]),
  dollarMints: new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  ]),
};

// raw liquidation transactions, from the history's day files
const rawTx = new Map<string, RpcTx>();
for (const day of new Set(liqs.map((l) => l.time.slice(0, 10)))) {
  const f = join(LENDING_HISTORY_DIR, 'raw', `${day}.jsonl.gz`);
  if (!existsSync(f)) continue;
  const want = new Set(liqs.filter((l) => l.time.startsWith(day)).map((l) => l.s));
  for (const line of gunzipSync(readFileSync(f)).toString('utf8').split('\n')) {
    if (!line) continue;
    const sig = line.slice(6, line.indexOf('"', 6));
    if (!want.has(sig)) continue;
    rawTx.set(sig, (JSON.parse(line) as { tx: RpcTx }).tx);
  }
}

// transaction cache
const CACHE = join(DIR, 'tx-cache.jsonl');
const cache = new Map<string, RpcTx | null>();
if (existsSync(CACHE))
  for (const l of readFileSync(CACHE, 'utf8').split('\n'))
    if (l) {
      const r = JSON.parse(l) as { s: string; tx: RpcTx | null };
      cache.set(r.s, r.tx);
    }
let fetched = 0;
const inflight = new Map<string, Promise<RpcTx | null>>();
const getTx = (s: string): Promise<RpcTx | null> => {
  if (cache.has(s)) return Promise.resolve(cache.get(s) as RpcTx | null);
  let p = inflight.get(s);
  if (!p) {
    p = rpc<RpcTx | null>('getTransaction', [
      s,
      { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]).then((tx) => {
      fetched++;
      cache.set(s, tx);
      appendFileSync(CACHE, `${JSON.stringify({ s, tx })}\n`);
      return tx;
    });
    inflight.set(s, p);
  }
  return p;
};

type Sig = { signature: string; slot: number; blockTime: number | null; err: unknown };
/** Every signature of `account` back to `untilTime` (newest first), or null past MAX_PAGES. */
const sigsCache = new Map<string, Promise<Sig[] | null>>();
let sigCalls = 0;
// signature lists on disk: reused when they were read after every follow window of the account had closed
const SIG_CACHE = join(DIR, 'sig-cache.json');
const sigDisk = (
  existsSync(SIG_CACHE) ? JSON.parse(readFileSync(SIG_CACHE, 'utf8')) : {}
) as Record<string, { readAt: number; sigs: Sig[] }>;
const latestWindowEnd = new Map<string, number>();
const fetchSigs = async (account: string, untilTime: number): Promise<Sig[] | null> => {
  const disk = sigDisk[account];
  if (disk && disk.readAt > (latestWindowEnd.get(account) ?? Number.POSITIVE_INFINITY))
    return disk.sigs;
  const all: Sig[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await rpc<Sig[]>('getSignaturesForAddress', [
      account,
      { limit: 1000, ...(before ? { before } : {}), commitment: 'confirmed' },
    ]);
    sigCalls++;
    all.push(...r);
    const last = r.at(-1);
    if (r.length < 1000 || !last || (last.blockTime ?? 0) < untilTime) {
      sigDisk[account] = { readAt: Date.now() / 1000, sigs: all };
      writeFileSync(SIG_CACHE, JSON.stringify(sigDisk));
      return all;
    }
    before = last.signature;
  }
  return null;
};
// one fetch per account, shared by the workers
const sigsBack = (account: string, untilTime: number): Promise<Sig[] | null> => {
  let p = sigsCache.get(account);
  if (!p) {
    p = fetchSigs(account, untilTime);
    sigsCache.set(account, p);
  }
  return p;
};

const rows: Array<FollowRow & { signature: string; outSignature?: string; pool?: string | null }> =
  [];
const stats = { liquidations: liqs.length, rawFound: 0, notTraced: [] as string[] };
const earliest = new Map<string, number>();
const receipts = liqs.map((l) => {
  const tx = rawTx.get(l.s);
  if (!tx) return { l, r: null };
  stats.rawFound++;
  const r = seizedReceipt(tx, l, ctx);
  if (r.kept === true)
    for (const a of r.accounts) {
      const t = Date.parse(l.time) / 1000;
      earliest.set(a, Math.min(earliest.get(a) ?? t, t));
      const end = t + P.followHours * 3600;
      latestWindowEnd.set(a, Math.max(latestWindowEnd.get(a) ?? end, end));
    }
  return { l, r, tx };
});
const decimalsOf = (tx: RpcTx | undefined, mint: string) => {
  for (const b of [
    ...(tx?.meta?.postTokenBalances ?? []),
    ...(tx?.meta?.preTokenBalances ?? []),
  ] as Array<{
    mint?: string;
    uiTokenAmount: { decimals?: number };
  }>)
    if (b.mint === mint) return b.uiTokenAmount.decimals ?? 0;
  return null;
};

const queue = [...receipts];
const worker = async () => {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { l, r, tx } = item as (typeof receipts)[number] & { tx?: RpcTx };
    const dec = decimalsOf(tx, l.collateralMint);
    const seizedUnits = Number(l.collateralSeized) / 10 ** (dec ?? 0);
    // USD at the program's collateral price; a price in a dollar debt token at par (the lending report's rule)
    const oracle =
      l.priceUnit === 'usd' || (l.priceUnit === 'debt_token' && ctx.dollarMints.has(l.debtMint))
        ? l.collateralPrice
        : null;
    const base = {
      signature: l.s,
      asset: symbolOf.get(l.collateralMint) ?? l.collateralMint.slice(0, 6),
      venue: l.venue,
      seizedUsd: oracle && dec !== null ? seizedUnits * oracle : null,
      oraclePrice: oracle,
    };
    const share = (m: MoveOut) => Number(m.units) / Number(l.collateralSeized);
    if (!r || r.kept === null) {
      rows.push({ ...base, outcome: 'not_traced', hours: null, share: null, realisedUsd: null });
      stats.notTraced.push(`${l.s.slice(0, 8)}: ${r ? r.reason : 'raw transaction not on disk'}`);
      continue;
    }
    if (r.kept === false) {
      const o = r.out;
      rows.push({
        ...base,
        outcome:
          o.outcome === 'sold_registry_pool'
            ? 'sold_same_tx_registry_pool'
            : o.outcome === 'sold_outside_registry'
              ? 'sold_same_tx_outside_registry'
              : 'transferred_same_tx',
        hours: 0,
        share: share(o),
        realisedUsd: o.realisedUsd,
        pool: o.pool,
      });
      continue;
    }
    const t0 = Date.parse(l.time) / 1000;
    const until = t0 + P.followHours * 3600;
    const sigs = new Map<string, Sig>();
    let tooActive = false;
    for (const a of r.accounts) {
      const s = await sigsBack(a, earliest.get(a) ?? t0);
      if (!s) tooActive = true;
      for (const x of s ?? []) sigs.set(x.signature, x);
    }
    if (tooActive) {
      rows.push({ ...base, outcome: 'not_traced', hours: null, share: null, realisedUsd: null });
      stats.notTraced.push(`${l.s.slice(0, 8)}: account history beyond ${MAX_PAGES} pages`);
      continue;
    }
    const after = [...sigs.values()]
      .filter((x) => !x.err && x.slot > l.slot && x.blockTime !== null && x.blockTime <= until)
      .sort((a, b) => a.slot - b.slot);
    let found: { m: MoveOut; s: Sig } | null = null;
    let complete = after.length <= MAX_TX_PER_LIQ;
    for (const s of after.slice(0, MAX_TX_PER_LIQ)) {
      const t = await getTx(s.signature);
      if (!t) {
        complete = false;
        continue;
      }
      const m = outflow(t, r.accounts, l.collateralMint, ctx);
      if (m) {
        found = { m, s };
        break;
      }
    }
    if (found)
      rows.push({
        ...base,
        outcome: found.m.outcome,
        hours: ((found.s.blockTime as number) - t0) / 3600,
        share: share(found.m),
        realisedUsd: found.m.realisedUsd,
        outSignature: found.s.signature,
        pool: found.m.pool,
      });
    else if (complete)
      rows.push({ ...base, outcome: 'held', hours: null, share: null, realisedUsd: null });
    else {
      rows.push({ ...base, outcome: 'not_traced', hours: null, share: null, realisedUsd: null });
      stats.notTraced.push(
        `${l.s.slice(0, 8)}: more than ${MAX_TX_PER_LIQ} transactions before an outflow`,
      );
    }
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const generatedAt = new Date().toISOString();
const stamp = generatedAt.replace(/[-:]/g, '').slice(0, 13);
writeFileSync(
  join(DIR, `rows-${stamp}.jsonl`),
  `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
);
const counts: Record<string, number> = {};
for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
const summary = {
  generatedAt,
  followHours: P.followHours,
  source:
    'lending history raw bodies (liquidation transactions); Solana RPC getSignaturesForAddress and getTransaction (after them)',
  method:
    'follow-seized-0.1: liquidator receipt in the liquidation transaction, then the first outflow within followHours',
  methodVersion: 'follow-0.1',
  provenance: 'live',
  liquidations: rows.length,
  counts,
  byAsset: followSummary(rows),
};
writeFileSync(join(DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify({
    ...stats,
    notTraced: stats.notTraced.length,
    notTracedSample: stats.notTraced.slice(0, 5),
    counts,
    rpc: {
      getSignaturesForAddress: sigCalls,
      getTransaction: fetched,
      fromCache: cache.size - fetched,
    },
  }),
);
