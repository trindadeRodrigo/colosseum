import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createDb, riskReferencePrices } from '@colosseum/db';
import { and, gte, inArray, isNotNull, lte } from 'drizzle-orm';

// PLAN-ANALYTICS item 12 — freezes the rows behind tests/risk-layer/facts-market.test.ts: 120 days of hourly
// reference prices (risk_reference_prices) for SPYx, TSLAx, QQQx and USDC, ending 2026-10-02 23:00Z.
// `pnpm risk:freeze-market-fixture`.
const SYMBOLS = ['SPYx', 'TSLAx', 'QQQx', 'USDC'];
const to = new Date('2026-10-02T23:00:00Z');
const from = new Date(to.getTime() - 120 * 86_400_000);
const { db, client } = createDb();
const rows = await db
  .select()
  .from(riskReferencePrices)
  .where(
    and(
      inArray(riskReferencePrices.symbol, SYMBOLS),
      gte(riskReferencePrices.observedAt, from),
      lte(riskReferencePrices.observedAt, to),
      isNotNull(riskReferencePrices.priceUsd),
    ),
  )
  .orderBy(riskReferencePrices.observedAt);
await client.end();
const series: Record<string, Array<[string, number, string, string | null]>> = {};
for (const r of rows) {
  const k = r.symbol as string;
  series[k] = [
    ...(series[k] ?? []),
    [r.observedAt.toISOString(), r.priceUsd as number, r.regime, r.quality],
  ];
}
mkdirSync('fixtures/risk/prices', { recursive: true });
writeFileSync(
  'fixtures/risk/prices/market-series.json',
  `${JSON.stringify({ from: from.toISOString(), to: to.toISOString(), methodVersion: rows[0]?.methodVersion, source: rows[0]?.source, method: rows[0]?.method, series })}\n`,
);
console.log(
  JSON.stringify(Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.length]))),
);
