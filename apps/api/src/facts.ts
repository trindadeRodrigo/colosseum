import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assets as assetsTable,
  type Db,
  riskAssetSnapshots,
  riskDepthCurves,
  riskEvents,
  riskLendingPositions,
  riskLpConcentration,
  riskPools,
} from '@colosseum/db';
import {
  type AssetCurves,
  type AssetFactsInput,
  assessLiquidity,
  buildAssetFacts,
  buildPlanFacts,
  type DepthCurve,
  defaultFactsParams,
  defaultLendingReportParams,
  defaultRegimeParams,
  fitCurve,
  type IssuerModel,
  maxNotionalAt,
  measuredRegimes,
  type PlanLeg,
  type Regime,
  regimeAt,
} from '@colosseum/risk';
import type { AssetFacts, PlanFacts } from '@colosseum/schemas';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

const ROOT = process.env.REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');
const CURVE_METHOD_VERSION = 'risk-0.3';
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures/risk', name), 'utf8'));

/**
 * Reads the rows behind one asset's fact sheet and hands them to `buildAssetFacts` (PLAN-ANALYTICS item 7).
 * `id` is a symbol, a mint or a registry asset id. An asset the registry knows but no collector measures gets
 * a sheet whose facts are all `null` with the reason; an unknown id gets null.
 */
export async function loadAssetFacts(
  db: Db,
  id: string,
  opts: { sizeUsd?: number; tau?: number; now?: Date } = {},
): Promise<AssetFacts | null> {
  const params = defaultFactsParams();
  const now = opts.now ?? new Date();
  const sizeUsd = opts.sizeUsd ?? params.refSizeUsd;
  const tau = opts.tau ?? params.tau;
  const [pool] = await db
    .select({ mint: riskPools.assetMint, symbol: riskPools.assetSymbol })
    .from(riskPools)
    .where(
      sql`lower(${riskPools.assetSymbol}) = ${id.toLowerCase()} or ${riskPools.assetMint} = ${id}`,
    )
    .limit(1);
  const [registry] = await db
    .select()
    .from(assetsTable)
    .where(
      pool
        ? eq(assetsTable.mint, pool.mint)
        : sql`${assetsTable.id} = ${id.toLowerCase()} or ${assetsTable.mint} = ${id}`,
    )
    .limit(1);
  if (!pool && !registry) return null;
  const mint = pool?.mint ?? registry?.mint ?? null;
  const symbol = pool?.symbol ?? registry?.symbol ?? id;
  const base = {
    assetId: registry?.id ?? symbol.toLowerCase(),
    symbol,
    chain: registry?.chain ?? 'solana',
    mint,
    sizeUsd,
    tau,
    asOf: now.toISOString(),
    platformFeeBps: params.platformFeeBps,
    gapGridPct: defaultLendingReportParams().gapGridPct,
  };
  const none = {
    source: 'risk_depth_curves',
    method: 'fitCurve_isotonic_pl_ln_notional',
    methodVersion: CURVE_METHOD_VERSION,
    provenance: 'live' as const,
  };
  const curveRows = mint
    ? await db
        .select()
        .from(riskDepthCurves)
        .where(
          and(
            eq(riskDepthCurves.assetMint, mint),
            eq(riskDepthCurves.methodVersion, CURVE_METHOD_VERSION),
          ),
        )
    : [];
  if (!curveRows.some((r) => r.side === 'sell'))
    return buildAssetFacts({
      ...base,
      sell: null,
      buy: null,
      curveMeta: none,
      uncoveredReason: base.chain === 'solana' ? 'not_collected' : 'chain_not_covered',
      lp: null,
      lpWithdrawals: null,
      capacitySeries: null,
      lendingCollateral: null,
      tracking: [],
      issuer: null,
    });

  const side = (s: 'sell' | 'buy'): AssetCurves | null => {
    const rows = curveRows.filter((r) => r.side === s);
    if (!rows.length) return null;
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
    return { assetId: base.assetId, byRegime };
  };
  const sell = side('sell') as AssetCurves;
  const first = curveRows.find((r) => r.side === 'sell') as (typeof curveRows)[number];
  const curveMeta = {
    source: first.source,
    method: first.method,
    methodVersion: first.methodVersion,
    provenance: first.provenance,
  };

  // LP concentration: latest row of the asset's largest dollar pool that has one
  const dollarPools = await db
    .select({ address: riskPools.address })
    .from(riskPools)
    .where(and(eq(riskPools.assetMint, mint as string), eq(riskPools.exitPath, 'direct_usd')))
    .orderBy(desc(riskPools.tvlUsd))
    .limit(5);
  let lp: AssetFactsInput['lp'] = null;
  for (const p of dollarPools) {
    const [row] = await db
      .select()
      .from(riskLpConcentration)
      .where(eq(riskLpConcentration.pool, p.address))
      .orderBy(desc(riskLpConcentration.fetchedAt))
      .limit(1);
    if (!row) continue;
    lp = {
      source: row.source,
      method: row.method,
      methodVersion: row.methodVersion,
      provenance: row.provenance,
      fetchedAt: row.fetchedAt.toISOString(),
      top1: row.top1,
      top3: row.top3,
      top10: row.top10,
      lpExitN: row.lpExitN,
      sellWithoutTopN: row.sellWithoutTopN as NonNullable<AssetFactsInput['lp']>['sellWithoutTopN'],
    };
    break;
  }

  const weekAgo = new Date(now.getTime() - params.capacityWindowDays * 86_400_000);
  const [withdrawals] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(riskEvents)
    .where(
      and(
        eq(riskEvents.kind, 'lp_withdrawal'),
        eq(riskEvents.asset, symbol),
        gte(riskEvents.fetchedAt, weekAgo),
      ),
    );

  // exit capacity at tau in every snapshot of the window, by regime
  const regimeParams = defaultRegimeParams(fixture('us-market-holidays.json'));
  const snaps = await db
    .select({
      fetchedAt: riskAssetSnapshots.fetchedAt,
      sell: riskAssetSnapshots.sell,
      source: riskAssetSnapshots.source,
      methodVersion: riskAssetSnapshots.methodVersion,
      provenance: riskAssetSnapshots.provenance,
    })
    .from(riskAssetSnapshots)
    .where(
      and(
        eq(riskAssetSnapshots.assetMint, mint as string),
        gte(riskAssetSnapshots.fetchedAt, weekAgo),
      ),
    );
  const series: Partial<Record<Regime, number[]>> = {};
  for (const s of snaps) {
    const pts = (s.sell as Array<{ notionalUsd: number; outUsd: number }>).filter((p) =>
      Number.isFinite(p.outUsd),
    );
    if (!pts.length) continue;
    const c = fitCurve(
      pts.map((p) => ({ notionalUsd: p.notionalUsd, cost: 1 - p.outUsd / p.notionalUsd })),
      { quantile: 0.5, minSamples: 1 },
    );
    const r = regimeAt(s.fetchedAt, regimeParams);
    series[r] = [...(series[r] ?? []), maxNotionalAt(c, tau).notionalUsd];
  }
  const lastSnap = snaps.reduce<(typeof snaps)[number] | null>(
    (a, s) => (!a || s.fetchedAt > a.fetchedAt ? s : a),
    null,
  );

  // stock collateral in lending markets: each market's latest hour with a USD value
  const posRows = await db
    .select()
    .from(riskLendingPositions)
    .where(
      and(
        eq(riskLendingPositions.collateralAsset, symbol),
        gte(riskLendingPositions.observedAt, new Date(now.getTime() - 2 * 86_400_000)),
      ),
    )
    .orderBy(desc(riskLendingPositions.observedAt));
  const latestByMarket = new Map<string, (typeof posRows)[number]>();
  for (const r of posRows)
    if (r.collateralUsd !== null && !latestByMarket.has(r.market)) latestByMarket.set(r.market, r);
  const latest = [...latestByMarket.values()];
  const lendingCollateral = latest.length
    ? {
        usd: latest.reduce((a, r) => a + (r.collateralUsd as number), 0),
        // the oldest of the hours summed: the figure is no fresher than that
        fetchedAt: new Date(Math.min(...latest.map((r) => r.observedAt.getTime()))).toISOString(),
        source: `risk_lending_positions (${latest.length} markets, each market's latest hour)`,
        method: (latest[0] as (typeof latest)[number]).method,
        methodVersion: (latest[0] as (typeof latest)[number]).methodVersion,
        provenance: (latest[0] as (typeof latest)[number]).provenance,
      }
    : null;

  const issuers = fixture('issuer-models.json') as {
    fetchedAt: string;
    models: Record<string, IssuerModel>;
  };
  const xstocks = issuers.models.xstocks;
  return buildAssetFacts({
    ...base,
    sell,
    buy: side('buy'),
    curveMeta,
    lp,
    lpWithdrawals: {
      count: withdrawals?.n ?? 0,
      to: now.toISOString(),
      source: `risk_events (lp_withdrawal, last ${params.capacityWindowDays} days)`,
      method: 'count',
    },
    capacitySeries: lastSnap
      ? {
          byRegime: series,
          to: lastSnap.fetchedAt.toISOString(),
          minSamples: params.capacityMinSamples,
          source: `risk_asset_snapshots (last ${params.capacityWindowDays} days)`,
          method: 'stdev_over_mean_of_max_notional_at_tau_per_snapshot',
          methodVersion: lastSnap.methodVersion,
          provenance: lastSnap.provenance,
        }
      : null,
    lendingCollateral,
    // the lending oracles' gaps are a report until item 11 imports them
    tracking: lendingCollateral
      ? measuredRegimes(sell).measured.flatMap((regime) =>
          (['kamino_scope', 'jupiter_lend_oracle'] as const).map((against) => ({
            against,
            regime,
            gap: 'not_imported' as const,
          })),
        )
      : [],
    issuer: xstocks ? { ...xstocks, fetchedAt: issuers.fetchedAt } : null,
  });
}

/** Mints of the assets that have a sell curve: the sheets that hold measured facts today. */
export async function measuredAssetMints(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ mint: riskDepthCurves.assetMint })
    .from(riskDepthCurves)
    .where(
      and(
        eq(riskDepthCurves.side, 'sell'),
        inArray(riskDepthCurves.methodVersion, [CURVE_METHOD_VERSION]),
      ),
    );
  return rows.map((r) => r.mint);
}

/**
 * Reads the legs behind a plan's fact sheet and hands them to `buildPlanFacts` (PLAN-ANALYTICS item 10). Each leg
 * gets its own AssetFacts at its value; issuer, class and chain come from the asset registry, or for an xStock the
 * registry does not list, from the issuer model; venue and quote token from the leg's largest exit pool. With
 * withdrawals, the breach assessment (risk-0.2) runs on the legs that have sell curves. An unknown asset id is a
 * leg with no sheet, never dropped.
 */
export async function loadPlanFacts(
  db: Db,
  positions: Array<{ assetId: string; valueUsd: number }>,
  opts: {
    now?: Date;
    withdrawals?: Array<{ at: string; usd: number }>;
    windowDays?: number;
  } = {},
): Promise<PlanFacts> {
  const params = defaultFactsParams();
  const now = opts.now ?? new Date();
  const issuers = fixture('issuer-models.json') as {
    fetchedAt: string;
    models: Record<string, IssuerModel>;
  };
  // the registry's own name for the xStocks issuer, so registered and unregistered xStocks group together
  const registered = await db.select().from(assetsTable);
  const xstocksIssuer =
    registered
      .map((r) => (r.metadata as { issuer?: string } | null)?.issuer)
      .find((i) => i && /xstocks/i.test(i)) ??
    issuers.models.xstocks?.issuer ??
    null;
  const legs: PlanLeg[] = [];
  const illiquid: Array<{ assetId: string; valueUsd: number; curves: AssetCurves }> = [];
  let cashUsd = 0;
  for (const p of positions) {
    const sheet =
      p.valueUsd > 0 ? await loadAssetFacts(db, p.assetId, { sizeUsd: p.valueUsd, now }) : null;
    const [reg] = await db
      .select()
      .from(assetsTable)
      .where(
        sql`${assetsTable.id} = ${p.assetId.toLowerCase()} or lower(${assetsTable.symbol}) = ${p.assetId.toLowerCase()}`,
      )
      .limit(1);
    const mint = sheet?.mint ?? reg?.mint ?? null;
    const exits = mint
      ? await db
          .select({
            address: riskPools.address,
            venue: riskPools.venue,
            quote: riskPools.quoteSymbol,
            exitPath: riskPools.exitPath,
          })
          .from(riskPools)
          .where(
            and(
              eq(riskPools.assetMint, mint),
              inArray(riskPools.exitPath, ['direct_usd', 'via_sol']),
              inArray(riskPools.tier, ['A', 'B']),
            ),
          )
          .orderBy(desc(riskPools.tvlUsd))
      : [];
    const xstock = !reg && exits.length > 0 && /x$/.test(sheet?.symbol ?? '');
    const meta = (reg?.metadata ?? {}) as { issuer?: string };
    const cls = reg?.kind ?? (xstock ? 'equity' : 'unknown');
    legs.push({
      assetId: sheet?.assetId ?? reg?.id ?? p.assetId.toLowerCase(),
      valueUsd: p.valueUsd,
      attrs: {
        issuer: meta.issuer ?? (xstock ? xstocksIssuer : null),
        chain: reg?.chain ?? sheet?.chain ?? 'solana',
        class: cls,
        venue: exits[0]?.venue ?? null,
        quoteToken: exits[0]?.quote ?? null,
      },
      sheet,
      exitPools: exits.map((e) => e.address),
      usesSol: exits.some((e) => e.exitPath === 'via_sol'),
    });
    if (cls === 'cash') cashUsd += p.valueUsd;
    else if (mint && p.valueUsd > 0) {
      const curves = await sellCurvesOf(db, mint, sheet?.assetId ?? p.assetId);
      if (curves)
        illiquid.push({ assetId: sheet?.assetId ?? p.assetId, valueUsd: p.valueUsd, curves });
    }
  }
  const breach =
    opts.withdrawals?.length && illiquid.length
      ? assessLiquidity({
          cashUsd,
          brlUsd: 0,
          liquid: [],
          illiquid,
          withdrawals: opts.withdrawals,
          windowDays: opts.windowDays ?? 7,
          tau: params.tau,
          shareOfDepth: 0.25,
          dryFactorFloor: 0.25,
          regimeParams: defaultRegimeParams(fixture('us-market-holidays.json')),
        })
      : null;
  return buildPlanFacts({
    legs,
    asOf: now.toISOString(),
    provenance: 'live',
    platformFeeBps: params.platformFeeBps,
    stress: { gapPct: 20, lpExitN: 3 },
    breach: breach
      ? {
          result: breach,
          source: `risk_depth_curves (${CURVE_METHOD_VERSION}) of ${illiquid.length} legs`,
          method: 'assessLiquidity (breach.ts, risk-0.2): shareOfDepth 0.25, dryFactorFloor 0.25',
          methodVersion: 'risk-0.2',
        }
      : null,
  });
}

/** The sell curves of one mint (current method version), or null when it has none. */
async function sellCurvesOf(db: Db, mint: string, assetId: string): Promise<AssetCurves | null> {
  const rows = await db
    .select()
    .from(riskDepthCurves)
    .where(
      and(
        eq(riskDepthCurves.assetMint, mint),
        eq(riskDepthCurves.side, 'sell'),
        eq(riskDepthCurves.methodVersion, CURVE_METHOD_VERSION),
      ),
    );
  if (!rows.length) return null;
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
  return { assetId, byRegime };
}
