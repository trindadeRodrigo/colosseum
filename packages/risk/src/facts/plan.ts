import {
  type AssetFacts,
  FACTS_METHOD_VERSION,
  type Fact,
  type FactNullReason,
  type FactUnit,
  fact,
  type MeasuredFact,
  missing,
  type PlanFacts,
} from '@colosseum/schemas';
import { REGIMES, type Regime } from '../time';
import { defaultFactsParams } from './asset';
import {
  correlation,
  type DailyClose,
  dailyCloses,
  maxDrawdown,
  type PricePoint,
  planCloses,
  volatilityAnnual,
} from './market';
import { breakEvenReturn, roundTripCost } from './returns';

/**
 * PlanFacts for a list of positions (PLAN-ANALYTICS item 10). A pure function over the legs' own AssetFacts, each
 * built at the leg's value, so every number here is a sum of facts the asset sheets already carry. Joint exit:
 * legs are summed in one regime; legs that share a pool or the SOL leg are flagged `sharedRoute` and the sum is a
 * lower bound, since a shared pool sold at once costs more than each leg alone (re-routing them together needs
 * item 3's router). No probability of reaching the goal: the product has none yet.
 */
export type PlanLeg = {
  assetId: string;
  valueUsd: number;
  attrs: {
    issuer: string | null;
    chain: string;
    /** Asset class from the registry (equity, cash, usd_yield, …). */
    class: string;
    /** DEX of the leg's largest exit pool, and the token it pays out. */
    venue: string | null;
    quoteToken: string | null;
  };
  /** The leg's AssetFacts at `sizeUsd = valueUsd`; null when no sheet exists (unknown asset or zero value). */
  sheet: AssetFacts | null;
  /** Pools an exit of this leg routes through. */
  exitPools: string[];
  /** The route converts through SOL. */
  usesSol: boolean;
  /** The leg's hourly reference prices (item 12); null when it has none. Absent on every leg: no marketRisk block. */
  prices?: {
    series: PricePoint[];
    source: string;
    method: string;
    methodVersion: string;
    provenance: MeasuredFact['provenance'];
  } | null;
  /** A deposit in a lending pool: what can be withdrawn now, or null when not read. */
  lendingSupply?: { availableUsd: number | null };
};

export type PlanBreach = {
  breach: boolean;
  likelyBreach: boolean;
  shortfallUsd: number;
  monthsAtRisk: string[];
  regimesMissing: Array<{ assetId: string; regime: string }>;
};

export type PlanFactsInput = {
  legs: PlanLeg[];
  asOf: string;
  provenance: MeasuredFact['provenance'];
  platformFeeBps: number;
  stress: { gapPct: number; lpExitN: number };
  breach?: { result: PlanBreach; source: string; method: string; methodVersion: string } | null;
};

/** The plan's unit of account: stablecoins at par have no exit cost by the method's definition. */
const isCash = (l: PlanLeg) => l.attrs.class === 'cash';

export function buildPlanFacts(inp: PlanFactsInput): PlanFacts {
  const total = inp.legs.reduce((s, l) => s + l.valueUsd, 0);
  const priced = inp.legs.filter((l) => !isCash(l) && l.valueUsd > 0);
  const exitIn = (l: PlanLeg, regime: Regime): Fact => {
    if (!l.sheet) return missing('not_collected', 'fraction', { regime, detail: 'no fact sheet' });
    const c = l.sheet.costs.find((x) => x.regime === regime);
    return c ? c.exit.total : missing('no_samples_in_regime', 'fraction', { regime });
  };
  const entryIn = (l: PlanLeg, regime: Regime): Fact => {
    if (!l.sheet) return missing('not_collected', 'fraction', { regime, detail: 'no fact sheet' });
    const c = l.sheet.costs.find((x) => x.regime === regime);
    return c ? c.entry.total : missing('no_samples_in_regime', 'fraction', { regime });
  };
  const num = (f: Fact) => (f.value === null ? null : f.value);
  // the plan's exit regime: among regimes every measured leg measures, the one with the highest loss
  const legMeasures = (l: PlanLeg) => REGIMES.filter((r) => num(exitIn(l, r)) !== null);
  const covered = priced.filter((l) => legMeasures(l).length > 0);
  const candidates = REGIMES.filter((r) => covered.every((l) => legMeasures(l).includes(r)));
  const lossIn = (r: Regime) =>
    covered.reduce((s, l) => s + l.valueUsd * (num(exitIn(l, r)) as number), 0);
  const regime =
    covered.length && candidates.length
      ? candidates.reduce((w, r) => (lossIn(r) > lossIn(w) ? r : w))
      : null;

  const shared = (l: PlanLeg) =>
    inp.legs.some(
      (o) =>
        o !== l &&
        o.valueUsd > 0 &&
        ((l.usesSol && o.usesSol) || o.exitPools.some((p) => l.exitPools.includes(p))),
    );
  const legs = inp.legs.map((l) => ({
    assetId: l.assetId,
    valueUsd: l.valueUsd,
    exit: isCash(l)
      ? missing('not_applicable', 'fraction', {
          detail: "the plan's unit of account (stablecoins at par)",
        })
      : regime
        ? exitIn(l, regime)
        : missing(l.sheet ? 'no_samples_in_regime' : 'not_collected', 'fraction'),
    sharedRoute: !isCash(l) && l.valueUsd > 0 && shared(l),
  }));

  const measuredLegs = priced.filter((l) => regime && num(exitIn(l, regime)) !== null);
  const measuredUsd =
    inp.legs.filter(isCash).reduce((s, l) => s + l.valueUsd, 0) +
    measuredLegs.reduce((s, l) => s + l.valueUsd, 0);
  const measuredShare = total > 0 ? Math.min(1, measuredUsd / total) : 0;
  const complete = measuredLegs.length === priced.length;
  const anyShared = legs.some((l) => l.sharedRoute);
  const legFacts = measuredLegs
    .map((l) => exitIn(l, regime as Regime))
    .filter((f): f is MeasuredFact => f.value !== null);
  /** A fact summed from the legs' facts: their sources, the oldest of their times. */
  const summed = (
    value: number,
    unit: FactUnit,
    from: MeasuredFact[],
    method: string,
    quality: MeasuredFact['quality'],
  ): MeasuredFact =>
    fact({
      value,
      unit,
      quality,
      ...(regime ? { regime } : {}),
      source: `AssetFacts of ${from.length} legs (${[...new Set(from.map((f) => f.source))].join('; ')})`,
      method,
      methodVersion: FACTS_METHOD_VERSION,
      fetchedAt: from.map((f) => f.fetchedAt).sort()[0] ?? inp.asOf,
      provenance: inp.provenance,
    });
  const noPlan = (unit: FactUnit, reason: FactNullReason = 'not_collected'): Fact =>
    missing(reason, unit, { detail: 'no leg of the plan has a measured exit in a common regime' });
  const exitUsd = measuredLegs.reduce(
    (s, l) => s + l.valueUsd * (num(exitIn(l, regime as Regime)) as number),
    0,
  );
  const lossUsd =
    exitUsd + (measuredLegs.reduce((s, l) => s + l.valueUsd, 0) * inp.platformFeeBps) / 10_000;
  const planExit: Fact =
    total > 0 && legFacts.length
      ? summed(
          exitUsd / total,
          'fraction',
          legFacts,
          'value-weighted exit cost of the legs in one regime; cash at par; shared routes not re-routed',
          complete && !anyShared ? 'measured' : 'lower_bound',
        )
      : noPlan('fraction');
  // without the network fee, so the loss is at least this
  const planLoss: Fact =
    total > 0 && legFacts.length
      ? summed(
          lossUsd,
          'usd',
          legFacts,
          'Σ value × (exit cost + platform fee); network fee not measured',
          'lower_bound',
        )
      : noPlan('usd');

  // round trip and break-even: value-weighted entry and exit costs over the legs measured on both sides
  const both = regime ? measuredLegs.filter((l) => num(entryIn(l, regime)) !== null) : [];
  const cIn =
    total > 0
      ? both.reduce((s, l) => s + l.valueUsd * (num(entryIn(l, regime as Regime)) as number), 0) /
        total
      : 0;
  const cOut =
    total > 0
      ? both.reduce((s, l) => s + l.valueUsd * (num(exitIn(l, regime as Regime)) as number), 0) /
        total
      : 0;
  const bothFacts = both
    .flatMap((l) => [entryIn(l, regime as Regime), exitIn(l, regime as Regime)])
    .filter((f): f is MeasuredFact => f.value !== null);
  const rtQuality = both.length === priced.length && !anyShared ? 'measured' : 'lower_bound';
  const netReturn = both.length
    ? {
        roundTrip: summed(
          roundTripCost(cIn, cOut),
          'fraction',
          bothFacts,
          'round trip of value-weighted entry and exit costs',
          rtQuality,
        ),
        breakEvenReturn: summed(
          breakEvenReturn(cIn, cOut),
          'fraction',
          bothFacts,
          'break-even gross return of value-weighted entry and exit costs',
          rtQuality,
        ),
      }
    : { roundTrip: noPlan('fraction'), breakEvenReturn: noPlan('fraction') };

  // concentration by value
  const conc = (key: (l: PlanLeg) => string | null) => {
    const m = new Map<string, number>();
    for (const l of inp.legs) {
      const k = key(l) ?? 'unknown';
      m.set(k, (m.get(k) ?? 0) + l.valueUsd);
    }
    return [...m]
      .map(([k, v]) => ({ key: k, share: total > 0 ? v / total : 0 }))
      .sort((a, b) => b.share - a.share);
  };

  // stress: each scenario is a named change to an input of the same facts
  const capIn = (l: PlanLeg, r: Regime): number | null => {
    const c = l.sheet?.costs.find((x) => x.regime === r)?.exitCapacityUsd;
    return c && c.value !== null ? c.value : null;
  };
  const stressFact = (
    value: number,
    unit: FactUnit,
    from: MeasuredFact[],
    method: string,
    regimeOf?: Regime,
  ) =>
    fact({
      value,
      unit,
      quality: 'assumption',
      ...(regimeOf ? { regime: regimeOf } : {}),
      source: from.length
        ? `AssetFacts of ${from.length} legs (${[...new Set(from.map((f) => f.source))].join('; ')})`
        : 'plan positions',
      method,
      methodVersion: FACTS_METHOD_VERSION,
      fetchedAt: from.map((f) => f.fetchedAt).sort()[0] ?? inp.asOf,
      provenance: inp.provenance,
    });
  const g = inp.stress.gapPct / 100;
  const stocks = inp.legs.filter((l) => l.attrs.class === 'equity' && l.valueUsd > 0);
  const cashUsd = inp.legs.filter(isCash).reduce((s, l) => s + l.valueUsd, 0);
  const weekendCaps = priced.map((l) => ({ l, cap: capIn(l, 'weekend') }));
  const weekendMissing = weekendCaps.filter((x) => x.cap === null);
  const capFacts = (r: Regime) =>
    priced
      .map((l) => l.sheet?.costs.find((x) => x.regime === r)?.exitCapacityUsd)
      .filter((f): f is MeasuredFact => !!f && f.value !== null);
  const weekendGap = {
    scenario: 'weekend_gap',
    inputs: { gapPct: inp.stress.gapPct, stockLegs: stocks.length },
    lossUsd: stressFact(
      stocks.reduce((s, l) => s + l.valueUsd * g, 0),
      'usd',
      [],
      'scenario: every stock leg gaps down by gapPct while the market is closed',
    ),
    liquidUsd: weekendMissing.length
      ? missing('no_samples_in_regime', 'usd', {
          regime: 'weekend',
          detail: `${weekendMissing.length} legs have no weekend exit capacity`,
        })
      : stressFact(
          cashUsd +
            weekendCaps.reduce(
              (s, x) =>
                s +
                Math.min(
                  x.l.valueUsd * (x.l.attrs.class === 'equity' ? 1 - g : 1),
                  x.cap as number,
                ),
              0,
            ),
          'usd',
          capFacts('weekend'),
          'cash plus each leg after the gap, capped at its weekend exit capacity at tau',
          'weekend',
        ),
  };
  const lpLegs = priced.map((l) => ({ l, c: l.sheet?.liquidityStability.lpExitCost }));
  const lpMeasured = lpLegs.filter((x) => x.c && x.c.value !== null);
  const lpExit = {
    scenario: 'lp_exit',
    inputs: { lpExitN: inp.stress.lpExitN, legsMeasured: lpMeasured.length, legs: priced.length },
    lossUsd: lpMeasured.length
      ? fact({
          ...stressFact(
            lpMeasured.reduce((s, x) => s + x.l.valueUsd * (x.c?.value as number), 0),
            'usd',
            lpMeasured.map((x) => x.c as MeasuredFact),
            "scenario: the top lpExitN LPs leave each leg's main pool; exit loss on that pool alone",
          ),
          ...(lpMeasured.length < priced.length ? { quality: 'lower_bound' as const } : {}),
        })
      : missing('not_collected', 'usd', { detail: 'no leg has an LP-exit curve' }),
    liquidUsd: missing('not_collected', 'usd', {
      detail: 'capacity without the top LPs is not fitted, only the cost at the leg size',
    }),
  };
  const lending = inp.legs.filter((l) => l.lendingSupply && l.valueUsd > 0);
  const others = priced.filter((l) => !l.lendingSupply);
  const regimeCaps = regime ? others.map((l) => capIn(l, regime)) : [];
  const lendingFull = {
    scenario: 'lending_pool_fully_lent',
    inputs: { lendingLegs: lending.length },
    lossUsd: stressFact(
      0,
      'usd',
      [],
      'scenario: nothing can be withdrawn from the lending pools; no price change',
    ),
    liquidUsd:
      !regime || regimeCaps.some((c) => c === null)
        ? missing('insufficient_samples', 'usd', {
            detail: 'a leg has no exit capacity in the plan regime',
          })
        : stressFact(
            cashUsd +
              others.reduce((s, l, i) => s + Math.min(l.valueUsd, regimeCaps[i] as number), 0),
            'usd',
            capFacts(regime),
            'cash plus each non-lending leg capped at its exit capacity at tau; lending legs at 0',
            regime,
          ),
  };

  const b = inp.breach;
  return {
    positions: inp.legs.map((l) => ({ assetId: l.assetId, valueUsd: l.valueUsd })),
    totalUsd: total,
    measuredShare,
    concentration: {
      byIssuer: conc((l) => l.attrs.issuer),
      byChain: conc((l) => l.attrs.chain),
      byClass: conc((l) => l.attrs.class),
      byVenue: conc((l) => (isCash(l) ? 'cash' : l.attrs.venue)),
      byQuoteToken: conc((l) => (isCash(l) ? 'cash' : l.attrs.quoteToken)),
    },
    exit: { regime, legs, planExit, lossUsd: planLoss },
    netReturn,
    ...(inp.legs.some((l) => l.prices !== undefined) ? { marketRisk: planMarketRisk(inp) } : {}),
    ...(b
      ? {
          breach: {
            breach: b.result.breach,
            likelyBreach: b.result.likelyBreach,
            shortfallUsd: fact({
              value: b.result.shortfallUsd,
              unit: 'usd',
              quality: 'measured',
              source: b.source,
              method: b.method,
              methodVersion: b.methodVersion,
              fetchedAt: inp.asOf,
              provenance: inp.provenance,
            }),
            monthsAtRisk: b.result.monthsAtRisk,
            regimesMissing: b.result.regimesMissing.map((m) => ({
              assetId: m.assetId,
              regime: m.regime as Regime,
            })),
          },
        }
      : {}),
    stress: [weekendGap, lpExit, lendingFull],
    methodVersion: FACTS_METHOD_VERSION,
    provenance: inp.provenance,
  };
}

/** The plan's volatility, drawdown and correlations from its legs' reference prices (item 12). */
function planMarketRisk(inp: PlanFactsInput): NonNullable<PlanFacts['marketRisk']> {
  const p = defaultFactsParams();
  const held = inp.legs.filter((l) => l.valueUsd > 0);
  const total = held.reduce((s, l) => s + l.valueUsd, 0);
  const closes = new Map<string, DailyClose[]>();
  for (const l of held)
    if (l.prices?.series.length) closes.set(l.assetId, dailyCloses(l.prices.series));
  const without = held.filter((l) => !closes.get(l.assetId)?.length).map((l) => l.assetId);
  const atPar = held
    .filter((l) => l.prices?.series.length && l.prices.series.every((x) => x.quality === 'par'))
    .map((l) => l.assetId);
  const withPrices = held.filter((l) => closes.get(l.assetId)?.length);
  const meta = withPrices.find((l) => !atPar.includes(l.assetId))?.prices ?? withPrices[0]?.prices;
  const quality = atPar.length ? 'assumption' : 'measured';
  const meas = (
    value: number,
    samples: number,
    c: DailyClose[],
    method: string,
    q: MeasuredFact['quality'] = quality,
  ): Fact =>
    meta
      ? fact({
          value,
          unit: 'fraction',
          quality: q,
          source: meta.source,
          method: `${meta.method}; ${method}`,
          methodVersion: meta.methodVersion,
          provenance: meta.provenance,
          fetchedAt: (c.at(-1) as DailyClose).at,
          dataFrom: (c[0] as DailyClose).at,
          samples,
        })
      : missing('no_reference_price', 'fraction');
  const index = without.length
    ? []
    : planCloses(
        held.map((l) => ({
          weight: l.valueUsd / total,
          closes: closes.get(l.assetId) as DailyClose[],
        })),
      );
  const vol = volatilityAnnual(index, {
    tradingDays: p.tradingDaysPerYear,
    minReturns: p.marketRiskMinReturns,
  });
  const dd = maxDrawdown(index, p.marketRiskMinReturns + 1);
  const noPrices = missing('no_reference_price', 'fraction', {
    detail: `no reference price for ${without.join(', ')}`,
  });
  const short = (n: string) =>
    missing('insufficient_samples', 'fraction', {
      detail: `${n} on the dates every leg has a price, ${p.marketRiskMinReturns} needed`,
    });
  const moving = withPrices.filter((l) => !atPar.includes(l.assetId));
  const correlations: NonNullable<PlanFacts['marketRisk']>['correlations'] = [];
  for (let i = 0; i < moving.length; i++)
    for (let j = i + 1; j < moving.length; j++) {
      const a = moving[i] as PlanLeg;
      const b = moving[j] as PlanLeg;
      const ca = closes.get(a.assetId) as DailyClose[];
      const c = correlation(ca, closes.get(b.assetId) as DailyClose[], p.marketRiskMinReturns);
      correlations.push({
        a: a.assetId,
        b: b.assetId,
        value: c
          ? meas(
              c.value,
              c.samples,
              ca,
              'Pearson correlation of daily close log returns on common dates',
              'measured',
            )
          : short('daily returns'),
      });
    }
  return {
    volatilityAnnual: without.length
      ? noPrices
      : vol
        ? meas(
            vol.value,
            vol.samples,
            index,
            `plan at fixed weights; sample sd of daily log returns × √${p.tradingDaysPerYear}`,
          )
        : short(`${Math.max(0, index.length - 1)} daily returns`),
    maxDrawdown: without.length
      ? noPrices
      : dd
        ? meas(
            dd.value,
            dd.samples,
            index,
            `plan at fixed weights; largest fall from a running peak (${dd.peak} → ${dd.trough})`,
          )
        : short(`${index.length} daily closes`),
    correlations,
    legsWithoutPrices: without,
    legsAtPar: atPar,
  };
}
