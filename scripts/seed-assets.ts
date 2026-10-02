import 'dotenv/config';
import { assets, createDb } from '@colosseum/db';
import { REGISTRY } from '@colosseum/engine';
import { Asset } from '@colosseum/schemas';

// Upserts the registry into `assets`. Idempotent. Run: pnpm db:seed
// It lives here, not in packages/db, because it joins the engine and the database
// (docs/vault/DESIGN-VAULT.md section 2, rule 3).
const { db, client } = createDb();
for (const raw of REGISTRY) {
  const a = Asset.parse(raw);
  await db
    .insert(assets)
    .values({
      id: a.id,
      symbol: a.symbol,
      name: a.name,
      kind: a.kind,
      chain: a.chain,
      mint: a.mint ?? null,
      tokenProgram: a.tokenProgram ?? null,
      decimals: a.decimals ?? null,
      eligibleProfiles: a.eligibleProfiles,
      capWeight: String(a.capWeight),
      mintPath: a.mintPath,
      metadata: a.metadata,
      provenance: a.provenance,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: assets.id,
      set: {
        symbol: a.symbol,
        name: a.name,
        kind: a.kind,
        chain: a.chain,
        mint: a.mint ?? null,
        tokenProgram: a.tokenProgram ?? null,
        decimals: a.decimals ?? null,
        eligibleProfiles: a.eligibleProfiles,
        capWeight: String(a.capWeight),
        mintPath: a.mintPath,
        metadata: a.metadata,
        provenance: a.provenance,
        updatedAt: new Date(),
      },
    });
}
console.log(`seeded ${REGISTRY.length} assets`);
await client.end();
