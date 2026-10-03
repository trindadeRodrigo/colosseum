import {
  FACTS_METHOD_VERSION,
  type Fact,
  type FactNullReason,
  type FactUnit,
  fact,
  type LendingPoolFacts,
  type LiquidationRoute,
  type MeasuredFact,
  missing,
} from '@colosseum/schemas';
import type { OracleGapObs } from '../lending/route';
import { REGIMES, type Regime } from '../time';

/**
 * LendingPoolFacts for one lending pool (PLAN-ANALYTICS item 10): a Kamino debt reserve, which lenders supply into,
 * or a Jupiter Lend vault, whose lenders are the shared liquidity layer of its debt token. A pure function over rows
 * the caller read: every number carries the source of its rows, and what the rows do not hold is `null` with its
 * reason. Wallets never enter: lender concentration and positions arrive as aggregates (DA4).
 */
type RowMeta = {
  source: string;
  method: string;
  methodVersion: string;
  provenance: MeasuredFact['provenance'];
};
type Stamped = RowMeta & {
  fetchedAt: string;
  dataFrom?: string;
  samples?: number;
  /** The true value is at least this (`quality: lower_bound`). */
  lowerBound?: boolean;
};
/** A number read from rows, or the reason the rows do not hold it. */
export type Read = (Stamped & { value: number }) | { reason: FactNullReason; detail?: string };

export type LendingCollateralInput = {
  asset: string;
  collateralUsd: Read;
  liquidationThreshold: Read;
  /** The smallest bonus a liquidator earns on it (Kamino: the bonus at the threshold; Jupiter Lend: the penalty). */
  liquidationBonus: Read;
  /** This pool's oracle against the routed reference mid, by regime (absent: no rows in that regime). */
  oracleGap: Partial<Record<Regime, OracleGapObs>>;
  /** Liquidation coverage ratio on the liquidator's margin at each gap (asset-wide: the pools share the DEX). */
  coverageByGap: Array<{ gapPct: number; ratio: Read & { regime?: Regime } }>;
  /** Regimes the coverage could not price (no curve, or no oracle rows), with the reason. */
  regimesMissing: Regime[];
  /** Liquidation routes per regime, best first within each regime. */
  routes: LiquidationRoute[];
  observed: { liquidations: Read; soldInSameTxShare: Read; realisedVsMid: Read };
};

export type LendingPoolFactsInput = {
  account: string;
  chain: string;
  venue: string;
  market: string;
  symbol: string;
  verification: 'onchain' | 'api';
  provenance: MeasuredFact['provenance'];
  withdrawal: {
    suppliedUsd: Read;
    availableUsd: Read;
    shareLentOut: Read;
    hoursAboveAlarmShare: Read;
  };
  rates: { supplyApy: Read; supplyApyVariation: Read; borrowApy: Read };
  lenders: { top1Share: Read; top3Share: Read; top10Share: Read };
  collateral: LendingCollateralInput[];
  history: {
    liquidations: Read;
    liquidatedUsd: Read;
    socialisedLossUsd: Read;
    parameterChanges30d: Read;
  };
  dataFrom: string | null;
  dataTo: string | null;
};

export function buildLendingPoolFacts(inp: LendingPoolFactsInput): LendingPoolFacts {
  const f = (
    r: Read,
    unit: FactUnit,
    extra: { regime?: Regime; quality?: MeasuredFact['quality'] } = {},
  ): Fact =>
    'reason' in r
      ? missing(r.reason, unit, {
          ...(extra.regime ? { regime: extra.regime } : {}),
          ...(r.detail ? { detail: r.detail } : {}),
        })
      : fact({
          value: r.value,
          unit,
          quality: extra.quality ?? (r.lowerBound ? 'lower_bound' : 'measured'),
          ...(extra.regime ? { regime: extra.regime } : {}),
          source: r.source,
          method: r.method,
          methodVersion: r.methodVersion,
          provenance: r.provenance,
          fetchedAt: r.fetchedAt,
          ...(r.dataFrom ? { dataFrom: r.dataFrom } : {}),
          ...(r.samples !== undefined ? { samples: r.samples } : {}),
        });
  return {
    account: inp.account,
    chain: inp.chain,
    venue: inp.venue,
    market: inp.market,
    symbol: inp.symbol,
    withdrawal: {
      suppliedUsd: f(inp.withdrawal.suppliedUsd, 'usd'),
      availableUsd: f(inp.withdrawal.availableUsd, 'usd'),
      shareLentOut: f(inp.withdrawal.shareLentOut, 'fraction'),
      hoursAboveAlarmShare: f(inp.withdrawal.hoursAboveAlarmShare, 'fraction'),
    },
    rates: {
      supplyApy: f(inp.rates.supplyApy, 'fraction'),
      supplyApyVariation: f(inp.rates.supplyApyVariation, 'fraction'),
      borrowApy: f(inp.rates.borrowApy, 'fraction'),
    },
    lenders: {
      top1Share: f(inp.lenders.top1Share, 'fraction'),
      top3Share: f(inp.lenders.top3Share, 'fraction'),
      top10Share: f(inp.lenders.top10Share, 'fraction'),
    },
    collateral: inp.collateral.map((c) => ({
      asset: c.asset,
      collateralUsd: f(c.collateralUsd, 'usd'),
      liquidationThreshold: f(c.liquidationThreshold, 'fraction'),
      liquidationBonus: f(c.liquidationBonus, 'fraction'),
      oracleGap: REGIMES.map((regime) => {
        const g = c.oracleGap[regime];
        return {
          regime,
          gap: g
            ? f({ ...g }, 'fraction', { regime })
            : missing('no_samples_in_regime', 'fraction', {
                regime,
                detail: 'no oracle-against-DEX rows in this regime',
              }),
        };
      }),
      coverageByGap: c.coverageByGap.map((g) => ({
        gapPct: g.gapPct,
        value: f(
          g.ratio,
          'ratio',
          'reason' in g.ratio || !g.ratio.regime ? {} : { regime: g.ratio.regime },
        ),
      })),
      regimesMissing: c.regimesMissing,
      routes: c.routes,
      observed: {
        liquidations: f(c.observed.liquidations, 'count'),
        soldInSameTxShare: f(c.observed.soldInSameTxShare, 'fraction'),
        realisedVsMid: f(c.observed.realisedVsMid, 'fraction'),
      },
    })),
    history: {
      liquidations: f(inp.history.liquidations, 'count'),
      liquidatedUsd: f(inp.history.liquidatedUsd, 'usd'),
      socialisedLossUsd: f(inp.history.socialisedLossUsd, 'usd'),
      parameterChanges30d: f(inp.history.parameterChanges30d, 'count'),
    },
    coverage: { dataFrom: inp.dataFrom, dataTo: inp.dataTo, verification: inp.verification },
    methodVersion: FACTS_METHOD_VERSION,
    provenance: inp.provenance,
  };
}

/** Standard deviation of a series, with its count; null below `minSamples`. */
export function variation(xs: readonly number[], minSamples: number) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < minSamples) return null;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return {
    sd: Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length),
    mean,
    n: v.length,
  };
}
