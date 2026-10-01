import 'dotenv/config';
import {
  createRpc,
  explorerTxUrl,
  loadKeypair,
  sendAndConfirm,
  signBase64,
  simulateBase64,
} from '@colosseum/chain-solana';
import type { UnsignedTx } from '@colosseum/schemas';

// Partner-side reference flow: ask the API for a plan's unsigned transactions, sign each with the wallet,
// simulate, send once, confirm, and report the outcome back to the API. Legs are independent: a failed leg is
// reported and the loop continues. `--fail-leg N` corrupts leg N before signing to prove partial-failure handling.
// Usage: tsx scripts/sign-and-send.ts --plan <id> [--api http://localhost:3001] [--send] [--fail-leg 2]
const a = process.argv.slice(2);
const opt = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
const planId = opt('--plan');
if (!planId) throw new Error('--plan <id> required');
const api = opt('--api') ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const SEND = a.includes('--send');
const failLeg = Number(opt('--fail-leg') ?? 0);

const rpc = createRpc();
const signer = await loadKeypair();
const res = await fetch(`${api}/plans/${planId}/transactions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ wallet: signer.address, chain: 'solana' }),
});
const body = (await res.json()) as {
  transactions: UnsignedTx[];
  skipped?: unknown[];
  errors?: unknown[];
  error?: string;
};
if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
console.log(
  JSON.stringify({
    planId,
    transactions: body.transactions.length,
    skipped: body.skipped,
    errors: body.errors,
  }),
);

const report = async (id: string | undefined, payload: Record<string, unknown>) => {
  if (!id) return;
  await fetch(`${api}/executions/${id}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
};

let i = 0;
for (const tx of body.transactions) {
  i++;
  let payload = tx.payload;
  if (i === failLeg) payload = `${payload.slice(0, -8)}AAAAAAA=`; // corrupt the tail: fails simulation/preflight
  const line: Record<string, unknown> = {
    leg: i,
    asset: tx.legAssetId,
    kind: tx.kind,
    description: tx.description,
  };
  try {
    const { wire, signature } = await signBase64(payload, signer);
    const sim = await simulateBase64(rpc, wire);
    if (!sim.ok) {
      await report(tx.executionId, {
        status: 'failed',
        error: `simulation: ${JSON.stringify(sim.err)}`,
      });
      console.log(JSON.stringify({ ...line, status: 'failed', stage: 'simulation', err: sim.err }));
      continue;
    }
    if (!SEND) {
      console.log(
        JSON.stringify({
          ...line,
          status: 'dry-run',
          simulation: 'ok',
          unitsConsumed: sim.unitsConsumed,
        }),
      );
      continue;
    }
    await report(tx.executionId, { status: 'sent', signature });
    const r = await sendAndConfirm(rpc, wire);
    if (r.err) {
      await report(tx.executionId, { status: 'failed', signature, error: JSON.stringify(r.err) });
      console.log(
        JSON.stringify({
          ...line,
          status: 'failed',
          stage: 'send',
          signature,
          explorer: explorerTxUrl(signature),
          err: r.err,
        }),
      );
      continue;
    }
    await report(tx.executionId, { status: 'confirmed', signature });
    console.log(
      JSON.stringify({
        ...line,
        status: 'confirmed',
        signature,
        explorer: explorerTxUrl(signature),
        slot: r.slot,
      }),
    );
  } catch (e) {
    await report(tx.executionId, { status: 'failed', error: String(e).slice(0, 500) });
    console.log(
      JSON.stringify({ ...line, status: 'failed', stage: 'sign', err: String(e).slice(0, 200) }),
    );
  }
}
