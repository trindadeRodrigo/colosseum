import { buildOrderTx, explorerTxUrl, simulateBase64 } from '@colosseum/chain-solana';
import { loadKeypair, sendAndConfirm } from '@colosseum/chain-solana/server';
import {
  assets as assetsTable,
  markConfirmed,
  markFailed,
  markSent,
  rebalances,
  recordBuilt,
} from '@colosseum/db';
import { ApiError } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type MonitorContext, rowToAsset } from './monitor';

/**
 * Rebalance execution under the policy: the one route of the monitor that reaches a signer. It loads
 * the agent key and signs on the server, so it lives in a file of its own, which the API loads only
 * with LEGACY_STRUCTURER on (app.ts). The handler is as it was in monitor.ts.
 */
export function registerMonitorRebalanceRoute(
  app: FastifyInstance,
  { db, rpc, snapshot }: MonitorContext,
) {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.post(
    '/policies/:id/rebalance',
    {
      schema: {
        summary:
          'Run the policy once: execute the first delegated order with the agent key, or return an unsigned transaction for the wallet to sign',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ dryRun: z.boolean().default(false) }).default({ dryRun: false }),
        response: { 200: z.any(), 404: ApiError },
      },
    },
    async (req, reply) => {
      const s = await snapshot(req.params.id);
      if (!s) return reply.code(404).send({ error: 'policy not found' });
      if (!s.proposal.triggered || s.proposal.orders.length === 0)
        return { triggered: false, reason: s.proposal.reason, orders: [] };
      const assets = new Map(
        (await db.select().from(assetsTable)).map((r) => [r.id, rowToAsset(r)]),
      );
      const prices = new Map(s.positions.map((p) => [p.assetId, p.price]));
      const order = s.proposal.orders[0];
      if (!order) return { triggered: false, reason: 'no orders', orders: [] };
      const agentPath = process.env.AGENT_KEYPAIR_PATH ?? './secrets/agent.json';
      const agent = order.mechanism === 'delegated' ? await loadKeypair(agentPath) : undefined;
      const build = await buildOrderTx(rpc(), order, assets, prices, agent);
      if (build.kind === 'unsupported')
        return {
          triggered: true,
          reason: s.proposal.reason,
          order,
          outcome: 'unsupported',
          detail: build.reason,
        };
      if (build.kind === 'user_signed') {
        const txs = [];
        for (const t of build.txs) {
          const executionId = await recordBuilt(db, {
            planId: s.policy.planId,
            wallet: s.policy.wallet,
            chain: 'solana',
            kind: t.kind,
            assetId: t.legAssetId,
            amountIn: build.amountBase.toString(),
            provenance: 'live',
          });
          txs.push({ ...t, executionId });
        }
        const first = txs[0];
        await db.insert(rebalances).values({
          policyId: s.policy.id,
          triggerReason: s.proposal.reason,
          proposed: s.proposal.orders,
          mechanism: 'user_signed',
          executionId: first?.executionId ?? null,
        });
        return {
          triggered: true,
          reason: s.proposal.reason,
          order,
          outcome: 'user_signed',
          transactions: txs,
        };
      }
      const sim = await simulateBase64(rpc(), build.signed.wire);
      if (!sim.ok)
        return {
          triggered: true,
          reason: s.proposal.reason,
          order,
          outcome: 'simulation_failed',
          detail: sim.err,
          logs: sim.logs.slice(-6),
        };
      if (req.body.dryRun)
        return {
          triggered: true,
          reason: s.proposal.reason,
          order,
          outcome: 'dry_run',
          quote: build.quote,
          unitsConsumed: sim.unitsConsumed,
        };
      const execId = await recordBuilt(db, {
        planId: s.policy.planId,
        wallet: agent?.address ?? s.policy.wallet,
        chain: 'solana',
        kind: 'rebalance',
        assetId: order.toAssetId,
        amountIn: build.amountBase.toString(),
        provenance: 'live',
      });
      const [reb] = await db
        .insert(rebalances)
        .values({
          policyId: s.policy.id,
          triggerReason: s.proposal.reason,
          proposed: s.proposal.orders,
          mechanism: 'delegated',
          executionId: execId,
        })
        .returning();
      await markSent(db, execId, build.signed.signature, explorerTxUrl(build.signed.signature));
      const r = await sendAndConfirm(rpc(), build.signed.wire);
      if (r.err) {
        await markFailed(db, execId, JSON.stringify(r.err));
        return {
          triggered: true,
          reason: s.proposal.reason,
          order,
          outcome: 'failed',
          signature: build.signed.signature,
          explorerUrl: explorerTxUrl(build.signed.signature),
          error: r.err,
          rebalanceId: reb?.id,
        };
      }
      await markConfirmed(db, execId, build.quote.outAmount);
      return {
        triggered: true,
        reason: s.proposal.reason,
        order,
        outcome: 'confirmed',
        signature: build.signed.signature,
        explorerUrl: explorerTxUrl(build.signed.signature),
        slot: r.slot,
        signer: agent?.address,
        rebalanceId: reb?.id,
      };
    },
  );
}
