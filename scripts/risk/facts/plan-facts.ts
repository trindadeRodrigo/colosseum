import { createDb } from '@colosseum/db';
import { collectFacts, PlanFacts } from '@colosseum/schemas';
import { loadPlanFacts } from '../../../apps/api/src/facts';

// Prints a plan's fact sheet from the live tables (PLAN-ANALYTICS item 10). Read-only.
// Usage: tsx scripts/risk/facts/plan-facts.ts <asset>=<usd> … [--withdraw=<iso>:<usd>] [--json]
const args = process.argv.slice(2);
const positions = args
  .filter((a) => !a.startsWith('--'))
  .map((a) => {
    const [assetId, usd] = a.split('=');
    if (!assetId || !usd) throw new Error(`expected <asset>=<usd>, got ${a}`);
    return { assetId, valueUsd: Number(usd) };
  });
if (!positions.length) throw new Error('usage: plan-facts.ts SPYx=50000 usdc=20000 … [--json]');
const withdrawals = args
  .filter((a) => a.startsWith('--withdraw='))
  .map((a) => {
    const v = a.slice('--withdraw='.length);
    const i = v.lastIndexOf(':');
    return { at: new Date(v.slice(0, i)).toISOString(), usd: Number(v.slice(i + 1)) };
  });
const { db, client } = createDb();
const sheet = await loadPlanFacts(db, positions, { withdrawals });
await client.end();
const parsed = PlanFacts.safeParse(sheet);
const { facts, invalid } = collectFacts(sheet);
if (args.includes('--json')) console.log(JSON.stringify(sheet, null, 2));
else {
  const pct = (v: number) => `${(v * 100).toFixed(4)}%`;
  console.log(
    `plan $${sheet.totalUsd}; exit regime ${sheet.exit.regime}; measured share ${(sheet.measuredShare * 100).toFixed(1)}%`,
  );
  for (const [k, rows] of Object.entries(sheet.concentration))
    console.log(
      `  ${k}: ${(rows ?? []).map((r) => `${r.key} ${(r.share * 100).toFixed(1)}%`).join(', ')}`,
    );
  console.table(
    facts.map(({ path, fact }) => ({
      fact: path,
      value:
        fact.value === null
          ? null
          : fact.unit === 'fraction'
            ? pct(fact.value)
            : fact.unit === 'usd'
              ? `$${fact.value.toFixed(2)}`
              : `${fact.value}`,
      quality: fact.value === null ? fact.reason : fact.quality,
    })),
  );
  console.log(
    `shared routes: ${
      sheet.exit.legs
        .filter((l) => l.sharedRoute)
        .map((l) => l.assetId)
        .join(', ') || 'none'
    }; breach: ${sheet.breach ? JSON.stringify({ breach: sheet.breach.breach, likelyBreach: sheet.breach.likelyBreach }) : 'no withdrawals given'}`,
  );
}
console.log(
  `${facts.filter((f) => f.fact.value !== null).length} of ${facts.length} facts measured; ${invalid.length} invalid; schema ${parsed.success ? 'ok' : 'FAILED'}`,
);
if (!parsed.success || invalid.length) process.exit(1);
