import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDb,
  riskAssetSnapshots,
  riskDepthCurves,
  riskEvents,
  riskLendingCoverage,
  riskLendingFacts,
  riskLpConcentration,
  riskMarketParams,
  riskPoolSnapshots,
  riskPools,
} from '@colosseum/db';
import {
  type AssetCurves,
  assessLiquidity,
  costAt,
  type DepthCurve,
  defaultRegimeParams,
  gapSim,
  hourOfWeek,
  type IssuerModel,
  liquidityScore,
  maxNotionalAt,
  REGIMES,
  type Regime,
  recoverableValue,
  regimesIn,
  weekendRatio,
} from '@colosseum/risk';
import { AssetFacts, DISCLAIMER, LendingPoolFacts, PlanFacts } from '@colosseum/schemas';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadAssetFacts, loadPlanFacts } from '../facts';
import { FACTS_METHODOLOGY } from '../facts-methodology';

/**
 * Liquidity & risk API (`/risk/*`). Mounted by apps/api and, alone, by apps/risk-api. Every number carries
 * its method version, sample counts and dates; issuer redemption terms are labelled `assumption`.
 * Not licensed advice or a rating: DISCLAIMER on every response.
 */
const ROOT = process.env.REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..', '..');
const calendar = JSON.parse(
  readFileSync(join(ROOT, 'fixtures/risk/us-market-holidays.json'), 'utf8'),
);
const REGIME_PARAMS = defaultRegimeParams(calendar);
const ISSUERS = JSON.parse(readFileSync(join(ROOT, 'fixtures/risk/issuer-models.json'), 'utf8'))
  .models as Record<string, IssuerModel>;
const METHOD_VERSION = 'risk-0.3';
/** Largest `POST /risk/positions/assess` body: 50 years of monthly withdrawals, 50 legs (PLAN-ANALYTICS item 2). */
export const ASSESS_MAX_WITHDRAWALS = 600;
export const ASSESS_MAX_LEGS = 50;
const HONESTY = [
  'Depth is measured from on-chain pool state; calm-market depth overstates depth in stress. Each curve shows its regime, sample count and date range.',
  'Curves simulate the best split of a sale across the asset’s dollar-exit pools (USDC, USDT, SOL) per snapshot; pools quoted in other tokens are not counted.',
  'Issuer redemption capacity is a scenario input (assumption), not a measurement.',
  'Asset- and market-level aggregates only; no wallet positions are published.',
];
const Regimes = z.enum(['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday']);

export async function registerRiskRoutes(app: FastifyInstance) {
  const { db } = createDb();
  const f = app.withTypeProvider<ZodTypeProvider>();

  async function resolveAsset(id: string) {
    const rows = await db
      .select({ mint: riskPools.assetMint, symbol: riskPools.assetSymbol })
      .from(riskPools)
      .where(
        sql`lower(${riskPools.assetSymbol}) = ${id.toLowerCase()} or ${riskPools.assetMint} = ${id}`,
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async function curvesFor(mint: string, side: 'sell' | 'buy' = 'sell'): Promise<AssetCurves> {
    const rows = await db
      .select()
      .from(riskDepthCurves)
      .where(
        and(
          eq(riskDepthCurves.assetMint, mint),
          eq(riskDepthCurves.side, side),
          eq(riskDepthCurves.methodVersion, METHOD_VERSION),
        ),
      );
    const byRegime: Partial<Record<Regime, DepthCurve>> = {};
    for (const r of rows)
      byRegime[r.regime as Regime] = {
        points: r.points as DepthCurve['points'],
        insufficientFrom: r.insufficientFrom,
        quantile: r.quantile,
        minSamples: r.minSamples,
        from: r.dataFrom?.toISOString() ?? null,
        to: r.dataTo?.toISOString() ?? null,
        samples: r.samples,
      };
    return { assetId: mint, byRegime };
  }

  f.get(
    '/risk/assets',
    {
      schema: {
        summary: 'Assets with measured exit capacity per regime',
        description: `Sell-side capacity at cost tolerance tau per time-of-week regime, weekend/market-hours ratio, and coverage.\n\n${DISCLAIMER.en}`,
        querystring: z.object({ tau: z.coerce.number().positive().max(0.5).default(0.01) }),
        response: {
          200: z.object({
            methodVersion: z.string(),
            tau: z.number(),
            honesty: z.array(z.string()),
            disclaimer: z.string(),
            assets: z.array(z.any()),
          }),
        },
      },
    },
    async (req) => {
      const tau = req.query.tau;
      const pools = await db
        .select()
        .from(riskPools)
        .where(inArray(riskPools.tier, ['A', 'B']));
      const tvl = new Map<string, { symbol: string; tvl: number; pools: number }>();
      for (const p of pools) {
        const v = tvl.get(p.assetMint) ?? { symbol: p.assetSymbol, tvl: 0, pools: 0 };
        v.tvl += p.tvlUsd ?? 0;
        v.pools++;
        tvl.set(p.assetMint, v);
      }
      const assets = [];
      for (const [mint, v] of [...tvl.entries()].sort((a, b) => b[1].tvl - a[1].tvl)) {
        const c = await curvesFor(mint);
        const capacity = Object.fromEntries(
          REGIMES.filter((r) => c.byRegime[r]).map((r) => {
            const m = maxNotionalAt(c.byRegime[r] as DepthCurve, tau);
            const cv = c.byRegime[r] as DepthCurve;
            return [
              r,
              {
                status: cv.insufficientFrom === 0 ? 'insufficient_samples' : 'ok',
                capacityUsd: cv.insufficientFrom === 0 ? null : m.notionalUsd,
                lowerBound: m.lowerBound,
                samples: cv.samples,
                from: cv.from,
                to: cv.to,
                insufficientFrom: cv.insufficientFrom,
              },
            ];
          }),
        );
        assets.push({
          assetMint: mint,
          symbol: v.symbol,
          poolTvlUsd: v.tvl,
          pools: v.pools,
          capacityAtTau: capacity,
          weekendRatio: weekendRatio(c, tau),
          provenance: 'live',
        });
      }
      return {
        methodVersion: METHOD_VERSION,
        tau,
        honesty: HONESTY,
        disclaimer: DISCLAIMER.en,
        assets,
      };
    },
  );

  f.get(
    '/risk/facts/assets/:id',
    {
      schema: {
        summary:
          'Fact sheet for one asset at one trade size: entry and exit cost by regime, capacity, LP concentration, lending use. A fact with no data is null with its reason, never zero',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          sizeUsd: z.coerce.number().positive().optional(),
          tau: z.coerce.number().positive().max(0.5).optional(),
        }),
        response: {
          200: AssetFacts.extend({ disclaimer: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const sheet = await loadAssetFacts(db, req.params.id, req.query);
      if (!sheet) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      return { ...sheet, disclaimer: DISCLAIMER.en };
    },
  );

  // PLAN-ANALYTICS item 11: the lending and plan fact sheets, and liquidation coverage under both definitions.
  const latestReportAt = async () => {
    const [r] = await db
      .select({ t: riskLendingFacts.reportAt })
      .from(riskLendingFacts)
      .orderBy(desc(riskLendingFacts.reportAt))
      .limit(1);
    return r?.t ?? null;
  };
  f.get(
    '/risk/facts/methodology',
    {
      schema: {
        summary: 'How every number in the fact sheets is computed (facts-0.1), as markdown',
        response: {
          200: z.object({
            methodVersion: z.string(),
            markdown: z.string(),
            disclaimer: z.string(),
          }),
        },
      },
    },
    async () => ({
      methodVersion: 'facts-0.1',
      markdown: FACTS_METHODOLOGY,
      disclaimer: DISCLAIMER.en,
    }),
  );

  f.get(
    '/risk/facts/lending',
    {
      schema: {
        summary: 'The lending pools that have a fact sheet, from the latest lending report',
        response: {
          200: z.object({
            reportAt: z.string().nullable(),
            pools: z.array(
              z.object({
                account: z.string(),
                venue: z.string(),
                market: z.string(),
                symbol: z.string(),
              }),
            ),
            disclaimer: z.string(),
          }),
        },
      },
    },
    async () => {
      const at = await latestReportAt();
      const pools = at
        ? await db
            .select({
              account: riskLendingFacts.account,
              venue: riskLendingFacts.venue,
              market: riskLendingFacts.market,
              symbol: riskLendingFacts.symbol,
            })
            .from(riskLendingFacts)
            .where(eq(riskLendingFacts.reportAt, at))
        : [];
      return { reportAt: at?.toISOString() ?? null, pools, disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/facts/lending/:account',
    {
      schema: {
        summary:
          'Fact sheet for one lending pool: what a lender can withdraw, rates, lender concentration, collateral coverage by price gap, liquidation routes, history. Null facts carry their reason',
        params: z.object({ account: z.string() }),
        response: {
          200: LendingPoolFacts.extend({ reportAt: z.string(), disclaimer: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const [row] = await db
        .select()
        .from(riskLendingFacts)
        .where(eq(riskLendingFacts.account, req.params.account))
        .orderBy(desc(riskLendingFacts.reportAt))
        .limit(1);
      if (!row) return reply.code(404).send({ error: `no fact sheet for ${req.params.account}` });
      return {
        ...(row.sheet as LendingPoolFacts),
        reportAt: row.reportAt.toISOString(),
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.post(
    '/risk/facts/plan',
    {
      schema: {
        summary:
          'Fact sheet for a set of positions: concentration, exit cost in one regime, round trip, stress cases, and the breach assessment when withdrawals are given. No probability of reaching a goal',
        body: z.object({
          positions: z
            .array(z.object({ assetId: z.string().min(1), valueUsd: z.number().nonnegative() }))
            .min(1)
            .max(ASSESS_MAX_LEGS),
          withdrawals: z
            .array(z.object({ at: z.string().datetime(), usd: z.number().positive() }))
            .max(ASSESS_MAX_WITHDRAWALS)
            .optional(),
          windowDays: z.number().int().min(0).max(365).optional(),
        }),
        response: { 200: PlanFacts.extend({ disclaimer: z.string() }) },
      },
    },
    async (req) => {
      const sheet = await loadPlanFacts(db, req.body.positions, {
        withdrawals: req.body.withdrawals,
        windowDays: req.body.windowDays,
      });
      return { ...sheet, disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/lending/coverage',
    {
      schema: {
        summary:
          "Liquidation coverage by price gap and collateral asset, from the latest lending report: the earlier ratio (sale cost at most the bonus) beside the ratio on the liquidator's margin",
        querystring: z.object({
          asset: z.string().optional(),
          gapPct: z.coerce.number().positive().optional(),
        }),
        response: { 200: z.any() },
      },
    },
    async (req) => {
      const [r] = await db
        .select({ t: riskLendingCoverage.reportAt })
        .from(riskLendingCoverage)
        .orderBy(desc(riskLendingCoverage.reportAt))
        .limit(1);
      if (!r) return { reportAt: null, rows: [], disclaimer: DISCLAIMER.en };
      const rows = await db
        .select()
        .from(riskLendingCoverage)
        .where(
          and(
            eq(riskLendingCoverage.reportAt, r.t),
            req.query.asset ? eq(riskLendingCoverage.asset, req.query.asset) : undefined,
            req.query.gapPct ? eq(riskLendingCoverage.gapPct, req.query.gapPct) : undefined,
          ),
        )
        .orderBy(riskLendingCoverage.gapPct, riskLendingCoverage.asset);
      return {
        reportAt: r.t.toISOString(),
        definitions: {
          earlier:
            'capacity at sale cost at most the bonus at the threshold, worst measured regime',
          margin:
            "capacity at liquidator margin at least 0 on the routed sale, at each regime's oracle gap; regimes without a curve or oracle rows are listed in regimesMissing",
        },
        rows,
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.get(
    '/risk/assets/:id/depth',
    {
      schema: {
        summary: 'Fitted depth curve for one asset, side and regime',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          side: z.enum(['sell', 'buy']).default('sell'),
          regime: Regimes.default('us_market_hours'),
        }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.params.id);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      const [row] = await db
        .select()
        .from(riskDepthCurves)
        .where(
          and(
            eq(riskDepthCurves.assetMint, a.mint),
            eq(riskDepthCurves.side, req.query.side),
            eq(riskDepthCurves.regime, req.query.regime),
            eq(riskDepthCurves.methodVersion, METHOD_VERSION),
          ),
        );
      if (!row)
        return reply
          .code(404)
          .send({ error: `no ${req.query.side} curve for ${a.symbol} in ${req.query.regime} yet` });
      return { asset: a.symbol, ...row, costUnit: 'fraction', disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/assets/:id/lp',
    {
      schema: {
        summary: 'LP concentration and LP-exit stress for the asset’s pools (latest hour)',
        params: z.object({ id: z.string() }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.params.id);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      const rows = await db
        .select()
        .from(riskLpConcentration)
        .where(eq(riskLpConcentration.asset, a.symbol))
        .orderBy(desc(riskLpConcentration.fetchedAt))
        .limit(50);
      const latest = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!latest.has(r.pool)) latest.set(r.pool, r);
      return { asset: a.symbol, pools: [...latest.values()], disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/assets/:id/heatmap',
    {
      schema: {
        summary:
          'Hour-of-week sell cost at a reference notional (median of best single-pool cost per snapshot)',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          notional: z.coerce.number().positive().default(50_000),
          side: z.enum(['sell', 'buy']).default('sell'),
        }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.params.id);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      const pools = await db
        .select({ address: riskPools.address })
        .from(riskPools)
        .where(
          and(
            eq(riskPools.assetMint, a.mint),
            inArray(riskPools.exitPath, ['direct_usd', 'via_sol']),
          ),
        );
      if (!pools.length) return { asset: a.symbol, cells: [], disclaimer: DISCLAIMER.en };
      const snaps = await db
        .select({
          fetchedAt: riskPoolSnapshots.fetchedAt,
          curve: req.query.side === 'sell' ? riskPoolSnapshots.sell : riskPoolSnapshots.buy,
        })
        .from(riskPoolSnapshots)
        .where(
          inArray(
            riskPoolSnapshots.pool,
            pools.map((p) => p.address),
          ),
        );
      const bestAt = new Map<string, number>();
      for (const s of snaps) {
        const pt = (s.curve as Array<{ notionalUsd: number; outUsd: number }>).find(
          (x) => x.notionalUsd === req.query.notional,
        );
        if (!pt) continue;
        const k = s.fetchedAt.toISOString();
        bestAt.set(k, Math.max(bestAt.get(k) ?? 0, pt.outUsd));
      }
      const byHow = new Map<number, number[]>();
      for (const [t, out] of bestAt) {
        const h = hourOfWeek(new Date(t));
        const arr = byHow.get(h) ?? [];
        arr.push(1 - out / req.query.notional);
        byHow.set(h, arr);
      }
      const cells = [...byHow.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([how, xs]) => {
          const s = [...xs].sort((p, q) => p - q);
          return {
            hourOfWeekEt: how,
            medianCost: s[Math.floor((s.length - 1) / 2)],
            samples: s.length,
          };
        });
      return {
        asset: a.symbol,
        notionalUsd: req.query.notional,
        side: req.query.side,
        cells,
        timezone: 'America/New_York',
        hourOfWeek: 'Mon 00:00 = 0',
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.get(
    '/risk/recoverable',
    {
      schema: {
        summary:
          'Recoverable value of a notional at a time and horizon (DEX path vs issuer redemption)',
        querystring: z.object({
          asset: z.string(),
          notional: z.coerce.number().positive(),
          at: z.string().datetime().optional(),
          hours: z.coerce
            .number()
            .positive()
            .max(24 * 30)
            .default(24),
          holderKyc: z.coerce.boolean().default(false),
        }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.query.asset);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.query.asset}` });
      const c = await curvesFor(a.mint);
      const at = req.query.at ? new Date(req.query.at) : new Date();
      const r = recoverableValue(
        c,
        ISSUERS.xstocks ?? null,
        req.query.notional,
        at,
        req.query.hours,
        REGIME_PARAMS,
        req.query.holderKyc,
      );
      return { asset: a.symbol, ...r, methodVersion: METHOD_VERSION, disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/assets/:id/score',
    {
      schema: {
        summary:
          'Liquidity score: share of a reference notional exitable at ≤ tau in the worst regime of the horizon',
        params: z.object({ id: z.string() }),
        querystring: z.object({
          tau: z.coerce.number().positive().default(0.01),
          nRef: z.coerce.number().positive(),
          hours: z.coerce.number().positive().default(72),
        }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.params.id);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      const c = await curvesFor(a.mint);
      const s = liquidityScore(
        c,
        regimesIn(new Date(), req.query.hours, REGIME_PARAMS),
        req.query.tau,
        req.query.nRef,
      );
      return { asset: a.symbol, ...s, methodVersion: METHOD_VERSION, disclaimer: DISCLAIMER.en };
    },
  );

  f.post(
    '/risk/positions/assess',
    {
      schema: {
        summary: 'Liquidity breach assessment for a set of positions and a withdrawal schedule',
        body: z.object({
          cashUsd: z.number().nonnegative(),
          brlUsd: z.number().nonnegative().default(0),
          liquid: z
            .array(z.object({ assetId: z.string(), valueUsd: z.number().nonnegative() }))
            .default([]),
          // bounded so one request cannot hold the event loop (AUDIT-VAULT finding 9; PLAN-ANALYTICS item 2)
          illiquid: z
            .array(z.object({ asset: z.string(), valueUsd: z.number().nonnegative() }))
            .max(ASSESS_MAX_LEGS),
          withdrawals: z
            .array(z.object({ at: z.string().datetime(), usd: z.number().positive() }))
            .max(ASSESS_MAX_WITHDRAWALS),
          windowDays: z.number().int().min(0).max(365),
          tau: z.number().positive().default(0.01),
          shareOfDepth: z.number().positive().max(1).default(0.25),
          dryFactorFloor: z.number().positive().max(1).default(0.25),
        }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const illiquid = [];
      for (const l of req.body.illiquid) {
        const a = await resolveAsset(l.asset);
        if (!a) return reply.code(404).send({ error: `unknown asset ${l.asset}` });
        illiquid.push({ assetId: a.symbol, valueUsd: l.valueUsd, curves: await curvesFor(a.mint) });
      }
      const r = assessLiquidity({ ...req.body, illiquid, regimeParams: REGIME_PARAMS });
      return { ...r, methodVersion: METHOD_VERSION, disclaimer: DISCLAIMER.en };
    },
  );

  async function latestMarkets() {
    const rows = await db
      .select()
      .from(riskMarketParams)
      .orderBy(desc(riskMarketParams.fetchedAt))
      .limit(2000);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.account)) latest.set(r.account, r);
    return [...latest.values()];
  }

  f.get(
    '/risk/markets',
    {
      schema: {
        summary:
          'Lending markets that accept tokenized stocks: parameters per reserve / vault and the dispersion table',
        description: `Kamino reserves are decoded from on-chain account bytes (verification: onchain); Jupiter Lend vaults come from the protocol API (verification: api).\n\n${DISCLAIMER.en}`,
        response: { 200: z.any() },
      },
    },
    async () => {
      const markets = await latestMarkets();
      const dispersion = new Map<
        string,
        Array<{
          venue: string;
          market: string;
          ltv: number;
          liquidationThreshold: number;
          verification: string;
        }>
      >();
      for (const m of markets.filter((x) => x.isXStock)) {
        const p = m.params as { ltv: number; liquidationThreshold: number };
        if (!p.ltv) continue;
        dispersion.set(m.asset, [
          ...(dispersion.get(m.asset) ?? []),
          {
            venue: m.venue,
            market: m.borrowAsset ? `${m.market} (${m.borrowAsset})` : m.market,
            ltv: p.ltv,
            liquidationThreshold: p.liquidationThreshold,
            verification: m.verification,
          },
        ]);
      }
      return {
        markets,
        dispersion: [...dispersion.entries()].map(([asset, venues]) => ({
          asset,
          venues,
          ltvRange: [Math.min(...venues.map((v) => v.ltv)), Math.max(...venues.map((v) => v.ltv))],
        })),
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.post(
    '/risk/markets/:account/gap',
    {
      schema: {
        summary:
          'Gap simulator: liquidatable at reopen vs unliquidatable while the primary market is closed',
        params: z.object({ account: z.string() }),
        body: z.object({
          gapPct: z.number().positive().max(0.9),
          /** Oracle price band while closed (fraction); the Scope band is not yet verified, so it is an input. */
          bandPct: z.number().positive().max(1).default(1),
          closeFactor: z.number().positive().max(1).default(0.2),
          fullLiqLtv: z.number().positive().max(1).optional(),
        }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const m = (await latestMarkets()).find((x) => x.account === req.params.account);
      if (!m || !m.assetMint)
        return reply.code(404).send({ error: `unknown market account ${req.params.account}` });
      const p = m.params as {
        liquidationThreshold: number;
        liquidationBonusMax: number;
        liquidationMaxLimit?: number;
      };
      const [snap] = await db
        .select()
        .from(riskAssetSnapshots)
        .where(eq(riskAssetSnapshots.assetMint, m.assetMint))
        .orderBy(desc(riskAssetSnapshots.fetchedAt))
        .limit(1);
      if (!snap) return reply.code(404).send({ error: `no price snapshot for ${m.asset}` });
      const t = (m.totals ?? {}) as Record<string, unknown>;
      let collateralUsd: number;
      let debtUsd: number;
      const assumptions: string[] = [];
      if (m.venue === 'jupiter_lend') {
        collateralUsd = (Number(t.totalSupply) / 10 ** Number(t.supplyDecimals)) * snap.refMidUsd;
        debtUsd = Number(t.totalBorrow) / 10 ** Number(t.borrowDecimals);
        assumptions.push(
          'isolated vault: collateral and debt are the vault totals (protocol API); debt valued at par',
        );
      } else {
        // Kamino: debt is pooled across a market's collaterals; attribute it pro rata to collateral value
        const siblings = (await latestMarkets()).filter((x) => x.market === m.market);
        const coll = siblings.reduce(
          (s2, x) =>
            s2 +
            Number((x.totals as Record<string, unknown> | null)?.totalSupplyUsd ?? 0) *
              (x.isXStock ? 1 : 0),
          0,
        );
        const debt = siblings.reduce(
          (s2, x) => s2 + Number((x.totals as Record<string, unknown> | null)?.totalBorrowUsd ?? 0),
          0,
        );
        collateralUsd = Number(t.totalSupplyUsd ?? 0);
        debtUsd = coll > 0 ? (debt * collateralUsd) / coll : 0;
        assumptions.push(
          'pooled market: debt attributed to this collateral pro rata to xStock collateral value (assumption)',
        );
      }
      assumptions.push(
        'one aggregate position at the average LTV: individual positions nearer the threshold liquidate earlier; obligations not enumerated',
        `close factor ${req.body.closeFactor} and band ${req.body.bandPct} are inputs (band: Scope config not yet verified)`,
      );
      const c = await curvesFor(m.assetMint);
      const reopen = c.byRegime.us_market_hours;
      const result = gapSim(
        {
          ltvLiq: p.liquidationThreshold,
          closeFactor: req.body.closeFactor,
          fullLiqLtv: req.body.fullLiqLtv ?? p.liquidationMaxLimit ?? 0.95,
          liqBonus: p.liquidationBonusMax,
          bandPct: req.body.bandPct,
          provenance: m.verification === 'onchain' ? 'live' : 'assumption',
          source: m.source,
        },
        [{ collateralUsd, debtUsd }],
        req.body.gapPct,
        (n) => (reopen ? costAt(reopen, n) : null),
      );
      return {
        market: m.market,
        venue: m.venue,
        asset: m.asset,
        account: m.account,
        verification: m.verification,
        aggregate: {
          collateralUsd,
          debtUsd,
          ltv: collateralUsd > 0 ? debtUsd / collateralUsd : null,
          priceUsd: snap.refMidUsd,
          priceAt: snap.fetchedAt,
        },
        ...result,
        assumptions: [...result.assumptions, ...assumptions],
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.post(
    '/risk/positions/borrow-capacity',
    {
      schema: {
        summary:
          'Borrow capacity for stock holdings (read-only): per market, max borrow, liquidation distance, thinnest hour of week',
        description: `Read-only assessment. No transaction is built or sent.\n\n${DISCLAIMER.en}`,
        body: z.object({
          holdings: z.array(z.object({ asset: z.string(), units: z.number().positive() })).min(1),
        }),
        response: { 200: z.any(), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const markets = await latestMarkets();
      const out = [];
      for (const h of req.body.holdings) {
        const a = await resolveAsset(h.asset);
        if (!a) return reply.code(404).send({ error: `unknown asset ${h.asset}` });
        const [snap] = await db
          .select()
          .from(riskAssetSnapshots)
          .where(eq(riskAssetSnapshots.assetMint, a.mint))
          .orderBy(desc(riskAssetSnapshots.fetchedAt))
          .limit(1);
        if (!snap) return reply.code(404).send({ error: `no price snapshot for ${a.symbol}` });
        const valueUsd = h.units * snap.refMidUsd;
        // thinnest hour: highest median routed sell cost at the holding's size, by hour of week (ET)
        const rows = await db
          .select({ fetchedAt: riskAssetSnapshots.fetchedAt, sell: riskAssetSnapshots.sell })
          .from(riskAssetSnapshots)
          .where(eq(riskAssetSnapshots.assetMint, a.mint));
        const byHow = new Map<number, number[]>();
        for (const r of rows) {
          const pts = (r.sell as Array<{ notionalUsd: number; outUsd: number }>)
            .map((p) => ({ n: p.notionalUsd, c: 1 - p.outUsd / p.notionalUsd }))
            .sort((x, y) => x.n - y.n);
          const hi = pts.findIndex((p) => p.n >= valueUsd);
          const cost = hi < 0 ? null : (pts[hi] as { c: number }).c;
          if (cost === null) continue;
          const how = hourOfWeek(r.fetchedAt);
          byHow.set(how, [...(byHow.get(how) ?? []), cost]);
        }
        const med = (xs: number[]) =>
          [...xs].sort((x, y) => x - y)[Math.floor((xs.length - 1) / 2)] as number;
        const thinnest =
          [...byHow.entries()]
            .map(([how, xs]) => ({
              hourOfWeekEt: how,
              medianSellCost: med(xs),
              samples: xs.length,
            }))
            .sort((x, y) => y.medianSellCost - x.medianSellCost)[0] ?? null;
        const venues = markets
          .filter((m) => m.assetMint === a.mint)
          .map((m) => {
            const p = m.params as { ltv: number; liquidationThreshold: number };
            const maxBorrowUsd = valueUsd * p.ltv;
            return {
              venue: m.venue,
              market: m.borrowAsset ? `${m.market} (${m.borrowAsset})` : m.market,
              account: m.account,
              ltv: p.ltv,
              liquidationThreshold: p.liquidationThreshold,
              maxBorrowUsd,
              /** price fall that triggers liquidation when borrowing the maximum: 1 − ltv / threshold */
              liquidationDistanceAtMax:
                p.liquidationThreshold > 0 ? 1 - p.ltv / p.liquidationThreshold : null,
              verification: m.verification,
            };
          });
        out.push({
          asset: a.symbol,
          units: h.units,
          priceUsd: snap.refMidUsd,
          priceAt: snap.fetchedAt,
          valueUsd,
          venues,
          thinnestHour: thinnest,
          timezone: 'America/New_York',
        });
      }
      return {
        readOnly: true,
        holdings: out,
        methodVersion: METHOD_VERSION,
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.get(
    '/risk/events',
    {
      schema: {
        summary: 'Collector events: LP withdrawals near the price, stale tick maps',
        querystring: z.object({
          since: z.string().datetime().optional(),
          kind: z.string().optional(),
        }),
        response: { 200: z.any() },
      },
    },
    async (req) => {
      const since = req.query.since
        ? new Date(req.query.since)
        : new Date(Date.now() - 7 * 86_400_000);
      const rows = await db
        .select()
        .from(riskEvents)
        .where(
          and(
            gte(riskEvents.fetchedAt, since),
            req.query.kind ? eq(riskEvents.kind, req.query.kind) : sql`true`,
          ),
        )
        .orderBy(desc(riskEvents.fetchedAt))
        .limit(500);
      return { events: rows, disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/pools',
    {
      schema: {
        summary: 'Pool registry: venue, exit path, on-chain TVL and refresh tier',
        querystring: z.object({
          asset: z.string().optional(),
          includeDust: z.coerce.boolean().default(false),
        }),
        response: { 200: z.any() },
      },
    },
    async (req) => {
      const a = req.query.asset ? await resolveAsset(req.query.asset) : null;
      const rows = await db
        .select()
        .from(riskPools)
        .where(
          and(
            a ? eq(riskPools.assetMint, a.mint) : sql`true`,
            req.query.includeDust ? sql`true` : inArray(riskPools.tier, ['A', 'B']),
          ),
        )
        .orderBy(desc(riskPools.tvlUsd))
        .limit(500);
      return { pools: rows, disclaimer: DISCLAIMER.en };
    },
  );
}
