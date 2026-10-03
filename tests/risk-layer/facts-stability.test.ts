import { readFileSync } from 'node:fs';
import {
  type AssetFactsInput,
  buildAssetFacts,
  depthRecovery,
  type LargeTrade,
  quantileOf,
  seriesVariation,
} from '@colosseum/risk';
import { AssetFacts, collectFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 15: depth recovery after large trades (Step 5b history replay, frozen TSLAx trades of the
// 2026-10-02 16:18 report in fixtures/risk/history/recovery-tslax.json) and capacity variation by regime.
const fx = JSON.parse(readFileSync('fixtures/risk/history/recovery-tslax.json', 'utf8')) as {
  largeShare: number;
  method: string;
  trades: LargeTrade[];
  table: Array<{
    regime: string;
    trades: number;
    medRecover50Min: number | null;
    medRecover90Min: number | null;
    unrecovered90Share: number;
  }>;
};
const lowerMedian = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor((a.length - 1) / 2)];

describe('depth recovery', () => {
  const rows = depthRecovery(fx.trades);

  it("agrees with Step 5b's own table on the trades, its median convention and the rounded share", () => {
    expect(rows.map((r) => r.regime).sort()).toEqual(fx.table.map((t) => t.regime).sort());
    for (const t of fx.table) {
      const r = rows.find((x) => x.regime === t.regime);
      const own = fx.trades.filter((x) => x.regime === t.regime);
      expect(r?.trades).toBe(t.trades);
      const r90 = own.map((x) => x.recover90Min).filter((x): x is number => x !== null);
      expect(lowerMedian(r90)).toBe(t.medRecover90Min);
      expect(r?.minutesTo90).toBe(quantileOf(r90, 0.5));
      expect(Math.abs((r?.notRecovered24h as number) - t.unrecovered90Share)).toBeLessThanOrEqual(
        0.005,
      );
      expect(r?.recovered).toBe(r90.length);
    }
  });

  it('a group where nothing came back has no median, and all of it not recovered', () => {
    const [r] = depthRecovery([
      {
        asset: 'X',
        regime: 'weekend',
        at: '2026-09-05T12:00:00.000Z',
        recover50Min: null,
        recover90Min: null,
      },
    ]);
    expect(r).toMatchObject({
      minutesTo50: null,
      minutesTo90: null,
      notRecovered24h: 1,
      recovered: 0,
    });
  });
});

describe('the sheet', () => {
  const meta = {
    source: 'fixture',
    method: 'fixture',
    methodVersion: 'risk-0.3',
    provenance: 'fixture' as const,
  };
  const sheet = (over: Partial<AssetFactsInput>) =>
    buildAssetFacts({
      assetId: 'tslax',
      symbol: 'TSLAx',
      chain: 'solana',
      mint: null,
      sizeUsd: 10_000,
      tau: 0.01,
      asOf: '2026-10-03T00:00:00.000Z',
      sell: null,
      buy: null,
      curveMeta: meta,
      platformFeeBps: 0,
      lp: null,
      lpWithdrawals: null,
      capacitySeries: null,
      lendingCollateral: null,
      tracking: [],
      issuer: null,
      gapGridPct: [20],
      ...over,
    });

  it('gives hours to recover by regime from the rows, and names what is thin or missing', () => {
    const rows = depthRecovery(fx.trades);
    const s = sheet({
      depthRecovery: {
        ...meta,
        rows,
        largeShare: fx.largeShare,
        fetchedAt: '2026-10-03T00:00:00.000Z',
      },
    });
    expect(AssetFacts.safeParse(s).success).toBe(true);
    expect(collectFacts(s).invalid).toEqual([]);
    const d = s.liquidityStability.depthRecovery ?? [];
    const mh = rows.find((r) => r.regime === 'us_market_hours');
    const got = d.find((r) => r.regime === 'us_market_hours');
    expect(got?.hoursTo90).toMatchObject({
      value: (mh?.minutesTo90 as number) / 60,
      quality: 'measured',
      samples: mh?.recovered,
    });
    expect(got?.largeTrades.value).toBe(mh?.trades);
    // TSLAx had 4 large trades on holidays: fewer than 8, so not measured
    const hol = d.find((r) => r.regime === 'us_holiday');
    expect(hol?.hoursTo90).toMatchObject({ value: null, reason: 'insufficient_samples' });
    expect(hol?.notRecovered24h).toMatchObject({ value: null, reason: 'insufficient_samples' });
    // no rows imported at all: not collected, never zero
    const none = sheet({}).liquidityStability.depthRecovery ?? [];
    expect(none.every((r) => r.hoursTo90.value === null && r.largeTrades.value === null)).toBe(
      true,
    );
    expect(none[0]?.largeTrades).toMatchObject({ reason: 'not_collected' });
    expect(s.liquidityStability.lpOwnerTop1Share).toMatchObject({
      value: null,
      reason: 'not_collected',
    });
  });

  it('gives the capacity variation of each regime with enough snapshots', () => {
    const xs = [9_000, 11_000, 9_000, 11_000, 9_000, 11_000, 9_000, 11_000];
    const s = sheet({
      capacitySeries: {
        ...meta,
        byRegime: { us_offhours_weekday: xs, us_market_hours: [50_000, 50_000] },
        to: '2026-10-02T12:00:00.000Z',
        minSamples: 8,
      },
    });
    const v = s.liquidityStability.capacityVariationByRegime ?? [];
    expect(v.find((r) => r.regime === 'us_offhours_weekday')?.value).toMatchObject({
      value: seriesVariation(xs, 8),
      samples: 8,
    });
    expect(seriesVariation(xs, 8)).toBeCloseTo(0.1, 12);
    expect(v.find((r) => r.regime === 'us_market_hours')?.value).toMatchObject({
      value: null,
      reason: 'insufficient_samples',
    });
    expect(v.find((r) => r.regime === 'weekend')?.value).toMatchObject({
      value: null,
      reason: 'no_samples_in_regime',
    });
  });
});
