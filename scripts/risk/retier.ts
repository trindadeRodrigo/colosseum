import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, riskPools } from '@colosseum/db';
import { eq } from 'drizzle-orm';

// Re-tiers the latest registry without re-reading the chain. Tiers (policy inputs):
//   A: pools that together hold TIER_A_SHARE of TVL among pools with TVL ≥ MIN_POOL_TVL_USD (5-min refresh)
//   B: other pools with TVL ≥ MIN_POOL_TVL_USD (hourly)
//   X: dust (TVL below MIN_POOL_TVL_USD) — kept in the registry, not collected.
const TIER_A_SHARE = Number(process.env.TIER_A_SHARE ?? 0.99);
const MIN_POOL_TVL_USD = Number(process.env.MIN_POOL_TVL_USD ?? 1000);
const OUT = process.env.RISK_DATA_DIR ?? 'data/risk';
const file = join(
  OUT,
  readdirSync(OUT)
    .filter((n) => n.startsWith('registry-2') && n.endsWith('.json'))
    .sort()
    .at(-1) as string,
);
const reg = JSON.parse(readFileSync(file, 'utf8')) as {
  pools: Array<{
    address: string;
    tvlUsd: number;
    tier: string;
    assetSymbol: string;
    venue: string;
  }>;
  [k: string]: unknown;
};
const live = reg.pools
  .filter((p) => (p.tvlUsd ?? 0) >= MIN_POOL_TVL_USD)
  .sort((a, b) => b.tvlUsd - a.tvlUsd);
const total = live.reduce((s, p) => s + p.tvlUsd, 0);
let cum = 0;
const tierOf = new Map<string, string>();
for (const p of live) {
  tierOf.set(p.address, cum < TIER_A_SHARE * total ? 'A' : 'B');
  cum += p.tvlUsd;
}
for (const p of reg.pools) p.tier = tierOf.get(p.address) ?? 'X';
const { db, client } = createDb();
for (const p of reg.pools)
  await db
    .update(riskPools)
    .set({
      tier: p.tier,
      statusReason: p.tier === 'X' ? `dust: tvl < ${MIN_POOL_TVL_USD} USD` : null,
    })
    .where(eq(riskPools.address, p.address));
await client.end();
Object.assign(reg, {
  tierAShare: TIER_A_SHARE,
  minPoolTvlUsd: MIN_POOL_TVL_USD,
  retieredAt: new Date().toISOString(),
});
writeFileSync(file, JSON.stringify(reg, null, 1));
const home = join(homedir(), '.colosseum', 'risk');
mkdirSync(home, { recursive: true });
// the collector only needs pools it will read
writeFileSync(
  join(home, 'registry.json'),
  JSON.stringify({ ...reg, pools: reg.pools.filter((p) => p.tier !== 'X') }),
);
const count = (t: string) => reg.pools.filter((p) => p.tier === t).length;
const pareto = (q: number) => {
  let s = 0;
  let n = 0;
  for (const p of live) {
    if (s >= q * total) break;
    s += p.tvlUsd;
    n++;
  }
  return n;
};
console.log(
  JSON.stringify({
    file,
    tierA: count('A'),
    tierB: count('B'),
    dust: count('X'),
    assetsLive: new Set(live.map((p) => p.assetSymbol)).size,
    tvlUsdLive: Math.round(total),
    pareto: { '80%': pareto(0.8), '90%': pareto(0.9), '95%': pareto(0.95), '99%': pareto(0.99) },
  }),
);
