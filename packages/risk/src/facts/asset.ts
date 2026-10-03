import {
  type AssetFacts,
  type CostBreakdown,
  FACTS_METHOD_VERSION,
  type Fact,
  type FactNullReason,
  type FactRegime,
  type FactUnit,
  fact,
  type MeasuredFact,
  missing,
} from '@colosseum/schemas';
import { type AssetCurves, curveFor, type IssuerModel, measuredRegimes } from '../assess';
import { costAt, type DepthCurve, maxNotionalAt, usableCount } from '../curves';
import { REGIMES, type Regime } from '../time';
import { splitAt } from './breakdown';
import {
  dailyCloses,
  gapFrequency,
  maxDrawdown,
  type PricePoint,
  volatilityAnnual,
  weekendGaps,
} from './market';
import { breakEvenReturn, lossUsd, roundTripCost } from './returns';
import { type DepthRecoveryRow, seriesVariation } from './stability';

/**
 * AssetFacts for one asset and one trade size (PLAN-ANALYTICS item 7). A pure function over rows the caller
 * read: no clock, no I/O. Every number comes out as a fact with the source of the rows it was read from; what
 * the rows do not hold comes out as `null` with its reason, never as zero.
 */
type RowMeta = {
  source: string;
  method: string;
  methodVersion: string;
  provenance: MeasuredFact['provenance'];
};

export type AssetFactsInput = {
  assetId: string;
  symbol: string;
  chain: string;
  mint: string | null;
  sizeUsd: number;
  tau: number;
  /** When the caller read the rows; the time of every fact that is a policy input. */
  asOf: string;
  /** Sell curves by regime; null when the asset's chain or class has no collector. */
  sell: AssetCurves | null;
  buy: AssetCurves | null;
  curveMeta: RowMeta;
  /** Why there are no curves at all, when `sell` is null. */
  uncoveredReason?: FactNullReason;
  /** Charged by the product or the aggregator on top of the pools (DA5). */
  platformFeeBps: number;
  /** Latest LP concentration row of the asset's largest dollar pool. */
  lp:
    | (RowMeta & {
        fetchedAt: string;
        top1: number;
        top3: number;
        top10: number;
        lpExitN: number;
        /** Sell curve of the pool without its largest `lpExitN` in-band positions. */
        sellWithoutTopN: Array<{ notionalUsd: number; costPct: number }> | null;
      })
    | null;
  /** LP-withdrawal events of the asset's pools in the 7 days before `to`. */
  lpWithdrawals: { count: number; to: string; source: string; method: string } | null;
  /** Exit capacity at `tau` in each snapshot of the last days, by regime. */
  capacitySeries:
    | (RowMeta & {
        byRegime: Partial<Record<Regime, number[]>>;
        to: string;
        minSamples: number;
      })
    | null;
  /** Stock collateral in lending markets, latest hour. */
  lendingCollateral: (RowMeta & { usd: number; fetchedAt: string }) | null;
  /** Other price sources the pool mid is compared with, and the gaps the caller could read. */
  tracking: Array<{
    against: string;
    regime: Regime;
    gap: (RowMeta & { value: number; fetchedAt: string; samples: number }) | FactNullReason;
  }>;
  issuer: (IssuerModel & { fetchedAt: string }) | null;
  gapGridPct: readonly number[];
  /** Where the split keys on the curve points come from (item 4); absent: the split is `not_collected`. */
  splitMeta?: RowMeta;
  /** Split snapshots needed at a size before its split is used. */
  splitMinSamples?: number;
  /** The asset's hourly reference prices over `marketRiskWindowDays`, oldest first (item 12); absent or empty:
   *  every market-risk fact is `no_reference_price`. */
  marketRisk?: (RowMeta & { series: PricePoint[] }) | null;
  /** Depth recovery after large trades by regime, from the Step 5b history (item 15); absent: not collected. */
  depthRecovery?:
    | (RowMeta & { rows: DepthRecoveryRow[]; largeShare: number; fetchedAt: string })
    | null;
  /** Median network fee per swap, or why it is not measured (item 4). */
  networkFee?:
    | (RowMeta & { usd: number; fetchedAt: string; dataFrom: string; samples: number })
    | { reason: FactNullReason; detail?: string }
    | null;
};

/** Policy inputs of the fact sheets (facts-0.1); each is shown on the sheet it shapes. */
export const defaultFactsParams = () => ({
  /** Trade size a sheet refers to when none is asked for. */
  refSizeUsd: 10_000,
  /** Cost tolerance behind capacity figures (PLAN-RISK §4 founder default). */
  tau: 0.01,
  /** Charged by the product or the aggregator on top of the pools (DA5). */
  platformFeeBps: 0,
  /** Window for capacity variation and LP-withdrawal counts. */
  capacityWindowDays: 7,
  capacityMinSamples: 8,
  /** Split snapshots (and swap transactions, for the network fee) needed before a split part is used. */
  splitMinSamples: 8,
  /** History behind volatility, drawdown, correlation and weekend gaps (item 12). */
  marketRiskWindowDays: 365,
  /** Trading days a year, to annualise daily volatility. */
  tradingDaysPerYear: 252,
  /** Daily returns needed for a volatility or a correlation. */
  marketRiskMinReturns: 20,
  /** Weekends needed before a gap frequency is given. */
  minWeekends: 8,
});

const NOT_SPLIT =
  'no split snapshot fitted at this size yet (pnpm risk:split-snapshot, risk:cost-breakdown)';

export function buildAssetFacts(inp: AssetFactsInput): AssetFacts {
  const curveFact = (
    value: number,
    unit: FactUnit,
    c: DepthCurve,
    regime: FactRegime,
    quality: MeasuredFact['quality'] = 'measured',
  ): MeasuredFact =>
    fact({
      value,
      unit,
      quality,
      regime,
      sizeUsd: inp.sizeUsd,
      ...inp.curveMeta,
      fetchedAt: c.to ?? c.from ?? inp.asOf,
      ...(c.from ? { dataFrom: c.from } : {}),
      samples: c.samples,
    });
  const platformFee = fact({
    value: inp.platformFeeBps / 10_000,
    unit: 'fraction',
    quality: 'assumption',
    source: 'policy input platformFeeBps',
    method: 'policy_input',
    methodVersion: FACTS_METHOD_VERSION,
    fetchedAt: inp.asOf,
    provenance: inp.curveMeta.provenance,
  });

  /** Total cost of one side at the sheet's size in one regime, or why it is not measured. */
  const sideCost = (
    curves: AssetCurves | null,
    regime: Regime,
  ): { cost: number; curve: DepthCurve } | { reason: FactNullReason } => {
    if (!curves) return { reason: inp.uncoveredReason ?? 'not_collected' };
    const { curve } = curveFor(curves, regime);
    if (!curve) return { reason: 'no_samples_in_regime' };
    if (usableCount(curve) === 0) return { reason: 'insufficient_samples' };
    const k = costAt(curve, inp.sizeUsd);
    return k === null ? { reason: 'beyond_measured_size' } : { cost: k, curve };
  };
  const nf = inp.networkFee;
  const networkFeeUsd = (regime: Regime): Fact =>
    nf && 'usd' in nf
      ? fact({
          value: nf.usd,
          unit: 'usd',
          quality: 'measured',
          regime,
          sizeUsd: inp.sizeUsd,
          source: nf.source,
          method: nf.method,
          methodVersion: nf.methodVersion,
          provenance: nf.provenance,
          fetchedAt: nf.fetchedAt,
          dataFrom: nf.dataFrom,
          samples: nf.samples,
        })
      : missing(nf?.reason ?? 'not_collected', 'usd', {
          regime,
          sizeUsd: inp.sizeUsd,
          detail: nf?.detail ?? 'the fee of real swap transactions (pnpm risk:network-fees)',
        });
  const breakdown = (curves: AssetCurves | null, regime: Regime): CostBreakdown => {
    const s = sideCost(curves, regime);
    const ctx = { regime, sizeUsd: inp.sizeUsd };
    const sp =
      'cost' in s && inp.splitMeta ? splitAt(s.curve, inp.sizeUsd, inp.splitMinSamples ?? 8) : null;
    const split = (unit: FactUnit) =>
      'cost' in s
        ? missing(sp && 'reason' in sp ? sp.reason : 'not_collected', unit, {
            ...ctx,
            detail: NOT_SPLIT,
          })
        : missing(s.reason, unit, ctx);
    const part = (value: number, meta: RowMeta): MeasuredFact | null =>
      sp && 'poolFee' in sp
        ? fact({
            value,
            unit: 'fraction',
            quality: 'measured',
            ...ctx,
            ...meta,
            fetchedAt: sp.to,
            dataFrom: sp.from,
            samples: sp.samples,
          })
        : null;
    const sm = inp.splitMeta as RowMeta;
    const network = networkFeeUsd(regime);
    const fee = network.value === null ? undefined : network.value;
    return {
      total: 'cost' in s ? curveFact(s.cost, 'fraction', s.curve, regime) : split('fraction'),
      poolFee: (sp && 'poolFee' in sp && part(sp.poolFee, sm)) || split('fraction'),
      transferFee: (sp && 'poolFee' in sp && part(sp.transferFee, sm)) || split('fraction'),
      // the rest of the curve's cost, so the four parts sum to the total exactly
      impact:
        ('cost' in s &&
          sp &&
          'poolFee' in sp &&
          part(s.cost - sp.poolFee - sp.transferFee - sp.basis, {
            ...sm,
            source: `${inp.curveMeta.source}; ${sm.source}`,
            method: `curve cost less poolFee, transferFee and basis (${sm.method})`,
          })) ||
        split('fraction'),
      basis: (sp && 'poolFee' in sp && part(sp.basis, sm)) || split('fraction'),
      networkFeeUsd: network,
      platformFee,
      // without a measured network fee the true loss is at least this
      lossUsd:
        'cost' in s
          ? curveFact(
              lossUsd(inp.sizeUsd, s.cost, {
                platformFeeBps: inp.platformFeeBps,
                ...(fee === undefined ? {} : { networkFeeUsd: fee }),
              }),
              'usd',
              s.curve,
              regime,
              fee === undefined ? 'lower_bound' : 'measured',
            )
          : split('usd'),
    };
  };

  const costs = REGIMES.map((regime) => {
    const out = sideCost(inp.sell, regime);
    const inn = sideCost(inp.buy, regime);
    const ctx = { regime, sizeUsd: inp.sizeUsd };
    const pairReason = 'reason' in out ? out.reason : 'reason' in inn ? inn.reason : null;
    const { curve } = inp.sell ? curveFor(inp.sell, regime) : { curve: null };
    const m = curve && usableCount(curve) > 0 ? maxNotionalAt(curve, inp.tau) : null;
    return {
      regime,
      exit: breakdown(inp.sell, regime),
      entry: breakdown(inp.buy, regime),
      roundTrip:
        'cost' in out && 'cost' in inn
          ? curveFact(roundTripCost(inn.cost, out.cost), 'fraction', out.curve, regime)
          : missing(pairReason as FactNullReason, 'fraction', ctx),
      breakEvenReturn:
        'cost' in out && 'cost' in inn
          ? curveFact(breakEvenReturn(inn.cost, out.cost), 'fraction', out.curve, regime)
          : missing(pairReason as FactNullReason, 'fraction', ctx),
      exitCapacityUsd:
        m && curve
          ? curveFact(
              m.notionalUsd,
              'usd',
              curve,
              regime,
              m.lowerBound ? 'lower_bound' : 'measured',
            )
          : missing('reason' in out ? out.reason : 'insufficient_samples', 'usd', { regime }),
    };
  });

  const regimes = inp.sell
    ? measuredRegimes(inp.sell)
    : { measured: [] as Regime[], missing: REGIMES.map((regime) => ({ regime })) };
  // the worst regime at this size: one whose curve stops below the size, else the highest measured cost
  let worstRegime: Regime | null = null;
  let worstCost = Number.NEGATIVE_INFINITY;
  for (const regime of regimes.measured) {
    const s = sideCost(inp.sell, regime);
    const k = 'cost' in s ? s.cost : Number.POSITIVE_INFINITY;
    if (k > worstCost) {
      worstCost = k;
      worstRegime = regime;
    }
  }

  const weekendRatio = ((): Fact => {
    if (!inp.sell) return missing(inp.uncoveredReason ?? 'not_collected', 'ratio');
    const w = inp.sell.byRegime.weekend;
    const m = inp.sell.byRegime.us_market_hours;
    for (const [regime, c] of [
      ['weekend', w],
      ['us_market_hours', m],
    ] as const) {
      if (!c) return missing('no_samples_in_regime', 'ratio', { regime });
      if (usableCount(c) === 0) return missing('insufficient_samples', 'ratio', { regime });
    }
    const cm = maxNotionalAt(m as DepthCurve, inp.tau).notionalUsd;
    if (!(cm > 0)) return missing('insufficient_samples', 'ratio', { regime: 'us_market_hours' });
    return curveFact(
      maxNotionalAt(w as DepthCurve, inp.tau).notionalUsd / cm,
      'ratio',
      w as DepthCurve,
      'weekend',
    );
  })();

  const rowFact = (
    value: number,
    unit: FactUnit,
    row: RowMeta & { fetchedAt: string },
    extra: Partial<MeasuredFact> = {},
  ): MeasuredFact =>
    fact({
      value,
      unit,
      quality: 'measured',
      source: row.source,
      method: row.method,
      methodVersion: row.methodVersion,
      provenance: row.provenance,
      fetchedAt: row.fetchedAt,
      ...extra,
    });
  const lpGone = (unit: FactUnit) =>
    missing(inp.sell ? 'not_collected' : (inp.uncoveredReason ?? 'not_collected'), unit, {
      detail: 'LP positions are read hourly for the pools holding the top 80% of liquidity',
    });
  const lpExit = ((): Fact => {
    if (!inp.lp) return lpGone('fraction');
    const pts = inp.lp.sellWithoutTopN;
    if (!pts?.length) return missing('not_collected', 'fraction', { sizeUsd: inp.sizeUsd });
    const hit = pts.find((p) => p.notionalUsd >= inp.sizeUsd);
    return hit
      ? rowFact(hit.costPct / 100, 'fraction', inp.lp, { sizeUsd: hit.notionalUsd })
      : missing('beyond_measured_size', 'fraction', { sizeUsd: inp.sizeUsd });
  })();
  const capacityVariation = ((): Fact => {
    const s = inp.capacitySeries;
    if (!s || !worstRegime) return missing('insufficient_samples', 'ratio');
    const xs = s.byRegime[worstRegime] ?? [];
    if (xs.length < s.minSamples)
      return missing('insufficient_samples', 'ratio', { regime: worstRegime });
    const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
    if (!(mean > 0)) return missing('insufficient_samples', 'ratio', { regime: worstRegime });
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length);
    return rowFact(
      sd / mean,
      'ratio',
      { ...s, fetchedAt: s.to },
      {
        regime: worstRegime,
        samples: xs.length,
      },
    );
  })();

  const issuerFact = (value: number, unit: FactUnit): Fact =>
    inp.issuer
      ? fact({
          value,
          unit,
          quality: inp.issuer.provenance === 'live' ? 'measured' : 'assumption',
          source: inp.issuer.source,
          method: 'issuer_model',
          methodVersion: FACTS_METHOD_VERSION,
          fetchedAt: inp.issuer.fetchedAt,
          provenance: inp.curveMeta.provenance,
        })
      : missing('not_applicable', unit);

  const curves = inp.sell ? Object.values(inp.sell.byRegime) : [];
  const dates = (k: 'from' | 'to') =>
    curves
      .map((c) => c[k])
      .filter((t): t is string => !!t)
      .sort();
  return {
    assetId: inp.assetId,
    symbol: inp.symbol,
    chain: inp.chain,
    mint: inp.mint,
    sizeUsd: inp.sizeUsd,
    tau: inp.tau,
    costs,
    worstRegime,
    weekendRatio,
    liquidityStability: {
      lpTop1Share: inp.lp ? rowFact(inp.lp.top1, 'fraction', inp.lp) : lpGone('fraction'),
      lpTop3Share: inp.lp ? rowFact(inp.lp.top3, 'fraction', inp.lp) : lpGone('fraction'),
      lpTop10Share: inp.lp ? rowFact(inp.lp.top10, 'fraction', inp.lp) : lpGone('fraction'),
      lpExitCost: lpExit,
      lpWithdrawalEvents7d: inp.lpWithdrawals
        ? fact({
            value: inp.lpWithdrawals.count,
            unit: 'count',
            quality: 'measured',
            source: inp.lpWithdrawals.source,
            method: inp.lpWithdrawals.method,
            methodVersion: FACTS_METHOD_VERSION,
            fetchedAt: inp.lpWithdrawals.to,
            provenance: inp.curveMeta.provenance,
          })
        : missing('not_collected', 'count'),
      capacityVariation,
      capacityVariationByRegime: REGIMES.map((regime) => {
        const s = inp.capacitySeries;
        const xs = s?.byRegime[regime] ?? [];
        const v = s ? seriesVariation(xs, s.minSamples) : null;
        return {
          regime,
          value:
            s && v !== null
              ? rowFact(v, 'ratio', { ...s, fetchedAt: s.to }, { regime, samples: xs.length })
              : missing(xs.length ? 'insufficient_samples' : 'no_samples_in_regime', 'ratio', {
                  regime,
                }),
        };
      }),
      depthRecovery: REGIMES.map((regime) => depthRecoveryFacts(inp, regime)),
      lpOwnerTop1Share: missing('not_collected', 'fraction', {
        detail: 'owners of the LP position NFTs: one read per position, from Mon Oct 5 (DA3)',
      }),
    },
    tracking: inp.tracking.map((t) => ({
      against: t.against,
      regime: t.regime,
      gap:
        typeof t.gap === 'string'
          ? missing(t.gap, 'fraction', { regime: t.regime })
          : rowFact(t.gap.value, 'fraction', t.gap, { regime: t.regime, samples: t.gap.samples }),
    })),
    lendingUse: {
      collateralUsd: inp.lendingCollateral
        ? rowFact(inp.lendingCollateral.usd, 'usd', inp.lendingCollateral)
        : missing('not_applicable', 'usd', { detail: 'no registered lending market takes it' }),
      coverageByGap: inp.gapGridPct.map((gapPct) => ({
        gapPct,
        value: missing(inp.lendingCollateral ? 'not_imported' : 'not_applicable', 'ratio', {
          detail: 'the coverage ratio is a report until item 11 imports it',
        }),
      })),
    },
    issuerRoute: {
      capacityUsdPerOpenHour: issuerFact(inp.issuer?.capacityUsdPerOpenHour ?? 0, 'usd'),
      fee: issuerFact(inp.issuer?.feePct ?? 0, 'fraction'),
      settlementHours: issuerFact(inp.issuer?.settlementHours ?? 0, 'hours'),
    },
    marketRisk: marketRiskFacts(inp),
    coverage: {
      regimesMeasured: regimes.measured,
      regimesMissing: regimes.missing.map((m) => m.regime),
      samples: curves.reduce((a, c) => a + c.samples, 0),
      dataFrom: dates('from')[0] ?? null,
      dataTo: dates('to').at(-1) ?? null,
    },
    methodVersion: FACTS_METHOD_VERSION,
    provenance: inp.curveMeta.provenance,
  };
}

/** The marketRisk block of an asset sheet from its reference prices (item 12). */
function marketRiskFacts(inp: AssetFactsInput): AssetFacts['marketRisk'] {
  const m = inp.marketRisk;
  const series = m?.series ?? [];
  if (!m || series.length === 0)
    return {
      volatilityAnnual: missing('no_reference_price', 'fraction'),
      maxDrawdown: missing('no_reference_price', 'fraction'),
      weekendGapFrequency: inp.gapGridPct.map((gapPct) => ({
        gapPct,
        value: missing('no_reference_price', 'fraction'),
      })),
    };
  const p = defaultFactsParams();
  const closes = dailyCloses(series);
  // a price that is only ever par is a stated peg, not a measured market
  const quality = series.every((x) => x.quality === 'par') ? 'assumption' : 'measured';
  const meas = (value: number, samples: number, from: string, to: string): MeasuredFact =>
    fact({
      value,
      unit: 'fraction',
      quality,
      source: m.source,
      method: m.method,
      methodVersion: m.methodVersion,
      provenance: m.provenance,
      fetchedAt: to,
      dataFrom: from,
      samples,
    });
  const first = closes[0]?.at ?? (series[0] as PricePoint).at;
  const last = closes.at(-1)?.at ?? (series.at(-1) as PricePoint).at;
  const vol = volatilityAnnual(closes, {
    tradingDays: p.tradingDaysPerYear,
    minReturns: p.marketRiskMinReturns,
  });
  const dd = maxDrawdown(closes, p.marketRiskMinReturns + 1);
  const gaps = weekendGaps(series);
  const gapDetail = `${gaps.length} weekends with a market-hours price on both sides, ${p.minWeekends} needed`;
  return {
    volatilityAnnual: vol
      ? {
          ...meas(vol.value, vol.samples, first, last),
          method: `${m.method}; daily close log returns, sample sd × √${p.tradingDaysPerYear}`,
        }
      : missing('insufficient_samples', 'fraction', {
          detail: `${Math.max(0, closes.length - 1)} daily returns, ${p.marketRiskMinReturns} needed`,
        }),
    maxDrawdown: dd
      ? {
          ...meas(dd.value, dd.samples, first, last),
          method: `${m.method}; daily closes, largest fall from a running peak (${dd.peak} → ${dd.trough})`,
        }
      : missing('insufficient_samples', 'fraction', {
          detail: `${closes.length} daily closes, ${p.marketRiskMinReturns + 1} needed`,
        }),
    weekendGapFrequency: gapFrequency(gaps, inp.gapGridPct, p.minWeekends).map((g) => ({
      gapPct: g.gapPct,
      value:
        'share' in g
          ? {
              ...meas(
                g.share,
                g.weekends,
                (gaps[0] as { closeAt: string }).closeAt,
                (gaps.at(-1) as { openAt: string }).openAt,
              ),
              method: `${m.method}; last market-hours price before a weekend against the first after it, |move| > ${g.gapPct}%: seen ${g.seen} times in ${g.weekends} weekends`,
            }
          : missing('insufficient_samples', 'fraction', { detail: gapDetail }),
    })),
  };
}

/** Depth recovery facts of one regime (item 15): hours to half and to 90% of the depth, and the share not back. */
function depthRecoveryFacts(
  inp: AssetFactsInput,
  regime: Regime,
): NonNullable<AssetFacts['liquidityStability']['depthRecovery']>[number] {
  const d = inp.depthRecovery;
  const row = d?.rows.find((r) => r.regime === regime);
  const none = (reason: FactNullReason, unit: FactUnit, detail?: string) =>
    missing(reason, unit, { regime, ...(detail ? { detail } : {}) });
  if (!d || !row) {
    const reason: FactNullReason = d ? 'no_samples_in_regime' : 'not_collected';
    return {
      regime,
      largeTrades: none(reason, 'count'),
      hoursTo50: none(reason, 'hours'),
      hoursTo90: none(reason, 'hours'),
      notRecovered24h: none(reason, 'fraction'),
    };
  }
  const min = defaultFactsParams().capacityMinSamples;
  const f = (value: number, unit: FactUnit, samples: number): MeasuredFact =>
    fact({
      value,
      unit,
      quality: 'measured',
      regime,
      source: d.source,
      method: `${d.method}; trades of at least ${d.largeShare * 100}% of the pool's ±2% depth`,
      methodVersion: d.methodVersion,
      provenance: d.provenance,
      fetchedAt: row.dataTo,
      dataFrom: row.dataFrom,
      samples,
    });
  const thin = row.trades < min;
  const hours = (m: number | null) =>
    thin
      ? none('insufficient_samples', 'hours', `${row.trades} large trades, ${min} needed`)
      : m === null || row.recovered < min
        ? none(
            'insufficient_samples',
            'hours',
            `${row.recovered} came back within 24 h, ${min} needed`,
          )
        : f(m / 60, 'hours', row.recovered);
  return {
    regime,
    largeTrades: f(row.trades, 'count', row.trades),
    hoursTo50: hours(row.minutesTo50),
    hoursTo90: hours(row.minutesTo90),
    notRecovered24h: thin
      ? none('insufficient_samples', 'fraction', `${row.trades} large trades, ${min} needed`)
      : f(row.notRecovered24h, 'fraction', row.trades),
  };
}
