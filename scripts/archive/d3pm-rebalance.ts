import 'dotenv/config';
import {
  asAddress,
  buildApprovalsTx,
  buildOrderTx,
  createRpc,
  explorerTxUrl,
  loadKeypair,
  readPositions,
  sendAndConfirm,
  simulateBase64,
} from '@colosseum/chain-solana';
import {
  assets as assetsTable,
  createDb,
  markConfirmed,
  markFailed,
  markSent,
  planLegs,
  plans,
  policies,
  positions as positionsTable,
  rebalances,
  recordBuilt,
} from '@colosseum/db';
import { proposeRebalance } from '@colosseum/engine';
import { Asset, type Policy } from '@colosseum/schemas';
import { desc, eq } from 'drizzle-orm';

// D3-PM: policy object + first rebalance under it.
//   --step policy            create (or reuse) the policy row for --plan
//   --step approve --send    user signs: approve 5 USDY + 5 syrupUSDC to the agent (policy activation)
//   --step propose           live positions → drift → proposed orders (no send)
//   --step run --send        execute the first executable order (delegated: agent signs alone)
const a = process.argv.slice(2);
const opt = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
const step = opt('--step') ?? 'propose';
const SEND = a.includes('--send');
const planId = opt('--plan');
if (!planId) throw new Error('--plan <id> required');

const rpc = createRpc();
const owner = await loadKeypair();
const agent = await loadKeypair(process.env.AGENT_KEYPAIR_PATH ?? './secrets/agent.json');
const { db, client } = createDb();
const assetMap = new Map(
  (await db.select().from(assetsTable)).map((r) => [
    r.id,
    Asset.parse({
      ...r,
      mint: r.mint ?? undefined,
      tokenProgram: r.tokenProgram ?? undefined,
      decimals: r.decimals ?? undefined,
      capWeight: Number(r.capWeight),
    }),
  ]),
);
const dexAssets = new Set(
  [...assetMap.values()]
    .filter(
      (x) =>
        x.mintPath === 'dex_swap' &&
        x.tokenProgram === 'token' &&
        x.id !== 'usdc' &&
        x.id !== 'usdt',
    )
    .map((x) => x.id),
);
const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
if (!plan) throw new Error('plan not found');
const legs = await db.select().from(planLegs).where(eq(planLegs.planId, planId));
const targets = Object.fromEntries(legs.map((l) => [l.assetId, Number(l.weight)]));

async function loadOrCreatePolicy(): Promise<Policy> {
  const [existing] = await db
    .select()
    .from(policies)
    .where(eq(policies.planId, planId as string))
    .orderBy(desc(policies.createdAt))
    .limit(1);
  if (existing) return rowToPolicy(existing);
  const bands = legs.map((l) => ({
    assetId: l.assetId,
    min: Math.max(0, Number(l.weight) - 0.1),
    max: Math.min(1, Number(l.weight) + 0.1),
  }));
  const [row] = await db
    .insert(policies)
    .values({
      planId: planId as string,
      wallet: owner.address,
      allowedAssets: legs.map((l) => l.assetId),
      bands,
      trigger: { driftPct: 5, minIntervalHours: 0.01 },
      withdrawalDestination: owner.address,
      mechanism: 'delegated',
      mechanismByAsset: { 'kamino-usdc': 'user_signed', spyx: 'user_signed', qqqx: 'user_signed' },
      delegation: { agent: agent.address, approvedBase: { usdy: '5000000', syrupusdc: '5000000' } },
    })
    .returning();
  if (!row) throw new Error('policy insert');
  return rowToPolicy(row);
}
const rowToPolicy = (r: typeof policies.$inferSelect): Policy => ({
  id: r.id,
  planId: r.planId,
  wallet: r.wallet,
  allowedAssets: r.allowedAssets as string[],
  bands: r.bands as Policy['bands'],
  trigger: r.trigger as Policy['trigger'],
  withdrawalDestination: r.withdrawalDestination,
  mechanism: r.mechanism,
  mechanismByAsset: (r.mechanismByAsset ?? {}) as Policy['mechanismByAsset'],
  delegation: (r.delegation ?? undefined) as Policy['delegation'],
  createdAt: r.createdAt.toISOString(),
});

let policy = await loadOrCreatePolicy();
const triggerArg = opt('--trigger');
if (triggerArg) {
  // Owner action: tighten or loosen the drift trigger of their own policy (a policy parameter, recorded).
  const trigger = { ...policy.trigger, driftPct: Number(triggerArg) };
  await db.update(policies).set({ trigger }).where(eq(policies.id, policy.id));
  policy = { ...policy, trigger };
}
console.log(
  JSON.stringify({
    step,
    policy: {
      id: policy.id,
      allowedAssets: policy.allowedAssets,
      bands: policy.bands,
      trigger: policy.trigger,
      mechanism: policy.mechanism,
      mechanismByAsset: policy.mechanismByAsset,
      delegate: policy.delegation?.agent,
    },
  }),
);

if (step === 'approve') {
  const usdy = assetMap.get('usdy');
  const syrup = assetMap.get('syrupusdc');
  if (!usdy?.mint || !syrup?.mint) throw new Error('mints');
  const built = await buildApprovalsTx(rpc, owner, asAddress(agent.address), [
    { mint: asAddress(usdy.mint), amountBase: 5_000_000n, decimals: 6 },
    { mint: asAddress(syrup.mint), amountBase: 5_000_000n, decimals: 6 },
  ]);
  const sim = await simulateBase64(rpc, built.wire);
  if (!sim.ok || !SEND)
    console.log(JSON.stringify({ step, simulation: sim.ok ? 'ok' : sim.err, sent: false }));
  else {
    const id = await recordBuilt(db, {
      planId,
      wallet: owner.address,
      chain: 'solana',
      kind: 'approve',
      assetId: 'usdy',
      provenance: 'live',
    });
    await markSent(db, id, built.signature, explorerTxUrl(built.signature));
    const r = await sendAndConfirm(rpc, built.wire);
    if (r.err) await markFailed(db, id, JSON.stringify(r.err));
    else await markConfirmed(db, id);
    console.log(
      JSON.stringify({
        step,
        signature: built.signature,
        explorer: explorerTxUrl(built.signature),
        status: r.err ? 'failed' : 'confirmed',
        err: r.err,
      }),
    );
  }
}

if (step === 'propose' || step === 'run') {
  const read = await readPositions(rpc, asAddress(owner.address), assetMap);
  if (read.errors.length) console.log(JSON.stringify({ step, positionErrors: read.errors }));
  const pos = read.positions;
  for (const p of pos)
    await db.insert(positionsTable).values({
      wallet: owner.address,
      assetId: p.assetId,
      amount: String(p.amount),
      valueUsd: String(p.valueUsd),
      observedAt: new Date(p.observedAt),
      source: p.source,
    });
  const prices = new Map(pos.map((p) => [p.assetId, p.price]));
  const [last] = await db
    .select()
    .from(rebalances)
    .where(eq(rebalances.policyId, policy.id))
    .orderBy(desc(rebalances.createdAt))
    .limit(1);
  const proposal = proposeRebalance({
    policy,
    targets,
    positions: pos.map((p) => ({ assetId: p.assetId, valueUsd: p.valueUsd })),
    dexAssets,
    lastRebalanceAt: last?.createdAt,
  });
  console.log(
    JSON.stringify({
      step,
      positions: pos.map((p) => ({
        assetId: p.assetId,
        amount: p.amount,
        valueUsd: Number(p.valueUsd.toFixed(2)),
        price: p.price.usdcPerUnit,
        priceMethod: p.price.method,
      })),
      targets,
      proposal,
    }),
  );

  if (step === 'run' && proposal.triggered) {
    const first = proposal.orders[0];
    if (!first) throw new Error('no orders');
    const build = await buildOrderTx(rpc, first, assetMap, prices, agent);
    if (build.kind === 'unsupported') {
      console.log(JSON.stringify({ step, order: first, build: build.kind, reason: build.reason }));
    } else if (build.kind === 'user_signed') {
      // The owner (demo wallet) signs each unsigned transaction in order; every outcome is logged.
      const { signBase64 } = await import('@colosseum/chain-solana');
      const [reb] = SEND
        ? await db
            .insert(rebalances)
            .values({
              policyId: policy.id,
              triggerReason: proposal.reason,
              proposed: proposal.orders,
              mechanism: 'user_signed',
            })
            .returning()
        : [undefined];
      for (const t of build.txs) {
        const { wire, signature } = await signBase64(t.payload, owner);
        const sim = await simulateBase64(rpc, wire);
        if (!sim.ok || !SEND) {
          console.log(
            JSON.stringify({
              step,
              rebalanceId: reb?.id,
              tx: t.description,
              simulation: sim.ok ? 'ok' : sim.err,
              sent: false,
              logs: sim.ok ? undefined : sim.logs.slice(-5),
            }),
          );
          if (!sim.ok) break;
          continue;
        }
        const execId = await recordBuilt(db, {
          planId,
          wallet: owner.address,
          chain: 'solana',
          kind: t.kind,
          assetId: t.legAssetId,
          amountIn: build.amountBase.toString(),
          provenance: 'live',
        });
        if (reb && t === build.txs[0])
          await db.update(rebalances).set({ executionId: execId }).where(eq(rebalances.id, reb.id));
        await markSent(db, execId, signature, explorerTxUrl(signature));
        const r = await sendAndConfirm(rpc, wire);
        if (r.err) {
          await markFailed(db, execId, JSON.stringify(r.err));
          console.log(
            JSON.stringify({
              step,
              rebalanceId: reb?.id,
              tx: t.description,
              signature,
              explorer: explorerTxUrl(signature),
              status: 'failed',
              err: r.err,
            }),
          );
          break;
        }
        await markConfirmed(db, execId);
        console.log(
          JSON.stringify({
            step,
            rebalanceId: reb?.id,
            tx: t.description,
            signature,
            explorer: explorerTxUrl(signature),
            slot: r.slot,
            status: 'confirmed',
            signer: owner.address,
          }),
        );
      }
    } else {
      const sim = await simulateBase64(rpc, build.signed.wire);
      if (!sim.ok || !SEND)
        console.log(
          JSON.stringify({
            step,
            order: first,
            amountBase: build.amountBase.toString(),
            quote: build.quote,
            simulation: sim.ok ? 'ok' : sim.err,
            sent: false,
          }),
        );
      else {
        const execId = await recordBuilt(db, {
          planId,
          wallet: agent.address,
          chain: 'solana',
          kind: 'rebalance',
          assetId: first.toAssetId,
          amountIn: build.amountBase.toString(),
          provenance: 'live',
        });
        const [reb] = await db
          .insert(rebalances)
          .values({
            policyId: policy.id,
            triggerReason: proposal.reason,
            proposed: proposal.orders,
            mechanism: 'delegated',
            executionId: execId,
          })
          .returning();
        await markSent(db, execId, build.signed.signature, explorerTxUrl(build.signed.signature));
        const r = await sendAndConfirm(rpc, build.signed.wire);
        if (r.err) await markFailed(db, execId, JSON.stringify(r.err));
        else await markConfirmed(db, execId, build.quote.outAmount);
        console.log(
          JSON.stringify({
            step,
            rebalanceId: reb?.id,
            order: first,
            signature: build.signed.signature,
            explorer: explorerTxUrl(build.signed.signature),
            status: r.err ? 'failed' : 'confirmed',
            signer: agent.address,
            err: r.err,
          }),
        );
      }
    }
  }
}
await client.end();
