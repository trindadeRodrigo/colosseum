import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Pareto structure of xStocks pools from the latest discovery file: how many pools (and assets) hold
// 80/90/95/99% of liquidity and of 24h volume, broken down by venue. Pairs between two xStocks appear
// under both assets and are counted once (by pair address).
const OUT = process.env.RISK_DATA_DIR ?? 'data/risk';
const file =
  process.argv[2] ??
  join(
    OUT,
    readdirSync(OUT)
      .filter((n) => n.startsWith('pools-dexscreener-') && n.endsWith('.jsonl'))
      .sort()
      .at(-1) as string,
  );

type Pair = {
  pairAddress: string;
  dexId: string;
  labels?: string[];
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};
const pools = new Map<
  string,
  { addr: string; venue: string; pair: string; assets: string[]; liq: number; vol: number }
>();
let fetchedAt = '';
let rowsWithError = 0;
for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line) as { pairs: Pair[]; error: string | null; fetchedAt: string };
  if (r.error) rowsWithError++;
  fetchedAt ||= r.fetchedAt;
  for (const p of r.pairs ?? []) {
    if (pools.has(p.pairAddress)) continue;
    const xs = [p.baseToken, p.quoteToken]
      .filter((t) => t.address.startsWith('Xs'))
      .map((t) => t.symbol);
    pools.set(p.pairAddress, {
      addr: p.pairAddress,
      venue: `${p.dexId}${p.labels?.length ? `:${p.labels.join('/')}` : ''}`,
      pair: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
      assets: xs,
      liq: p.liquidity?.usd ?? 0,
      vol: p.volume?.h24 ?? 0,
    });
  }
}
const all = [...pools.values()];
const total = (k: 'liq' | 'vol') => all.reduce((s, p) => s + p[k], 0);
const cut = (k: 'liq' | 'vol') => {
  const sorted = [...all].sort((a, b) => b[k] - a[k]);
  const T = total(k);
  const out: Record<string, { pools: number; assets: number }> = {};
  for (const q of [0.8, 0.9, 0.95, 0.99]) {
    let s = 0;
    let n = 0;
    const assets = new Set<string>();
    for (const p of sorted) {
      if (s >= q * T) break;
      s += p[k];
      n++;
      for (const a of p.assets) assets.add(a);
    }
    out[`${q * 100}%`] = { pools: n, assets: assets.size };
  }
  return {
    totalUsd: Math.round(T),
    ...out,
    top: sorted.slice(0, 15).map((p) => `${p.pair} ${p.venue} ${Math.round(p[k])}`),
  };
};
const byVenue = new Map<string, { pools: number; liq: number; vol: number }>();
for (const p of all) {
  const v = byVenue.get(p.venue) ?? { pools: 0, liq: 0, vol: 0 };
  v.pools++;
  v.liq += p.liq;
  v.vol += p.vol;
  byVenue.set(p.venue, v);
}
const assetsWithPools = new Set(all.flatMap((p) => p.assets));
const report = {
  file,
  fetchedAt,
  source:
    'api.dexscreener.com token-pairs (discovery only; liquidity and volume are DexScreener estimates)',
  rowsWithError,
  pools: all.length,
  assetsWithAnyPool: assetsWithPools.size,
  poolsWithZeroLiquidity: all.filter((p) => p.liq === 0).length,
  liquidity: cut('liq'),
  volume24h: cut('vol'),
  byVenue: [...byVenue.entries()]
    .sort((a, b) => b[1].liq - a[1].liq)
    .map(([venue, v]) => ({
      venue,
      pools: v.pools,
      liqUsd: Math.round(v.liq),
      vol24hUsd: Math.round(v.vol),
    })),
};
writeFileSync(file.replace('.jsonl', '.pareto.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
