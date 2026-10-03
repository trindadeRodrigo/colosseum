import 'dotenv/config';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskDepthCurves, riskNetworkFees } from '@colosseum/db';
import { attachSplit, type DepthCurve } from '@colosseum/risk';
import { and, eq, inArray } from 'drizzle-orm';
import { LENDING_DATA } from '../lib-lending';

// PLAN-ANALYTICS item 4 — freezes the rows behind tests/risk-layer/facts-breakdown.test.ts: SPYx's and TSLAx's
// `risk-0.3` curves (split keys removed, as before the fit), their split snapshot rows, and the network fee rows
// without signatures (D13: nothing that leads to a wallet). `pnpm risk:freeze-split-fixture`.
const SYMBOLS = ['SPYx', 'TSLAx'];
const { db, client } = createDb();
const curves = (
  await db
    .select()
    .from(riskDepthCurves)
    .where(
      and(
        inArray(riskDepthCurves.assetSymbol, SYMBOLS),
        eq(riskDepthCurves.methodVersion, 'risk-0.3'),
      ),
    )
).map((r) => ({
  assetMint: r.assetMint,
  assetSymbol: r.assetSymbol,
  side: r.side,
  regime: r.regime,
  curve: {
    points: attachSplit(r.points as DepthCurve['points'], undefined),
    insufficientFrom: r.insufficientFrom,
    quantile: r.quantile,
    minSamples: r.minSamples,
    from: r.dataFrom?.toISOString() ?? null,
    to: r.dataTo?.toISOString() ?? null,
    samples: r.samples,
  },
}));
const fees = (await db.select().from(riskNetworkFees)).map((r, i) => ({
  signature: `tx${i}`,
  blockTime: r.blockTime.toISOString(),
  feeLamports: r.feeLamports,
  solUsd: r.solUsd,
}));
await client.end();
const dir = join(LENDING_DATA, 'split');
const splitRows = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()
  .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
  .map((l) => JSON.parse(l) as { asset?: string; legs?: unknown; vsCollector?: unknown })
  .filter((r) => SYMBOLS.includes(r.asset ?? ''))
  .map(({ legs: _l, vsCollector: _v, ...r }) => r);
mkdirSync('fixtures/risk/split', { recursive: true });
writeFileSync(
  'fixtures/risk/split/breakdown.json',
  `${JSON.stringify({ frozenAt: new Date().toISOString(), curves, splitRows, networkFees: fees })}\n`,
);
console.log(
  JSON.stringify({ curves: curves.length, splitRows: splitRows.length, fees: fees.length }),
);
