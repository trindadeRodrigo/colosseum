import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bearingDictionary } from '../../i18n/bearing';
import { isStale, newestReading } from './BearingProvider';
import { R, type Res } from './data';
import {
  assetVol,
  capacitySeries,
  capFact,
  type DexAsset,
  dexCounters,
  dexIds,
  dexVolume,
  HOUR,
  liquidityTotal,
  poolsOf,
  sourcesOf,
  tvlSeries,
  vol24,
} from './dex';
import { largestFirst, mk, none, partial, pinSource, STALE_AFTER_MS, sumFact } from './fact';
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
  LiqHistBody,
  LiquidityBody,
  Pool,
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
    // its own reading is three hours old: stale with its age, though the page is live
    expect(pinSource(f, { now, stale: false }).staleAgeSec).toBe(3 * 3600);
    // on a stale page, a reading of half an hour ago is stale too, with its own age
    const fresh = mk(1, { source: 's', fetchedAt: '2026-10-03T14:30:00Z', method: 'm' });
    expect(pinSource(fresh, { now, stale: true }).staleAgeSec).toBe(1800);
    // a reading of an hour ago, on a live page, is live
    expect(
      pinSource(f, { now: Date.parse('2026-10-03T13:00:00Z'), stale: false }).staleAgeSec,
    ).toBeNull();
  });

  it('a figure read long ago is stale on a live page: SPYx’s volume 24 h, 52 hours old in his recording', () => {
    const sheet = ok(answer<SheetBody>(R.sheet('SPYx', 100_000)));
    const vol = vol24({ ok: true, status: 200, body: sheet, reason: null });
    expect(vol.fetchedAt).toBe('2026-10-01T12:02:31.000Z');
    // the page is live: the newest depth curve ends at 15:07, ten minutes ago
    const now = Date.parse('2026-10-03T15:17:00Z');
    expect(isStale(newestReading({ ok: true, status: 200, body: assets, reason: null }), now)).toBe(
      false,
    );
    const pin = pinSource(vol, { now, stale: false });
    expect(pin.staleAgeSec).not.toBeNull();
    expect(Math.round((pin.staleAgeSec as number) / 3600)).toBe(51);
    // the capacity read at the same moment is live
    const tsla = assets.assets.find((a) => a.symbol === 'SPYx');
    expect(
      pinSource(capFact(tsla, 'weekend', assets), { now, stale: false }).staleAgeSec,
    ).toBeNull();
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

describe('the recorded pools: no price in dollars, and recordings of more than one job', () => {
  // Gold's two recorded pools in his recording: one against USDC, one against a token with no measured
  // way to dollars. The second is answered here as the API answers it now: its dollar figures null,
  // with the reason. The two sources are the API's own words for the two jobs that record pools.
  const USDC_POOL = '78ReVNMLGRWmjtf2HmBoHUe2pRcsctXTTbxJnbhchyze';
  const OTHER_POOL = '7WQcQi2dDgZDnpJKwoY7F9cALk3QEUG4kAyhtjZVkVa1';
  const COLLECTOR =
    'pool collector hourly raw recording (Solana RPC getMultipleAccounts: pool head + every tick/bin array), decoded by packages/risk/src/pools';
  const ARRAYS =
    'raw-arrays job hourly raw recording (Solana RPC getMultipleAccounts: pool head + every tick/bin array the pool collector’s cache lists), decoded by packages/risk/src/pools';
  const res = <T>(body: T): Res<T> => ({ ok: true, status: 200, body, reason: null });
  const liq = (pool: string) => ok(answer<LiquidityBody>(R.liquidity(pool)));
  const hist = (pool: string) => answer<LiqHistBody>(R.liqHist(pool));
  const noUsd = (h: Res<LiqHistBody>) =>
    res<LiqHistBody>({
      ...ok(h),
      points: ok(h).points.map((p) => ({
        ...p,
        valueUsd: null,
        assetUsd: null,
        usdNullReason: 'no_quote_price',
      })),
    });
  /** A history that did not load. */
  const failed: Res<LiqHistBody> = { ok: false, status: 0, body: null, reason: 'api_error' };
  /** The sum where `unpriced` of the `n` recorded pools were left unread, their quote having no price. */
  const leaving = (unpriced: number, hs: Array<Res<LiqHistBody>>, n: number) =>
    tvlSeries(hs, n, undefined, undefined, unpriced);
  /** A history as it would be had each of its recordings been made `hours` earlier. */
  const earlier = (h: Res<LiqHistBody>, hours: number) => {
    const back = (t: string) => new Date(Date.parse(t) - hours * HOUR).toISOString();
    const body = ok(h);
    return res<LiqHistBody>({
      ...body,
      to: body.to && back(body.to),
      points: body.points.map((p) => ({ ...p, t: back(p.t) })),
    });
  };

  it('the dollars a pool holds are its answer’s two sides; an answer with none is its reason, never $0', () => {
    const d = liq(USDC_POOL);
    expect(d.source).toBe(COLLECTOR);
    const total = liquidityTotal(d);
    expect(usd1(total.value as number)).toBe('$831.9K');
    expect(total).toMatchObject({
      quality: 'measured',
      source: d.source,
      fetchedAt: d.fetchedAt,
      method: d.method,
      provenance: 'live',
    });
    const bare: LiquidityBody = {
      ...liq(OTHER_POOL),
      totalAssetUsd: null,
      totalQuoteUsd: null,
      usdNullReason: 'no_quote_price',
    };
    expect(liquidityTotal(bare)).toEqual({
      value: null,
      reason: 'no_quote_price',
      detail: undefined,
    });
    // an answer that names no reason (an API older than `usdNullReason`): still no figure
    expect(liquidityTotal({ ...bare, usdNullReason: null }).reason).toBe('no_reference_price');
    // one side alone is not the total
    expect(liquidityTotal({ ...d, totalQuoteUsd: null }).value).toBeNull();
    // zero is a value: a pool that holds nothing is a measured $0, and only that is
    expect(liquidityTotal({ ...d, totalAssetUsd: 0, totalQuoteUsd: 0 })).toMatchObject({
      value: 0,
      quality: 'measured',
    });
  });

  it('the TVL sum leaves out a pool with no dollar value, and says it is a pool short', () => {
    const both = tvlSeries([hist(USDC_POOL), hist(OTHER_POOL)], 2);
    expect(both.fact.quality).toBe('measured');
    expect(usd1(both.fact.value as number)).toBe('$1.4M');
    const alone = tvlSeries([hist(USDC_POOL)], 1);
    const short = tvlSeries([hist(USDC_POOL), noUsd(hist(OTHER_POOL))], 2);
    expect(usd1(short.fact.value as number)).toBe('$915.8K');
    expect(short.fact.value).toBe(alone.fact.value);
    expect(short.fact.quality).toBe('lower_bound');
    expect(short.fact.method).toContain('summed over 1 of 2 recorded pools in the selection');
    // hour by hour it is the other pool's value alone, each hour labelled a pool short
    expect(short.value.map((p) => p.v)).toEqual(alone.value.map((p) => p.v));
    expect(short.held.map((p) => p.v)).toEqual(alone.held.map((p) => p.v));
    for (const p of short.value.filter((q) => q.v != null))
      expect(p.show).toMatch(/\(1 of 2 pools\)$/);
  });

  it('a selection whose every recording has no dollar value says that reason, not “not collected”', () => {
    const s = tvlSeries([noUsd(hist(OTHER_POOL))], 1);
    expect(s.fact).toEqual({ value: null, reason: 'no_quote_price', detail: undefined });
    expect(s.value).toEqual([]);
    expect(s.held).toEqual([]);
    // nothing recorded is still not collected
    expect(tvlSeries([], 0).fact.reason).toBe('not_collected');
  });

  it('a read that failed is the reason, never another pool’s missing price', () => {
    const bare = noUsd(hist(OTHER_POOL));
    // one history has no dollar value, one did not load: what the second holds is not known
    expect(tvlSeries([bare, failed], 2).fact).toEqual({
      value: null,
      reason: 'api_error',
      detail: undefined,
    });
    expect(tvlSeries([failed, bare], 2).fact.reason).toBe('api_error');
    // alone too: a recorded pool that did not load is not “not collected”
    expect(tvlSeries([failed], 1).fact.reason).toBe('api_error');
    // and a pool left unread for want of a price does not speak for the one that failed
    expect(leaving(1, [failed], 2).fact.reason).toBe('api_error');
    // every history read has no dollar value and none failed: the recordings’ own reason
    expect(tvlSeries([bare, noUsd(hist(USDC_POOL))], 2).fact.reason).toBe('no_quote_price');
    // the pools left unread have that reason by their registry row, beside a history or alone
    expect(leaving(1, [bare], 2).fact.reason).toBe('no_quote_price');
    expect(leaving(1, [], 1).fact.reason).toBe('no_quote_price');
    // a history with no recording gives no reason, so the selection has no one reason of its own
    const empty = res<LiqHistBody>({ ...ok(hist(USDC_POOL)), points: [] });
    expect(tvlSeries([bare, empty], 2).fact.reason).toBe('not_collected');
    expect(leaving(1, [empty], 2).fact.reason).toBe('not_collected');
    // with a pool in the sum there is a figure, a lower bound, whatever failed beside it
    const part = tvlSeries([hist(USDC_POOL), failed], 2).fact;
    expect(usd1(part.value as number)).toBe('$915.8K');
    expect(part.quality).toBe('lower_bound');
  });

  it('says which histories are in the sum, and how many recorded pools have no price in dollars', () => {
    expect(tvlSeries([hist(USDC_POOL), hist(OTHER_POOL)], 2)).toMatchObject({
      inSum: [true, true],
      noUsd: 0,
    });
    // four recorded pools: one in the sum, one read and found with no price, one that did not load,
    // and one left unread because its registry row says its quote token has no way to dollars
    const s = leaving(1, [hist(USDC_POOL), noUsd(hist(OTHER_POOL)), failed], 4);
    expect(s.inSum).toEqual([true, false, false]);
    // the pool that did not load is not one “with no price”: nothing is known of it
    expect(s.noUsd).toBe(2);
    expect(s.fact.quality).toBe('lower_bound');
    expect(s.fact.method).toContain('summed over 1 of 4 recorded pools in the selection');
    for (const p of s.value.filter((q) => q.v != null)) expect(p.show).toMatch(/\(1 of 4 pools\)$/);
    // a pool left unread makes the sum a pool short, as one read and found with no price does
    const alone = leaving(1, [hist(USDC_POOL)], 2);
    expect(alone).toMatchObject({ inSum: [true], noUsd: 1 });
    expect(alone.fact.quality).toBe('lower_bound');
    expect(alone.fact.value).toBe(tvlSeries([hist(USDC_POOL)], 1).fact.value);
  });

  it('counts in the figure the pools of its own hour: one whose newest recording is 7 h behind is drawn, not counted', () => {
    // both pools' newest recordings are of the same hour in his recording; the second is set back
    const s = tvlSeries([hist(USDC_POOL), earlier(hist(OTHER_POOL), 7)], 2);
    expect(s.inSum).toEqual([true, false]);
    // the figure is the first pool's alone, and says it is a pool short
    expect(s.fact.value).toBe(tvlSeries([hist(USDC_POOL)], 1).fact.value);
    expect(s.fact.quality).toBe('lower_bound');
    expect(s.fact.method).toContain('summed over 1 of 2 recorded pools in the selection');
    expect(s.value.at(-1)?.show).toMatch(/\(1 of 2 pools\)$/);
    // the note counts the histories in the sum: its count is the figure's
    const k = s.inSum.filter(Boolean).length;
    expect(bearingDictionary('en').dex.tvl.note(k, 2, null, 0)).toMatch(
      /^1 of 2 selected pools is recorded and in the sum; /,
    );
    // the pool behind is counted as that, so the note's counts are every recorded pool: 1 in the sum, 1 behind
    expect([s.behind, s.noUsd, s.failed]).toEqual([1, 0, 0]);
    expect(
      bearingDictionary('en').dex.tvl.note(k, 2, null, s.noUsd, s.failed, '', s.behind),
    ).toContain('1 more has no recording within 6 h of the newest hour, so it is not in the sum.');
    // it is still drawn where it has recordings: hours that hold both are whole
    expect(s.value.some((p) => p.v != null && !p.show?.includes(' of '))).toBe(true);
    // six hours behind is within what a pool's last value is kept for: counted
    const six = tvlSeries([hist(USDC_POOL), earlier(hist(OTHER_POOL), 6)], 2);
    expect(six.inSum).toEqual([true, true]);
    expect(six.behind).toBe(0);
    expect(six.fact.quality).toBe('measured');
    // nothing with a value, nothing in the sum, and nothing behind: one has no price, one did not load
    const none = tvlSeries([noUsd(hist(OTHER_POOL)), failed], 2);
    expect(none.inSum).toEqual([false, false]);
    expect([none.behind, none.noUsd, none.failed]).toEqual([0, 1, 1]);
    // a history that loads with no recording in the window is behind too: the four counts are every pool read
    const empty = res<LiqHistBody>({
      ...ok(hist(OTHER_POOL)),
      from: undefined,
      to: undefined,
      points: [],
    });
    const four = tvlSeries([hist(USDC_POOL), empty, noUsd(hist(OTHER_POOL)), failed], 4);
    expect([four.inSum.filter(Boolean).length, four.behind, four.noUsd, four.failed]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('counts the histories that did not load, and gives the first one’s reason', () => {
    expect(tvlSeries([hist(USDC_POOL), hist(OTHER_POOL)], 2)).toMatchObject({
      failed: 0,
      failedWhy: null,
    });
    /** A history the API does not serve. */
    const gone: Res<LiqHistBody> = {
      ok: false,
      status: 404,
      body: { message: 'Route GET:/risk/pools/x/liquidity/history not found' },
      reason: 'not_served',
    };
    // the series stay in the histories' places: the one that loaded is the third, and in the sum
    const s = tvlSeries([failed, gone, hist(USDC_POOL)], 3);
    expect(s).toMatchObject({
      inSum: [false, false, true],
      noUsd: 0,
      failed: 2,
      failedWhy: 'api_error',
    });
    expect(s.fact.quality).toBe('lower_bound');
    expect(s.fact.value).toBe(tvlSeries([hist(USDC_POOL)], 1).fact.value);
    expect(tvlSeries([gone, failed], 2).failedWhy).toBe('not_served');
    // a pool with no price is not one that did not load, nor the other way round
    expect(leaving(1, [hist(USDC_POOL), noUsd(hist(OTHER_POOL)), failed], 4)).toMatchObject({
      noUsd: 2,
      failed: 1,
      failedWhy: 'api_error',
    });
  });

  it('the TVL sum is live only when every history summed is', () => {
    const a = hist(USDC_POOL);
    const b = ok(hist(OTHER_POOL));
    // the API says what its recordings are, and his are live
    expect([ok(a).provenance, b.provenance]).toEqual(['live', 'live']);
    expect(tvlSeries([a, res(b)], 2).fact.provenance).toBe('live');
    // one history from a test network: the sum is not live, whichever comes first
    const sandbox = res<LiqHistBody>({ ...b, provenance: 'sandbox' });
    expect(tvlSeries([a, sandbox], 2).fact.provenance).toBe('sandbox');
    expect(tvlSeries([sandbox, a], 2).fact.provenance).toBe('sandbox');
    expect(pinSource(tvlSeries([a, sandbox], 2).fact, { now: 0, stale: false }).provenance).toBe(
      'sandbox',
    );
    // a history with no dollar value is not summed, so what it is does not mark the sum
    expect(tvlSeries([a, noUsd(sandbox)], 2).fact.provenance).toBe('live');
  });

  it('the part held in the asset is no value, not $0, where a recording does not give it', () => {
    const h = ok(hist(USDC_POOL));
    const lastPoint = h.points[h.points.length - 1];
    expect(tvlSeries([res(h)], 1).held.at(-1)?.v).toBe(lastPoint?.assetUsd);
    const s = tvlSeries(
      [
        res({
          ...h,
          points: h.points.map((p) => (p === lastPoint ? { ...p, assetUsd: null } : p)),
        }),
      ],
      1,
    );
    expect(s.value.at(-1)?.v).toBe(lastPoint?.valueUsd);
    expect(s.held.at(-1)?.v).toBeNull();
  });

  it('the TVL sum names each source its histories carry, once', () => {
    const a = hist(USDC_POOL);
    const b = res<LiqHistBody>({ ...ok(hist(OTHER_POOL)), source: ARRAYS });
    // one job recorded both pools: its source, as the history gives it
    expect(tvlSeries([a, hist(OTHER_POOL)], 2).fact.source).toBe(COLLECTOR);
    // two jobs: both are named, in the order of the pools
    expect(tvlSeries([a, b], 2).fact.source).toBe(`${COLLECTOR}; ${ARRAYS}`);
    expect(tvlSeries([b, a], 2).fact.source).toBe(`${ARRAYS}; ${COLLECTOR}`);
    // a history that names both itself (a pool both jobs recorded) does not name one twice
    const mixed = res<LiqHistBody>({ ...ok(b), source: `${COLLECTOR}; ${ARRAYS}` });
    expect(tvlSeries([a, mixed], 2).fact.source).toBe(`${COLLECTOR}; ${ARRAYS}`);
    // a history with no dollar value is not in the sum, so its source is not the sum's
    expect(tvlSeries([a, noUsd(b)], 2).fact.source).toBe(COLLECTOR);
    expect(sourcesOf([COLLECTOR, null, COLLECTOR, ARRAYS])).toBe(`${COLLECTOR}; ${ARRAYS}`);
    // and the pin is handed all of it
    expect(pinSource(tvlSeries([a, b], 2).fact, { now: 0, stale: false }).source).toBe(
      `${COLLECTOR}; ${ARRAYS}`,
    );
  });

  it('the TVL sum’s method is each history’s own, once when they agree', () => {
    const a = hist(USDC_POOL);
    const head =
      'summed over 2 of 2 recorded pools in the selection, each at its newest recording within 6 h; ';
    expect(tvlSeries([a, hist(OTHER_POOL)], 2).fact.method).toBe(`${head}${ok(a).method}`);
    const other = `${ok(a).method}, except where the quote has no price`;
    const b = res<LiqHistBody>({ ...ok(hist(OTHER_POOL)), source: ARRAYS, method: other });
    expect(tvlSeries([a, b], 2).fact.method).toBe(
      `${head}each pool by its own history’s method: ${ok(a).method} | ${other}`,
    );
  });
});

describe('what the page says of recordings, whichever job wrote them', () => {
  const said = (lang: 'en' | 'pt') => {
    const t = bearingDictionary(lang).dex;
    return [
      t.tvl.none,
      t.tvl.note(3, 12, '82%', 0),
      t.tvl.note(1, 1, null, 2),
      t.liquidity.failed('the Solana RPC read failed'),
      t.liquidity.recordedAt('2026-10-03 15:02 UTC'),
    ];
  };

  it.each(['en', 'pt'] as const)('names no job, no hour and no set of pools, in %s', (lang) => {
    for (const s of said(lang)) {
      expect(s).not.toMatch(/collector|coletor|raw-arrays/i);
      expect(s).not.toMatch(/hourly|hour by hour|every hour|de hora em hora|hora a hora|horári/i);
      expect(s).not.toMatch(/80%|every pool|all pools|todos os pools|todo pool/i);
    }
  });

  it('says the same in both languages', () => {
    const [en, pt] = [bearingDictionary('en').dex, bearingDictionary('pt').dex];
    expect(en.liquidity.failed('x')).toBe(
      'x. Only some pools are recorded; pick one without “not recorded”, or wait for the live read.',
    );
    expect(pt.liquidity.failed('x')).toBe(
      'x. Só alguns pools são registrados; escolha um sem “não registrado”, ou espere pela leitura ao vivo.',
    );
    expect(en.tvl.none).toMatch(
      /^the pool value over time is recorded only for some of the concentrated-liquidity pools, /,
    );
    expect(pt.tvl.none).toMatch(
      /^o valor do pool no tempo é registrado só para alguns dos pools de liquidez concentrada, /,
    );
    expect(en.tvl.note(3, 12, '82%', 0)).toMatch(
      /^3 of 12 selected pools are recorded and in the sum, holding 82% of the selection’s TVL; .* No recording is older than 2026-10-01\.$/,
    );
    expect(pt.tvl.note(3, 12, '82%', 0)).toMatch(
      /^3 de 12 pools selecionados são registrados e entram na soma, com 82% do TVL da seleção; .* Nenhum registro é anterior a 2026-10-01\.$/,
    );
  });

  it('the TVL note counts the pools in the sum, and says apart the recorded ones with no USD price', () => {
    const [en, pt] = [bearingDictionary('en').dex.tvl, bearingDictionary('pt').dex.tvl];
    // every recorded pool is in the sum: nothing is added
    expect(en.note(3, 12, '82%', 0)).toBe(
      '3 of 12 selected pools are recorded and in the sum, holding 82% of the selection’s TVL; the value of the tokens their liquidity holds, uncollected fees not counted. A pool not recorded in an hour keeps its last value for up to 6 h. No recording is older than 2026-10-01.',
    );
    expect(pt.note(3, 12, '82%', 0)).toBe(
      '3 de 12 pools selecionados são registrados e entram na soma, com 82% do TVL da seleção; o valor dos tokens que a liquidez deles guarda, sem contar taxas não coletadas. Um pool sem registro numa hora mantém seu último valor por até 6 h. Nenhum registro é anterior a 2026-10-01.',
    );
    // one more is recorded with no price: gold's two recorded pools
    expect(en.note(1, 63, '41.44%', 1)).toBe(
      '1 of 63 selected pools is recorded and in the sum, holding 41.44% of the selection’s TVL; the value of the tokens its liquidity holds, uncollected fees not counted. 1 more is recorded and has no USD price for the quote token, so it is not in the sum. A pool not recorded in an hour keeps its last value for up to 6 h. No recording is older than 2026-10-01.',
    );
    expect(pt.note(1, 63, '41,44%', 1)).toBe(
      '1 de 63 pools selecionados é registrado e entra na soma, com 41,44% do TVL da seleção; o valor dos tokens que a liquidez dele guarda, sem contar taxas não coletadas. Mais 1 é registrado e não tem preço em dólar para a moeda de cotação, por isso não entra na soma. Um pool sem registro numa hora mantém seu último valor por até 6 h. Nenhum registro é anterior a 2026-10-01.',
    );
    // recorded, priced and read, and too old for the hour the figure is taken from: said in a clause of its own, so
    // the four counts are every recorded pool of the selection
    expect(en.note(26, 929, '58.92%', 1, 0, '', 3)).toContain(
      ' so it is not in the sum. 3 more have no recording within 6 h of the newest hour, so they are not in the sum. A pool not recorded in an hour keeps',
    );
    expect(pt.note(26, 929, '58,92%', 1, 0, '', 3)).toContain(
      ' por isso não entra na soma. Mais 3 não têm registro nas 6 h antes da hora mais recente, por isso não entram na soma. Um pool sem registro numa hora mantém',
    );
    expect(en.note(0, 1, null, 0, 0, '', 1)).toContain(
      'not counted. 1 has no recording within 6 h of the newest hour, so it is not in the sum. A pool',
    );
    expect(pt.note(0, 1, null, 0, 0, '', 1)).toContain(
      'não coletadas. 1 não tem registro nas 6 h antes da hora mais recente, por isso não entra na soma. Um pool',
    );
    // several
    expect(en.note(3, 12, '82%', 2)).toContain(
      ' uncollected fees not counted. 2 more are recorded and have no USD price for the quote token, so they are not in the sum. A pool ',
    );
    expect(pt.note(3, 12, '82%', 2)).toContain(
      ' sem contar taxas não coletadas. Mais 2 são registrados e não têm preço em dólar para a moeda de cotação, por isso não entram na soma. Um pool ',
    );
    // none in the sum: the pools with no price are not “more”
    expect(en.note(0, 1, null, 1)).toBe(
      '0 of 1 selected pools are recorded and in the sum; the value of the tokens their liquidity holds, uncollected fees not counted. 1 is recorded and has no USD price for the quote token, so it is not in the sum. A pool not recorded in an hour keeps its last value for up to 6 h. No recording is older than 2026-10-01.',
    );
    expect(pt.note(0, 1, null, 1)).toBe(
      '0 de 1 pools selecionados são registrados e entram na soma; o valor dos tokens que a liquidez deles guarda, sem contar taxas não coletadas. 1 é registrado e não tem preço em dólar para a moeda de cotação, por isso não entra na soma. Um pool sem registro numa hora mantém seu último valor por até 6 h. Nenhum registro é anterior a 2026-10-01.',
    );
  });

  it('the TVL note says the histories that did not load, apart and with why, only when there are any', () => {
    const [en, pt] = [bearingDictionary('en').dex.tvl, bearingDictionary('pt').dex.tvl];
    const [enWhy, ptWhy] = [
      bearingDictionary('en').reasons.api_error,
      bearingDictionary('pt').reasons.api_error,
    ];
    // none failed: the note is the one it was
    expect(en.note(3, 12, '82%', 2, 0)).toBe(en.note(3, 12, '82%', 2));
    expect(pt.note(3, 12, '82%', 2, 0)).toBe(pt.note(3, 12, '82%', 2));
    expect(en.note(3, 12, '82%', 2)).not.toContain('did not load');
    expect(pt.note(3, 12, '82%', 2)).not.toMatch(/carreg/);
    // one, after the pools with no price
    expect(en.note(28, 929, '74.00%', 1, 1, enWhy)).toBe(
      '28 of 929 selected pools are recorded and in the sum, holding 74.00% of the selection’s TVL; the value of the tokens their liquidity holds, uncollected fees not counted. 1 more is recorded and has no USD price for the quote token, so it is not in the sum. 1 more did not load (the API returned no answer), so it is not in the sum. A pool not recorded in an hour keeps its last value for up to 6 h. No recording is older than 2026-10-01.',
    );
    expect(pt.note(28, 929, '74,00%', 1, 1, ptWhy)).toBe(
      '28 de 929 pools selecionados são registrados e entram na soma, com 74,00% do TVL da seleção; o valor dos tokens que a liquidez deles guarda, sem contar taxas não coletadas. Mais 1 é registrado e não tem preço em dólar para a moeda de cotação, por isso não entra na soma. Mais 1 não carregou (a API não respondeu), por isso não entra na soma. Um pool sem registro numa hora mantém seu último valor por até 6 h. Nenhum registro é anterior a 2026-10-01.',
    );
    // several, and no pool without a price before them
    expect(en.note(3, 12, '82%', 0, 2, enWhy)).toContain(
      ' uncollected fees not counted. 2 more did not load (the API returned no answer), so they are not in the sum. A pool ',
    );
    expect(pt.note(3, 12, '82%', 0, 2, ptWhy)).toContain(
      ' sem contar taxas não coletadas. Mais 2 não carregaram (a API não respondeu), por isso não entram na soma. Um pool ',
    );
    // nothing counted before them: they are not “more”
    expect(en.note(0, 1, null, 0, 1, enWhy)).toBe(
      '0 of 1 selected pools are recorded and in the sum; the value of the tokens their liquidity holds, uncollected fees not counted. 1 did not load (the API returned no answer), so it is not in the sum. A pool not recorded in an hour keeps its last value for up to 6 h. No recording is older than 2026-10-01.',
    );
    expect(pt.note(0, 1, null, 0, 1, ptWhy)).toBe(
      '0 de 1 pools selecionados são registrados e entram na soma; o valor dos tokens que a liquidez deles guarda, sem contar taxas não coletadas. 1 não carregou (a API não respondeu), por isso não entra na soma. Um pool sem registro numa hora mantém seu último valor por até 6 h. Nenhum registro é anterior a 2026-10-01.',
    );
    // none in the sum, one with no price: the one that did not load is one more
    expect(en.note(0, 63, null, 1, 1, enWhy)).toContain(
      ' 1 is recorded and has no USD price for the quote token, so it is not in the sum. 1 more did not load (the API returned no answer), so it is not in the sum. A pool ',
    );
    expect(pt.note(0, 63, null, 1, 1, ptWhy)).toContain(
      ' 1 é registrado e não tem preço em dólar para a moeda de cotação, por isso não entra na soma. Mais 1 não carregou (a API não respondeu), por isso não entra na soma. Um pool ',
    );
  });

  it('the TVL note’s verb follows its count, in both', () => {
    const [en, pt] = [bearingDictionary('en').dex.tvl, bearingDictionary('pt').dex.tvl];
    expect(en.note(1, 63, null, 0)).toMatch(/^1 of 63 selected pools is recorded and in the sum; /);
    expect(en.note(2, 63, null, 0)).toMatch(
      /^2 of 63 selected pools are recorded and in the sum; /,
    );
    expect(pt.note(1, 63, null, 0)).toMatch(
      /^1 de 63 pools selecionados é registrado e entra na soma; /,
    );
    expect(pt.note(2, 63, null, 0)).toMatch(
      /^2 de 63 pools selecionados são registrados e entram na soma; /,
    );
  });

  it('the liquidity caption reads as one sentence, from a recording or from a live read, in both', () => {
    const [en, pt] = [bearingDictionary('en').dex.liquidity, bearingDictionary('pt').dex.liquidity];
    expect(en.note(en.recordedAt('2026-10-03 15:02 UTC'))).toBe(
      'held within ±30% of the price, from the pool’s newest recording, 2026-10-03 15:02 UTC; the asset waits above the price (sold into as it rises), the quote below (bought with as it falls); + and − zoom',
    );
    expect(en.note(en.liveAt('15:02'))).toBe(
      'held within ±30% of the price, from a live read at 15:02 UTC; the asset waits above the price (sold into as it rises), the quote below (bought with as it falls); + and − zoom',
    );
    // Portuguese joins the preposition to the article: “do registro”, “da leitura”, not “de o”
    expect(pt.note(pt.recordedAt('3 de out. de 2026, 15:02 UTC'))).toBe(
      'guardada a até ±30% do preço, a partir do registro mais recente do pool, 3 de out. de 2026, 15:02 UTC; o ativo espera acima do preço (vendido conforme sobe), a moeda de cotação abaixo (usada para comprar conforme cai); + e − para zoom',
    );
    expect(pt.note(pt.liveAt('15:02'))).toBe(
      'guardada a até ±30% do preço, a partir da leitura ao vivo das 15:02 UTC; o ativo espera acima do preço (vendido conforme sobe), a moeda de cotação abaixo (usada para comprar conforme cai); + e − para zoom',
    );
    for (const s of [pt.note(pt.recordedAt('x')), pt.note(pt.liveAt('x'))])
      expect(s).not.toMatch(/\bde (o|a|os|as) /);
  });

  it('has words for a quote token with no price in dollars, in both', () => {
    expect(bearingDictionary('en').reasons.no_quote_price).toBe('no USD price for the quote token');
    expect(bearingDictionary('pt').reasons.no_quote_price).toBe(
      'sem preço em dólar para a moeda de cotação',
    );
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

  it('the tolerance moves the covered share: 3.77% at 0.5%, 8.88% at 2% (CHECKS.md section 10)', () => {
    const at = (tau: number) => {
      const body = ok(answer<AssetsBody>(R.assets(tau)));
      return covFacts(groupBy(rows.map((row) => coverage(row, body, null, r))), r, body).covF;
    };
    expect(pct(at(0.005).value as number)).toBe('3.77%');
    expect(pct(at(0.01).value as number)).toBe('6.82%');
    expect(pct(at(0.02).value as number)).toBe('8.88%');
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

describe('DexScreener’s 24 h volume (gate VOLUME-DEXSCREENER)', () => {
  const pool = (v: number | null | undefined, at: string): Pool => ({
    address: `P${at}`,
    venue: 'raydium_clmm',
    assetSymbol: 'SPYx',
    quoteSymbol: 'USDC',
    exitPath: 'direct_usd',
    tvlUsd: 1,
    discoveryVolume24hUsd: v,
    fetchedAt: at,
  });

  it('sums the pools under its own source, never Bearing’s, and a pool without it makes a lower bound', () => {
    const f = dexVolume([pool(1_000, '2026-10-06T04:00:00Z'), pool(250, '2026-10-06T05:00:00Z')]);
    expect(f.value).toBe(1_250);
    expect(f.source).toBe('DexScreener · 24 h');
    expect(f.method).toContain("not Bearing's swap history");
    expect(f.fetchedAt).toBe('2026-10-06T05:00:00Z');
    expect(f.quality).toBe('measured');
    expect(
      dexVolume([pool(1_000, '2026-10-06T04:00:00Z'), pool(null, '2026-10-06T04:00:00Z')]).quality,
    ).toBe('lower_bound');
    expect(dexVolume([pool(null, '2026-10-06T04:00:00Z')]).reason).toBe('not_collected');
    expect(dexVolume([]).reason).toBe('nothing_selected');
  });

  it('stands only where Bearing’s swap history is not collected', () => {
    const pools: Res<PoolsBody> = {
      ok: true,
      status: 200,
      body: { pools: [pool(900, '2026-10-06T04:00:00Z')] },
      reason: null,
    };
    const sheet = (byWindow: unknown[]) =>
      ({
        ok: true,
        status: 200,
        body: { costs: [], flow: { byWindow }, liquidityStability: {} },
        reason: null,
      }) as never;
    const own = mk(42, {
      source: 'risk_pool_flow',
      method: 'swaps',
      fetchedAt: '2026-10-06T00:00:00Z',
    });
    expect(
      assetVol({ sheet: sheet([{ window: '24h', volumeUsd: own }]), hist: null as never, pools })
        .source,
    ).toBe('risk_pool_flow');
    expect(assetVol({ sheet: sheet([]), hist: null as never, pools }).source).toBe(
      'DexScreener · 24 h',
    );
  });
});

describe('a missing figure is never a zero (STYLE rule 2)', () => {
  const at = '2026-10-06T04:00:00Z';
  const fact = (v: number) => mk(v, { source: 's', fetchedAt: at, method: 'm' });
  const pool = (address: string, tvlUsd: number | null): Pool => ({
    address,
    venue: 'raydium_clmm',
    assetSymbol: 'GLDx',
    quoteSymbol: 'USDC',
    exitPath: 'direct_usd',
    tvlUsd,
    discoveryVolume24hUsd: null,
    fetchedAt: at,
  });

  it("a pool's liquidity chart with no dollar price for its quote has no total, not $0", () => {
    const body = (a: number | null, q: number | null) => ({
      pool: 'p',
      bands: [],
      midPrice: 1,
      totalAssetUsd: a,
      totalQuoteUsd: q,
      fetchedAt: at,
      source: 's',
      method: 'm',
      methodVersion: 'v',
      provenance: 'live',
    });
    expect(liquidityTotal(body(null, null))).toMatchObject({
      value: null,
      reason: 'no_reference_price',
    });
    // half a pool is never shown as the pool
    expect(liquidityTotal(body(1_000, null)).value).toBeNull();
    expect(liquidityTotal(body(1_000, 250))).toMatchObject({
      value: 1_250,
      quality: 'measured',
      source: 's',
      fetchedAt: at,
      method: 'm',
    });
  });

  it('a sum says how many of its parts were measured, and is whole only with all of them', () => {
    const short = sumFact([fact(10), none('not_collected'), fact(5)], {});
    expect(short).toMatchObject({ value: 15, measured: 2, of: 3, quality: 'lower_bound' });
    expect(partial(short)).toBe(true);
    const whole = sumFact([fact(10), fact(5)], {});
    expect(whole).toMatchObject({ measured: 2, of: 2 });
    expect(partial(whole)).toBe(false);
    // with no part measured there is no figure to mark
    expect(partial(sumFact([none('not_collected')], {}))).toBe(false);
  });

  it('sorts what has no figure last, never among the measured as a zero', () => {
    const rows = [none('not_collected'), fact(3), fact(-1), fact(8), none('not_served')];
    expect(
      rows
        .slice()
        .sort(largestFirst)
        .map((f) => f.value),
    ).toEqual([8, 3, -1, null, null]);
  });

  it('pool TVL is the sum of the pools that have one, marked partial; with none it has no figure', () => {
    const k = dexCounters(
      assets,
      ['GLDx'],
      {},
      [pool('A', 1_000), pool('B', null)],
      'weekend',
      true,
    );
    expect(k.tvl).toMatchObject({ value: 1_000, measured: 1, of: 2, quality: 'lower_bound' });
    expect(partial(k.tvl)).toBe(true);
    const none2 = dexCounters(assets, ['GLDx'], {}, [pool('A', null)], 'weekend', true);
    expect(none2.tvl).toMatchObject({ value: null, reason: 'not_collected' });
    const whole = dexCounters(
      assets,
      ['GLDx'],
      {},
      [pool('A', 1_000), pool('B', 2_000)],
      'weekend',
      true,
    );
    expect(whole.tvl.value).toBe(3_000);
    expect(partial(whole.tvl)).toBe(false);
  });

  it('collateral is summed over the positions with a figure, and every figure made of it says so', () => {
    const cap = fact(500);
    const groups = groupBy([
      [
        { key: 'm1|SPYx', asset: 'SPYx', coll: fact(1_000), cap },
        { key: 'm2|SPYx', asset: 'SPYx', coll: none('not_collected'), cap },
        { key: 'm3|SPYx', asset: 'SPYx', coll: fact(250), cap },
      ],
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ collV: 1_250, missing: 1 });
    const f = covFacts(groups, 'weekend', assets);
    expect(f.collF).toMatchObject({ value: 1_250, measured: 2, of: 3, quality: 'lower_bound' });
    expect(f.maxF).toMatchObject({ value: 500, measured: 2, of: 3, quality: 'lower_bound' });
    expect(f.covF).toMatchObject({ value: 0.4, measured: 2, of: 3, quality: 'lower_bound' });
    for (const x of [f.collF, f.maxF, f.covF]) expect(partial(x)).toBe(true);
    // with every position measured nothing is marked
    const whole = covFacts(
      groupBy([[{ key: 'm1|SPYx', asset: 'SPYx', coll: fact(1_000), cap }]]),
      'weekend',
      assets,
    );
    for (const x of [whole.collF, whole.maxF, whole.covF]) expect(partial(x)).toBe(false);
  });
});
