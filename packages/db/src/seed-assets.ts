import './env';
import { REGISTRY } from '@colosseum/engine';
import { Asset } from '@colosseum/schemas';
import { assets, createDb } from './index';

// Upserts the registry into `assets`. Idempotent. Run: pnpm db:seed
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
