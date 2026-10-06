import { readFileSync } from 'node:fs';
import {
  type AssetFactsInput,
  buildAssetFacts,
  buildOracleFacts,
  defaultOracleFactsParams,
  defaultRegimeParams,
  inVaultSession,
  type OracleFactsInput,
  type OracleReading,
  refusedShareByHour,
} from '@colosseum/risk';
import { AssetFacts, collectFacts, type Fact, type OracleBucketFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { vaultPriceLimits } from '../../apps/api/src/oracle-facts';

// PLAN-UNIVERSE RU.9: the oracle block of an asset sheet. Real rows, frozen by `pnpm risk:freeze-oracle-fixture`:
// NVDAx's Scope entry on Solana across the US open of Mon 2026-10-05 (read every 5 minutes) and NVDA's Chainlink
// feed on Robinhood Chain over the hourly loop's first night. Every expected figure is worked out here by hand,
// over the raw rows, without the package's functions. No network, no database.
type Block = {
  id: string;
  feed: NonNullable<OracleFactsInput['feed']>;
  readings: NonNullable<OracleFactsInput['readings']>;
  mids: NonNullable<OracleFactsInput['mids']>;
};
const fx = JSON.parse(readFileSync('fixtures/risk/oracle/readings.json', 'utf8')) as {
  assets: Block[];
};
const SOL = fx.assets.find((a) => a.id === 'solana:nvdax') as Block;
const EVM = fx.assets.find((a) => a.id === 'robinhood:nvda') as Block;
const regimeParams = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const input = (
  b: Block,
  chain: string,
  over: Partial<OracleFactsInput> = {},
): OracleFactsInput => ({
  feed: b.feed,
  feedReason: null,
  autoRebalanceOpen: null,
  readings: b.readings,
  mids: b.mids,
  limits: vaultPriceLimits(chain),
  regimeParams,
  params: defaultOracleFactsParams(),
  ...over,
});

// --- by hand -----------------------------------------------------------------------------------------------------
const sec = (iso: string) => Date.parse(iso) / 1000;
/** Linear interpolation between the two nearest ranks. */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return frac === 0
    ? (s[lo] as number)
    : (s[lo] as number) * (1 - frac) + (s[lo + 1] as number) * frac;
}
const ageOf = (r: OracleReading) => sec(r.at) - sec(r.sourceTs as string);
/** (mid − oracle) ÷ oracle against the mid nearest in time, or null when none is within `within` seconds. */
function gapOf(r: OracleReading, mids: Block['mids']['rows'], within: number): number | null {
  let best: { d: number; mid: number } | null = null;
  for (const m of mids) {
    const d = Math.abs(sec(m.at) - sec(r.at));
    if (!best || d <= best.d) best = { d, mid: m.midUsd };
  }
  return best && best.d <= within ? (best.mid - r.price) / r.price : null;
}
/** |price ÷ mean of the readings of the 3,600 s up to it − 1|, or null with fewer than `min` of them. */
function distanceOf(r: OracleReading, all: OracleReading[], min: number): number | null {
  const near = all.filter((x) => sec(x.at) <= sec(r.at) && sec(x.at) >= sec(r.at) - 3600);
  if (near.length < min) return null;
  const mean = near.reduce((a, x) => a + x.price, 0) / near.length;
  return Math.abs(r.price / mean - 1);
}
/** Each UTC hour once, by the share of its readings refused; the mean over the hours. */
function hourShare(rows: Array<{ at: string; refused: boolean | null }>) {
  const hours = new Map<string, boolean[]>();
  for (const r of rows) {
    if (r.refused === null) continue;
    const h = r.at.slice(0, 13);
    hours.set(h, [...(hours.get(h) ?? []), r.refused]);
  }
  const shares = [...hours.values()].map((v) => v.filter(Boolean).length / v.length);
  return { hours: shares.length, share: shares.reduce((a, x) => a + x, 0) / shares.length };
}
const value = (f: Fact) => f.value as number;
const reasonOf = (f: Fact) => (f.value === null ? f.reason : `measured ${f.value}`);
const FIGURES = [
  'ageMedian',
  'ageP95',
  'gapMedian',
  'gapAbsP95',
  'gapAbsMax',
  'refusedShare',
  'refusedByAgeShare',
  'refusedByDistanceShare',
] as const;
const regimeOf = (o: ReturnType<typeof buildOracleFacts>, regime: string) =>
  o.byRegime.find((b) => b.regime === regime) as OracleBucketFacts;

// Mon 2026-10-05, New York on summer time: market hours start at 13:30 UTC, the vault's session at 14:30 UTC.
const OPEN = '2026-10-05T13:30:00.000Z';
const SESSION = '2026-10-05T14:30:00.000Z';

describe('the oracle block, on real Scope readings (NVDAx, Solana)', () => {
  const rows = SOL.readings.rows;
  const before = rows.filter((r) => r.at < OPEN);
  const market = rows.filter((r) => r.at >= OPEN);
  const session = rows.filter((r) => r.at >= SESSION);
  const o = buildOracleFacts(input(SOL, 'solana'));

  it('holds readings on both sides of the open and inside the vault session', () => {
    expect(rows.length).toBe(48);
    expect(before.length).toBeGreaterThanOrEqual(8);
    expect(market.length).toBeGreaterThanOrEqual(8);
    expect(session.length).toBeGreaterThanOrEqual(8);
    expect(before.length + market.length).toBe(rows.length);
    expect(rows.every((r) => r.sourceTs !== null)).toBe(true);
  });

  it('names the oracle and says a rebalance may run by itself', () => {
    expect(o.feed).toMatchObject({ kind: 'scope', ref: '332', averageRef: '269' });
    expect(o.feedReason).toBeNull();
    expect(o.autoRebalance).toBe(true);
    expect(o.autoRebalanceReason).toBeNull();
    expect(o.window).toEqual({ from: rows[0]?.at, to: rows.at(-1)?.at });
  });

  it.each([
    ['us_offhours_weekday', () => before, () => regimeOf(o, 'us_offhours_weekday')],
    ['us_market_hours', () => market, () => regimeOf(o, 'us_market_hours')],
    ['the vault session', () => session, () => o.vaultSession],
  ] as const)('age and gap in %s, recomputed by hand', (_name, pick, bucket) => {
    const xs = pick();
    const b = bucket();
    const ages = xs.map(ageOf);
    expect(value(b.ageMedian)).toBeCloseTo(quantile(ages, 0.5), 9);
    expect(value(b.ageP95)).toBeCloseTo(quantile(ages, 0.95), 9);
    expect(b.ageMedian).toMatchObject({ unit: 'seconds', samples: xs.length, quality: 'measured' });
    const gaps = xs.map((r) => gapOf(r, SOL.mids.rows, 300)).filter((g) => g !== null);
    expect(gaps.length).toBeGreaterThanOrEqual(8);
    expect(value(b.gapMedian)).toBeCloseTo(quantile(gaps, 0.5), 12);
    expect(value(b.gapAbsP95)).toBeCloseTo(quantile(gaps.map(Math.abs), 0.95), 12);
    expect(value(b.gapAbsMax)).toBeCloseTo(Math.max(...gaps.map(Math.abs)), 12);
    expect(b.gapMedian).toMatchObject({ unit: 'fraction', samples: gaps.length });
    // the figure is the two prices set side by side: its source names both tables
    expect((b.gapMedian as { source: string }).source).toContain('risk_price_observations');
    expect((b.gapMedian as { source: string }).source).toContain('risk_asset_snapshots');
  });

  it('gives no refusal share on four hours of readings: 8 hours are needed', () => {
    for (const b of [regimeOf(o, 'us_market_hours'), regimeOf(o, 'us_offhours_weekday')])
      for (const k of ['refusedShare', 'refusedByAgeShare', 'refusedByDistanceShare'] as const)
        expect(reasonOf(b[k])).toBe('insufficient_samples');
  });

  it('refusal shares at tighter limits, recomputed by hand hour by hour', () => {
    // limits chosen so that some readings are refused and some are not: 36 s and 20 bps
    const limits = { ...vaultPriceLimits('solana'), maxAgeSeconds: 36, maxDistanceBps: 20 };
    const params = { ...defaultOracleFactsParams(), minSamples: 2 };
    const tight = buildOracleFacts(input(SOL, 'solana', { limits, params }));
    const byAge = market.map((r) => ({ at: r.at, refused: ageOf(r) > 36 }));
    const byDistance = market.map((r) => {
      const d = distanceOf(r, rows, 6);
      return { at: r.at, refused: d === null ? null : d > 0.002 };
    });
    const either = market.map((r, i) => ({
      at: r.at,
      refused: byAge[i]?.refused === true || byDistance[i]?.refused === true,
    }));
    // the limits do bite on these rows, or the test would compare zero with zero
    expect(byAge.some((x) => x.refused) && byAge.some((x) => !x.refused)).toBe(true);
    expect(byDistance.some((x) => x.refused === true)).toBe(true);
    const b = regimeOf(tight, 'us_market_hours');
    for (const [fact, hand] of [
      [b.refusedByAgeShare, hourShare(byAge)],
      [b.refusedByDistanceShare, hourShare(byDistance)],
      [b.refusedShare, hourShare(either)],
    ] as const) {
      expect(value(fact)).toBeCloseTo(hand.share, 12);
      expect((fact as { samples: number }).samples).toBe(hand.hours);
    }
    expect(tight.limits.maxAgeSeconds).toMatchObject({ value: 36, unit: 'seconds' });
    expect(tight.limits.maxDistance).toMatchObject({ value: 0.002, quality: 'assumption' });
  });

  it('states the limits it counts against, and that the distance is a placeholder', () => {
    expect(o.limits.maxAgeSeconds).toMatchObject({ value: 120, quality: 'assumption' });
    expect(o.limits.maxDistance).toMatchObject({ value: 0.02, quality: 'assumption' });
    expect((o.limits.maxDistance as { method: string }).method).toContain('placeholder');
    expect((o.limits.maxAgeSeconds as { source: string }).source).toContain('DESIGN-VAULT');
  });

  it('answers insufficient_samples in a regime with fewer than 8 readings', () => {
    const few = buildOracleFacts(
      input(SOL, 'solana', {
        readings: { ...SOL.readings, rows: [...before, ...market.slice(0, 7)] },
      }),
    );
    const b = regimeOf(few, 'us_market_hours');
    for (const k of FIGURES) expect(reasonOf(b[k])).toBe('insufficient_samples');
    expect((b.ageMedian as { detail: string }).detail).toContain('7 readings');
    // the regime beside it, with its readings, is untouched
    expect(value(regimeOf(few, 'us_offhours_weekday').ageMedian)).toBeCloseTo(
      quantile(before.map(ageOf), 0.5),
      9,
    );
  });

  it('answers no_samples_in_regime where nothing was read', () => {
    for (const regime of ['weekend', 'us_holiday'])
      for (const k of FIGURES)
        expect(reasonOf(regimeOf(o, regime)[k])).toBe('no_samples_in_regime');
  });
});

describe('the oracle block, on real Chainlink readings (NVDA, Robinhood Chain)', () => {
  const rows = EVM.readings.rows;
  const o = buildOracleFacts(input(EVM, 'robinhood'));
  const night = regimeOf(o, 'us_offhours_weekday');

  it('measures the age of a feed that last moved at the close', () => {
    const ages = rows.map(ageOf);
    expect(rows.length).toBe(13);
    expect(value(night.ageMedian)).toBeCloseTo(quantile(ages, 0.5), 9);
    expect(value(night.ageP95)).toBeCloseTo(quantile(ages, 0.95), 9);
    // hours old, not seconds: the feed publishes nothing while the market is closed
    expect(value(night.ageMedian)).toBeGreaterThan(3600);
  });

  it('measures the gap to the pool mid, signed at the median and unsigned at the tail', () => {
    const gaps = rows.map((r) => gapOf(r, EVM.mids.rows, 300)).filter((g) => g !== null);
    expect(value(night.gapMedian)).toBeCloseTo(quantile(gaps, 0.5), 12);
    expect(value(night.gapAbsP95)).toBeCloseTo(quantile(gaps.map(Math.abs), 0.95), 12);
    expect(value(night.gapAbsMax)).toBeCloseTo(Math.max(...gaps.map(Math.abs)), 12);
    expect((night.gapMedian as { samples: number }).samples).toBe(gaps.length);
    expect(value(night.gapAbsMax)).toBeGreaterThanOrEqual(Math.abs(value(night.gapMedian)));
  });

  it('refuses nothing for age at 26 hours, and a hand-counted share at 6 hours', () => {
    const hand26 = hourShare(rows.map((r) => ({ at: r.at, refused: ageOf(r) > 93_600 })));
    expect(o.limits.maxAgeSeconds).toMatchObject({ value: 93_600 });
    expect(value(night.refusedByAgeShare)).toBe(0);
    expect(hand26.share).toBe(0);
    expect((night.refusedByAgeShare as { samples: number }).samples).toBe(hand26.hours);
    const limits = { ...vaultPriceLimits('robinhood'), maxAgeSeconds: 6 * 3600 };
    const tight = regimeOf(
      buildOracleFacts(input(EVM, 'robinhood', { limits })),
      'us_offhours_weekday',
    );
    const hand6 = hourShare(rows.map((r) => ({ at: r.at, refused: ageOf(r) > 6 * 3600 })));
    expect(hand6.share).toBeGreaterThan(0);
    expect(hand6.share).toBeLessThan(1);
    expect(value(tight.refusedByAgeShare)).toBeCloseTo(hand6.share, 12);
    expect(value(tight.refusedShare)).toBeCloseTo(hand6.share, 12);
  });

  it('says the distance from the average is not collected: one reading an hour rebuilds none', () => {
    expect(rows.every((r) => distanceOf(r, rows, 6) === null)).toBe(true);
    expect(reasonOf(night.refusedByDistanceShare)).toBe('not_collected');
    expect((night.refusedShare as { method: string }).method).toContain('not checked here');
  });

  it('has nothing in the vault session yet: the fixture is one night', () => {
    for (const k of FIGURES) expect(reasonOf(o.vaultSession[k])).toBe('no_samples_in_regime');
    expect(o.vaultSession.session).toContain('14:30 to 20:00 UTC');
  });
});

describe('the oracle block, without an oracle or without rows', () => {
  it('a stock with no oracle: autoRebalance false, no_oracle, every figure null', () => {
    const o = buildOracleFacts(
      input(SOL, 'solana', {
        feed: null,
        feedReason: 'no_scope_entry',
        readings: null,
        mids: null,
      }),
    );
    expect(o.feed).toBeNull();
    expect(o.feedReason).toBe('no_scope_entry');
    expect(o.autoRebalance).toBe(false);
    expect(o.autoRebalanceReason).toBe('no_oracle');
    expect(o.window).toBeNull();
    expect(o.byRegime.map((b) => b.regime)).toEqual([
      'us_market_hours',
      'us_offhours_weekday',
      'weekend',
      'us_holiday',
    ]);
    for (const b of [...o.byRegime, o.vaultSession])
      for (const k of FIGURES) expect(b[k]).toMatchObject({ value: null, reason: 'no_oracle' });
    // readings handed over by mistake change nothing: there is no oracle to read them as
    const again = buildOracleFacts(input(SOL, 'solana', { feed: null, feedReason: 'no_feed' }));
    expect(again.byRegime).toEqual(o.byRegime);
  });

  it('an oracle no reading of which is stored: not_collected, and still autoRebalance by the rule', () => {
    const o = buildOracleFacts(input(SOL, 'solana', { readings: null }));
    expect(o.autoRebalance).toBe(true);
    for (const b of [...o.byRegime, o.vaultSession])
      for (const k of FIGURES) expect(reasonOf(b[k])).toBe('not_collected');
  });

  it('readings with no pool mid beside them: ages measured, gaps not_collected', () => {
    const b = regimeOf(buildOracleFacts(input(SOL, 'solana', { mids: null })), 'us_market_hours');
    expect(b.ageMedian.value).not.toBeNull();
    expect(reasonOf(b.gapMedian)).toBe('not_collected');
    // and a mid too far in time is no pair
    const far = regimeOf(
      buildOracleFacts(
        input(SOL, 'solana', { params: { ...defaultOracleFactsParams(), pairWithinSec: 1 } }),
      ),
      'us_market_hours',
    );
    expect(reasonOf(far.gapMedian)).toBe('insufficient_samples');
  });

  it('carries the open question of the asset list through, undecided', () => {
    const o = buildOracleFacts(
      input(EVM, 'robinhood', { autoRebalanceOpen: 'oracle_prices_from_pools' }),
    );
    expect(o.autoRebalance).toBe(true);
    expect(o.autoRebalanceOpen).toBe('oracle_prices_from_pools');
  });

  it('readings without the oracle timestamp: no age, no refusal by age', () => {
    const rows = SOL.readings.rows.map((r) => ({ ...r, sourceTs: null }));
    const b = regimeOf(
      buildOracleFacts(input(SOL, 'solana', { readings: { ...SOL.readings, rows } })),
      'us_market_hours',
    );
    expect(reasonOf(b.ageMedian)).toBe('insufficient_samples');
    expect(b.gapMedian.value).not.toBeNull();
  });
});

describe('the pieces', () => {
  it('counts each hour once, by the share of its readings refused', () => {
    const t = (iso: string) => sec(iso);
    const s = refusedShareByHour([
      { t: t('2026-10-05T14:05:00Z'), refused: true },
      { t: t('2026-10-05T14:35:00Z'), refused: false },
      { t: t('2026-10-05T14:55:00Z'), refused: false },
      { t: t('2026-10-05T14:58:00Z'), refused: false },
      { t: t('2026-10-05T15:10:00Z'), refused: true },
      { t: t('2026-10-05T16:10:00Z'), refused: null },
    ]);
    // hour 14: 1 of 4; hour 15: 1 of 1; hour 16 has nothing to check
    expect(s).toMatchObject({ hours: 2, share: (0.25 + 1) / 2 });
    expect(refusedShareByHour([{ t: 0, refused: null }])).toBeNull();
  });

  it("knows the vault's session: weekdays 14:30 to 20:00 UTC, closed days and half days out", () => {
    const s = vaultPriceLimits('solana').session;
    const at = (iso: string) => inVaultSession(sec(iso), s);
    expect(at('2026-10-05T14:29:59Z')).toBe(false);
    expect(at('2026-10-05T14:30:00Z')).toBe(true);
    expect(at('2026-10-05T19:59:59Z')).toBe(true);
    expect(at('2026-10-05T20:00:00Z')).toBe(false);
    expect(at('2026-10-10T15:00:00Z')).toBe(false); // a Saturday
    expect(at('2026-11-26T15:00:00Z')).toBe(false); // Thanksgiving
    expect(at('2026-11-27T15:00:00Z')).toBe(false); // the half day after it, counted closed
    expect(at('2026-11-25T15:00:00Z')).toBe(true);
  });
});

describe('the sheet', () => {
  const base: AssetFactsInput = {
    assetId: 'solana:nvdax',
    symbol: 'NVDAx',
    chain: 'solana',
    mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
    sizeUsd: 10_000,
    tau: 0.01,
    asOf: '2026-10-05T16:00:00.000Z',
    sell: null,
    buy: null,
    curveMeta: {
      source: 'fixture',
      method: 'fixture',
      methodVersion: 'risk-0.3',
      provenance: 'fixture',
    },
    platformFeeBps: 0,
    lp: null,
    lpWithdrawals: null,
    capacitySeries: null,
    lendingCollateral: null,
    tracking: [],
    issuer: null,
    gapGridPct: [5, 10],
  };

  it('carries the block when the asset is on a list, and parses with every fact well formed', () => {
    const sheet = buildAssetFacts({ ...base, oracle: input(SOL, 'solana') });
    expect(AssetFacts.parse(sheet).oracle?.feed?.kind).toBe('scope');
    const { facts, invalid } = collectFacts(sheet.oracle);
    expect(invalid).toEqual([]);
    // 8 figures in each of 4 regimes and the vault session, and the 2 limits
    expect(facts.length).toBe(8 * 5 + 2);
  });

  it('has no oracle key at all without the input: an older sheet is unchanged', () => {
    const without = buildAssetFacts(base);
    expect('oracle' in without).toBe(false);
    const withIt = buildAssetFacts({ ...base, oracle: input(SOL, 'solana') });
    const { oracle: _oracle, ...rest } = withIt;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(without));
  });
});
