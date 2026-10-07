import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deploymentAssets, EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { createDb } from '@colosseum/db';
import { fillChainAssets } from '../solana/basket-assets';

// Fills `basket_assets` with an EVM network's tokens from its deploy record, the list the API's EVM
// adapter runs on (`CHAIN_MODE_ROBINHOOD=live` or `readonly`). Idempotent, as the Solana script is:
// a row already as the record says is left alone, a retired token's row is removed unless something
// still points at it. Prints every row it adds, changes, leaves, removes or keeps so.
//
//   pnpm exec tsx scripts/robinhood/basket-assets.ts [deployments/robinhood-testnet.json]
//
// One database serves one network. Reads DATABASE_URL, or the local database when it is unset.

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? 'deployments/robinhood-testnet.json';
  const record = EvmDeploymentRecord.parse(JSON.parse(readFileSync(file, 'utf8')));
  const { db, client } = createDb();
  try {
    const filled = await fillChainAssets(
      db,
      record.chain,
      deploymentAssets(record),
      record.retired.map((r) => r.address),
    );
    for (const f of filled)
      console.log(`${f.outcome}\t${f.id}\t${f.mint}${f.reason ? `\t${f.reason}` : ''}`);
  } finally {
    await client.end();
  }
}
