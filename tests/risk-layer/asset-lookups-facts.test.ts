import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AssetFigure,
  BAR_KEYS,
  type BarRow,
  barCoverage,
  compareVersions,
  factNullReason,
  type LendingMarketRow,
  lendingFigures,
  lendsIt,
  lentOf,
  MAX_POOLS,
  maxMissingHours,
  midCoverage,
  newestByMetric,
  type ObservationRow,
  type PoolBarRow,
  poolFigures,
  priceHistoryFigures,
  profileFigures,
  staleAfterSec,
  windowStart,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// The pure builders of the asset lookups (API-AGENT-LOOKUPS-1), on rows read from the local database
// (fixtures/risk/assets/lookups/, read-only, NVDAx on Solana and a dollar-yield token).
const DIR = join(__dirname, '../../fixtures/risk/assets/lookups');
const load = <T>(file: string): T => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as T;
const nvdax = load<{ observations: ObservationRow[] }>('nvdax-observations.json').observations;
const yieldToken = load<{ observations: ObservationRow[] }>(
  'yield-token-observations.json',
).observations;
const bars = load<{ bars: BarRow[] }>('nvdax-bars.json').bars;
const pools = load<{ reading: ObservationRow; poolBars: PoolBarRow[] }>('nvdax-pools.json');
const lending = load<{ markets: LendingMarketRow[] }>('nvdax-lending.json').markets;

const byKey = (figures: AssetFigure[]) => new Map(figures.map((f) => [f.key, f]));
const HOUR = 3_600_000;
/** Every hour from `from` to `to`, both included, as the bars write them. */
const hoursBetween = (from: string | number, to: string | number): string[] => {
  const out: string[] = [];
  for (let at = new Date(from).getTime(); at <= new Date(to).getTime(); at += HOUR)
    out.push(new Date(at).toISOString());
  return out;
};
// The chain's collector ran every hour of the fixture: from its first bar to its last.
const collected = hoursBetween((bars[0] as BarRow).hour, (bars.at(-1) as BarRow).hour);

describe('profile: the newest reading of each metric', () => {
  // supply_total was read at 13:44; the pool TVL reading is the registry's build of Oct 1.
  const now = new Date('2026-10-14T14:00:00.000Z');
  const figures = byKey(profileFigures(nvdax, now));

  it('serves each metric once, measured with its pin or null with a reason', () => {
    expect([...figures.keys()]).toEqual([
      'supply_total',
      'supply_issuer',
      'holders_top20_share',
      'pool_tvl_usd',
      'dex_volume_24h_usd',
      'protocol_tvl_usd',
      'exchange_rate',
      'yield_realised_30d',
      'yield_quoted',
    ]);
    const supply = nvdax.find((row) => row.metric === 'supply_total') as ObservationRow;
    expect(figures.get('supply_total')).toEqual({
      key: 'supply_total',
      value: supply.value,
      unit: 'tokens',
      source: supply.source,
      method: `${supply.method} (${supply.methodVersion})`,
      fetchedAt: supply.fetchedAt,
      provenance: 'live',
    });
  });

  it("maps the job's null reasons, unknown ones to not_collected", () => {
    expect(figures.get('exchange_rate')).toEqual({
      key: 'exchange_rate',
      value: null,
      reason: 'not_applicable',
    });
    // rpc_method_unavailable: the job's own word, which no fact reason names
    expect(figures.get('holders_top20_share')).toMatchObject({
      value: null,
      reason: 'not_collected',
    });
    expect(figures.get('protocol_tvl_usd')).toMatchObject({
      value: null,
      reason: 'not_applicable',
    });
    expect(factNullReason('insufficient_history')).toBe('insufficient_samples');
    expect(factNullReason('in_yield_observations')).toBe('not_imported');
    expect(factNullReason('not_a_finite_number')).toBe('not_a_number');
    expect(factNullReason('gate_open')).toBe('gate_open');
    expect(factNullReason('something_new')).toBe('not_collected');
    expect(factNullReason(null)).toBe('not_collected');
  });

  it('serves a reading past three of its job intervals with its age, never as fresh', () => {
    const tvl = figures.get('pool_tvl_usd');
    const observed = nvdax.find((row) => row.metric === 'pool_tvl_usd') as ObservationRow;
    expect(tvl).toMatchObject({ value: observed.value, unit: 'usd' });
    expect(tvl && 'staleAgeSec' in tvl ? tvl.staleAgeSec : undefined).toBe(
      Math.floor((now.getTime() - Date.parse(observed.observedAt)) / 1_000),
    );
    // hourly: three hours; daily: three days
    expect(staleAfterSec('pool_tvl_usd')).toBe(3 * 3_600);
    expect(staleAfterSec('dex_volume_24h_usd')).toBe(3 * 86_400);
    expect(staleAfterSec('yield_realised_7d')).toBe(3 * 3_600);
    // read at 13:44 (hourly) and 20 hours ago (daily): both within their limit
    expect(figures.get('supply_total')).not.toHaveProperty('staleAgeSec');
    expect(figures.get('dex_volume_24h_usd')).not.toHaveProperty('staleAgeSec');
  });

  it("keeps each yield reading as its own figure, the newest of a metric's rows", () => {
    const at = new Date('2026-10-13T18:00:00.000Z');
    const quoted = yieldToken.find((row) => row.metric === 'yield_quoted') as ObservationRow;
    const older = { ...quoted, value: 0.5, observedAt: '2026-10-11T03:02:13.612Z' };
    const own = byKey(profileFigures([older, ...yieldToken], at));
    expect(own.get('yield_quoted')).toMatchObject({ value: quoted.value, unit: 'fraction' });
    expect(own.get('yield_realised_30d')).toMatchObject({ value: null, reason: 'not_collected' });
    expect(newestByMetric([older, quoted])).toEqual([quoted]);
  });

  it('a sum that left a pool out is a lower bound', () => {
    const row = { ...(nvdax[3] as ObservationRow), detail: { lowerBound: true } };
    expect(profileFigures([row], new Date(row.observedAt))[0]).toMatchObject({ lowerBound: true });
  });
});

describe('price history: the asset bars of a window, in dollars', () => {
  // The bars run to the hour of 05:00 on Oct 6; at 06:30 they reach the present.
  const now = new Date('2026-10-06T06:30:00.000Z');

  it('serves the window when the bars cover it', () => {
    const figures = byKey(priceHistoryFigures(bars, null, '24h', now, collected));
    expect([...figures.keys()]).toEqual([...BAR_KEYS]);
    const start = windowStart('24h', now).getTime();
    const inside = bars.filter((bar) => Date.parse(bar.hour) >= start);
    const priced = inside.filter((bar) => bar.closeUsd !== null);
    const valued = inside.filter((bar) => bar.volumeUsd !== null);
    const first = priced[0] as BarRow;
    const last = priced.at(-1) as BarRow;
    expect(figures.get('close')).toMatchObject({ value: last.closeUsd, unit: 'usd' });
    expect(figures.get('high')?.value).toBe(Math.max(...priced.map((b) => b.highUsd as number)));
    expect(figures.get('low')?.value).toBe(Math.min(...priced.map((b) => b.lowUsd as number)));
    expect(figures.get('change')).toMatchObject({
      value: ((last.closeUsd as number) - (first.closeUsd as number)) / (first.closeUsd as number),
      unit: 'fraction',
    });
    expect(figures.get('volume')?.value).toBeCloseTo(
      valued.reduce((s, b) => s + (b.volumeUsd as number), 0),
      6,
    );
    expect(figures.get('buyvol')?.value).toBeCloseTo(
      valued.reduce((s, b) => s + (b.buyVolumeUsd as number), 0),
      6,
    );
    expect(figures.get('swaps')).toMatchObject({
      value: inside.reduce((s, b) => s + b.swaps, 0),
      unit: 'count',
    });
    // the window's hours up to the chain's last collected one (05:00): the current hour is not a gap
    expect(figures.get('gaps')).toMatchObject({ value: 23 - valued.length, unit: 'hours' });
    for (const figure of figures.values())
      expect(figure).toMatchObject({
        provenance: 'live',
        method: expect.stringContaining('bars-0.1'),
      });
  });

  it('a window the bars do not reach back to is not collected, with the hours missing', () => {
    // 30 days back from Oct 6 is Sep 6; the fixture's bars start on Sep 29 and none is older.
    const figures = priceHistoryFigures(bars, null, '30d', now, collected);
    const start = windowStart('30d', now).getTime();
    const missing = Math.round((Date.parse((bars[0] as BarRow).hour) - start) / HOUR);
    expect(missing).toBeGreaterThan(500);
    expect(figures).toEqual(
      BAR_KEYS.map((key) => ({ key, value: null, reason: 'not_collected', missingHours: missing })),
    );
    // An older bar before the window says the asset's history goes back further; the hours between
    // were quiet only where the chain was collected.
    const all = hoursBetween(start, (bars.at(-1) as BarRow).hour);
    expect(barCoverage(bars, '2026-08-01T00:00:00.000Z', '30d', now, all)).toEqual({
      covered: true,
      collectedHours: 720 - 1,
      missingHours: 0,
    });
    expect(barCoverage(bars, '2026-08-01T00:00:00.000Z', '30d', now, collected)).toEqual({
      covered: false,
      missingHours: missing,
    });
  });

  it('bars that stop short of now are not collected, never a part shown as the whole', () => {
    const later = new Date('2026-10-06T12:00:00.000Z');
    const figures = priceHistoryFigures(bars, null, '24h', later, collected);
    // the last bar ended at 06:00, six hours before
    expect(figures.every((f) => f.value === null && f.missingHours === 6)).toBe(true);
    expect(priceHistoryFigures([], null, '7d', now, collected)).toEqual(
      BAR_KEYS.map((key) => ({ key, value: null, reason: 'not_collected', missingHours: 168 })),
    );
  });

  it('reads the DEX bars in dollars only, never an oracle price', () => {
    // A row carrying more than the dollar columns: an oracle's price and the quote-token close.
    const odd = bars.map((bar) => ({ ...bar, oracleUsd: 1_000_000, closeQuote: 1_000_000 }));
    const figures = byKey(priceHistoryFigures(odd, null, '7d', now, collected));
    const last = bars.filter((bar) => bar.closeUsd !== null).at(-1) as BarRow;
    expect(figures.get('close')?.value).toBe(last.closeUsd);
    expect(figures.get('high')?.value).toBeLessThan(1_000_000);
    for (const figure of figures.values()) {
      if (figure.value === null) continue;
      expect(figure.source).toMatch(/^market_bars \(DEX swaps;/u);
      expect(`${figure.source} ${figure.method}`).not.toMatch(/oracle|scope|chainlink|pyth/iu);
    }
  });

  it('keeps one row an hour, the later method version', () => {
    const last = bars.at(-1) as BarRow;
    const again = { ...last, methodVersion: 'bars-0.2', closeUsd: (last.closeUsd as number) * 2 };
    const figures = byKey(priceHistoryFigures([...bars, again], null, '24h', now, collected));
    expect(figures.get('close')?.value).toBe(again.closeUsd);
  });

  it('orders method versions by their numbers: bars-0.10 is later than bars-0.9', () => {
    const last = bars.at(-1) as BarRow;
    const nine = { ...last, methodVersion: 'bars-0.9', closeUsd: 1 };
    const ten = { ...last, methodVersion: 'bars-0.10', closeUsd: 2 };
    for (const rows of [
      [...bars, nine, ten],
      [...bars, ten, nine],
    ])
      expect(
        byKey(priceHistoryFigures(rows, null, '24h', now, collected)).get('close')?.value,
      ).toBe(2);
    expect(compareVersions('bars-0.10', 'bars-0.9')).toBeGreaterThan(0);
    expect(compareVersions('bars-1.0', 'bars-0.12')).toBeGreaterThan(0);
    expect(compareVersions('bars-0.1', 'bars-0.1')).toBe(0);
  });
});

describe("price history: an hour the chain's collector did not run is never a quiet hour", () => {
  // The Robinhood Chain outage in the local data: no asset of the chain has a bar from Oct 6 03:00 to
  // Oct 8 23:00 (69 hours). A week read on Oct 10 at 00:30 spans it.
  const now = new Date('2026-10-10T00:30:00.000Z');
  const start = windowStart('7d', now).getTime();
  const outage = new Set(hoursBetween('2026-10-06T03:00:00.000Z', '2026-10-08T23:00:00.000Z'));
  const week = hoursBetween(start, '2026-10-10T00:00:00.000Z');
  const template = bars.find((bar) => bar.closeUsd !== null && bar.volumeUsd !== null) as BarRow;
  const asset = (hours: string[]): BarRow[] => hours.map((hour) => ({ ...template, hour }));

  it('a window with an outage is not collected, with the outage hours missing', () => {
    const served = week.filter((hour) => !outage.has(hour));
    expect(outage.size).toBe(69);
    // the asset's bars on every hour the chain has any: its history starts before the window
    const figures = priceHistoryFigures(
      asset(served),
      '2026-10-01T00:00:00.000Z',
      '7d',
      now,
      served,
    );
    expect(figures).toEqual(
      BAR_KEYS.map((key) => ({ key, value: null, reason: 'not_collected', missingHours: 69 })),
    );
  });

  it('a quiet hour, where the chain has bars and this asset none, is a gap', () => {
    const quiet = week.filter((hour) => !outage.has(hour));
    const figures = byKey(
      priceHistoryFigures(asset(quiet), '2026-10-01T00:00:00.000Z', '7d', now, week),
    );
    expect(figures.get('gaps')).toMatchObject({ value: 69, unit: 'hours' });
    expect(figures.get('swaps')).toMatchObject({ value: quiet.length * template.swaps });
  });

  it('the tolerated tail after the chain’s last collected hour is not a gap', () => {
    // collected to 23:00 on Oct 9; the hour of 00:00 has not ended: neither covered nor a gap
    const upTo = week.slice(0, -1);
    const figures = byKey(
      priceHistoryFigures(asset(upTo), '2026-10-01T00:00:00.000Z', '7d', now, upTo),
    );
    expect(figures.get('gaps')).toMatchObject({ value: 0 });
    // past the tolerance it is not collected
    const late = new Date('2026-10-10T02:30:00.000Z');
    expect(barCoverage(asset(upTo), null, '7d', late, upTo)).toEqual({
      covered: false,
      missingHours: 3,
    });
  });
});

describe('a window with up to 5% of its hours not collected is shown, with the count (HOURLY-BARS, Oct 22)', () => {
  // A week read on Oct 10 at 00:30: 168 hours from Oct 3 01:00 to Oct 10 00:00, the asset's bar in every
  // hour the chain was collected, its history older than the window.
  const now = new Date('2026-10-10T00:30:00.000Z');
  const week = hoursBetween(windowStart('7d', now).getTime(), '2026-10-10T00:00:00.000Z');
  const template = bars.find((bar) => bar.closeUsd !== null && bar.volumeUsd !== null) as BarRow;
  const asset = (hours: string[]): BarRow[] => hours.map((hour) => ({ ...template, hour }));
  const old = '2026-10-01T00:00:00.000Z';
  /** The window's hours with `n` hours of the chain's collector down, from the window's middle. */
  const down = (hours: string[], n: number) => {
    const from = Math.floor(hours.length / 2);
    return hours.filter((_, at) => at < from || at >= from + n);
  };

  it('tolerates 5% of the hours, rounded down: 1 of 24, 8 of 168, 36 of 720', () => {
    expect(maxMissingHours('24h')).toBe(1);
    expect(maxMissingHours('7d')).toBe(8);
    expect(maxMissingHours('30d')).toBe(36);
  });

  it('exactly 5% missing is covered; every figure says how many hours of the window are missing', () => {
    const served = down(week, 8);
    expect(week).toHaveLength(168);
    expect(barCoverage(asset(served), old, '7d', now, served)).toEqual({
      covered: true,
      collectedHours: 160,
      missingHours: 8,
    });
    const figures = priceHistoryFigures(asset(served), old, '7d', now, served);
    for (const figure of figures) {
      expect(figure.value).not.toBeNull();
      expect(figure).toMatchObject({
        missingHours: 8,
        windowHours: 168,
        method: expect.stringContaining('no more than 5% of its hours were not collected'),
      });
    }
    const got = byKey(figures);
    // the figures are the bars that exist: the missing hours are neither swaps nor gaps
    expect(got.get('swaps')).toMatchObject({ value: 160 * template.swaps });
    expect(got.get('gaps')).toMatchObject({ value: 0 });
  });

  it('one hour past 5% is withheld, every figure not collected with the hours missing', () => {
    const served = down(week, 9);
    expect(barCoverage(asset(served), old, '7d', now, served)).toEqual({
      covered: false,
      missingHours: 9,
    });
    expect(priceHistoryFigures(asset(served), old, '7d', now, served)).toEqual(
      BAR_KEYS.map((key) => ({ key, value: null, reason: 'not_collected', missingHours: 9 })),
    );
  });

  it('a day tolerates one hour and not two; a month 36 and not 37', () => {
    const day = week.slice(-24);
    expect(barCoverage(asset(down(day, 1)), old, '24h', now, down(day, 1))).toMatchObject({
      covered: true,
      missingHours: 1,
    });
    expect(barCoverage(asset(down(day, 2)), old, '24h', now, down(day, 2))).toEqual({
      covered: false,
      missingHours: 2,
    });
    const month = hoursBetween(windowStart('30d', now).getTime(), '2026-10-10T00:00:00.000Z');
    expect(month).toHaveLength(720);
    expect(barCoverage(asset(down(month, 36)), old, '30d', now, down(month, 36))).toEqual({
      covered: true,
      collectedHours: 684,
      missingHours: 36,
    });
    expect(barCoverage(asset(down(month, 37)), old, '30d', now, down(month, 37))).toEqual({
      covered: false,
      missingHours: 37,
    });
  });

  it("a history that starts inside the window counts its hours before the asset's first bar", () => {
    const late = week.slice(8);
    expect(barCoverage(asset(late), null, '7d', now, week)).toMatchObject({
      covered: true,
      missingHours: 8,
    });
    expect(barCoverage(asset(week.slice(9)), null, '7d', now, week)).toEqual({
      covered: false,
      missingHours: 9,
    });
  });

  it('a complete window carries no count', () => {
    for (const figure of priceHistoryFigures(asset(week), old, '7d', now, week)) {
      expect(figure).not.toHaveProperty('missingHours');
      expect(figure).not.toHaveProperty('windowHours');
    }
  });

  it('freshness stays strict: within the 5%, bars that stop more than two hours short of now are withheld', () => {
    // one hour missing in the middle (tolerated) and the chain's bars end at 23:00: fine at 00:30
    const served = down(week, 1).slice(0, -1);
    expect(barCoverage(asset(served), old, '7d', now, served)).toMatchObject({
      covered: true,
      missingHours: 1,
    });
    // at 02:30 the last hour ended three and a half hours before: withheld, the stale hours counted
    const later = new Date('2026-10-10T02:30:00.000Z');
    expect(barCoverage(asset(served), old, '7d', later, served)).toMatchObject({
      covered: false,
    });
    expect(
      priceHistoryFigures(asset(served), old, '7d', later, served).every(
        (f) => f.value === null && f.reason === 'not_collected',
      ),
    ).toBe(true);
  });

  it('no bar of the asset in the window is withheld, whatever the chain holds', () => {
    expect(barCoverage([], old, '7d', now, week)).toEqual({ covered: false, missingHours: 168 });
  });

  it('the mid bars of a Solana token: up to 5% of the hours the mid collector did not run, its own bars current', () => {
    const mids = (hours: string[]): BarRow[] =>
      hours.map((hour) => ({ ...template, hour, methodVersion: 'mids-0.1' }));
    const day = week.slice(-24);
    // an hour neither the swap collector nor the mid collector ran
    const one = down(day, 1);
    expect(midCoverage(mids(one), old, '24h', now, [], one)).toMatchObject({
      covered: true,
      missingHours: 1,
    });
    const close = byKey(priceHistoryFigures(mids(one), old, '24h', now, [], one)).get('close');
    expect(close).toMatchObject({ missingHours: 1, windowHours: 24 });
    expect(midCoverage(mids(down(day, 2)), old, '24h', now, [], down(day, 2))).toEqual({
      covered: false,
      missingHours: 2,
    });
    // the chain's mids go on, but this token's own stopped three hours before: withheld
    const ownStops = day.slice(0, -3);
    expect(midCoverage(mids(ownStops), old, '24h', now, [], day)).toMatchObject({
      covered: false,
    });
  });

  it("a pool's day volume over a covered day with an hour missing carries the count", () => {
    const at = new Date('2026-10-06T06:30:00.000Z');
    const dayHours = collected.filter(
      (hour) => Date.parse(hour) >= windowStart('24h', at).getTime(),
    );
    const holed = down(dayHours, 1);
    const coverage = barCoverage(
      bars.filter((bar) => holed.includes(bar.hour)),
      null,
      '24h',
      at,
      holed,
    );
    expect(coverage).toMatchObject({ covered: true, missingHours: 1 });
    const { pools: served } = poolFigures(pools.reading, pools.poolBars, coverage, at);
    expect(byKey((served[0] as (typeof served)[number]).figures).get('volume')).toMatchObject({
      unit: 'usd',
      missingHours: 1,
      windowHours: 24,
      method: expect.stringContaining('no more than 5%'),
    });
  });
});

describe('pools: by dollars held, at most five', () => {
  const now = new Date('2026-10-06T06:30:00.000Z');
  const day = barCoverage(
    bars.filter((bar) => Date.parse(bar.hour) >= windowStart('24h', now).getTime()),
    null,
    '24h',
    now,
    collected,
  );

  it('serves the five largest with their TVL, share and day volume, the reading aged', () => {
    const { pools: served, missing } = poolFigures(pools.reading, pools.poolBars, day, now);
    expect(missing).toBeNull();
    const listed = pools.reading.detail?.pools as Array<{ address: string; tvlUsd: number }>;
    expect(listed.length).toBeGreaterThan(MAX_POOLS);
    expect(served.map((p) => p.pool)).toEqual(listed.slice(0, MAX_POOLS).map((p) => p.address));
    expect(served.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
    const age = Math.floor((now.getTime() - Date.parse(pools.reading.observedAt)) / 1_000);
    const top = byKey((served[0] as (typeof served)[number]).figures);
    expect(top.get('tvl')).toMatchObject({ value: listed[0]?.tvlUsd, staleAgeSec: age });
    expect(top.get('share')).toMatchObject({
      value: (listed[0]?.tvlUsd as number) / (pools.reading.value as number),
      unit: 'fraction',
      staleAgeSec: age,
    });
    const own = pools.poolBars.filter(
      (bar) =>
        bar.pool === listed[0]?.address &&
        Date.parse(bar.hour) >= now.getTime() - 24 * HOUR &&
        bar.volumeUsd !== null,
    );
    expect(top.get('volume')?.value).toBeCloseTo(
      own.reduce((s, b) => s + (b.volumeUsd as number), 0),
      6,
    );
  });

  it('a day the bars do not cover leaves the volume not collected; no reading leaves the pools out', () => {
    const late = new Date('2026-10-06T12:00:00.000Z');
    const stale = barCoverage(bars, null, '24h', late, collected);
    const { pools: served } = poolFigures(pools.reading, pools.poolBars, stale, late);
    expect(byKey((served[0] as (typeof served)[number]).figures).get('volume')).toEqual({
      key: 'volume',
      value: null,
      reason: 'not_collected',
      missingHours: 6,
    });
    expect(poolFigures(null, [], day, now)).toEqual({
      pools: [],
      missing: { key: 'tvl', value: null, reason: 'not_collected' },
    });
    const none = { ...pools.reading, value: null, nullReason: 'no_registered_pool', detail: {} };
    // A sum that left a pool out is a lower bound: no pool's share of it is served, its TVL is.
    const partial = { ...pools.reading, detail: { ...pools.reading.detail, lowerBound: true } };
    const [top] = poolFigures(partial, pools.poolBars, day, now).pools;
    const f = byKey(top?.figures ?? []);
    expect(f.get('share')).toEqual({ key: 'share', value: null, reason: 'not_collected' });
    const listed = pools.reading.detail?.pools as Array<{ tvlUsd: number }>;
    expect(f.get('tvl')).toMatchObject({ value: listed[0]?.tvlUsd });
    expect(poolFigures(none, [], day, now).missing).toEqual({
      key: 'tvl',
      value: null,
      reason: 'not_collected',
    });
  });
});

describe('lending: per market, from the report’s sheets', () => {
  it('serves the supply and borrow rate, the share lent out and what can be withdrawn now', () => {
    const now = new Date('2026-10-14T14:00:00.000Z');
    const markets = lendingFigures(lending, now);
    expect(markets.map((m) => m.account)).toEqual([...lending.map((m) => m.account)].sort());
    // each a Jupiter Lend vault that takes NVDAx as collateral and lends a dollar token: the rates are
    // that token's
    expect(markets.map((m) => [m.market, m.lent, m.collateral, m.lends])).toEqual([
      ['Jupiter Lend NVDAx/JupUSD', 'JupUSD', 'NVDAx', false],
      ['Jupiter Lend NVDAx/USDC', 'USDC', 'NVDAx', false],
    ]);
    // read for the token it lends (by its debt mint), the same vault's figures are that token's
    expect(
      lendingFigures([{ ...(lending[0] as LendingMarketRow), lends: true }], now)[0]?.lends,
    ).toBe(true);
    for (const market of markets) {
      const sheet = (lending.find((m) => m.account === market.account) as LendingMarketRow).sheet;
      const f = byKey(market.figures);
      expect(f.get('supply')).toMatchObject({
        value: sheet.rates.supplyApy.value,
        unit: 'fraction',
      });
      expect(f.get('borrow')).toMatchObject({ value: sheet.rates.borrowApy.value });
      expect(f.get('util')).toMatchObject({ value: sheet.withdrawal.shareLentOut.value });
      expect(f.get('withdrawable')).toMatchObject({
        value: sheet.withdrawal.availableUsd.value,
        unit: 'usd',
      });
      // read at 13:11, an hour of the report's: fresh
      expect(f.get('supply')).not.toHaveProperty('staleAgeSec');
    }
  });

  it('a sheet three reports old carries its age; a missing fact keeps its reason', () => {
    const later = new Date('2026-10-15T14:00:00.000Z');
    const market = lending[0] as LendingMarketRow;
    const sheet = {
      ...market.sheet,
      withdrawal: {
        ...market.sheet.withdrawal,
        availableUsd: { value: null, reason: 'not_collected' as const, unit: 'usd' as const },
      },
    };
    const [one] = lendingFigures([{ ...market, sheet }], later);
    const f = byKey(one?.figures ?? []);
    expect(f.get('supply')).toHaveProperty('staleAgeSec');
    expect(f.get('withdrawable')).toEqual({
      key: 'withdrawable',
      value: null,
      reason: 'not_collected',
    });
  });
});

describe('lending: whether a market lends the token it was read for', () => {
  it('says what the row says, or by its role: a vault or a collateral pool takes the token as collateral', () => {
    expect(lendsIt({ role: 'vault' })).toBe(false);
    expect(lendsIt({ role: 'collateral' })).toBe(false);
    expect(lendsIt({ role: 'debt' })).toBe(true);
    expect(lendsIt({ role: 'curated_vault' })).toBe(true);
    expect(lendsIt({ role: 'vault', lends: true })).toBe(true);
  });
});

describe('lending: the token whose rates a market holds', () => {
  const market = lending[0] as LendingMarketRow;
  it('reads it from the row, or from the sheet’s symbol; a symbol with a digit is not named', () => {
    expect(lentOf(market)).toEqual({ lent: 'JupUSD', collateral: 'NVDAx' });
    expect(lentOf({ ...market, lent: 'USDC' })).toEqual({ lent: 'USDC', collateral: 'NVDAx' });
    const reserve = { ...market, role: 'debt', sheet: { ...market.sheet, symbol: 'PYUSD' } };
    expect(lentOf(reserve)).toEqual({ lent: 'PYUSD', collateral: null });
    expect(lentOf({ ...market, lent: 'USDT0' })).toEqual({ lent: null, collateral: 'NVDAx' });
  });
});
