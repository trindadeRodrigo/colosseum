import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// PLAN-ANALYTICS item 16 — freezes the rows behind tests/risk-layer/facts-flow.test.ts: TSLAx's USDC pool on
// Raydium CLMM (HHQUnU…), its decoded swap events of 2026-09-04 and 2026-09-05 (Step 5b history) and its hourly rows of
// those days. Only what the flow method reads is kept: time, amounts and direction of each swap event. Signatures,
// vault balances, liquidity events and any position or owner are dropped. `pnpm risk:freeze-flow-fixture`.
const H = join(process.env.RISK_DATA_DIR ?? 'data/risk', 'history-full');
const POOL = 'HHQUnUbmWLrYzkscDY1C3deEFbGtiGBGoHjpANogmvum';
const DAYS = ['2026-09-04', '2026-09-05'];
type Ev = { kind: string; pool: string; amount0: string; amount1: string; zeroForOne: boolean };
const swaps: Array<[number, string, string, boolean]> = [];
for (const d of DAYS)
  for (const l of readFileSync(join(H, 'events', POOL, `${d}.jsonl`), 'utf8').split('\n')) {
    if (!l) continue;
    const r = JSON.parse(l) as { t: number; ev: Ev[] | null };
    for (const e of r.ev ?? [])
      if (e.kind === 'swap' && e.pool === POOL)
        swaps.push([r.t, e.amount0, e.amount1, e.zeroForOne]);
  }
swaps.sort((a, b) => a[0] - b[0]);
const hourly = readFileSync(join(H, 'hourly', `${POOL}.jsonl`), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((h) => DAYS.includes(h.hour.slice(0, 10)))
  .map((h) => [h.hour, h.regime, h.quoteUsd, h.depth2pctSellUsd]);
const head = JSON.parse(
  readFileSync(join(H, 'hourly', `${POOL}.jsonl`), 'utf8').split('\n')[0] as string,
);
mkdirSync('fixtures/risk/history', { recursive: true });
writeFileSync(
  'fixtures/risk/history/flow-tslax.json',
  `${JSON.stringify({
    pool: POOL,
    asset: 'TSLAx',
    // risk_pools: TSLAx is token 0 (8 decimals), USDC token 1 (6 decimals)
    assetIsToken0: true,
    decimals0: 8,
    decimals1: 6,
    days: DAYS,
    source: head.source,
    method: head.method,
    quoteUsdMethod: head.quoteUsdMethod,
    swapColumns: ['t', 'amount0', 'amount1', 'zeroForOne'],
    swaps,
    hourlyColumns: ['hour', 'regime', 'quoteUsd', 'depth2pctSellUsd'],
    hourly,
  })}\n`,
);
console.log(JSON.stringify({ swaps: swaps.length, hours: hourly.length }));
