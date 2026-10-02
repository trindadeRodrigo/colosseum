import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PriceObservation } from '@colosseum/risk';
import { RISK_HOME } from '../lib-lending';
import { readObservations } from './lib';

// Step 11 — freezes real observations and the registry context for tests/risk-layer/prices.test.ts.
//   fixtures/risk/prices/context.json       the registered Kamino reserves (token name, mint, market) and the
//                                           mint lists the price parameters are built from
//   fixtures/risk/prices/observations.json  three windows of real observations, thinned:
//     weekend   SPYx from every source and USDG, Fri 2026-09-25 12:00Z → Mon 2026-09-28 16:00Z
//     listing   METAx from Kamino, 2026-02-09 → 2026-02-13: the placeholder price, then the live feed
// Thinning keeps the last observation of each source, market and ten-minute bucket; the tests' expectations are
// computed on the frozen rows themselves, never on the full data.
// Usage: tsx scripts/risk/prices/freeze-fixtures.ts && pnpm exec biome format --write fixtures/risk/prices
const OUT = 'fixtures/risk/prices';
mkdirSync(OUT, { recursive: true });
const fetchedAt = new Date().toISOString();
const lreg = JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
  rows: Array<{
    account: string;
    venue: string;
    market: string;
    mint: string | null;
    symbol: string | null;
    dexAssetMint: string | null;
  }>;
};
const reserves = lreg.rows.filter((r) => r.venue === 'kamino' && r.mint && r.symbol);
const mintOf = (s: string) => reserves.find((r) => r.symbol === s)?.mint as string;
writeFileSync(
  join(OUT, 'context.json'),
  `${JSON.stringify(
    {
      source:
        'lending registry (~/.colosseum/risk/lending-registry.json), confirmed on-chain (Step 10b item 2)',
      method: 'prices-freeze-fixtures',
      fetchedAt,
      provenance: 'fixture',
      kaminoReserves: Object.fromEntries(
        reserves.map((r) => [r.account, { symbol: r.symbol, mint: r.mint, market: r.market }]),
      ),
      continuousMints: [...new Set(reserves.filter((r) => !r.dexAssetMint).map((r) => r.mint))],
      usdStableMints: [mintOf('USDG'), mintOf('PYUSD')],
      usdc: mintOf('USDC'),
      jupiterLendVaults: lreg.rows.filter((r) => r.venue === 'jupiter_lend').map((r) => r.account),
    },
    null,
    2,
  )}\n`,
);

const unix = (iso: string) => Date.parse(iso) / 1000;
const windows = [
  {
    name: 'weekend',
    mints: [mintOf('SPYx'), mintOf('USDG')],
    from: unix('2026-09-25T12:00:00Z'),
    to: unix('2026-09-28T16:00:00Z'),
  },
  {
    name: 'listing',
    mints: [mintOf('METAx')],
    from: unix('2026-02-09T00:00:00Z'),
    to: unix('2026-02-13T22:00:00Z'),
  },
];
const kept = new Map<string, PriceObservation>();
const count: Record<string, number> = {};
for (const o of readObservations()) {
  const w = windows.find((x) => x.mints.includes(o.mint) && o.t >= x.from && o.t <= x.to);
  if (!w) continue;
  const { source: _s, fetchedAt: _f, methodVersion: _v, provenance: _p, ...obs } = o;
  // the last observation of each source, method, market and ten-minute bucket
  const k = `${o.priceSource}|${o.method}|${o.market ?? o.ref}|${o.mint}|${Math.floor(o.t / 600)}`;
  const prev = kept.get(k);
  if (!prev || prev.t <= o.t) kept.set(k, obs);
  count[w.name] = (count[w.name] ?? 0) + 1;
}
const observations = [...kept.values()].sort(
  (a, b) => a.t - b.t || a.priceSource.localeCompare(b.priceSource) || a.ref.localeCompare(b.ref),
);
writeFileSync(
  join(OUT, 'observations.json'),
  `${JSON.stringify(
    {
      source:
        'data/risk/prices/obs (Step 11 item 1): klend refresh logs, Jupiter Lend oracle returns, Step 5b hourly pool mids',
      method: 'prices-freeze-fixtures (last observation per source, market and ten-minute bucket)',
      fetchedAt,
      provenance: 'fixture',
      windows: windows.map((w) => ({
        name: w.name,
        from: new Date(w.from * 1000).toISOString(),
        to: new Date(w.to * 1000).toISOString(),
      })),
      observations,
    },
    null,
    2,
  )}\n`,
);
console.log(`read ${JSON.stringify(count)}, kept ${observations.length} → ${OUT}`);
