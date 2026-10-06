import {
  FACTS_METHOD_VERSION,
  type Fact,
  type FactNullReason,
  type FactRegime,
  type FactUnit,
  fact,
  type MeasuredFact,
  missing,
  type OracleBucketFacts,
  type OracleFacts,
} from '@colosseum/schemas';
import { quantileOf } from '../curves';
import { REGIMES, type Regime, type RegimeParams, regimeAt } from '../time';

/**
 * The oracle block of an asset sheet (PLAN-UNIVERSE RU.9): what a rebalance the vault runs by itself needs to know
 * of the oracle it is checked against. A pure function over rows the caller read: no clock, no I/O.
 *
 * The oracle and the pool mid are two readings set side by side; nothing here makes one price of them (gate
 * ORACLE-VS-DEX). No multiplier is applied to either. A figure the rows do not hold is `null` with its reason.
 */
type RowMeta = {
  source: string;
  method: string;
  methodVersion: string;
  provenance: MeasuredFact['provenance'];
};

/** One reading of the oracle: when it was read, its answer, and the oracle's own timestamp for that answer. */
export type OracleReading = { at: string; price: number; sourceTs: string | null };

/** The limits of the vault's price check on the asset's chain, and the hours its keeper may trade in. */
export type VaultPriceLimits = {
  maxAgeSeconds: number;
  maxAgeNote: string;
  /** Largest distance of the price from its one-hour average, in bps; null when the chain's vault has none. */
  maxDistanceBps: number | null;
  maxDistanceNote: string;
  /** The design marks the distance a placeholder. */
  maxDistancePlaceholder: boolean;
  session: {
    label: string;
    /** `Date.getUTCDay()` values: Sunday is 0. */
    weekdaysUtc: number[];
    fromUtcMinute: number;
    toUtcMinute: number;
    /** UTC dates the keeper does not trade on. */
    closedDays: ReadonlySet<string>;
  };
  source: string;
  fetchedAt: string;
  method: string;
  provenance: MeasuredFact['provenance'];
};

export type OracleFactsInput = {
  feed: OracleFacts['feed'];
  /** Why the asset list names no oracle; null with one. */
  feedReason: string | null;
  autoRebalanceOpen: string | null;
  /** The oracle's readings over the window, in any order; null when none were read. */
  readings: (RowMeta & { rows: OracleReading[] }) | null;
  /** The asset's pool mid over the same window, in USD. */
  mids: (RowMeta & { rows: Array<{ at: string; midUsd: number }> }) | null;
  limits: VaultPriceLimits;
  regimeParams: RegimeParams;
  params: OracleFactsParams;
};

export type OracleFactsParams = {
  /** Readings (ages, paired gaps) or hours (refusal shares) needed in a bucket. */
  minSamples: number;
  /** A reading is paired with the pool mid nearest in time, at most this far from it. */
  pairWithinSec: number;
  /** The oracle's own average is rebuilt from its readings of the hour before, when there are this many. */
  averageWindowSec: number;
  averageMinReadings: number;
};

export const defaultOracleFactsParams = (): OracleFactsParams => ({
  minSamples: 8,
  pairWithinSec: 300,
  averageWindowSec: 3600,
  averageMinReadings: 6,
});

type Row = {
  t: number;
  price: number;
  regime: Regime;
  inSession: boolean;
  /** Seconds; null when the reading carries no timestamp of the oracle's. */
  age: number | null;
  /** (pool mid − oracle) ÷ oracle; null with no mid near enough. */
  gap: number | null;
  /** |price ÷ the mean of the hour before − 1|; null with too few readings in that hour. */
  distance: number | null;
};

const sec = (iso: string) => Date.parse(iso) / 1000;

/** Whether the vault's keeper may trade at `t` (check 9 of the rule table): its session, closed days out. */
export function inVaultSession(t: number, s: VaultPriceLimits['session']): boolean {
  const d = new Date(t * 1000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (
    s.weekdaysUtc.includes(d.getUTCDay()) &&
    minute >= s.fromUtcMinute &&
    minute < s.toUtcMinute &&
    !s.closedDays.has(d.toISOString().slice(0, 10))
  );
}

/** The readings as rows, oldest first, each with its age, its gap to the nearest pool mid and its distance. */
function rowsOf(inp: OracleFactsInput): Row[] {
  const p = inp.params;
  const readings = [...(inp.readings?.rows ?? [])]
    .filter((r) => Number.isFinite(r.price) && r.price > 0)
    .sort((a, b) => sec(a.at) - sec(b.at));
  const mids = [...(inp.mids?.rows ?? [])]
    .filter((m) => Number.isFinite(m.midUsd) && m.midUsd > 0)
    .map((m) => ({ t: sec(m.at), mid: m.midUsd }))
    .sort((a, b) => a.t - b.t);
  const ts = readings.map((r) => sec(r.at));
  let m = 0;
  let from = 0;
  let sum = 0;
  return readings.map((r, i) => {
    const t = ts[i] as number;
    // the mid nearest in time: both lists are sorted, so the pointer only moves forward
    while (
      m + 1 < mids.length &&
      Math.abs((mids[m + 1] as { t: number }).t - t) <= Math.abs((mids[m] as { t: number }).t - t)
    )
      m++;
    const near = mids[m];
    const gap = near && Math.abs(near.t - t) <= p.pairWithinSec ? near.mid / r.price - 1 : null;
    // the mean of the readings in the hour up to this one, this one included
    sum += r.price;
    while ((ts[from] as number) < t - p.averageWindowSec) {
      sum -= (readings[from] as OracleReading).price;
      from++;
    }
    const n = i - from + 1;
    return {
      t,
      price: r.price,
      regime: regimeAt(new Date(t * 1000), inp.regimeParams),
      inSession: inVaultSession(t, inp.limits.session),
      age: r.sourceTs === null ? null : t - sec(r.sourceTs),
      gap,
      distance: n >= p.averageMinReadings ? Math.abs(r.price / (sum / n) - 1) : null,
    };
  });
}

/**
 * Share of hours refused: every UTC hour with a reading the check can be run on counts once, by the share of its
 * readings the check refuses. Null when no reading can be checked.
 */
export function refusedShareByHour(
  rows: Array<{ t: number; refused: boolean | null }>,
): { share: number; hours: number; from: number; to: number } | null {
  const hours = new Map<number, { n: number; refused: number }>();
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    if (r.refused === null) continue;
    const h = Math.floor(r.t / 3600);
    const b = hours.get(h) ?? { n: 0, refused: 0 };
    b.n++;
    if (r.refused) b.refused++;
    hours.set(h, b);
    from = Math.min(from, r.t);
    to = Math.max(to, r.t);
  }
  if (hours.size === 0) return null;
  let s = 0;
  for (const b of hours.values()) s += b.refused / b.n;
  return { share: s / hours.size, hours: hours.size, from, to };
}

export function buildOracleFacts(inp: OracleFactsInput): OracleFacts {
  const { limits, params: p } = inp;
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const limitFact = (value: number, unit: FactUnit, note: string, placeholder: boolean): Fact =>
    fact({
      value,
      unit,
      quality: 'assumption',
      source: limits.source,
      method: `${limits.method}: ${note}${placeholder ? ' (a placeholder, not a decided limit)' : ''}`,
      methodVersion: FACTS_METHOD_VERSION,
      fetchedAt: limits.fetchedAt,
      provenance: limits.provenance,
    });
  const maxDistance = limits.maxDistanceBps === null ? null : limits.maxDistanceBps / 10_000;
  const head = {
    feed: inp.feed,
    feedReason: inp.feed ? null : (inp.feedReason ?? 'no_oracle'),
    autoRebalance: inp.feed !== null,
    autoRebalanceReason: inp.feed ? null : 'no_oracle',
    autoRebalanceOpen: inp.autoRebalanceOpen,
    limits: {
      maxAgeSeconds: limitFact(limits.maxAgeSeconds, 'seconds', limits.maxAgeNote, false),
      maxDistance:
        maxDistance === null
          ? missing('not_applicable', 'fraction', { detail: limits.maxDistanceNote })
          : limitFact(
              maxDistance,
              'fraction',
              limits.maxDistanceNote,
              limits.maxDistancePlaceholder,
            ),
    },
  };
  const none = (
    reason: FactNullReason,
    regime: FactRegime | undefined,
    detail?: string,
  ): OracleBucketFacts => {
    const f = (unit: FactUnit) =>
      missing(reason, unit, { ...(regime ? { regime } : {}), ...(detail ? { detail } : {}) });
    return {
      ageMedian: f('seconds'),
      ageP95: f('seconds'),
      gapMedian: f('fraction'),
      gapAbsP95: f('fraction'),
      gapAbsMax: f('fraction'),
      refusedShare: f('fraction'),
      refusedByAgeShare: f('fraction'),
      refusedByDistanceShare: f('fraction'),
    };
  };
  if (!inp.feed)
    return {
      ...head,
      window: null,
      byRegime: REGIMES.map((regime) => ({ regime, ...none('no_oracle', regime) })),
      vaultSession: { session: limits.session.label, ...none('no_oracle', undefined) },
    };
  const rows = rowsOf(inp);
  const r = inp.readings;
  if (!r || rows.length === 0) {
    const detail = 'no reading of this oracle is stored (risk_price_observations)';
    return {
      ...head,
      window: null,
      byRegime: REGIMES.map((regime) => ({ regime, ...none('not_collected', regime, detail) })),
      vaultSession: {
        session: limits.session.label,
        ...none('not_collected', undefined, detail),
      },
    };
  }

  const bucket = (xs: Row[], regime: FactRegime | undefined): OracleBucketFacts => {
    if (xs.length === 0) return none('no_samples_in_regime', regime);
    const ctx = regime ? { regime } : {};
    const meas = (
      value: number,
      unit: FactUnit,
      used: Array<{ t: number }>,
      samples: number,
      source: string,
      method: string,
    ): MeasuredFact =>
      fact({
        value,
        unit,
        quality: 'measured',
        ...ctx,
        source,
        method,
        methodVersion: FACTS_METHOD_VERSION,
        fetchedAt: iso(Math.max(...used.map((x) => x.t))),
        dataFrom: iso(Math.min(...used.map((x) => x.t))),
        samples,
        provenance: r.provenance,
      });
    const thin = (unit: FactUnit, have: number, of: string): Fact =>
      missing('insufficient_samples', unit, {
        ...ctx,
        detail: `${have} ${of}, ${p.minSamples} needed`,
      });

    const aged = xs.filter((x) => x.age !== null);
    const ages = aged.map((x) => x.age as number);
    const ageSource = `${r.source} (${r.methodVersion})`;
    const age = (q: number, name: string): Fact =>
      ages.length < p.minSamples
        ? thin('seconds', ages.length, "readings with the oracle's own timestamp")
        : meas(
            quantileOf(ages, q),
            'seconds',
            aged,
            ages.length,
            ageSource,
            `${name} of the read's time less the oracle's own timestamp (${r.method})`,
          );

    const paired = xs.filter((x) => x.gap !== null);
    const gaps = paired.map((x) => x.gap as number);
    const abs = gaps.map(Math.abs);
    const gapSource = inp.mids
      ? `${ageSource}; ${inp.mids.source} (${inp.mids.methodVersion})`
      : ageSource;
    const pairing = `each oracle reading against the pool mid nearest in time, at most ${p.pairWithinSec} s apart; kept apart, no multiplier applied`;
    const gap = (value: () => number, name: string): Fact =>
      !inp.mids
        ? missing('not_collected', 'fraction', { ...ctx, detail: 'no pool mid is stored' })
        : gaps.length < p.minSamples
          ? thin('fraction', gaps.length, 'readings with a pool mid beside them')
          : meas(
              value(),
              'fraction',
              paired,
              gaps.length,
              gapSource,
              `${name} of (pool mid − oracle) ÷ oracle: ${pairing}`,
            );

    const byAge = xs.map((x) => ({
      t: x.t,
      refused: x.age === null ? null : x.age > limits.maxAgeSeconds,
    }));
    const byDistance = xs.map((x) => ({
      t: x.t,
      refused: maxDistance === null || x.distance === null ? null : x.distance > maxDistance,
    }));
    // refused by either check; a check that cannot be run on a reading does not refuse it
    const either = xs.map((x, i) => {
      const a = (byAge[i] as { refused: boolean | null }).refused;
      const d = (byDistance[i] as { refused: boolean | null }).refused;
      return { t: x.t, refused: a === null && d === null ? null : a === true || d === true };
    });
    const hourly = `each UTC hour counts once, by the share of its readings refused`;
    const ageRule = `older than ${limits.maxAgeSeconds} s when read`;
    const distanceRule =
      maxDistance === null
        ? null
        : `more than ${limits.maxDistanceBps} bps from the mean of the oracle's own readings in the ${p.averageWindowSec} s before (${p.averageMinReadings} readings needed; our rebuild of its average, not the average the vault reads)`;
    const share = (
      rs: Array<{ t: number; refused: boolean | null }>,
      method: string,
      unchecked: () => Fact,
    ): Fact => {
      const s = refusedShareByHour(rs);
      if (!s) return unchecked();
      if (s.hours < p.minSamples) return thin('fraction', s.hours, 'hours with a reading to check');
      return meas(
        s.share,
        'fraction',
        [{ t: s.from }, { t: s.to }],
        s.hours,
        ageSource,
        `share of hours refused: ${method}; ${hourly}`,
      );
    };
    const noTimestamp = (): Fact =>
      missing('not_collected', 'fraction', {
        ...ctx,
        detail: "no reading carries the oracle's own timestamp",
      });
    const noAverage = (): Fact =>
      maxDistance === null
        ? missing('not_applicable', 'fraction', { ...ctx, detail: limits.maxDistanceNote })
        : missing('not_collected', 'fraction', {
            ...ctx,
            detail: `the average the vault compares the price with is not recorded, and no hour holds the ${p.averageMinReadings} readings to rebuild one`,
          });
    const distanceChecked = byDistance.some((x) => x.refused !== null);
    return {
      ageMedian: age(0.5, 'median'),
      ageP95: age(0.95, '95th percentile'),
      gapMedian: gap(() => quantileOf(gaps, 0.5), 'median'),
      gapAbsP95: gap(() => quantileOf(abs, 0.95), '95th percentile of the size'),
      gapAbsMax: gap(() => Math.max(...abs), 'largest size'),
      refusedShare: share(
        either,
        distanceRule && distanceChecked
          ? `${ageRule}, or ${distanceRule}`
          : `${ageRule}; the distance from its average is not checked here (${maxDistance === null ? 'the vault has no such limit' : 'no average to compare with'})`,
        noTimestamp,
      ),
      refusedByAgeShare: share(byAge, ageRule, noTimestamp),
      refusedByDistanceShare: share(byDistance, distanceRule ?? '', noAverage),
    };
  };

  return {
    ...head,
    window: { from: iso((rows[0] as Row).t), to: iso((rows.at(-1) as Row).t) },
    byRegime: REGIMES.map((regime) => ({
      regime,
      ...bucket(
        rows.filter((x) => x.regime === regime),
        regime,
      ),
    })),
    vaultSession: {
      session: limits.session.label,
      ...bucket(
        rows.filter((x) => x.inSession),
        undefined,
      ),
    },
  };
}
