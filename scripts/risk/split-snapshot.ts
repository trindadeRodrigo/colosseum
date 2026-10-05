import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPoolSim,
  decodeClmmPool,
  type PoolRef,
  type RoutePool,
  routeTrade,
  usdCurves,
} from '@colosseum/risk';
import { multipleAccounts, RISK_HOME, SPLIT_DIR } from './lib-lending';

// PLAN-ANALYTICS item 4, DA7 (a) — `pnpm risk:split-snapshot`: our own read-only snapshot of every asset's dollar and
// SOL exit pools, routed with routeTrade so each row stores what the collector's rows lack: the amount sent to each
// pool and the cost split (pool fee, transfer fee, basis, impact). Reads the collector's registry and cached child
// accounts (no getProgramAccounts, DA3); one getMultipleAccounts batch of 100 at a time; the SOL price from Jupiter's
// public price API, as the collector does. Writes only SPLIT_DIR/<day>.jsonl (data/risk/split
// unless RISK_DATA_DIR is set). Sends no transaction.
// Each asset is compared with the collector's routed row nearest in time (`vsCollector`), which measures the drift
// between the two snapshots, not an error of either.
const METHOD_VERSION = 'split-0.1';
const NOTIONALS = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const USD_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const SOL = 'So11111111111111111111111111111111111111112';
type RegPool = PoolRef & {
  assetSymbol: string;
  quoteMint: string;
  exitPath: string;
  tier: string;
  tvlUsd: number;
  decimals0: number;
  decimals1: number;
  vault0: string;
  vault1: string;
};
const registry = (
  JSON.parse(readFileSync(join(RISK_HOME, 'registry.json'), 'utf8')) as {
    pools: Array<Omit<RegPool, 'assetIsToken0'> & { assetIsToken0: boolean | number }>;
  }
).pools
  .filter(
    (p) => (p.exitPath === 'direct_usd' || p.exitPath === 'via_sol') && ['A', 'B'].includes(p.tier),
  )
  .map((p) => ({ ...p, assetIsToken0: Boolean(p.assetIsToken0) })) as RegPool[];
const cache = JSON.parse(readFileSync(join(RISK_HOME, 'cache.json'), 'utf8')) as {
  children: Record<string, string[]>;
};
const b = (a: { data: Uint8Array } | null | undefined) => a?.data;

const t0 = Date.now();
const heads = await multipleAccounts(registry.map((p) => p.address));
const cfgKeys = registry
  .filter((p) => p.venue === 'raydium_clmm')
  .map((p) => {
    const h = b(heads.accounts.get(p.address));
    return h ? decodeClmmPool(h).ammConfig : null;
  })
  .filter((k): k is string => !!k);
const childKeys = registry.flatMap((p) => cache.children[p.address] ?? []);
const rest = await multipleAccounts([...new Set([...cfgKeys, ...childKeys])]);
const fetchedAt = new Date().toISOString();
const solUsd = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, {
  signal: AbortSignal.timeout(20_000),
})
  .then((r) => r.json() as Promise<Record<string, { usdPrice?: number }>>)
  .then((r) => r[SOL]?.usdPrice ?? null)
  .catch(() => null);

const byAsset = new Map<string, RoutePool[]>();
const meta = new Map<string, { symbol: string }>();
const failures: string[] = [];
for (const p of registry) {
  const head = b(heads.accounts.get(p.address));
  if (!head) {
    failures.push(`${p.address}: head missing`);
    continue;
  }
  const quoteUsd = USD_MINTS.has(p.quoteMint) ? 1 : p.quoteMint === SOL ? solUsd : null;
  if (!quoteUsd) {
    failures.push(`${p.address}: no USD for quote ${p.quoteMint}`);
    continue;
  }
  try {
    const cfg =
      p.venue === 'raydium_clmm' ? b(rest.accounts.get(decodeClmmPool(head).ammConfig)) : undefined;
    const kids = (cache.children[p.address] ?? [])
      .map((k) => b(rest.accounts.get(k)))
      .filter((d): d is Uint8Array => !!d);
    const built = buildPoolSim(p, head, kids, cfg);
    const decAsset = p.assetIsToken0 ? p.decimals0 : p.decimals1;
    const decQuote = p.assetIsToken0 ? p.decimals1 : p.decimals0;
    const midUsd = usdCurves(built.sim, decAsset, decQuote, quoteUsd, [100]).midUsd;
    if (!(midUsd > 0)) continue;
    byAsset.set(p.assetMint, [
      ...(byAsset.get(p.assetMint) ?? []),
      {
        pool: p.address,
        sim: built.sim,
        decAsset,
        decQuote,
        quoteUsd,
        midUsd,
        tvlUsd: p.tvlUsd,
        feeRate: built.feeRate,
        transferFeeBps: {
          asset: p.assetIsToken0 ? p.transferFeeBps0 : p.transferFeeBps1,
          quote: p.assetIsToken0 ? p.transferFeeBps1 : p.transferFeeBps0,
        },
      },
    ]);
    meta.set(p.assetMint, { symbol: p.assetSymbol });
  } catch (e) {
    failures.push(`${p.address}: ${String(e).slice(0, 80)}`);
  }
}

// the collector's routed row nearest in time, per asset, for the drift comparison
const day = fetchedAt.slice(0, 10);
const collectorFile = join(RISK_HOME, 'assets', `${day}.jsonl`);
const collector = new Map<
  string,
  { fetchedAt: string; pools: number; sell: Array<{ notionalUsd: number; costPct: number }> }
>();
if (existsSync(collectorFile))
  for (const l of readFileSync(collectorFile, 'utf8').split('\n')) {
    if (!l) continue;
    const r = JSON.parse(l) as {
      assetMint: string;
      fetchedAt: string;
      pools: number;
      sell: Array<{ notionalUsd: number; costPct: number }>;
    };
    const prev = collector.get(r.assetMint);
    if (
      !prev ||
      Math.abs(Date.parse(r.fetchedAt) - Date.parse(fetchedAt)) <
        Math.abs(Date.parse(prev.fetchedAt) - Date.parse(fetchedAt))
    )
      collector.set(r.assetMint, r);
  }

const outDir = SPLIT_DIR;
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${day}.jsonl`);
const drift: number[] = [];
let rows = 0;
for (const [mint, pools] of byAsset) {
  const c = collector.get(mint);
  for (const side of ['sell', 'buy'] as const)
    for (const n of NOTIONALS) {
      const r = routeTrade(pools, n, side);
      const cc = side === 'sell' ? c?.sell.find((x) => x.notionalUsd === n) : undefined;
      if (cc && n <= 250_000) drift.push(Math.abs(r.costPct - cc.costPct));
      appendFileSync(
        file,
        `${JSON.stringify({
          assetMint: mint,
          asset: meta.get(mint)?.symbol,
          fetchedAt,
          slot: rest.slot,
          side,
          notionalUsd: n,
          outUsd: r.outUsd,
          costPct: r.costPct,
          poolsUsed: r.poolsUsed,
          pools: pools.length,
          refPool: r.refPool,
          refMidUsd: r.refMidUsd,
          split: r.split,
          legs: r.legs,
          solUsd,
          vsCollector:
            cc && c ? { fetchedAt: c.fetchedAt, pools: c.pools, costPct: cc.costPct } : null,
          source:
            'Solana RPC getMultipleAccounts (pool and child accounts from the collector cache); Jupiter price API (SOL)',
          method: 'routed_greedy_32_chunks with per-pool split (packages/risk/src/pools/route.ts)',
          methodVersion: METHOD_VERSION,
          provenance: 'live',
        })}\n`,
      );
      rows++;
    }
}
drift.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    file,
    fetchedAt,
    seconds: Math.round((Date.now() - t0) / 1000),
    accounts: heads.accounts.size + rest.accounts.size,
    pools: [...byAsset.values()].reduce((s, p) => s + p.length, 0),
    assets: byAsset.size,
    rows,
    solUsd,
    failures: failures.length,
    failureSample: failures.slice(0, 3),
    vsCollectorSellUpTo250k: drift.length
      ? {
          n: drift.length,
          medianAbsPp: drift[Math.floor(drift.length / 2)],
          p90AbsPp: drift[Math.floor(drift.length * 0.9)],
        }
      : null,
  }),
);
