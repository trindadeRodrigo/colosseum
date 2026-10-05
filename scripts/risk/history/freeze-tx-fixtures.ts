// Step 5b — attach each tx fixture's pool vaults (from the registry) so tests can cross-check decoded
// amounts against the vaults' token balance changes. Usage: tsx freeze-tx-fixtures.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decoders, txAccountKeys } from '@colosseum/risk';
import { latestRegistryFile, type RegistryPool } from '../lib-history';

const reg = JSON.parse(readFileSync(latestRegistryFile(), 'utf8')).pools as RegistryPool[];
const by = new Map(reg.map((p) => [p.address, p]));
for (const f of readdirSync('fixtures/risk/txs')) {
  const fx = JSON.parse(readFileSync(`fixtures/risk/txs/${f}`, 'utf8'));
  const pools: Record<string, [string, string]> = {};
  const mints: Record<string, string> = {};
  for (const k of txAccountKeys(fx.tx)) {
    const p = by.get(k);
    if (
      p &&
      p.venue === fx.venue &&
      decoders[fx.venue]?.(fx.tx, k, { mint0: p.mint0 }).events.length
    ) {
      pools[k] = [p.vault0, p.vault1];
      mints[k] = p.mint0;
    }
  }
  fx.pools = pools;
  fx.mint0 = mints;
  writeFileSync(`fixtures/risk/txs/${f}`, JSON.stringify(fx));
  console.log(f, Object.keys(pools));
}
