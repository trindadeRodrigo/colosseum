import {
  AssetFacts,
  collectFacts,
  FACTS_METHOD_VERSION,
  Fact,
  type FactRegime,
  fact,
  missing,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 1: a fact is a number with where it came from, or null with a reason. Never a bare number,
// never a zero standing in for missing data.
const meta = {
  source: 'fixture',
  method: 'fixture',
  methodVersion: FACTS_METHOD_VERSION,
  fetchedAt: '2026-10-02T12:00:00.000Z',
  provenance: 'fixture' as const,
};
const measured = (value: number, unit: 'fraction' | 'usd' | 'ratio' | 'count' | 'hours') =>
  fact({ value, unit, quality: 'measured', ...meta });

const breakdown = (regime: FactRegime, total: number | null) =>
  total === null
    ? {
        total: missing('no_samples_in_regime', 'fraction', { regime }),
        poolFee: missing('no_samples_in_regime', 'fraction', { regime }),
        transferFee: missing('no_samples_in_regime', 'fraction', { regime }),
        impact: missing('no_samples_in_regime', 'fraction', { regime }),
        basis: missing('no_samples_in_regime', 'fraction', { regime }),
        networkFeeUsd: missing('insufficient_samples', 'usd'),
        platformFee: fact({ value: 0, unit: 'fraction', quality: 'assumption', ...meta }),
        lossUsd: missing('no_samples_in_regime', 'usd', { regime }),
      }
    : {
        total: measured(total, 'fraction'),
        poolFee: measured(total / 2, 'fraction'),
        transferFee: measured(0, 'fraction'),
        impact: measured(total / 2, 'fraction'),
        basis: measured(0, 'fraction'),
        networkFeeUsd: missing('insufficient_samples', 'usd'),
        platformFee: fact({ value: 0, unit: 'fraction', quality: 'assumption', ...meta }),
        lossUsd: measured(total * 10_000, 'usd'),
      };

const regimeCosts = (regime: FactRegime, total: number | null) => ({
  regime,
  exit: breakdown(regime, total),
  entry: breakdown(regime, total),
  roundTrip:
    total === null
      ? missing('no_samples_in_regime', 'fraction', { regime })
      : measured(2 * total, 'fraction'),
  breakEvenReturn:
    total === null
      ? missing('no_samples_in_regime', 'fraction', { regime })
      : measured(1 / (1 - total) ** 2 - 1, 'fraction'),
  exitCapacityUsd:
    total === null
      ? missing('no_samples_in_regime', 'usd', { regime })
      : fact({ value: 250_000, unit: 'usd', quality: 'lower_bound', ...meta }),
});

const sheet: AssetFacts = {
  assetId: 'spyx',
  symbol: 'SPYx',
  chain: 'solana',
  mint: null,
  sizeUsd: 10_000,
  tau: 0.01,
  costs: [regimeCosts('us_market_hours', 0.001), regimeCosts('weekend', null)],
  worstRegime: 'us_market_hours',
  weekendRatio: missing('no_samples_in_regime', 'ratio', { regime: 'weekend' }),
  liquidityStability: {
    lpTop1Share: measured(0.4, 'fraction'),
    lpTop3Share: measured(0.6, 'fraction'),
    lpTop10Share: measured(0.9, 'fraction'),
    lpExitCost: measured(0.03, 'fraction'),
    lpWithdrawalEvents7d: measured(0, 'count'),
    capacityVariation: missing('insufficient_samples', 'ratio'),
  },
  tracking: [
    { against: 'kamino_scope', regime: 'us_market_hours', gap: measured(0.001, 'fraction') },
  ],
  lendingUse: {
    collateralUsd: measured(1_000_000, 'usd'),
    coverageByGap: [{ gapPct: 20, value: measured(1.4, 'ratio') }],
  },
  issuerRoute: {
    capacityUsdPerOpenHour: missing('not_collected', 'usd'),
    fee: missing('not_collected', 'fraction'),
    settlementHours: missing('not_collected', 'hours'),
  },
  marketRisk: {
    volatilityAnnual: missing('no_reference_price', 'fraction'),
    maxDrawdown: missing('no_reference_price', 'fraction'),
    weekendGapFrequency: [{ gapPct: 5, value: missing('no_reference_price', 'fraction') }],
  },
  coverage: {
    regimesMeasured: ['us_market_hours'],
    regimesMissing: ['weekend', 'us_holiday', 'us_offhours_weekday'],
    samples: 96,
    dataFrom: '2026-10-01T02:00:00.000Z',
    dataTo: '2026-10-02T12:00:00.000Z',
  },
  methodVersion: FACTS_METHOD_VERSION,
  provenance: 'fixture',
};

describe('fact contract', () => {
  it('a measured fact needs its source, method and time', () => {
    expect(Fact.safeParse(measured(0.01, 'fraction')).success).toBe(true);
    for (const drop of [
      'source',
      'method',
      'fetchedAt',
      'methodVersion',
      'provenance',
      'quality',
    ]) {
      const f: Record<string, unknown> = { ...measured(0.01, 'fraction') };
      delete f[drop];
      expect(Fact.safeParse(f).success, drop).toBe(false);
    }
    expect(Fact.safeParse({ value: 0.01, unit: 'fraction' }).success).toBe(false);
  });

  it('a missing fact is null with a reason from the closed list', () => {
    expect(Fact.safeParse(missing('not_collected', 'usd')).success).toBe(true);
    expect(Fact.safeParse({ value: null, unit: 'usd' }).success).toBe(false);
    expect(Fact.safeParse({ value: null, unit: 'usd', reason: 'unknown' }).success).toBe(false);
  });

  it('a sheet parses, and every number in it is a full fact', () => {
    expect(AssetFacts.safeParse(sheet).success).toBe(true);
    const { facts, invalid } = collectFacts(sheet);
    expect(invalid).toEqual([]);
    expect(facts.length).toBeGreaterThan(40);
    const weekend = facts.filter((f) => f.path.startsWith('costs[1].exit.total'));
    expect(weekend).toHaveLength(1);
    expect(weekend[0]?.fact.value).toBeNull();
  });

  it('collectFacts reports a bare number stored as a fact', () => {
    const bad = structuredClone(sheet) as unknown as { weekendRatio: unknown };
    bad.weekendRatio = { value: 0, unit: 'ratio' };
    const { invalid } = collectFacts(bad);
    expect(invalid.map((i) => i.path)).toEqual(['weekendRatio']);
    expect(AssetFacts.safeParse(bad).success).toBe(false);
  });
});
