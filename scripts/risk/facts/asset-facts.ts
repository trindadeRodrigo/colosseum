import { createDb } from '@colosseum/db';
import { collectFacts } from '@colosseum/schemas';
import { loadAssetFacts } from '../../../apps/api/src/facts';

// Prints one asset's fact sheet from the live tables (PLAN-ANALYTICS item 7). Read-only.
// Usage: tsx scripts/risk/facts/asset-facts.ts <symbol | mint | registry id> [sizeUsd] [--json]
const [id, size] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!id) throw new Error('usage: asset-facts.ts <asset> [sizeUsd] [--json]');
const { db, client } = createDb();
const sheet = await loadAssetFacts(db, id, { sizeUsd: size ? Number(size) : undefined });
await client.end();
if (!sheet) {
  console.log(`unknown asset ${id}`);
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify(sheet, null, 2));
} else {
  const { facts, invalid } = collectFacts(sheet);
  const show = (v: number, unit: string) =>
    unit === 'fraction' ? `${(v * 100).toFixed(4)}%` : unit === 'usd' ? `$${v.toFixed(2)}` : `${v}`;
  console.log(
    `${sheet.symbol} (${sheet.assetId}, ${sheet.chain}) at $${sheet.sizeUsd}, tau ${sheet.tau}; worst regime ${sheet.worstRegime}`,
  );
  console.log(
    `measured ${sheet.coverage.regimesMeasured.join(', ') || 'none'}; missing ${sheet.coverage.regimesMissing.join(', ') || 'none'}; data ${sheet.coverage.dataFrom} → ${sheet.coverage.dataTo}`,
  );
  console.table(
    facts.map(({ path, fact }) => ({
      fact: path,
      value: fact.value === null ? null : show(fact.value, fact.unit),
      quality: fact.value === null ? fact.reason : fact.quality,
      asOf: fact.value === null ? '' : fact.fetchedAt.slice(0, 16),
    })),
  );
  const filled = facts.filter((f) => f.fact.value !== null).length;
  console.log(`${filled} of ${facts.length} facts measured; ${invalid.length} invalid`);
}
