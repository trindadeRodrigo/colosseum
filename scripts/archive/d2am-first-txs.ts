import 'dotenv/config';
import {
  buildSwapTx,
  createRpc,
  explorerTxUrl,
  getQuote,
  loadKeypair,
  sendAndConfirm,
  signBase64,
  simulateBase64,
} from '@colosseum/chain-solana';
import { createDb, markConfirmed, markFailed, markSent, recordBuilt } from '@colosseum/db';
import { REGISTRY_BY_ID } from '@colosseum/engine';

// D2-AM: first mainnet transactions. Jupiter swaps USDC→USDY and USDC→syrupUSDC (5 USDC each).
// Every leg: quote → build → simulate → (with --send) sign → send once → confirm → log in `executions`.
// Archived, do not run. Was: tsx scripts/execute/d2am-first-txs.ts [--send] [--legs usdy,syrupusdc] [--usd 5]
const args = process.argv.slice(2);
const SEND = args.includes('--send');
const legs = (
  args[args.indexOf('--legs') + 1] && args.includes('--legs')
    ? args[args.indexOf('--legs') + 1]
    : 'usdy,syrupusdc'
)!.split(',');
const usd = Number(args.includes('--usd') ? args[args.indexOf('--usd') + 1] : 5);

const rpc = createRpc();
const signer = await loadKeypair();
const { db, client } = createDb();
const usdc = REGISTRY_BY_ID.get('usdc');
if (!usdc?.mint) throw new Error('usdc mint');
const amountBase = BigInt(Math.round(usd * 1_000_000));

for (const legId of legs) {
  const asset = REGISTRY_BY_ID.get(legId);
  if (!asset?.mint) throw new Error(`asset ${legId} has no mint`);
  if (asset.mintPath !== 'dex_swap') throw new Error(`asset ${legId} is not a DEX leg`);
  const quote = await getQuote({ inputMint: usdc.mint, outputMint: asset.mint, amountBase });
  const built = await buildSwapTx({ quote, userPublicKey: signer.address });
  const sim = await simulateBase64(rpc, built.swapTransaction);
  const line: Record<string, unknown> = {
    leg: legId,
    usd,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    simulation: sim.ok ? 'ok' : sim.err,
  };
  if (!sim.ok) {
    console.log(JSON.stringify({ ...line, sent: false }));
    break;
  }
  if (!SEND) {
    console.log(JSON.stringify({ ...line, sent: false, note: 'dry run; pass --send to execute' }));
    continue;
  }
  const execId = await recordBuilt(db, {
    wallet: signer.address,
    chain: 'solana',
    kind: 'swap',
    assetId: legId,
    amountIn: amountBase.toString(),
    provenance: 'live',
  });
  const { wire, signature } = await signBase64(built.swapTransaction, signer);
  await markSent(db, execId, signature, explorerTxUrl(signature));
  const res = await sendAndConfirm(rpc, wire);
  if (res.err) {
    await markFailed(db, execId, JSON.stringify(res.err));
    console.log(
      JSON.stringify({
        ...line,
        sent: true,
        signature,
        explorer: explorerTxUrl(signature),
        status: 'failed',
        err: res.err,
      }),
    );
    break; // no automatic retry
  }
  await markConfirmed(db, execId, quote.outAmount);
  console.log(
    JSON.stringify({
      ...line,
      sent: true,
      signature,
      explorer: explorerTxUrl(signature),
      slot: res.slot,
      status: 'confirmed',
    }),
  );
}
await client.end();
