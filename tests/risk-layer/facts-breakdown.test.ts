import { readFileSync } from 'node:fs';
import {
  type AssetCurves,
  attachSplit,
  buildAssetFacts,
  carrySplit,
  createLiquidityProvider,
  type DepthCurve,
  defaultFactsParams,
  defaultRegimeParams,
  fitCostBreakdown,
  type NetworkFeeRow,
  networkFeePerSwap,
  quantileOf,
  REGIMES,
  type Regime,
  regimeAt,
  type SplitRow,
  splitAt,
  splitKey,
} from '@colosseum/risk';
import { AssetFacts, collectFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 4: the cost split fitted from the split snapshots and stored as optional keys on the curve
// points. On frozen mainnet rows (SPYx, TSLAx curves of risk-0.3; two split snapshots of 2026-10-02; our own swaps'
// network fees): the provider answers the same with and without the keys, and the sheet's four parts sum to the
// curve's cost.
const fx = JSON.parse(readFileSync('fixtures/risk/split/breakdown.json', 'utf8')) as {
  curves: Array<{
    assetMint: string;
    assetSymbol: string;
    side: 'sell' | 'buy';
    regime: Regime;
    curve: DepthCurve;
  }>;
  splitRows: Array<SplitRow & { asset: string }>;
  networkFees: NetworkFeeRow[];
};
const P = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const regimeOf = (at: Date) => regimeAt(at, P);
const fit = fitCostBreakdown(fx.splitRows, regimeOf);
const SPY = fx.curves.find((c) => c.assetSymbol === 'SPYx')?.assetMint as string;

const curvesOf = (symbol: string, side: 'sell' | 'buy', withSplit: boolean): AssetCurves => {
  const byRegime: AssetCurves['byRegime'] = {};
  for (const c of fx.curves.filter((c) => c.assetSymbol === symbol && c.side === side))
    byRegime[c.regime] = {
      ...c.curve,
      points: withSplit
        ? attachSplit(c.curve.points, fit.get(splitKey(c.assetMint, side, c.regime)))
        : c.curve.points,
    };
  return { assetId: symbol.toLowerCase(), byRegime };
};

describe('fitting the split', () => {
  it('takes the median of each part per asset, side, regime and size, with its samples', () => {
    const runs = new Set(fx.splitRows.map((r) => r.fetchedAt));
    expect(runs.size).toBe(2);
    const regime = regimeOf(new Date([...runs][0] as string));
    const bySize = fit.get(splitKey(SPY, 'sell', regime));
    expect(bySize?.size).toBe(8);
    const rows = fx.splitRows.filter(
      (r) => r.asset === 'SPYx' && r.side === 'sell' && r.notionalUsd === 10_000,
    );
    const s = bySize?.get(10_000);
    expect(s?.splitSamples).toBe(2);
    expect(s?.poolFee).toBeCloseTo(
      quantileOf(
        rows.map((r) => r.split.poolFee),
        0.5,
      ),
      15,
    );
    expect(s?.basis).toBeCloseTo(
      quantileOf(
        rows.map((r) => r.split.basis),
        0.5,
      ),
      15,
    );
    expect((s?.splitFrom as string) < (s?.splitTo as string)).toBe(true);
  });

  it('leaves every provider answer unchanged (cost, capacity, per regime, both sides)', () => {
    const provider = (withSplit: boolean) =>
      createLiquidityProvider({
        curves: new Map(
          ['SPYx', 'TSLAx'].map((s) => [s.toLowerCase(), curvesOf(s, 'sell', withSplit)]),
        ),
        buyCurves: new Map(
          ['SPYx', 'TSLAx'].map((s) => [s.toLowerCase(), curvesOf(s, 'buy', withSplit)]),
        ),
        regimeParams: P,
        methodVersion: 'risk-0.3',
        provenance: 'fixture',
      });
    const before = provider(false);
    const after = provider(true);
    let compared = 0;
    for (const id of ['spyx', 'tslax']) {
      expect(after.regimes(id)).toEqual(before.regimes(id));
      for (const tau of [0.001, 0.01, 0.05]) {
        expect(after.exitCapacity(id, tau, 30)).toEqual(before.exitCapacity(id, tau, 30));
        for (const r of REGIMES)
          expect(after.exitCapacityIn(id, tau, r)).toEqual(before.exitCapacityIn(id, tau, r));
      }
      for (const n of [100, 3_000, 10_000, 250_000, 1_000_000, 9_000_000]) {
        expect(after.exitCost(id, n, 30)).toEqual(before.exitCost(id, n, 30));
        for (const r of REGIMES) {
          expect(after.exitCostIn(id, n, r)).toEqual(before.exitCostIn(id, n, r));
          expect(after.entryCostIn(id, n, r)).toEqual(before.entryCostIn(id, n, r));
          compared++;
        }
      }
    }
    expect(compared).toBe(48);
  });

  it('attach replaces earlier keys and keeps cost and samples; a refit carries them by size', () => {
    const c = fx.curves.find(
      (c) => c.assetSymbol === 'SPYx' && c.side === 'sell',
    ) as (typeof fx.curves)[number];
    const once = attachSplit(c.curve.points, fit.get(splitKey(c.assetMint, 'sell', c.regime)));
    const twice = attachSplit(once, fit.get(splitKey(c.assetMint, 'sell', c.regime)));
    expect(twice).toEqual(once);
    expect(once.map(({ notionalUsd, cost, samples }) => ({ notionalUsd, cost, samples }))).toEqual(
      c.curve.points.map(({ notionalUsd, cost, samples }) => ({ notionalUsd, cost, samples })),
    );
    expect(attachSplit(once, undefined)).toEqual(c.curve.points);
    // a refit: new costs, one grid size dropped and one added; the keys follow the size, never the index
    const refit = [
      ...c.curve.points.slice(1).map((p) => ({ ...p, cost: p.cost + 0.001 })),
      { notionalUsd: 20_000_000, cost: 0.9, samples: 9 },
    ];
    const carried = carrySplit(once, refit);
    for (const p of carried) {
      const o = once.find((q) => q.notionalUsd === p.notionalUsd);
      expect(p.poolFee).toBe(o?.poolFee);
      expect(p.cost).toBe(refit.find((q) => q.notionalUsd === p.notionalUsd)?.cost);
    }
    expect(carried.at(-1)?.splitSamples).toBeUndefined();
    expect(carrySplit(null, refit)).toEqual(refit);
  });
});

describe('the split at a size', () => {
  const c = curvesOf('TSLAx', 'sell', true);
  const r = Object.keys(c.byRegime).find(
    (k) => c.byRegime[k as Regime]?.points[0]?.splitSamples,
  ) as Regime;
  const curve = c.byRegime[r] as DepthCurve;

  it('is interpolated in ln(notional) between grid points and exact on them', () => {
    const at = splitAt(curve, 10_000, 2);
    const p = curve.points.find((p) => p.notionalUsd === 10_000);
    expect('poolFee' in at && at.poolFee).toBe(p?.poolFee);
    const mid = splitAt(curve, Math.sqrt(10_000 * 50_000), 2);
    const q = curve.points.find((p) => p.notionalUsd === 50_000);
    expect('basis' in mid && mid.basis).toBeCloseTo(
      ((p?.basis as number) + (q?.basis as number)) / 2,
      15,
    );
  });

  it('names what is missing: too few snapshots, no keys, beyond the grid', () => {
    expect(splitAt(curve, 10_000, 8)).toEqual({ reason: 'insufficient_samples' });
    expect(splitAt(curvesOf('TSLAx', 'sell', false).byRegime[r] as DepthCurve, 10_000, 2)).toEqual({
      reason: 'not_collected',
    });
    expect(splitAt(curve, 1e9, 2)).toEqual({ reason: 'beyond_measured_size' });
  });
});

describe('network fee per swap', () => {
  it('is the median of our swaps priced in USD, and not measured below the minimum', () => {
    const m = networkFeePerSwap(fx.networkFees, 8);
    expect('usd' in m && m.samples).toBe(fx.networkFees.length);
    const usd = fx.networkFees.map((r) => (r.feeLamports / 1e9) * r.solUsd);
    expect('usd' in m && m.usd).toBeCloseTo(quantileOf(usd, 0.5), 15);
    expect(networkFeePerSwap(fx.networkFees.slice(0, 7), 8)).toEqual({
      reason: 'insufficient_samples',
      samples: 7,
    });
  });
});

describe('the sheet with the split', () => {
  const meta = {
    source: 'fixture rows',
    method: 'fixture',
    methodVersion: 'risk-0.3',
    provenance: 'fixture' as const,
  };
  const fee = networkFeePerSwap(fx.networkFees, 8);
  const sheet = (over: { splitMinSamples?: number; fee?: boolean } = {}) =>
    buildAssetFacts({
      assetId: 'tslax',
      symbol: 'TSLAx',
      chain: 'solana',
      mint: null,
      sizeUsd: 250_000,
      tau: 0.01,
      asOf: '2026-10-03T00:00:00.000Z',
      sell: curvesOf('TSLAx', 'sell', true),
      buy: curvesOf('TSLAx', 'buy', true),
      curveMeta: meta,
      platformFeeBps: defaultFactsParams().platformFeeBps,
      lp: null,
      lpWithdrawals: null,
      capacitySeries: null,
      lendingCollateral: null,
      tracking: [],
      issuer: null,
      gapGridPct: [20],
      splitMeta: { ...meta, methodVersion: 'split-0.1' },
      splitMinSamples: over.splitMinSamples ?? 2,
      networkFee:
        over.fee === false || !('usd' in fee)
          ? { reason: 'insufficient_samples' }
          : { ...meta, usd: fee.usd, fetchedAt: fee.to, dataFrom: fee.from, samples: fee.samples },
    });

  it('splits the curve cost into four parts that sum to it exactly, with a measured loss', () => {
    const s = sheet();
    expect(AssetFacts.safeParse(s).success).toBe(true);
    expect(collectFacts(s).invalid).toEqual([]);
    const split = s.costs.flatMap((c) => [c.exit, c.entry]).filter((b) => b.poolFee.value !== null);
    expect(split.length).toBeGreaterThan(0);
    for (const b of split) {
      const parts =
        (b.poolFee.value as number) +
        (b.transferFee.value as number) +
        (b.impact.value as number) +
        (b.basis.value as number);
      expect(Math.abs(parts - (b.total.value as number))).toBeLessThan(1e-15);
      expect(b.poolFee.value as number).toBeGreaterThan(0);
      expect(b.networkFeeUsd.value).toBeGreaterThan(0);
      expect(b.lossUsd).toMatchObject({ quality: 'measured' });
      expect(b.lossUsd.value).toBeCloseTo(
        250_000 * (b.total.value as number) + (b.networkFeeUsd.value as number),
        9,
      );
    }
  });

  it('keeps each missing part null with its reason, never zero', () => {
    const s = sheet({ splitMinSamples: 8, fee: false });
    for (const c of s.costs)
      for (const b of [c.exit, c.entry]) {
        for (const k of ['poolFee', 'transferFee', 'impact', 'basis', 'networkFeeUsd'] as const)
          expect(b[k].value).toBeNull();
        if (b.total.value !== null) {
          // snapshots exist in this regime but fewer than 8; none at all is `not_collected`
          const sampled = curvesOf('TSLAx', 'sell', true).byRegime[c.regime]?.points.some(
            (p) => p.splitSamples,
          );
          if (b === c.exit)
            expect(b.poolFee).toMatchObject({
              reason: sampled ? 'insufficient_samples' : 'not_collected',
            });
          expect(b.lossUsd).toMatchObject({ quality: 'lower_bound' });
        }
      }
  });
});
