import { readFileSync } from 'node:fs';
import {
  type AssetFactsInput,
  addSwap,
  buildAssetFacts,
  defaultFactsParams,
  type FlowAggregate,
  type FlowBucket,
  type FlowHour,
  type FlowInput,
  flowFacts,
  flowWindow,
  type PoolEvent,
  poolFlow,
  quantileOf,
  type Regime,
  swapsOfRow,
} from '@colosseum/risk';
import { AssetFacts, collectFacts } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 16, part 1: volume, net sell pressure and turnover from the decoded swap history. Real rows:
// TSLAx's USDC pool (HHQUnU…) on 2026-09-04 and 05, frozen by `pnpm risk:freeze-flow-fixture` (no signature, no
// wallet). The expected numbers are summed here by hand, over the raw tuples, without the package's functions.
const fx = JSON.parse(readFileSync('fixtures/risk/history/flow-tslax.json', 'utf8')) as {
  pool: string;
  assetIsToken0: boolean;
  decimals0: number;
  decimals1: number;
  source: string;
  swaps: Array<[number, string, string, boolean]>;
  hourly: Array<[string, Regime, number | null, number | null]>;
};
const meta = {
  pool: fx.pool,
  assetIsToken0: fx.assetIsToken0,
  decimals0: fx.decimals0,
  decimals1: fx.decimals1,
};
const hours: FlowHour[] = fx.hourly.map(([hour, regime, quoteUsd, depth2pctSellUsd]) => ({
  hour,
  regime,
  quoteUsd,
  depth2pctSellUsd,
}));
const hourMap = new Map(hours.map((h) => [h.hour, h]));
// regimes of hours without a row: the fixture's only such hour is 2026-09-04 00:00Z, a weekday night
const regimeAt = (): Regime => 'us_offhours_weekday';
const rowOf = ([t, amount0, amount1, zeroForOne]: (typeof fx.swaps)[number]) => ({
  t,
  ev: [{ kind: 'swap', pool: fx.pool, ixIndex: 0, amount0, amount1, zeroForOne }] as PoolEvent[],
});
const buckets = new Map<string, FlowBucket>();
for (const r of fx.swaps)
  for (const s of swapsOfRow(rowOf(r), meta)) addSwap(buckets, s, hourMap, regimeAt);
const to = new Date((fx.swaps.at(-1) as (typeof fx.swaps)[number])[0] * 1000).toISOString();
const aggs = poolFlow(buckets.values(), hours, to);
const ROWMETA = {
  source: 'risk_pool_flow (fixture)',
  method: 'fixture',
  methodVersion: 'flow-0.1',
  provenance: 'fixture' as const,
};
const input = (pools: FlowInput['pools']): FlowInput => ({ ...ROWMETA, pools });

/** By hand: the USDC leg of every swap (token 1, 6 decimals) at the hour's quoteUsd, in a window and regime. */
function byHand(from: string, regime?: Regime) {
  let sell = 0;
  let buy = 0;
  let n = 0;
  let unpriced = 0;
  for (const [t, , a1, z] of fx.swaps) {
    const hour = new Date(Math.floor(t / 3600) * 3_600_000).toISOString();
    if (hour < from) continue;
    const h = hourMap.get(hour);
    if (regime && (h?.regime ?? 'us_offhours_weekday') !== regime) continue;
    n++;
    if (!h || h.quoteUsd === null) {
      unpriced++;
      continue;
    }
    // TSLAx is token 0: zeroForOne sends it into the pool, a sale
    if (z) sell += (Number(a1) / 1e6) * h.quoteUsd;
    else buy += (Number(a1) / 1e6) * h.quoteUsd;
  }
  const hs = hours.filter(
    (h) => h.hour >= from && h.hour <= to && (!regime || h.regime === regime),
  );
  return {
    sell,
    buy,
    n,
    unpriced,
    hours: hs.length,
    depth: hs.map((h) => h.depth2pctSellUsd as number),
  };
}

describe('flow from the swap history', () => {
  it('sums sells and buys in USD from the quote leg, and counts the unpriced swaps', () => {
    const w = flowWindow(to, '28d');
    const all = aggs.find((a) => a.regime === 'all' && a.window === '28d') as FlowAggregate;
    const h = byHand(w.from);
    expect(all.swaps).toBe(fx.swaps.length);
    expect(all.swaps).toBe(h.n);
    expect(all.sellUsd).toBeCloseTo(h.sell, 6);
    expect(all.buyUsd).toBeCloseTo(h.buy, 6);
    expect(all.sellSwaps + all.buySwaps).toBe(all.swaps);
    // the hour 2026-09-04 00:00Z has no hourly row: its swaps are counted, not priced
    expect(h.unpriced).toBeGreaterThan(0);
    expect(all.unpricedSwaps).toBe(h.unpriced);
    // the last hourly row (23:00Z) starts after the newest swap: outside the window
    expect(all.hours).toBe(hours.length - 1);
    expect(all.hours).toBe(h.hours);
    expect(all.medianDepthSellUsd).toBe(quantileOf(h.depth, 0.5));
    // the regimes add up to the whole
    const parts = aggs.filter((a) => a.window === '28d' && a.regime !== 'all');
    expect(parts.reduce((s, a) => s + a.swaps, 0)).toBe(all.swaps);
    expect(parts.reduce((s, a) => s + a.sellUsd + a.buyUsd, 0)).toBeCloseTo(
      all.sellUsd + all.buyUsd,
      6,
    );
  });

  it('the 24-hour window is the last 24 hours of the history, to its newest event', () => {
    const w = flowWindow(to, '24h');
    expect(Date.parse(to) - Date.parse(w.from)).toBeLessThan(24 * 3_600_000);
    expect(Date.parse(to) - Date.parse(w.from)).toBeGreaterThanOrEqual(23 * 3_600_000);
    const a = aggs.find((x) => x.regime === 'all' && x.window === '24h') as FlowAggregate;
    const h = byHand(w.from);
    expect(a.swaps).toBe(h.n);
    expect(a.sellUsd + a.buyUsd).toBeCloseTo(h.sell + h.buy, 6);
    expect(a.hours).toBe(24);
  });

  it('the sheet: volume, net sell pressure and turnover by regime, with their source and window', () => {
    const block = flowFacts(
      input([{ pool: fx.pool, venue: 'raydium_clmm', quote: 'USDC', rows: aggs }]),
      8,
    );
    const w = flowWindow(to, '28d');
    expect(block.window).toEqual(w);
    for (const regime of ['us_market_hours', 'us_offhours_weekday', 'weekend'] as const) {
      const h = byHand(w.from, regime);
      const r = block.byRegime.find((x) => x.regime === regime);
      const vol = h.sell + h.buy;
      expect(r?.swaps).toMatchObject({ value: h.n, quality: 'lower_bound', regime, fetchedAt: to });
      expect(r?.unpricedSwaps.value).toBe(h.unpriced);
      expect(r?.volumeUsd).toMatchObject({
        quality: 'lower_bound',
        dataFrom: w.from,
        fetchedAt: to,
      });
      expect(r?.volumeUsd.value).toBeCloseTo(vol, 6);
      expect(r?.sellUsd.value).toBeCloseTo(h.sell, 6);
      expect(r?.netSellPressure.value).toBeCloseTo((h.sell - h.buy) / vol, 12);
      expect(r?.turnoverPerHour.value).toBeCloseTo(vol / h.hours / quantileOf(h.depth, 0.5), 12);
      expect(r?.netSellPressure).toMatchObject({ unit: 'ratio', samples: h.n - h.unpriced });
    }
    // Sep 4 and 5 hold no US holiday: the regime has no hourly row
    expect(block.byRegime.find((x) => x.regime === 'us_holiday')?.volumeUsd).toMatchObject({
      value: null,
      reason: 'no_samples_in_regime',
    });
    // where the token sits is part 2
    expect(block.holders.top10Share).toMatchObject({ value: null, reason: 'not_collected' });
  });

  it('net sell pressure has the sign of the flow: a SOL pool priced at the hour, by hand', () => {
    // SPYx is token 0 (8 decimals), SOL token 1 (9 decimals); SOL at 100 USD in that hour
    const m = { pool: 'P', assetIsToken0: true, decimals0: 8, decimals1: 9 };
    const hour = '2026-09-10T15:00:00.000Z';
    const t = Date.parse(hour) / 1000 + 60;
    const hm = new Map<string, FlowHour>([
      [hour, { hour, regime: 'us_market_hours', quoteUsd: 100, depth2pctSellUsd: 4_000 }],
    ]);
    const b = new Map<string, FlowBucket>();
    // 9 sales of 2 SOL each and 1 purchase of 3 SOL: 1,800 USD sold, 300 bought
    for (let i = 0; i < 9; i++)
      for (const s of swapsOfRow(
        {
          t,
          ev: [
            {
              kind: 'swap',
              pool: 'P',
              ixIndex: 0,
              amount0: '1',
              amount1: '2000000000',
              zeroForOne: true,
            },
          ],
        },
        m,
      ))
        addSwap(b, s, hm, regimeAt);
    for (const s of swapsOfRow(
      {
        t,
        ev: [
          {
            kind: 'swap',
            pool: 'P',
            ixIndex: 0,
            amount0: '1',
            amount1: '3000000000',
            zeroForOne: false,
          },
        ],
      },
      m,
    ))
      addSwap(b, s, hm, regimeAt);
    const rows = poolFlow(b.values(), hm.values(), new Date(t * 1000).toISOString());
    const block = flowFacts(input([{ pool: 'P', venue: 'raydium_clmm', quote: 'SOL', rows }]), 8);
    const r = block.byRegime.find((x) => x.regime === 'us_market_hours');
    expect(r?.sellUsd.value).toBeCloseTo(1_800, 9);
    expect(r?.buyUsd.value).toBeCloseTo(300, 9);
    expect(r?.netSellPressure.value).toBeCloseTo(1_500 / 2_100, 12);
    // 2,100 USD in one hourly row against a median ±2% sell depth of 4,000 USD
    expect(r?.turnoverPerHour.value).toBeCloseTo(2_100 / 4_000, 12);
    // one swap fewer than the minimum: not measured, never zero
    const thin = flowFacts(input([{ pool: 'P', venue: 'raydium_clmm', quote: 'SOL', rows }]), 11);
    const tr = thin.byRegime.find((x) => x.regime === 'us_market_hours');
    expect(tr?.volumeUsd).toMatchObject({ value: null, reason: 'insufficient_samples' });
    expect(tr?.netSellPressure).toMatchObject({ value: null, reason: 'insufficient_samples' });
    expect(tr?.swaps.value).toBe(10);
  });

  it('a pool with no hourly rows counts its swaps and prices none of them', () => {
    const b = new Map<string, FlowBucket>();
    for (const r of fx.swaps)
      for (const s of swapsOfRow(rowOf(r), meta)) addSwap(b, s, new Map(), regimeAt);
    const rows = poolFlow(b.values(), [], to);
    const block = flowFacts(
      input([{ pool: fx.pool, venue: 'raydium_clmm', quote: 'USDC', rows }]),
      8,
    );
    const all = block.byWindow.find((x) => x.window === '28d');
    expect(all?.swaps.value).toBe(fx.swaps.length);
    expect(all?.unpricedSwaps.value).toBe(fx.swaps.length);
    expect(all?.volumeUsd).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
    expect(all?.turnoverPerHour).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
    expect(block.byPool[0]?.share).toMatchObject({ value: null, reason: 'no_samples_in_regime' });
  });

  it("the asset's figures are the sum of its pools, and each pool's share of them", () => {
    // the same pool counted as two pools of one asset, the second without prices
    const b = new Map<string, FlowBucket>();
    for (const r of fx.swaps.slice(0, 100))
      for (const s of swapsOfRow(rowOf(r), meta)) addSwap(b, s, new Map(), regimeAt);
    const unpriced = poolFlow(b.values(), [], to);
    const block = flowFacts(
      input([
        { pool: 'A', venue: 'raydium_clmm', quote: 'USDC', rows: aggs },
        { pool: 'B', venue: 'orca_whirlpool', quote: 'USDC', rows: unpriced },
      ]),
      8,
    );
    const pick = (rows: FlowAggregate[]) =>
      rows.find((x) => x.regime === 'all' && x.window === '28d') as FlowAggregate;
    const a = pick(aggs);
    const t = block.byWindow.find((x) => x.window === '28d');
    expect(t?.swaps.value).toBe(a.swaps + 100);
    expect(t?.unpricedSwaps.value).toBe(a.unpricedSwaps + 100);
    expect(t?.volumeUsd.value).toBeCloseTo(a.sellUsd + a.buyUsd, 6);
    expect(block.byPool[0]?.volume28dUsd.value).toBeCloseTo(a.sellUsd + a.buyUsd, 6);
    expect(block.byPool[0]?.share.value).toBe(1);
    expect(block.byPool[1]?.volume28dUsd).toMatchObject({
      value: null,
      reason: 'no_samples_in_regime',
    });
    const byRegimeSum = block.byRegime.reduce((s, r) => s + (r.volumeUsd.value ?? 0), 0);
    expect(byRegimeSum).toBeCloseTo(t?.volumeUsd.value as number, 6);
  });

  it('an asset outside the value pools is not collected, and no fact is a zero standing in for missing data', () => {
    const base: AssetFactsInput = {
      assetId: 'x',
      symbol: 'X',
      chain: 'solana',
      mint: null,
      sizeUsd: 10_000,
      tau: 0.01,
      asOf: '2026-10-02T00:00:00.000Z',
      sell: null,
      buy: null,
      curveMeta: ROWMETA,
      platformFeeBps: 0,
      lp: null,
      lpWithdrawals: null,
      capacitySeries: null,
      lendingCollateral: null,
      tracking: [],
      issuer: null,
      gapGridPct: [20],
    };
    const none = buildAssetFacts(base);
    expect(AssetFacts.safeParse(none).success).toBe(true);
    const flow = none.flow;
    expect(flow?.window).toBeNull();
    expect(flow?.byPool).toEqual([]);
    expect(flow?.byRegime.every((r) => r.volumeUsd.value === null && r.swaps.value === null)).toBe(
      true,
    );
    expect(flow?.byRegime[0]?.swaps).toMatchObject({ reason: 'not_collected' });
    expect(flow?.byRegime[0]?.swaps).toMatchObject({ detail: expect.stringContaining('Oct 12') });

    const sheet = buildAssetFacts({
      ...base,
      flow: input([{ pool: fx.pool, venue: 'raydium_clmm', quote: 'USDC', rows: aggs }]),
    });
    expect(AssetFacts.safeParse(sheet).success).toBe(true);
    const { facts, invalid } = collectFacts(sheet);
    expect(invalid).toEqual([]);
    const flowFactsIn = facts.filter((f) => f.path.startsWith('flow.'));
    expect(flowFactsIn.length).toBeGreaterThan(40);
    // a zero is only ever measured from enough priced swaps (on Saturday Sep 5 all 33 swaps were purchases, so no
    // stock was sold: a measured zero) or a count of unpriced swaps; never a figure standing in for missing rows
    const zeros = flowFactsIn.filter((f) => f.fact.value === 0);
    expect(zeros.map((z) => z.path)).toContain('flow.byRegime[2].sellUsd');
    for (const { path, fact } of zeros)
      if (!/unpricedSwaps$/.test(path))
        expect((fact as { samples: number }).samples, path).toBeGreaterThanOrEqual(8);
    expect(defaultFactsParams().flowMinSwaps).toBe(8);
  });
});
