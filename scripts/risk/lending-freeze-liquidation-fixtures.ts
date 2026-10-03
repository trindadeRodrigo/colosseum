import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createDb } from '@colosseum/db';
import { sql } from 'drizzle-orm';

// PLAN-ANALYTICS item 9 — freeze the decoded liquidation events for tests
// (`pnpm risk:lending-freeze-liquidation-fixtures`): every `liquidation` row of risk_lending_events (block time, venue,
// the decoded liquidation detail) and the registry's symbol and decimals for the mints they name. The liquidator and
// the liquidated position are wallets and are dropped (DA4). Output: fixtures/risk/lending/liquidations.json.
const { db, client } = createDb();
const exec = async <T>(q: ReturnType<typeof sql>) => {
  const r = (await db.execute(q)) as unknown as { rows?: T[] } & T[];
  return (r.rows ?? r) as T[];
};
const events = await exec<{ block_time: string; venue: string; liq: Record<string, unknown> }>(
  sql`select block_time, venue, detail->'liquidation' liq from risk_lending_events
  where kind = 'liquidation' order by block_time, signature, event_key`,
);
const mints = await exec<{ mint: string; symbol: string; decimals: number }>(
  sql`select distinct on (mint) mint, symbol, decimals from risk_lending_pools order by mint, account`,
);
await client.end();
const rows = events.map((e) => {
  const { liquidator: _l, position: _p, ...liq } = e.liq;
  return { blockTime: new Date(e.block_time).toISOString(), venue: e.venue, liq };
});
const named = new Set(
  rows.flatMap((r) => [r.liq.collateralMint as string, r.liq.debtMint as string]),
);
const out = {
  frozenAt: new Date().toISOString(),
  source:
    'risk_lending_events kind = liquidation (Step 10b decode pass, lending-tx-0.x); risk_lending_pools symbol and decimals',
  rows,
  mints: mints.filter((m) => named.has(m.mint)),
};
mkdirSync('fixtures/risk/lending', { recursive: true });
writeFileSync('fixtures/risk/lending/liquidations.json', `${JSON.stringify(out)}\n`);
console.log(
  `fixtures/risk/lending/liquidations.json: ${rows.length} liquidations, ${out.mints.length} mints`,
);
