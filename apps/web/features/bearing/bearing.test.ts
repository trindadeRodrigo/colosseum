import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStale, newestReading } from './BearingProvider';
import { R, type Res } from './data';
import { capacitySeries, capFact, type DexAsset, dexCounters, dexIds, poolsOf } from './dex';
import { mk, none, pinSource, STALE_AFTER_MS, sumFact } from './fact';
import { pct, usd, usd1 } from './format';
import {
  collateralAssets,
  coverage,
  coveredSeries,
  covFacts,
  groupBy,
  type LendRow,
  priceGroups,
} from './lending';
import { chunksFor, parseAmount, simPaths } from './sim';
import { answer, CAPTURED, snapshotReader } from './test/snapshot';
import { CAL, nextOpen, regimeAt } from './time';
import type {
  AssetsBody,
  HistBody,
  LendBody,
  LendHistBody,
  LendListBody,
  PoolsBody,
  SheetBody,
} from './types';

// Bearing's figures, worked out from Rodrigo's recording of the risk API and held to the hand checks
// his prototype was held to (assets/analytics/CHECKS.md, sections 9 and 10), and the rules his reviewer
// found broken and fixed there: collateral grouped by asset before capacity applies, each Kamino market
// once, a position with no figure kept and the total a lower bound.

const ok = <T>(r: Res<T>): T => {
  if (!r.ok) throw new Error(`not recorded: ${r.reason}`);
  return r.body;
};
const assets = ok(answer<AssetsBody>(R.assets(0.01)));

function lendRows(): LendRow[] {
  const list = ok(answer<LendListBody>(R.lendList()));
  return list.pools.map((meta) => ({
    meta,
    sheet: answer<LendBody>(R.lend(meta.account)),
    h7: answer<LendHistBody>(R.lendH(meta.account, 7)),
    h30: answer<LendHistBody>(R.lendH(meta.account, 30)),
  }));
}

describe('the time of week, by the API’s rule', () => {
  it('reads the same holiday calendar as the API', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../../../../fixtures/risk/us-market-holidays.json'),
        'utf8',
      ),
    ) as { closed: string[]; earlyClose13ET: string[] };
    expect(CAL.closed).toEqual(fixture.closed);
    expect(CAL.early).toEqual(fixture.earlyClose13ET);
  });

  it('opens market hours at 09:30 ET on a Monday, not a minute before', () => {
    expect(regimeAt(new Date('2026-10-05T13:29:00Z'))).toBe('us_offhours_weekday');
    expect(regimeAt(new Date('2026-10-05T13:31:00Z'))).toBe('us_market_hours');
    expect(regimeAt(new Date(CAPTURED))).toBe('weekend');
    expect(regimeAt(new Date('2026-11-26T15:00:00Z'))).toBe('us_holiday');
  });

  it('finds the next open from a Saturday morning: Monday 09:30 ET, 47.4 h later', () => {
    const at = new Date('2026-10-03T14:06:00Z'); // Sat 10:06 ET
    const open = nextOpen(at) as Date;
    expect(open.toISOString()).toBe('2026-10-05T13:30:00.000Z');
    expect(((open.getTime() - at.getTime()) / 3600e3).toFixed(1)).toBe('47.4');
  });
});

describe('a figure and its staleness', () => {
  it('a sum with a part missing is a lower bound, and says how many parts it has', () => {
    const a = mk(10, { source: 's', fetchedAt: '2026-10-03T10:00:00Z', method: 'm' });
    const b = mk(5, { source: 's', fetchedAt: '2026-10-03T12:00:00Z', method: 'm' });
    const full = sumFact([a, b], {});
    expect(full).toMatchObject({
      value: 15,
      quality: 'measured',
      fetchedAt: '2026-10-03T12:00:00Z',
    });
    const short = sumFact([a, none('not_collected')], {});
    expect(short.quality).toBe('lower_bound');
    expect(short.method).toContain('1 of 2 with a figure');
    expect(sumFact([], {})).toEqual({ value: null, reason: 'nothing_selected', detail: undefined });
  });

  it('a figure never stands without its source: no value is its reason, and a non-finite one too', () => {
    expect(mk(Number.NaN, { source: 's', method: 'm' }).value).toBeNull();
    expect(mk(null, { reason: 'gate_open' })).toMatchObject({ value: null, reason: 'gate_open' });
  });

  it('is stale when the collectors’ newest reading is older than two hours, each figure with its own age', () => {
    const newest = newestReading({ ok: true, status: 200, body: assets, reason: null });
    expect(newest).toBe('2026-10-03T15:07:00.728Z');
    const t = Date.parse(newest as string);
    expect(isStale(newest, t + STALE_AFTER_MS)).toBe(false);
    expect(isStale(newest, t + STALE_AFTER_MS + 1)).toBe(true);
    expect(isStale(null, t)).toBe(true);
    const f = mk(1, {
      source: 's',
      fetchedAt: '2026-10-03T12:00:00Z',
      method: 'm',
      methodVersion: 'v1',
    });
    const now = Date.parse('2026-10-03T15:00:00Z');
    expect(pinSource(f, { now, stale: true })).toEqual({
      source: 's',
      fetchedAt: '2026-10-03T12:00:00.000Z',
      method: 'm · v1',
      provenance: 'live',
      staleAgeSec: 3 * 3600,
    });
    expect(pinSource(f, { now, stale: false }).staleAgeSec).toBeNull();
  });

  it('a measured figure is live, never MOCK; a figure the API marks otherwise keeps its mark', () => {
    expect(
      pinSource(mk(1, { source: 's', fetchedAt: '2026-10-03T12:00:00Z', method: 'm' }), {
        now: 0,
        stale: false,
      }).provenance,
    ).toBe('live');
    expect(
      pinSource(
        mk(1, { source: 's', fetchedAt: '2026-10-03T12:00:00Z', method: 'm', provenance: 'mock' }),
        { now: 0, stale: false },
      ).provenance,
    ).toBe('mock');
    expect(
      sumFact(
        [
          mk(1, { source: 's', method: 'm' }),
          mk(2, { source: 's', method: 'm', provenance: 'sandbox' }),
        ],
        {},
      ).provenance,
    ).toBe('sandbox');
  });
});

describe('the stocks and commodities pages', () => {
  const dd = (ids: string[]): Record<string, DexAsset> =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          sheet: answer<SheetBody>(R.sheet(id, 100_000)),
          hist: answer<HistBody>(R.hist(id, 0.01)),
          pools: answer<PoolsBody>(R.poolsOf(id)),
        },
      ]),
    );

  it('gold is a commodity and nothing else is', () => {
    expect(dexIds(assets, 'commodities')).toEqual(['GLDx']);
    expect(dexIds(assets, 'stocks')).toHaveLength(46);
  });

  it('the commodities counters, weekend, as the prototype shows them', () => {
    const d = dd(['GLDx']);
    const k = dexCounters(assets, ['GLDx'], d, poolsOf(d.GLDx), 'weekend', false);
    expect(usd1(k.tvl.value as number)).toBe('$2.3M');
    expect(usd1(k.cap.value as number)).toBe('$184.1K');
    expect(k.vol.quality).toBe('lower_bound');
    expect(usd1(k.vol.value as number)).toBe('$870.3K');
    expect(pct(k.lp.value as number)).toBe('30.33%');
  });

  it('capacity is the fitted curve’s, and a regime with no curve says so rather than showing 0', () => {
    const tsla = assets.assets.find((a) => a.symbol === 'TSLAx');
    expect(usd1(capFact(tsla, 'weekend', assets).value as number)).toBe('$72.8K');
    expect(capFact(tsla, 'us_holiday', assets)).toEqual({
      value: null,
      reason: 'no_samples_in_regime',
      detail: undefined,
    });
    expect(capFact(undefined, 'weekend', assets).reason).toBe('not_collected');
  });

  it('an hour short of an asset is labelled with how many it has', () => {
    const ids = ['SPYx', 'TSLAx'];
    const s = capacitySeries(ids, dd(ids));
    const partial = s.sell.filter((p) => p.show?.includes('of 2 assets'));
    const whole = s.sell.filter((p) => p.v != null && !p.show?.includes(' of '));
    expect(whole.length).toBeGreaterThan(0);
    for (const p of partial) expect(p.show).toMatch(/\(1 of 2 assets\)$/);
  });
});

describe('the lending page, weekend, 1% tolerance (CHECKS.md 9 and 10)', () => {
  const rows = lendRows();
  const r = 'weekend' as const;

  it('covered 6.82% of $37.65M, largest sale within tolerance $2.57M, both lower bounds', async () => {
    const covs = rows.map((row) => coverage(row, assets, null, r));
    const all = groupBy(covs);
    await priceGroups(all, r, snapshotReader());
    const f = covFacts(all, r, assets);
    expect(pct(f.covF.value as number)).toBe('6.82%');
    expect(usd1(f.maxF.value as number)).toBe('$2.6M');
    expect(Math.round((f.maxF.value as number) / 1e4) / 100).toBe(2.57);
    expect(usd1(f.collF.value as number)).toBe('$37.6M');
    expect(f.covF.quality).toBe('lower_bound');
    expect(pct(f.lossPF.value as number)).toBe('38.13%');
  });

  it('Sentora xStocks Market · PYUSD alone: (79.3K + 418K + 1.01M) ÷ 2.875M = 52.57%', async () => {
    const row = rows.find((x) => x.meta.symbol === 'PYUSD') as LendRow;
    const g = groupBy([coverage(row, assets, null, r)]);
    await priceGroups(g, r, snapshotReader());
    expect(pct(covFacts(g, r, assets).covF.value as number)).toBe('52.57%');
  });

  it('a Kamino market’s collateral counts once, however many of its reserves repeat it', () => {
    const market = rows.filter(
      (x) => x.meta.venue === 'kamino' && x.meta.market === 'xStocks Market',
    );
    expect(market.length).toBeGreaterThan(1);
    const once = groupBy(market.map((row) => coverage(row, assets, null, r)));
    const one = groupBy([coverage(market[0] as LendRow, assets, null, r)]);
    expect(once.reduce((a, g) => a + g.collV, 0)).toBeCloseTo(
      one.reduce((a, g) => a + g.collV, 0),
      6,
    );
  });

  it('collateral is grouped by asset before its capacity applies', () => {
    const all = groupBy(rows.map((row) => coverage(row, assets, null, r)));
    const assetsSeen = all.map((g) => g.asset);
    expect(new Set(assetsSeen).size).toBe(assetsSeen.length);
    expect(collateralAssets(rows)).toContain('SPYx');
  });

  it('the covered share over time never passes 100%, and leaves out hours with an asset unmeasured', () => {
    const all = groupBy(rows.map((row) => coverage(row, assets, null, r)));
    const hist = Object.fromEntries(
      all.map((g) => [g.asset, answer<HistBody>(R.hist(g.asset, 0.01))]),
    );
    const cs = coveredSeries(all, hist);
    expect(cs.length).toBeGreaterThan(24);
    for (const p of cs) if (p.v != null) expect(p.v).toBeLessThanOrEqual(1);
  });
});

describe('the simulation (CHECKS.md 9: TSLAx $100k, weekend)', () => {
  it('splits into 2 hourly sales of $50k, the best path, losing $552 against $1,380 now', () => {
    const at = new Date(CAPTURED);
    const tsla = assets.assets.find((a) => a.symbol === 'TSLAx');
    const cap = capFact(tsla, 'weekend', assets);
    const chunks = chunksFor(100_000, cap);
    expect(chunks).toBe(2);
    const sim = simPaths({
      id: 'TSLAx',
      n: 100_000,
      at,
      r: 'weekend',
      sheet: ok(answer<SheetBody>(R.sheet('TSLAx', 100_000))),
      chunks,
      chunkSheet: answer<SheetBody>(R.sheet('TSLAx', 50_000)),
      recov: answer(R.recov('TSLAx', 100_000)),
    });
    expect(sim.paths.map((p) => p.key)).toEqual(['now', 'open', 'split', 'issuer']);
    expect(sim.best?.key).toBe('split');
    expect(usd(sim.best?.loss.value as number)).toBe('$552');
    expect(sim.verdict).toBe(
      'Best path for $100,000 of TSLAx now: split into 2 hourly sales. It loses $552 (0.55%), against $1,380 selling all of it now. Waiting carries price risk this loss does not count.',
    );
    // the issuer path rests on its terms: shown, labelled an assumption, never chosen
    const issuer = sim.paths.find((p) => p.key === 'issuer');
    expect(issuer?.assumption).toBe(true);
    expect(issuer?.capF?.quality).toBe('assumption');
  });

  it('never splits a sale into more than two days of hourly sales', () => {
    expect(chunksFor(1e9, mk(1000, { source: 's', method: 'm' }))).toBe(0);
    expect(chunksFor(500, mk(1000, { source: 's', method: 'm' }))).toBe(0);
  });

  it('reads an amount as a person writes it, and refuses one out of range', () => {
    expect(parseAmount('250k')).toBe(250_000);
    expect(parseAmount('$1,000,000')).toBe(1_000_000);
    expect(parseAmount('2.5m')).toBe(2_500_000);
    expect(parseAmount('12')).toBeNull();
    expect(parseAmount('lots')).toBeNull();
  });
});
