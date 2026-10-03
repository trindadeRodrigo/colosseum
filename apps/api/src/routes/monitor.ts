import {
  asAddress,
  buildOrderTx,
  buildRevokeUnsigned,
  createRpc,
  explorerTxUrl,
  readPositions,
  simulateBase64,
} from '@colosseum/chain-solana';
import { loadKeypair, sendAndConfirm } from '@colosseum/chain-solana/server';
import {
  assets as assetsTable,
  constraintSheets,
  createDb,
  executions,
  markConfirmed,
  markFailed,
  markSent,
  planLegs,
  plans,
  policies,
  positions as positionsTable,
  rebalances,
  recordBuilt,
  schedules,
} from '@colosseum/db';
import { computeDrift, proposeRebalance } from '@colosseum/engine';
import {
  ApiError,
  Asset,
  DISCLAIMER,
  type LiquidityAssessment,
  type Policy,
} from '@colosseum/schemas';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadLiquidityProvider } from '../liquidity';

const rowToAsset = (r: typeof assetsTable.$inferSelect): Asset =>
  Asset.parse({
    ...r,
    mint: r.mint ?? undefined,
    tokenProgram: r.tokenProgram ?? undefined,
    decimals: r.decimals ?? undefined,
    capWeight: Number(r.capWeight),
  });
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

/** Monitoring: live positions vs the policy, proposal, next withdrawal, projected vs actual; and rebalance execution under the policy. */
export async function registerMonitorRoutes(app: FastifyInstance) {
  const { db } = createDb();
  let rpcInstance: ReturnType<typeof createRpc> | undefined;
  const rpc = () => (rpcInstance ??= createRpc());
  const f = app.withTypeProvider<ZodTypeProvider>();

  async function snapshot(policyId: string) {
    const [pol] = await db.select().from(policies).where(eq(policies.id, policyId));
    if (!pol) return null;
    const policy = rowToPolicy(pol);
    const assets = (await db.select().from(assetsTable)).map(rowToAsset);
    const assetMap = new Map(assets.map((a) => [a.id, a]));
    const legs = await db.select().from(planLegs).where(eq(planLegs.planId, policy.planId));
    const targets = Object.fromEntries(legs.map((l) => [l.assetId, Number(l.weight)]));
    const read = await readPositions(rpc(), asAddress(policy.wallet), assetMap);
    const live = read.positions;
    for (const p of live)
      await db.insert(positionsTable).values({
        wallet: policy.wallet,
        assetId: p.assetId,
        amount: String(p.amount),
        valueUsd: String(p.valueUsd),
        observedAt: new Date(p.observedAt),
        source: p.source,
      });
    const allowed = new Set(policy.allowedAssets);
    const inPolicy = live
      .filter((p) => allowed.has(p.assetId))
      .map((p) => ({ assetId: p.assetId, valueUsd: p.valueUsd }));
    const drift = computeDrift(policy, targets, inPolicy);
    const dexAssets = new Set(
      assets
        .filter(
          (x) =>
            x.mintPath === 'dex_swap' &&
            x.tokenProgram === 'token' &&
            x.id !== 'usdc' &&
            x.id !== 'usdt',
        )
        .map((x) => x.id),
    );
    const [last] = await db
      .select()
      .from(rebalances)
      .where(eq(rebalances.policyId, policy.id))
      .orderBy(desc(rebalances.createdAt))
      .limit(1);
    // liquidity trigger (risk layer): assess the next withdrawals against measured exit capacity
    let liquidity: (LiquidityAssessment & { withdrawalScale: number; windowDays: number }) | null =
      null;
    const trig = policy.trigger.liquidity;
    if (trig && read.errors.length === 0) {
      const provider = await loadLiquidityProvider(db, assets);
      const [planRow] = await db.select().from(plans).where(eq(plans.id, policy.planId));
      if (provider && planRow) {
        const [sheetRow] = await db
          .select()
          .from(constraintSheets)
          .where(eq(constraintSheets.id, planRow.constraintSheetId));
        const windowDays =
          (sheetRow?.sheet as { liquidityWindowDays?: number } | undefined)?.liquidityWindowDays ??
          30;
        const baseRowsAll = ((
          await db.select().from(schedules).where(eq(schedules.planId, policy.planId))
        ).find((x) => x.caseId === 'base')?.rows ?? []) as Array<{
          month: string;
          withdrawalBrl: number;
          fxUsdBrl: number;
        }>;
        const thisMonth = new Date().toISOString().slice(0, 7);
        const actual = inPolicy.reduce((t, p) => t + p.valueUsd, 0);
        // the plan's schedule is at plan capital; the wallet may hold a demo-size amount
        const scale = Number(planRow.capitalUsd) > 0 ? actual / Number(planRow.capitalUsd) : 1;
        const withdrawals = baseRowsAll
          .filter((r) => r.month >= thisMonth && r.withdrawalBrl > 0)
          .slice(0, trig.horizonMonths)
          .map((r) => ({
            at: `${r.month}-01T12:00:00.000Z`,
            usd: (r.withdrawalBrl / r.fxUsdBrl) * scale,
          }));
        const byKind = (k: string) =>
          inPolicy.filter((p) => assetMap.get(p.assetId)?.kind === k && p.assetId !== 'usdc');
        const a = provider.assess({
          cashUsd: inPolicy.find((p) => p.assetId === 'usdc')?.valueUsd ?? 0,
          brlUsd: byKind('brl_stable').reduce((t, p) => t + p.valueUsd, 0),
          liquid: byKind('usd_yield'),
          illiquid: byKind('equity'),
          withdrawals,
          windowDays,
          tau: trig.impactTolerancePct / 100,
          shareOfDepth: trig.shareOfDepth,
          dryFactorFloor: trig.dryFactorFloor,
        });
        liquidity = { ...a, withdrawalScale: scale, windowDays };
      }
    }
    const proposal =
      read.errors.length > 0
        ? {
            triggered: false,
            reason: `positions incomplete, no rebalance: ${read.errors.map((e) => `${e.assetId}: ${e.error}`).join('; ')}`,
            orders: [],
          }
        : proposeRebalance({
            policy,
            targets,
            positions: inPolicy,
            dexAssets,
            lastRebalanceAt: last?.createdAt,
            liquidity: liquidity ?? undefined,
          });
    const [base] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.planId, policy.planId))
      .limit(50);
    const baseRows = ((
      await db.select().from(schedules).where(eq(schedules.planId, policy.planId))
    ).find((s) => s.caseId === 'base')?.rows ?? []) as Array<{
      month: string;
      withdrawalBrl: number;
      balanceUsd: number;
      balanceBrl: number;
      fxUsdBrl: number;
    }>;
    const nowMonth = new Date().toISOString().slice(0, 7);
    const nextWithdrawal = baseRows.find((r) => r.month >= nowMonth && r.withdrawalBrl > 0) ?? null;
    const projected = baseRows.find((r) => r.month === nowMonth) ?? null;
    const [plan] = await db.select().from(plans).where(eq(plans.id, policy.planId));
    const actualUsd = inPolicy.reduce((s, p) => s + p.valueUsd, 0);
    return {
      policy,
      targets,
      positionErrors: read.errors,
      positions: live.map((p) => ({
        assetId: p.assetId,
        amount: p.amount,
        valueUsd: p.valueUsd,
        price: p.price,
        observedAt: p.observedAt,
        inPolicy: allowed.has(p.assetId),
      })),
      drift,
      proposal,
      liquidity,
      nextWithdrawal,
      projectedVsActual:
        plan && projected
          ? {
              month: nowMonth,
              projectedUsd: projected.balanceUsd,
              actualUsd,
              planCapitalUsd: Number(plan.capitalUsd),
              note: "projection is at plan capital; actual is the wallet's in-policy value (demo size)",
            }
          : null,
      baseScheduleAvailable: Boolean(base),
      disclaimer: DISCLAIMER,
    };
  }

  f.get(
    '/policies/:id/drift',
    {
      schema: {
        summary:
          'Live positions vs the policy: weights, drift, bands, proposal, next withdrawal, projected vs actual',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.any(), 404: ApiError },
      },
    },
    async (req, reply) => {
      const s = await snapshot(req.params.id);
      if (!s) return reply.code(404).send({ error: 'policy not found' });
      return s;
    },
  );

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

  f.get(
    '/executions',
    {
      schema: {
        summary: 'Recent executions across wallets (explorer links)',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.any() },
      },
    },
    async (req) => {
      const rows = await db
        .select()
        .from(executions)
        .orderBy(desc(executions.createdAt))
        .limit(req.query.limit);
      return rows
        .filter((e) => e.status !== 'built')
        .map((e) => ({
          id: e.id,
          kind: e.kind,
          assetId: e.assetId,
          wallet: e.wallet,
          status: e.status,
          signature: e.signature,
          explorerUrl: e.explorerUrl,
          createdAt: e.createdAt.toISOString(),
        }));
    },
  );

  f.get(
    '/stats',
    {
      schema: {
        summary:
          'Live numbers for the close: wallets, plans, confirmed executions, rebalances, value observed',
        response: { 200: z.any() },
      },
    },
    async () => {
      const execs = await db.select().from(executions);
      const confirmed = execs.filter((e) => e.status === 'confirmed');
      const wallets = new Set(confirmed.map((e) => e.wallet));
      const rebs = await db.select().from(rebalances);
      const planRows = await db.select().from(plans);
      const latestPositions = await db
        .select()
        .from(positionsTable)
        .orderBy(desc(positionsTable.observedAt))
        .limit(300);
      const latest = new Map<string, number>();
      for (const p of latestPositions) {
        const k = `${p.wallet}:${p.assetId}`;
        if (!latest.has(k)) latest.set(k, Number(p.valueUsd ?? 0));
      }
      return {
        wallets: wallets.size,
        plans: planRows.length,
        executionsConfirmed: confirmed.length,
        executionsFailed: execs.filter((e) => e.status === 'failed').length,
        rebalances: rebs.length,
        byKind: Object.fromEntries(
          ['swap', 'deposit', 'withdraw', 'mint', 'rebalance', 'approve'].map((k) => [
            k,
            confirmed.filter((e) => e.kind === k).length,
          ]),
        ),
        observedValueUsd: Math.round([...latest.values()].reduce((a, b) => a + b, 0) * 100) / 100,
        firstExecutionAt:
          confirmed
            .map((e) => e.createdAt)
            .sort((a, b) => a.getTime() - b.getTime())[0]
            ?.toISOString() ?? null,
        asOf: new Date().toISOString(),
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.post(
    '/policies/:id/revoke',
    {
      schema: {
        summary:
          'Policy off-switch: unsigned transaction revoking the agent delegate on every delegated asset; the wallet signs',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.any(), 404: ApiError },
      },
    },
    async (req, reply) => {
      const [pol] = await db.select().from(policies).where(eq(policies.id, req.params.id));
      if (!pol) return reply.code(404).send({ error: 'policy not found' });
      const policy = rowToPolicy(pol);
      const assets = new Map(
        (await db.select().from(assetsTable)).map((r) => [r.id, rowToAsset(r)]),
      );
      const mints = Object.keys(policy.delegation?.approvedBase ?? {})
        .map((id) => assets.get(id)?.mint)
        .filter((m): m is string => Boolean(m));
      if (mints.length === 0)
        return { transactions: [], note: 'no delegated approvals on this policy' };
      const built = await buildRevokeUnsigned(
        rpc(),
        asAddress(policy.wallet),
        mints.map((m) => asAddress(m)),
      );
      const executionId = await recordBuilt(db, {
        planId: policy.planId,
        wallet: policy.wallet,
        chain: 'solana',
        kind: 'approve',
        assetId: null,
        provenance: 'live',
      });
      return {
        transactions: [
          {
            legAssetId: 'policy',
            kind: 'approve',
            chain: 'solana',
            payload: built.wire,
            description: `Revoke agent ${policy.delegation?.agent} on ${mints.length} asset(s)`,
            provenance: 'live',
            executionId,
            lastValidBlockHeight: built.lastValidBlockHeight,
          },
        ],
      };
    },
  );
}
