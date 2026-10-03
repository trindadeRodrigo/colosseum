import { etParts, type Regime } from '../time';

/**
 * Market risk from the reference price (PLAN-ANALYTICS item 12): volatility, drawdown, the correlation between
 * legs, and how often the price gapped over a weekend. Pure functions over the hourly rows of
 * `risk_reference_prices` (Step 11), oldest first. Every result carries its sample count and dates; nothing is
 * extrapolated: a gap never seen is a measured zero with the number of weekends behind it.
 */
export type PricePoint = {
  /** The hour (ISO 8601). */
  at: string;
  priceUsd: number;
  regime: Regime;
  /** Step 11's quality: traded | oracle_open | oracle_closed | oracle_continuous | external | par. */
  quality: string | null;
};

export type DailyClose = { date: string; at: string; priceUsd: number };

/** The last market-hours price of each US trading day (ET date). Hours outside market hours are not used. */
export function dailyCloses(series: PricePoint[]): DailyClose[] {
  const byDate = new Map<string, DailyClose>();
  for (const p of series) {
    if (p.regime !== 'us_market_hours' || !(p.priceUsd > 0)) continue;
    const date = etParts(new Date(p.at)).date;
    const prev = byDate.get(date);
    if (!prev || p.at > prev.at) byDate.set(date, { date, at: p.at, priceUsd: p.priceUsd });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export const logReturns = (closes: DailyClose[]): Array<{ date: string; r: number }> =>
  closes.slice(1).map((c, i) => ({
    date: c.date,
    r: Math.log(c.priceUsd / (closes[i] as DailyClose).priceUsd),
  }));

/** Sample standard deviation of daily log returns × √tradingDays; null below `minReturns` returns. */
export function volatilityAnnual(
  closes: DailyClose[],
  opts: { tradingDays: number; minReturns: number },
): { value: number; samples: number } | null {
  const rs = logReturns(closes).map((x) => x.r);
  if (rs.length < opts.minReturns || rs.length < 2) return null;
  const mean = rs.reduce((a, x) => a + x, 0) / rs.length;
  const v = rs.reduce((a, x) => a + (x - mean) ** 2, 0) / (rs.length - 1);
  return { value: Math.sqrt(v * opts.tradingDays), samples: rs.length };
}

/** Largest fall from a running peak, 1 − P_t ÷ max(P_s, s ≤ t), on daily closes; with the peak and trough dates. */
export function maxDrawdown(
  closes: DailyClose[],
  minCloses: number,
): { value: number; samples: number; peak: string; trough: string } | null {
  if (closes.length < minCloses || closes.length === 0) return null;
  let peak = closes[0] as DailyClose;
  let best = { value: 0, peak: peak.date, trough: peak.date };
  for (const c of closes) {
    if (c.priceUsd > peak.priceUsd) peak = c;
    const dd = 1 - c.priceUsd / peak.priceUsd;
    if (dd > best.value) best = { value: dd, peak: peak.date, trough: c.date };
  }
  return { ...best, samples: closes.length };
}

export type WeekendGap = {
  /** Last market-hours hour before the weekend, and the first after it. */
  closeAt: string;
  openAt: string;
  gap: number;
};

/**
 * Each weekend's move: the last market-hours price before a stretch of closed hours that contains a weekend hour,
 * against the first market-hours price after it, `open ÷ close − 1`. A long weekend (a Monday holiday) is one gap.
 * A stretch with no market-hours price on either side (the start or end of the data) is not counted.
 */
export function weekendGaps(series: PricePoint[]): WeekendGap[] {
  const out: WeekendGap[] = [];
  let close: PricePoint | null = null;
  let sawWeekend = false;
  for (const p of series) {
    if (!(p.priceUsd > 0)) continue;
    if (p.regime === 'us_market_hours') {
      if (close && sawWeekend)
        out.push({ closeAt: close.at, openAt: p.at, gap: p.priceUsd / close.priceUsd - 1 });
      close = p;
      sawWeekend = false;
    } else if (p.regime === 'weekend') sawWeekend = true;
  }
  return out;
}

/** Share of weekends whose move exceeded each gap (in either direction), with the count behind it. */
export function gapFrequency(
  gaps: WeekendGap[],
  gapGridPct: readonly number[],
  minWeekends: number,
): Array<
  | { gapPct: number; share: number; seen: number; weekends: number }
  | { gapPct: number; weekends: number }
> {
  return gapGridPct.map((gapPct) => {
    if (gaps.length < minWeekends) return { gapPct, weekends: gaps.length };
    const seen = gaps.filter((g) => Math.abs(g.gap) > gapPct / 100).length;
    return { gapPct, share: seen / gaps.length, seen, weekends: gaps.length };
  });
}

/** Pearson correlation of two assets' daily log returns on the dates both have; null below `minReturns`. */
export function correlation(
  a: DailyClose[],
  b: DailyClose[],
  minReturns: number,
): { value: number; samples: number } | null {
  const rb = new Map(logReturns(b).map((x) => [x.date, x.r]));
  const pairs = logReturns(a)
    .filter((x) => rb.has(x.date))
    .map((x) => [x.r, rb.get(x.date) as number] as const);
  if (pairs.length < minReturns || pairs.length < 3) return null;
  const n = pairs.length;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / n;
  const mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (const [x, y] of pairs) {
    cov += (x - ma) * (y - mb);
    va += (x - ma) ** 2;
    vb += (y - mb) ** 2;
  }
  if (!(va > 0) || !(vb > 0)) return null;
  return { value: cov / Math.sqrt(va * vb), samples: n };
}

/**
 * Daily closes of a plan held at fixed weights (rebalanced daily), on the dates every leg has: the index starts at
 * 1 and grows by the weighted simple return of the legs. Used for the plan's volatility and drawdown.
 */
export function planCloses(legs: Array<{ weight: number; closes: DailyClose[] }>): DailyClose[] {
  if (!legs.length) return [];
  const maps = legs.map((l) => new Map(l.closes.map((c) => [c.date, c])));
  const dates = [...(maps[0] as Map<string, DailyClose>).keys()]
    .filter((d) => maps.every((m) => m.has(d)))
    .sort();
  const out: DailyClose[] = [];
  let level = 1;
  dates.forEach((d, i) => {
    if (i > 0) {
      const prev = dates[i - 1] as string;
      level *=
        1 +
        legs.reduce((s, l, k) => {
          const m = maps[k] as Map<string, DailyClose>;
          return (
            s +
            l.weight *
              ((m.get(d) as DailyClose).priceUsd / (m.get(prev) as DailyClose).priceUsd - 1)
          );
        }, 0);
    }
    out.push({
      date: d,
      at: ((maps[0] as Map<string, DailyClose>).get(d) as DailyClose).at,
      priceUsd: level,
    });
  });
  return out;
}
