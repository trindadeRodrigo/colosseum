import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORY_DIR, readSignatures, valuePools } from '../lib-history';
import { rpc } from '../lib-pools';

// Step 5b.3 helper — sample walked transactions per venue, tally the pool program's instruction names
// (from "Program log: Instruction: X" lines at the program's invoke depth) and event discriminators,
// and keep one full example transaction per instruction name for decoder tests.
// Usage: tsx probe-events.ts [perPool=400] [venue]
const PER = Number(process.argv[2] ?? 400);
const VENUE = process.argv[3];
const out = join(HISTORY_DIR, 'probe');
mkdirSync(out, { recursive: true });
const disc = (name: string) =>
  createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
const KNOWN: Record<string, string> = {};
for (const n of [
  'SwapEvent',
  'CreatePersonalPositionEvent',
  'IncreaseLiquidityEvent',
  'DecreaseLiquidityEvent',
  'LiquidityChangeEvent',
  'CollectPersonalFeeEvent',
  'PoolCreatedEvent',
  'LiquidityCalculateEvent',
  'Traded',
  'LiquidityIncreased',
  'LiquidityDecreased',
  'PositionOpened',
  'PositionHarvestUpdated',
  'Swap',
  'AddLiquidity',
  'RemoveLiquidity',
  'PositionCreate',
  'PositionClose',
  'ClaimFee',
  'LpChangeEvent',
  'CompositionFee',
  'UpdatePositionLockReleasePoint',
  'IncreasePositionLength',
  'DynamicFeeParameterUpdate',
  'ClaimReward',
  'Rebalancing',
])
  KNOWN[disc(n)] = n;
const pools = valuePools().filter((p) => !VENUE || p.venue === VENUE);
const byVenue = new Map<string, typeof pools>();
for (const p of pools) byVenue.set(p.venue, [...(byVenue.get(p.venue) ?? []), p]);
for (const [venue, ps] of byVenue) {
  const ixCount: Record<string, number> = {};
  const evCount: Record<string, number> = {};
  const examples: Record<string, unknown> = {};
  for (const p of ps.slice(0, 3)) {
    const sigs: string[] = [];
    let skip = 0;
    for (const s of readSignatures(p.address)) {
      if (s.failed) continue;
      if (skip++ % 25) continue; // spread over the walk
      sigs.push(s.signature);
      if (sigs.length >= PER) break;
    }
    for (let i = 0; i < sigs.length; i += 16) {
      const txs = await Promise.all(
        sigs
          .slice(i, i + 16)
          .map((s) =>
            rpc<{ meta: { logMessages: string[] } } | null>('getTransaction', [
              s,
              { encoding: 'json', maxSupportedTransactionVersion: 1 },
            ]).catch(() => null),
          ),
      );
      for (const tx of txs) {
        if (!tx) continue;
        const logs = tx.meta.logMessages ?? [];
        const stack: string[] = [];
        const names = new Set<string>();
        for (const l of logs) {
          const inv = l.match(/^Program (\w+) invoke/);
          if (inv) {
            stack.push(inv[1] as string);
            continue;
          }
          if (/^Program \w+ (success|failed)/.test(l)) {
            stack.pop();
            continue;
          }
          if (stack.at(-1) !== p.program) continue;
          const ix = l.match(/^Program log: Instruction: (\w+)/);
          if (ix) names.add(ix[1] as string);
          if (l.startsWith('Program data: ')) {
            const d = Buffer.from(l.slice(14), 'base64');
            const k = `${KNOWN[d.subarray(0, 8).toString('hex')] ?? d.subarray(0, 8).toString('hex')}/${d.length}`;
            evCount[k] = (evCount[k] ?? 0) + 1;
          }
        }
        for (const n of names) {
          ixCount[n] = (ixCount[n] ?? 0) + 1;
          if (!examples[n]) examples[n] = tx;
        }
      }
    }
  }
  writeFileSync(
    join(out, `${venue}.json`),
    JSON.stringify({ ixCount, evCount, examples }, null, 1),
  );
  console.log(JSON.stringify({ venue, ixCount, evCount }));
}
