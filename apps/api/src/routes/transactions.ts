import { buildPlanTransactions, createRpc, explorerTxUrl } from '@colosseum/chain-solana';
import {
  assets as assetsTable,
  executions,
  markConfirmed,
  markFailed,
  markSent,
  planLegs,
  plans,
  recordBuilt,
  sharedDb,
} from '@colosseum/db';
import {
  ApiError,
  Asset,
  DISCLAIMER,
  ExecutionReport,
  PostPlanTransactionsRequest,
  PostPlanTransactionsResponse,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const rowToAsset = (r: typeof assetsTable.$inferSelect): Asset =>
  Asset.parse({
    ...r,
    mint: r.mint ?? undefined,
    tokenProgram: r.tokenProgram ?? undefined,
    decimals: r.decimals ?? undefined,
    capWeight: Number(r.capWeight),
  });

export async function registerTransactionRoutes(app: FastifyInstance) {
  // The process's one pool (packages/db: `sharedDb`).
  const { db } = sharedDb();
  // RPC is created on first use so the app builds (and tests run) without chain env.
  let rpcInstance: ReturnType<typeof createRpc> | undefined;
  const rpc = () => (rpcInstance ??= createRpc());
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.post(
    '/plans/:id/transactions',
    {
      schema: {
        summary:
          'Build the unsigned transaction set for a plan; the partner wallet signs and sends, then reports each outcome',
        description:
          'One transaction per leg, ordered: funding conversion, DEX swaps, lending deposits. Legs are independent; a leg that cannot be built is listed under `errors` and the others are still returned. Legs whose asset is not executable yet (e.g. the BRL leg before the issuer integration) are listed under `skipped`. Every transaction has an `executions` row (`executionId`) in status `built`; report outcomes to POST /executions/{id}/report.',
        params: z.object({ id: z.string().uuid() }),
        body: PostPlanTransactionsRequest,
        response: { 200: PostPlanTransactionsResponse, 404: ApiError },
      },
    },
    async (req, reply) => {
      const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id));
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const legs = await db.select().from(planLegs).where(eq(planLegs.planId, plan.id));
      const assetMap = new Map(
        (await db.select().from(assetsTable)).map((r) => [r.id, rowToAsset(r)]),
      );
      const wallet = req.body.wallet;

      const inputs = [];
      for (const l of legs) {
        const a = assetMap.get(l.assetId);
        const executable = a && a.mintPath !== 'unavailable' && a.id !== 'usdc';
        const executionId = executable
          ? await recordBuilt(db, {
              planId: plan.id,
              planLegId: l.id,
              wallet,
              chain: 'solana',
              kind: a.mintPath === 'lending_deposit' ? 'deposit' : 'swap',
              assetId: a.id,
              amountIn: String(Math.round(Number(l.amountUsd) * 1_000_000)),
              provenance: 'live',
            })
          : undefined;
        inputs.push({ assetId: l.assetId, amountUsd: Number(l.amountUsd), executionId });
      }
      const results = await buildPlanTransactions(
        rpc(),
        { wallet, fundingAssetId: 'usdc', legs: inputs },
        assetMap,
      );
      for (const r of results)
        if (r.error && r.leg.executionId)
          await markFailed(db, r.leg.executionId, `build: ${r.error}`);
      return {
        planId: plan.id,
        wallet,
        transactions: results.flatMap((r) => (r.tx ? [r.tx] : [])),
        skipped: results.flatMap((r) =>
          r.skipped ? [{ assetId: r.leg.assetId, reason: r.skipped }] : [],
        ),
        errors: results.flatMap((r) =>
          r.error
            ? [{ assetId: r.leg.assetId, executionId: r.leg.executionId, error: r.error }]
            : [],
        ),
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.post(
    '/executions/:id/report',
    {
      schema: {
        summary: 'Report the outcome of a transaction the partner wallet signed and sent',
        params: z.object({ id: z.string().uuid() }),
        body: ExecutionReport,
        response: {
          200: z.object({ id: z.string(), status: z.string(), explorerUrl: z.string().nullable() }),
          404: ApiError,
        },
      },
    },
    async (req, reply) => {
      const [row] = await db.select().from(executions).where(eq(executions.id, req.params.id));
      if (!row) return reply.code(404).send({ error: 'execution not found' });
      const { status, signature, error } = req.body;
      if (status === 'sent' && signature)
        await markSent(db, row.id, signature, explorerTxUrl(signature));
      else if (status === 'confirmed') {
        if (signature && !row.signature)
          await markSent(db, row.id, signature, explorerTxUrl(signature));
        await markConfirmed(db, row.id);
      } else if (status === 'failed') {
        if (signature && !row.signature)
          await markSent(db, row.id, signature, explorerTxUrl(signature));
        await markFailed(db, row.id, error ?? 'reported failed');
      }
      const [after] = await db.select().from(executions).where(eq(executions.id, row.id));
      return {
        id: row.id,
        status: after?.status ?? status,
        explorerUrl: after?.explorerUrl ?? null,
      };
    },
  );
}
