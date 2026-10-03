import { assets as assetsTable, createDb } from '@colosseum/db';
import { breakEvenReturn, REGIMES, roundTripCost } from '@colosseum/risk';
import { Asset } from '@colosseum/schemas';
import { loadLiquidityProvider } from '../../../apps/api/src/liquidity';

// Check for PLAN-ANALYTICS items 5 and 6: per regime, what the live provider answers for a registry asset at
// one size. Read-only. Usage: tsx scripts/risk/facts/provider-check.ts [sizeUsd] [assetId …]
const size = Number(process.argv[2] ?? 10_000);
const only = process.argv.slice(3);
const { db, client } = createDb();
const rows = await db.select().from(assetsTable);
const assets = rows.map((r) =>
  Asset.parse({
    ...r,
    mint: r.mint ?? undefined,
    tokenProgram: r.tokenProgram ?? undefined,
    decimals: r.decimals ?? undefined,
    capWeight: Number(r.capWeight),
  }),
);
const p = await loadLiquidityProvider(db, assets);
if (!p) {
  console.log('no provider: no sell curve for any registry asset');
} else {
  const pct = (x: number | null | undefined) => (x == null ? null : `${(x * 100).toFixed(4)}%`);
  for (const a of assets.filter((x) => p.covers(x.id) && (!only.length || only.includes(x.id)))) {
    const g = p.regimes(a.id);
    console.log(
      `\n${a.id} at $${size}: measured ${g?.measured.join(', ') || 'none'}; missing ${
        g?.missing.map((m) => `${m.regime} (${m.reason})`).join(', ') || 'none'
      }`,
    );
    console.table(
      REGIMES.map((regime) => {
        const out = p.exitCostIn(a.id, size, regime);
        const inn = p.entryCostIn(a.id, size, regime);
        const both = out?.cost != null && inn?.cost != null;
        return {
          regime,
          exit: pct(out?.cost) ?? out?.reason,
          entry: pct(inn?.cost) ?? inn?.reason ?? 'no buy curve',
          roundTrip: both ? pct(roundTripCost(inn.cost as number, out.cost as number)) : null,
          breakEven: both ? pct(breakEvenReturn(inn.cost as number, out.cost as number)) : null,
          capacityAt1pct: p.exitCapacityIn(a.id, 0.01, regime)?.capacityUsd.toFixed(0) ?? null,
          samples: out?.samples,
          dataTo: out?.dataTo,
        };
      }),
    );
    const worst = p.exitCapacity(a.id, 0.01, 7);
    console.log(
      `worst measured regime: ${worst?.regime}, capacity at 1% $${worst?.capacityUsd.toFixed(0)}${
        worst?.lowerBound ? ' (lower bound)' : ''
      }, exit cost ${pct(p.exitCost(a.id, size, 7))}`,
    );
  }
}
await client.end();
