import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { basketAssets, createDb, type Db } from '@colosseum/db';
import type { BasketAsset } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';

// Fills `basket_assets` with a Solana network's tokens from its deploy record, the list the API's
// Solana adapter runs on (`CHAIN_MODE_SOLANA=live` or `readonly`). Idempotent: a row that is already
// what the record says is left alone. Prints every row it writes or leaves.
//
//   pnpm exec tsx scripts/solana/basket-assets.ts [deployments/solana-devnet.json]
//
// `basket_assets` has no network column: one database serves one network, as `chains` already
// requires (DESIGN-VAULT section 2). Reads DATABASE_URL, or the local database when it is unset.

export type Filled = { id: string; mint: string; outcome: 'added' | 'changed' | 'same' };

const columns = (a: BasketAsset) => ({
  chainId: a.chain,
  address: a.address,
  symbol: a.symbol,
  decimals: a.decimals,
  cls: a.cls,
  underlying: a.underlying,
  issuer: a.issuer,
  tier: a.tier,
  priceKind: a.priceKind,
  priceRef: a.priceRef,
  session: a.session,
  autoFollowEligible: a.autoFollowEligible,
  maxWeightBps: a.maxWeightBps,
  blockedCountries: a.blockedCountries,
  sheet: a.sheet,
  provenance: a.provenance,
});

export async function fillBasketAssets(db: Db, record: SolanaDeploymentRecord): Promise<Filled[]> {
  const out: Filled[] = [];
  for (const asset of deploymentAssets(record)) {
    const want = columns(asset);
    const [row] = await db.select().from(basketAssets).where(eq(basketAssets.id, asset.id));
    if (row) {
      const { id: _, updatedAt: __, ...have } = row;
      if (JSON.stringify(have) === JSON.stringify({ ...have, ...want })) {
        out.push({ id: asset.id, mint: asset.address, outcome: 'same' });
        continue;
      }
      await db
        .update(basketAssets)
        .set({ ...want, updatedAt: new Date() })
        .where(eq(basketAssets.id, asset.id));
      out.push({ id: asset.id, mint: asset.address, outcome: 'changed' });
      continue;
    }
    await db.insert(basketAssets).values({ id: asset.id, ...want });
    out.push({ id: asset.id, mint: asset.address, outcome: 'added' });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'deployments/solana-devnet.json';
  const record = SolanaDeploymentRecord.parse(JSON.parse(readFileSync(file, 'utf8')));
  const { db, client } = createDb();
  try {
    for (const f of await fillBasketAssets(db, record))
      console.log(`${f.outcome}\t${f.id}\t${f.mint}`);
  } finally {
    await client.end();
  }
}
