import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Step 3 report: Jupiter quote vs our best single-pool simulation at the nearest pool snapshot (≤ 5 min).
// gap = Jupiter output ÷ simulated output − 1 (sell side, USD). gap > 0: routing across pools adds depth
// (our curves are a lower bound, as documented). gap < −FLAG: the simulation overstates depth → investigate.
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const FLAG = Number(process.env.RISK_GAP_FLAG ?? 0.002);
const read = (dir: string) =>
  existsSync(join(HOME, dir))
    ? readdirSync(join(HOME, dir))
        .filter((n) => n.endsWith('.jsonl'))
        .flatMap((n) =>
          readFileSync(join(HOME, dir, n), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        )
    : [];
type Snap = {
  pool: string;
  assetMint: string;
  fetchedAt: string;
  exitPath: string;
  midUsd: number | null;
  sell: Array<{ notionalUsd: number; outUsd: number }> | null;
};
const snaps = (read('pools') as Snap[]).filter(
  (s) => s.sell && s.midUsd && s.exitPath === 'direct_usd',
);
// per asset and snapshot time: each pool's mid and sell curve
const byAssetTime = new Map<string, Map<string, Snap[]>>();
for (const s of snaps) {
  const a = byAssetTime.get(s.assetMint) ?? new Map<string, Snap[]>();
  a.set(s.fetchedAt, [...(a.get(s.fetchedAt) ?? []), s]);
  byAssetTime.set(s.assetMint, a);
}
// USD out of selling `units` through one pool: notional at the pool's own mid, cost interpolated in ln n
const outVia = (s: Snap, units: number): number | null => {
  const n = units * (s.midUsd as number);
  const pts = (s.sell ?? [])
    .map((p) => ({ n: p.notionalUsd, c: 1 - p.outUsd / p.notionalUsd }))
    .sort((x, y) => x.n - y.n);
  const hi = pts.findIndex((p) => p.n >= n);
  if (hi < 0) return null;
  let c: number;
  if (hi === 0 || pts[hi]?.n === n) c = pts[hi]?.c as number;
  else {
    const a = pts[hi - 1] as { n: number; c: number };
    const b = pts[hi] as { n: number; c: number };
    c = a.c + ((Math.log(n) - Math.log(a.n)) / (Math.log(b.n) - Math.log(a.n))) * (b.c - a.c);
  }
  return n * (1 - c);
};
type Q = {
  asset: string;
  assetMint: string;
  side: string;
  notionalUsd: number;
  amountIn: string;
  outAmount: string | null;
  fetchedAt: string;
  route: Array<{ pool: string; percent: number }> | null;
};
const quotes = (read('quotes') as Q[]).filter((q) => q.side === 'sell' && q.outAmount);
const rows: Array<{ asset: string; n: number; gap: number; pools: number }> = [];
for (const q of quotes) {
  const a = byAssetTime.get(q.assetMint);
  if (!a) continue;
  const tq = Date.parse(q.fetchedAt);
  let nearest: string | null = null;
  for (const t of a.keys())
    if (
      Math.abs(Date.parse(t) - tq) <= 5 * 60_000 &&
      (!nearest || Math.abs(Date.parse(t) - tq) < Math.abs(Date.parse(nearest) - tq))
    )
      nearest = t;
  if (!nearest) continue;
  const units = Number(q.amountIn) / 1e8;
  const outs = (a.get(nearest) as Snap[])
    .map((s) => outVia(s, units))
    .filter((x): x is number => x !== null);
  if (!outs.length) continue;
  const simUsd = Math.max(...outs);
  rows.push({
    asset: q.asset,
    n: q.notionalUsd,
    gap: Number(q.outAmount) / 1e6 / simUsd - 1,
    pools: new Set((q.route ?? []).map((r) => r.pool)).size,
  });
}
const byAsset = new Map<string, number[]>();
for (const r of rows)
  byAsset.set(`${r.asset} $${r.n}`, [...(byAsset.get(`${r.asset} $${r.n}`) ?? []), r.gap]);
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] as number;
const report = [...byAsset.entries()].sort().map(([k, xs]) => ({
  key: k,
  samples: xs.length,
  medianGapPct: Number((median(xs) * 100).toFixed(3)),
  minGapPct: Number((Math.min(...xs) * 100).toFixed(3)),
}));
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      comparisons: rows.length,
      flagged: rows.filter((r) => r.gap < -FLAG).length,
      flagThresholdPct: FLAG * 100,
      note: 'xStocks have 8 decimals (amountIn / 1e8). gap > 0 = routing beats our best single pool (curves are conservative).',
      byAssetAndSize: report,
    },
    null,
    1,
  ),
);
