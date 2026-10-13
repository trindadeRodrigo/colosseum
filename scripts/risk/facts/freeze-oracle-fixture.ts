import { mkdirSync, writeFileSync } from 'node:fs';
import { createDb } from '@colosseum/db';
import { loadOracleInput } from '../../../apps/api/src/oracle-facts';

// PLAN-UNIVERSE RU.9 — freezes the rows behind tests/risk-layer/facts-oracle.test.ts, as the sheet's loader reads
// them from the local database (read-only): the oracle's readings and the pool mids of two tracked stocks over a
// few hours each. NVDAx on Solana (a Scope entry read every 5 minutes) across the US open of Mon 2026-10-05, so
// the window holds off-hours, market hours and the vault's own session; NVDA on Robinhood Chain (a Chainlink feed
// read by the hourly loop) over the loop's first night. `pnpm risk:freeze-oracle-fixture`.
const PICKS = [
  {
    id: 'solana:nvdax',
    mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
    from: '2026-10-05T12:00:00.000Z',
    to: '2026-10-05T16:00:00.000Z',
  },
  {
    id: 'robinhood:nvda',
    mint: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
    from: '2026-10-06T02:00:00.000Z',
    to: '2026-10-06T12:30:00.000Z',
  },
];
const { db, client } = createDb();
const assets = [];
for (const p of PICKS) {
  const inp = await loadOracleInput(db, p.mint, new Date(p.to));
  if (!inp?.readings || !inp.mids) throw new Error(`${p.id}: no oracle readings or no pool mids`);
  const inside = (at: string) => at >= p.from && at <= p.to;
  assets.push({
    id: p.id,
    mint: p.mint,
    from: p.from,
    to: p.to,
    feed: inp.feed,
    readings: { ...inp.readings, rows: inp.readings.rows.filter((r) => inside(r.at)) },
    mids: { ...inp.mids, rows: inp.mids.rows.filter((m) => inside(m.at)) },
  });
}
await client.end();
mkdirSync('fixtures/risk/oracle', { recursive: true });
writeFileSync(
  'fixtures/risk/oracle/readings.json',
  `${JSON.stringify({
    source:
      'risk_price_observations and risk_asset_snapshots of the local database, through loadOracleInput (apps/api/src/oracle-facts.ts); each block names its own source',
    method: 'frozen_rows',
    fetchedAt: new Date().toISOString(),
    provenance: 'fixture',
    assets,
  })}\n`,
);
for (const a of assets)
  console.log(`${a.id}: ${a.readings.rows.length} readings, ${a.mids.rows.length} pool mids`);
