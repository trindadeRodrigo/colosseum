import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, riskDepthCurves, riskLpConcentration, riskPools } from '@colosseum/db';
import {
  type AssetCurves,
  createLiquidityProvider,
  type DepthCurve,
  defaultRegimeParams,
  type Regime,
} from '@colosseum/risk';
import type { Asset, RegimeLiquidityProvider } from '@colosseum/schemas';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  CURVE_METHOD_VERSIONS,
  curveKey,
  curveVersionOf,
  EVM_METHOD_VERSION,
  RISK_METHOD_VERSION,
} from './curve-version';

const ROOT = process.env.REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');

export { RISK_METHOD_VERSION };

/**
 * Builds the structurer's LiquidityProvider from the risk layer's stored curves, keyed by registry asset
 * id through the asset's mint. Each address is read under its own method version (`curveVersionOf`): the
 * routed risk-0.3 on Solana, the EVM collector's evmq-0.1 for an EVM address. The provider's own
 * `methodVersion` is still the one name, risk-0.3. Sell curves answer every exit question; buy curves
 * answer `entryCostIn` only. Returns undefined when disabled
 * (RISK_LIQUIDITY=off) or when no curve exists for any registry asset: the engine then behaves exactly as
 * before the risk layer.
 */
export async function loadLiquidityProvider(
  db: Db,
  assets: Pick<Asset, 'id' | 'mint'>[],
): Promise<RegimeLiquidityProvider | undefined> {
  if (process.env.RISK_LIQUIDITY === 'off') return undefined;
  // Keyed by `curveKey`: an EVM address in lower case, since the shelf and the collector do not spell
  // it alike (PLAN-UNIVERSE RU.8); a Solana address as it is, base58 being case-sensitive.
  const byMint = new Map(
    assets.filter((a) => a.mint).map((a) => [curveKey(a.mint as string), a.id]),
  );
  if (byMint.size === 0) return undefined;
  const keys = [...byMint.keys()];
  const evm = keys.filter((k) => curveVersionOf(k) === EVM_METHOD_VERSION);
  const solana = keys.filter((k) => curveVersionOf(k) !== EVM_METHOD_VERSION);
  const rows = await db
    .select()
    .from(riskDepthCurves)
    .where(
      and(
        or(
          solana.length ? inArray(riskDepthCurves.assetMint, solana) : undefined,
          evm.length ? inArray(sql`lower(${riskDepthCurves.assetMint})`, evm) : undefined,
        ),
        inArray(riskDepthCurves.side, ['sell', 'buy']),
        inArray(riskDepthCurves.methodVersion, CURVE_METHOD_VERSIONS),
      ),
    )
    .then((all) => all.filter((r) => r.methodVersion === curveVersionOf(r.assetMint)));
  if (!rows.some((r) => r.side === 'sell')) return undefined;
  const curves = new Map<string, AssetCurves>();
  const buyCurves = new Map<string, AssetCurves>();
  for (const r of rows) {
    const id = byMint.get(curveKey(r.assetMint));
    if (!id) continue;
    const side = r.side === 'sell' ? curves : buyCurves;
    const a = side.get(id) ?? { assetId: id, byRegime: {} };
    a.byRegime[r.regime as Regime] = {
      points: r.points as DepthCurve['points'],
      insufficientFrom: r.insufficientFrom,
      quantile: r.quantile,
      minSamples: r.minSamples,
      from: r.dataFrom?.toISOString() ?? null,
      to: r.dataTo?.toISOString() ?? null,
      samples: r.samples,
    };
    side.set(id, a);
  }
  // LP-exit stress: latest concentration row of each asset's largest exit pool
  const lpCurve = new Map<string, Array<{ notionalUsd: number; costPct: number }>>();
  for (const [mint, id] of byMint) {
    const [pool] = await db
      .select({ address: riskPools.address })
      .from(riskPools)
      .where(and(eq(riskPools.assetMint, mint), eq(riskPools.exitPath, 'direct_usd')))
      .orderBy(desc(riskPools.tvlUsd))
      .limit(1);
    if (!pool) continue;
    const [lp] = await db
      .select({ s: riskLpConcentration.sellWithoutTopN })
      .from(riskLpConcentration)
      .where(eq(riskLpConcentration.pool, pool.address))
      .orderBy(desc(riskLpConcentration.fetchedAt))
      .limit(1);
    if (lp?.s) lpCurve.set(id, lp.s as Array<{ notionalUsd: number; costPct: number }>);
  }
  const calendar = JSON.parse(
    readFileSync(join(ROOT, 'fixtures/risk/us-market-holidays.json'), 'utf8'),
  );
  return createLiquidityProvider({
    curves,
    buyCurves,
    regimeParams: defaultRegimeParams(calendar),
    methodVersion: RISK_METHOD_VERSION,
    provenance: 'live',
    lpExitCost: (id, n) => {
      const pts = lpCurve.get(id);
      if (!pts?.length) return null;
      const hit = pts.find((p) => p.notionalUsd >= n);
      return hit ? hit.costPct / 100 : null;
    },
  });
}
