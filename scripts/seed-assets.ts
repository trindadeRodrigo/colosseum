import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assets, createDb } from '@colosseum/db';
import { REGISTRY } from '@colosseum/engine';
import { Asset, AssetList } from '@colosseum/schemas';
import { type CutForSeed, evmAssetRows } from './seed-evm';

// Upserts the registry into `assets`. Idempotent. Run: pnpm db:seed
// It lives here, not in packages/db, because it joins the engine and the database
// (docs/vault/DESIGN-VAULT.md section 2, rule 3).
// It also writes one row per tracked stock of each EVM asset list (PLAN-UNIVERSE RU.8), so the risk
// layer's curves have an asset to answer under. Those rows offer nothing to a plan (scripts/seed-evm.ts).
// The address is spelled as the cut the list names spells it, so the cut must be on this machine
// (RISK_EVM_DIR, default data/risk-evm): without it the registry rows are written and the EVM rows are
// not, and the run says so.
const EVM_LISTS = ['robinhood'];
const LIST_DIR = process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe';
const CUT_DIR = process.env.RISK_EVM_DIR ?? 'data/risk-evm';

const { db, client } = createDb();
async function upsert(a: Asset) {
  const row = {
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
  };
  await db
    .insert(assets)
    .values({ id: a.id, ...row })
    .onConflictDoUpdate({ target: assets.id, set: row });
}
for (const raw of REGISTRY) await upsert(Asset.parse(raw));
console.log(`seeded ${REGISTRY.length} assets`);
for (const chain of EVM_LISTS) {
  const listFile = join(LIST_DIR, `${chain}.json`);
  if (!existsSync(listFile)) {
    console.log(`${chain}: no asset list at ${listFile}, no row written`);
    continue;
  }
  const list = AssetList.parse(JSON.parse(readFileSync(listFile, 'utf8')));
  const cutName = list.inputs.cut;
  if (!cutName) throw new Error(`${listFile} does not name the cut it was written from`);
  const cutFile = join(CUT_DIR, cutName);
  if (!existsSync(cutFile)) {
    console.log(
      `${chain}: ${list.assets.length} tracked stocks NOT seeded: ${cutFile}, the cut the list was written from, is not on this machine, and the address is spelled as that file spells it`,
    );
    continue;
  }
  const cut = JSON.parse(readFileSync(cutFile, 'utf8')) as CutForSeed;
  const rows = evmAssetRows(list, cut, cutName);
  for (const a of rows) await upsert(a);
  console.log(
    `seeded ${rows.length} ${chain} stocks from ${listFile}, addresses as ${cutName} spells them; none is eligible for a plan`,
  );
}
await client.end();
