import 'dotenv/config';
import { createDb, executions, riskNetworkFees } from '@colosseum/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { rpc } from '../lib-pools';

// PLAN-ANALYTICS item 4 — `pnpm risk:network-fees`: reads the network fee (`meta.fee`, base plus priority fee, in
// lamports) of every confirmed swap the product sent (`executions`) and stores it in risk_network_fees with the SOL
// price at the time of reading. Read-only: getTransaction one signature at a time (DA3); signatures already stored
// are skipped. Step 5b's swap history did not keep the fee field, so our own swaps are the source.
const METHOD_VERSION = 'netfee-0.1';
const SOL = 'So11111111111111111111111111111111111111112';

const { db, client } = createDb();
const swaps = await db
  .select({ signature: executions.signature })
  .from(executions)
  .where(
    and(
      eq(executions.kind, 'swap'),
      eq(executions.status, 'confirmed'),
      eq(executions.chain, 'solana'),
      isNotNull(executions.signature),
    ),
  );
const have = new Set(
  (await db.select({ s: riskNetworkFees.signature }).from(riskNetworkFees)).map((r) => r.s),
);
const todo = swaps.map((s) => s.signature as string).filter((s) => !have.has(s));
const solUsd = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, {
  signal: AbortSignal.timeout(20_000),
})
  .then((r) => r.json() as Promise<Record<string, { usdPrice?: number }>>)
  .then((r) => r[SOL]?.usdPrice ?? null)
  .catch(() => null);
if (todo.length && !solUsd)
  throw new Error('no SOL price from the Jupiter price API; nothing written');

type Tx = {
  slot: number;
  blockTime: number | null;
  meta: { fee: number; err: unknown; computeUnitsConsumed?: number } | null;
};
let written = 0;
const skipped: string[] = [];
for (const signature of todo) {
  const tx = await rpc<Tx | null>('getTransaction', [
    signature,
    { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);
  if (!tx?.meta || tx.meta.err || !tx.blockTime) {
    skipped.push(
      `${signature.slice(0, 8)}: ${!tx ? 'not found' : tx.meta?.err ? 'failed' : 'no time'}`,
    );
    continue;
  }
  const fetchedAt = new Date();
  await db
    .insert(riskNetworkFees)
    .values({
      signature,
      chain: 'solana',
      origin: 'executions',
      slot: tx.slot,
      blockTime: new Date(tx.blockTime * 1000),
      feeLamports: tx.meta.fee,
      computeUnits: tx.meta.computeUnitsConsumed ?? null,
      solUsd: solUsd as number,
      feeUsd: (tx.meta.fee / 1e9) * (solUsd as number),
      methodVersion: METHOD_VERSION,
      source: 'Solana RPC getTransaction meta.fee; SOL price from the Jupiter price API when read',
      method: 'transaction_meta_fee',
      fetchedAt,
      provenance: 'live',
    })
    .onConflictDoNothing();
  written++;
}
const all = await db.select().from(riskNetworkFees);
await client.end();
const lamports = all.map((r) => r.feeLamports).sort((a, b) => a - b);
console.log(
  JSON.stringify({
    swapsInExecutions: swaps.length,
    written,
    skipped,
    stored: all.length,
    solUsd,
    feeLamports: lamports.length
      ? {
          min: lamports[0],
          median: lamports[Math.floor(lamports.length / 2)],
          max: lamports.at(-1),
        }
      : null,
    methodVersion: METHOD_VERSION,
  }),
);
