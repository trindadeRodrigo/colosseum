import {
  assets as assetsTable,
  constraintSheets,
  createDb,
  fxObservations,
  goals,
  planLegs,
  plans,
  riskSheets,
  schedules,
  stressCases,
  yieldObservations,
} from '@colosseum/db';
import {
  buildRiskSheet,
  buildScheduleWithStresses,
  parseGoal,
  pickPrimaryYield,
  SOLVER_PARAMS,
  SOLVER_VERSION,
  solve,
} from '@colosseum/engine';
import {
  ApiError,
  Asset,
  type DepthObservation,
  DISCLAIMER,
  PostGoalsRequest,
  PostGoalsResponse,
  PostPlansRequest,
  PostPlansResponse,
  type YieldObservation,
} from '@colosseum/schemas';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadLiquidityProvider } from '../liquidity';

const rowToAsset = (r: typeof assetsTable.$inferSelect): Asset =>
  Asset.parse({
    ...r,
    mint: r.mint ?? undefined,
    tokenProgram: r.tokenProgram ?? undefined,
    decimals: r.decimals ?? undefined,
    capWeight: Number(r.capWeight),
  });

export async function registerPlanRoutes(app: FastifyInstance) {
  const { db } = createDb();
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.post(
    '/goals',
    {
      schema: {
        summary: 'Parse a natural-language goal (PT/EN) into a validated constraint sheet',
        description:
          'The LLM (when configured) or the deterministic rules parser proposes a sheet; zod validation decides. On failure the candidate and the errors are returned so the user can fix the sheet in the editor. The solver never runs on an unvalidated sheet.',
        body: PostGoalsRequest,
        response: { 200: PostGoalsResponse },
      },
    },
    async (req) => {
      const outcome = await parseGoal(req.body.text, req.body.language);
      const [goal] = await db
        .insert(goals)
        .values({
          rawText: req.body.text,
          language: outcome.sheet?.language ?? req.body.language ?? 'pt',
          wallet: req.body.wallet ?? null,
        })
        .returning();
      if (!goal) throw new Error('goal insert');
      await db.insert(constraintSheets).values({
        goalId: goal.id,
        sheet: outcome.sheet ?? outcome.candidate,
        valid: Boolean(outcome.sheet),
        validationErrors: outcome.errors,
        origin: 'llm',
        model: outcome.model ?? outcome.method,
      });
      return {
        goalId: goal.id,
        sheet: outcome.sheet ?? null,
        candidate: outcome.candidate,
        validationErrors: outcome.errors,
        parser: { method: outcome.method, model: outcome.model },
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.post(
    '/plans',
    {
      schema: {
        summary:
          'Solve an allocation, BRL schedule with stresses, and risk sheet for a validated constraint sheet',
        description:
          'Deterministic: rules + LP over the registry with the latest yield observations (each with source, method, timestamp and haircut rule) and the latest PTAX. Persists the plan, legs, schedules, stress cases and risk sheet. Capital is in USD (the wallet holds USDC/USDT).',
        body: PostPlansRequest,
        response: { 200: PostPlansResponse, 404: ApiError, 422: ApiError },
      },
    },
    async (req, reply) => {
      const { goalId, sheet, capitalUsd, wallet } = req.body;
      const [goal] = await db.select().from(goals).where(eq(goals.id, goalId));
      if (!goal) return reply.code(404).send({ error: 'goal not found' });
      const assets = (await db.select().from(assetsTable)).map(rowToAsset);
      const yRows = await db
        .select()
        .from(yieldObservations)
        .orderBy(desc(yieldObservations.fetchedAt))
        .limit(200);
      if (yRows.length === 0)
        return reply.code(422).send({ error: 'no yield observations; run pnpm feeds:refresh' });
      const yObs: YieldObservation[] = yRows.map((y) => ({
        assetId: y.assetId,
        quotedYield: Number(y.quotedYield),
        haircutYield: Number(y.haircutYield),
        haircutRule: y.haircutRule,
        source: y.source,
        method: y.method,
        fetchedAt: y.fetchedAt.toISOString(),
        provenance: y.provenance,
      }));
      const yields = pickPrimaryYield(yObs);
      const yieldIdByAsset = new Map<string, string>();
      for (const y of yRows) {
        const chosen = yields.get(y.assetId);
        if (
          chosen &&
          chosen.fetchedAt === y.fetchedAt.toISOString() &&
          chosen.method === y.method &&
          !yieldIdByAsset.has(y.assetId)
        )
          yieldIdByAsset.set(y.assetId, y.id);
      }
      const [fx] = await db
        .select()
        .from(fxObservations)
        .where(eq(fxObservations.pair, 'USD/BRL'))
        .orderBy(desc(fxObservations.fetchedAt))
        .limit(1);
      if (!fx) return reply.code(422).send({ error: 'no FX observation; run pnpm feeds:refresh' });
      const fxUsdBrl = Number(fx.value);

      const [cs] = await db
        .insert(constraintSheets)
        .values({ goalId, sheet, valid: true, validationErrors: [], origin: 'user_edit' })
        .returning();
      if (!cs) throw new Error('sheet insert');
      // the plan's chain only (ONE-CHAIN): a curve of another chain's asset must not make a provider exist
      const liquidity = await loadLiquidityProvider(
        db,
        assets.filter((a) => a.chain === 'solana'),
      );
      const solved = solve({ sheet, capitalUsd, assets, yields, fxUsdBrl, liquidity });
      const assetMap = new Map(assets.map((a) => [a.id, a]));
      const sched = buildScheduleWithStresses({
        sheet,
        legs: solved.legs,
        assets: assetMap,
        yields,
        capitalUsd,
        fxUsdBrl,
        liquidity,
      });
      const legAssets = solved.legs
        .map((l) => assetMap.get(l.assetId))
        .filter((a): a is Asset => Boolean(a));
      const risk = buildRiskSheet({
        assets: legAssets,
        yields,
        depth: new Map<string, DepthObservation[]>(),
        liquidity: liquidity
          ? {
              provider: liquidity,
              tau: SOLVER_PARAMS.impactTolerancePct / 100,
              windowDays: sheet.liquidityWindowDays,
              legAmounts: new Map(solved.legs.map((l) => [l.assetId, l.amountUsd])),
            }
          : undefined,
      });

      const [plan] = await db
        .insert(plans)
        .values({
          goalId,
          constraintSheetId: cs.id,
          profile: sheet.profile,
          capitalUsd: String(capitalUsd),
          wallet: wallet ?? goal.wallet ?? null,
          solverVersion: `${SOLVER_VERSION}/${solved.method}`,
          bindingConstraints: [...solved.bindingConstraints, ...solved.notes],
          disclaimer: DISCLAIMER.en,
        })
        .returning();
      if (!plan) throw new Error('plan insert');
      await db.insert(planLegs).values(
        solved.legs.map((l) => ({
          planId: plan.id,
          assetId: l.assetId,
          weight: String(l.weight),
          amountUsd: String(l.amountUsd),
          reasoning: l.reasoning,
          yieldObservationId: yieldIdByAsset.get(l.assetId) ?? null,
        })),
      );
      await db.insert(schedules).values({
        planId: plan.id,
        caseId: 'base',
        rows: sched.base.rows,
        liquidityOk: sched.base.liquidityOk,
        fxObservationId: fx.id,
      });
      for (const s of sched.stresses) {
        await db.insert(schedules).values({
          planId: plan.id,
          caseId: s.id,
          rows: s.rows,
          liquidityOk: s.liquidityOk,
          fxObservationId: fx.id,
        });
        await db.insert(stressCases).values({
          planId: plan.id,
          stressId: s.id,
          name: s.name,
          params: s.params,
          liquidityOk: s.liquidityOk,
          summary: sched.stressSummaries.find((x) => x.id === s.id)?.summary ?? null,
        });
      }
      for (const r of risk)
        await db.insert(riskSheets).values({ planId: plan.id, assetId: r.assetId, entry: r });

      return {
        id: plan.id,
        goalId,
        sheet,
        profile: sheet.profile,
        capitalUsd,
        legs: solved.legs,
        bindingConstraints: [...solved.bindingConstraints, ...solved.notes],
        schedule: sched.base.rows,
        stresses: sched.stresses,
        riskSheet: risk,
        solverVersion: `${SOLVER_VERSION}/${solved.method}`,
        liquidity: liquidity
          ? { methodVersion: liquidity.methodVersion, provenance: liquidity.provenance }
          : null,
        disclaimer: DISCLAIMER.en,
        createdAt: plan.createdAt.toISOString(),
      };
    },
  );
}
