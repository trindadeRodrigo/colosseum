import 'dotenv/config';
import {
  buildKaminoDepositTx,
  createRpc,
  explorerTxUrl,
  loadKeypair,
  sendAndConfirm,
  simulateBase64,
} from '@colosseum/chain-solana';
import { createDb, markConfirmed, markFailed, markSent, recordBuilt } from '@colosseum/db';

// D2-AM leg 3: Kamino Lend USDC deposit (main market) from the demo wallet.
// build (signed) → simulate → (with --send) send once → confirm → log in `executions`.
const SEND = process.argv.includes('--send');
const usd = Number(
  process.argv.includes('--usd') ? process.argv[process.argv.indexOf('--usd') + 1] : 5,
);
const amountBase = BigInt(Math.round(usd * 1_000_000));
const rpc = createRpc();
const signer = await loadKeypair();
const { db, client } = createDb();

const built = await buildKaminoDepositTx(rpc, signer, amountBase);
const sim = await simulateBase64(rpc, built.wire);
const line: Record<string, unknown> = {
  leg: 'kamino-usdc',
  usd,
  instructions: built.instructionCount,
  lookupTables: built.lookupTables,
  simulation: sim.ok ? 'ok' : sim.err,
  unitsConsumed: sim.unitsConsumed,
};
if (!sim.ok) {
  console.log(JSON.stringify({ ...line, logs: sim.logs.slice(-6), sent: false }));
} else if (!SEND) {
  console.log(JSON.stringify({ ...line, sent: false, note: 'dry run; pass --send to execute' }));
} else {
  const execId = await recordBuilt(db, {
    wallet: signer.address,
    chain: 'solana',
    kind: 'deposit',
    assetId: 'kamino-usdc',
    amountIn: amountBase.toString(),
    provenance: 'live',
  });
  await markSent(db, execId, built.signature, explorerTxUrl(built.signature));
  const res = await sendAndConfirm(rpc, built.wire);
  if (res.err) {
    await markFailed(db, execId, JSON.stringify(res.err));
    console.log(
      JSON.stringify({
        ...line,
        sent: true,
        signature: built.signature,
        explorer: explorerTxUrl(built.signature),
        status: 'failed',
        err: res.err,
      }),
    );
  } else {
    await markConfirmed(db, execId, amountBase.toString());
    console.log(
      JSON.stringify({
        ...line,
        sent: true,
        signature: built.signature,
        explorer: explorerTxUrl(built.signature),
        slot: res.slot,
        status: 'confirmed',
      }),
    );
  }
}
await client.end();
process.exit(sim.ok ? 0 : 1);
