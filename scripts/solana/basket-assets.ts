import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { basketAssets, createDb, type Db } from '@colosseum/db';
import type { BasketAsset, ChainId } from '@colosseum/schemas';
import { and, eq, inArray } from 'drizzle-orm';

// Fills `basket_assets` with a Solana network's tokens from its deploy record, the list the API's
// Solana adapter runs on (`CHAIN_MODE_SOLANA=live` or `readonly`). Idempotent: a row that is already
// what the record says is left alone, and the row of a token the record retired is removed, unless
// something still points at it (a price observed for it): that row stays and is printed as
// `referenced`, with the reason. Prints every row it adds, changes, leaves, removes or keeps so.
//
//   pnpm exec tsx scripts/solana/basket-assets.ts [deployments/solana-devnet.json]
//
// `basket_assets` has no network column: one database serves one network, as `chains` already
// requires (DESIGN-VAULT section 2). Reads DATABASE_URL, or the local database when it is unset.

export type Filled = {
  id: string;
  mint: string;
  outcome: 'added' | 'changed' | 'same' | 'removed' | 'referenced';
  /** Why a retired token's row stayed: what still points at it. */
  reason?: string;
};

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
  return fillChainAssets(
    db,
    'solana',
    deploymentAssets(record),
    record.retired.map((r) => r.mint),
  );
}

/**
 * The same for any chain: the assets a record makes (its `deploymentAssets`) and the addresses of the
 * tokens it retired. The EVM chains' script (`scripts/robinhood/basket-assets.ts`) runs on this.
 */
export async function fillChainAssets(
  db: Db,
  chain: ChainId,
  assets: BasketAsset[],
  retired: string[],
): Promise<Filled[]> {
  const out: Filled[] = [];
  for (const asset of assets) {
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
  // A token the deploy retired is no longer the network's to offer: its row goes. It stays listed on
  // chain, and a vault that holds it still sees it and withdraws it, under its mint. A row something
  // else still points at (a price observed for it) stays, and says so; the API leaves it out anyway.
  const rows = retired.length
    ? await db
        .select({ id: basketAssets.id, address: basketAssets.address })
        .from(basketAssets)
        .where(and(eq(basketAssets.chainId, chain), inArray(basketAssets.address, retired)))
    : [];
  for (const row of rows) {
    try {
      await db.delete(basketAssets).where(eq(basketAssets.id, row.id));
      out.push({ id: row.id, mint: row.address, outcome: 'removed' });
    } catch (e) {
      const code =
        (e as { code?: string; cause?: { code?: string } }).code ??
        (e as { cause?: { code?: string } }).cause?.code;
      if (code !== '23503') throw e;
      out.push({
        id: row.id,
        mint: row.address,
        outcome: 'referenced',
        reason: 'price_observations still names it, so its row stays',
      });
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'deployments/solana-devnet.json';
  const record = SolanaDeploymentRecord.parse(JSON.parse(readFileSync(file, 'utf8')));
  const { db, client } = createDb();
  try {
    for (const f of await fillBasketAssets(db, record))
      console.log(`${f.outcome}\t${f.id}\t${f.mint}${f.reason ? `\t${f.reason}` : ''}`);
  } finally {
    await client.end();
  }
}
