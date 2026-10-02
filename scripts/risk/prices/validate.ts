import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSessionClock,
  defaultLivenessParams,
  defaultRegimeParams,
  etParts,
  markLiveness,
  openSecondsBetween,
  type Regime,
  regimeAt,
  type SessionClock,
} from '@colosseum/risk';
import { LENDING_HISTORY_DIR, RISK_HOME, USDC } from '../lib-lending';
import {
  PRICES_DIR,
  PRICES_METHOD_VERSION,
  readJsonl,
  readObservations,
  type StoredObservation,
} from './lib';

// Step 11 item 2 — can the logged oracle prices be trusted, and how old may one be? Reads the observation files
// of item 1 (`pnpm risk:prices-extract`) and the collectors' files; fetches nothing. A failed check is a finding:
// it is reported with its numbers and no tolerance is widened to pass it.
//   P-1  coverage: observations per asset, time between consecutive ones, and the share of hours that have an
//        observation no older than each candidate limit (all hours, and US market hours only)
//   P-2  extraction: a logged klend price equals the reserve's stored price at the same refresh slot (read live by
//        the collector); a Jupiter Lend return agrees with the protocol API's oracle price at the nearest hour; the
//        same asset refreshed in two Kamino markets in one slot has one price
//   P-3  overlap: each lending oracle against Step 5b's hourly pool mid, by asset and regime
//   P-4  unit: in US market hours the oracles and the pool mid agree far inside the token's multiplier
//   P-5  calendar: on each closed date no stock's Scope price changes; and how often it changes in each regime
// Output: data/risk/prices/validate-<stamp>.json. Usage: tsx scripts/risk/prices/validate.ts
const METHOD = 'prices-validate-0.1';
const P = {
  /** Candidate staleness limits on wall clock, seconds (assets priced around the clock). */
  ageGridSec: [900, 1800, 3600, 7200, 14400, 21600, 86400],
  /** Candidate limits on market time, seconds of US market hours since the observation (stock oracles). */
  openAgeGridSec: [900, 1800, 3600, 7200, 14400],
  /** Oldest stock-oracle observation accepted across a closure, seconds. */
  maxClosedAgeSec: 4 * 86400,
  /** P-3 compares a pool mid with an oracle observation at most this old. */
  overlapMaxAgeSec: 3600,
  /** P-2: klend prints four decimals. */
  logDecimalsTol: 1e-4,
  /** P-2: a Jupiter Lend return and an API row are compared when at most this far apart. */
  apiMatchSec: 1800,
  /** P-4: the median market-hours gap must be under this share of (multiplier − 1). */
  unitShareOfMultiplier: 0.5,
};
const calendar = JSON.parse(
  readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
) as { closed: string[]; earlyClose13ET: string[] };
const RP = defaultRegimeParams(calendar);
const regimeOf = (t: number) => regimeAt(new Date(t * 1000), RP);
const q = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
};
const r6 = (x: number | null) => (x === null ? null : +x.toFixed(6));

type LendingRow = {
  account: string;
  venue: string;
  market: string;
  marketName: string | null;
  mint: string | null;
  symbol: string | null;
  dexAssetMint: string | null;
};
const lreg = JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
  rows: LendingRow[];
};
const symbolOf = new Map<string, string>();
const stocks = new Set<string>();
for (const r of lreg.rows) {
  if (r.mint && r.symbol && r.venue !== 'kamino_vault') symbolOf.set(r.mint, r.symbol);
  if (r.mint && r.dexAssetMint) stocks.add(r.mint);
}
const sym = (m: string) => symbolOf.get(m) ?? m.slice(0, 8);

// ------------------------------------------------------------------------------------------------- load
const by = new Map<string, StoredObservation[]>();
for (const o of readObservations()) {
  const k = `${o.priceSource}|${o.method}`;
  const a = by.get(k);
  if (a) a.push(o);
  else by.set(k, [o]);
}
for (const a of by.values()) a.sort((x, y) => x.t - y.t || (x.slot ?? 0) - (y.slot ?? 0));
const kLog = by.get('kamino_scope|klend_refresh_log') ?? [];
const jLog = by.get('jupiter_lend_oracle|jl_oracle_return') ?? [];
const poolH = by.get('pool_mid|pool_hourly_mid') ?? [];
const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const a = m.get(k);
    if (a) a.push(x);
    else m.set(k, [x]);
  }
  return m;
};
/** Latest element at or before t in a list sorted by t. */
const latestAt = (a: StoredObservation[], t: number) => {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((a[m] as StoredObservation).t <= t) lo = m + 1;
    else hi = m;
  }
  return lo > 0 ? (a[lo - 1] as StoredObservation) : null;
};

const checks: Array<{ check: string; status: 'pass' | 'finding'; note: string }> = [];

// ------------------------------------------------------------------------------------------------- P-1
// liveness of each stock oracle series, one asset, source and quote at a time; flags are written on the observations
const LP = defaultLivenessParams();
const liveness = [];
for (const [key, a] of groupBy(
  [...kLog, ...jLog].filter((o) => stocks.has(o.mint)),
  (o) => `${o.priceSource}|${o.mint}|${o.quote}`,
)) {
  const [priceSource, mint, quote] = key.split('|') as [string, string, string];
  const L = markLiveness(a, RP, LP);
  L.live.forEach((v, i) => {
    if (!v) (a[i] as StoredObservation).live = false;
  });
  liveness.push({
    oracle: `${priceSource} ${sym(mint)}${quote === 'usd' ? '' : quote === USDC ? '/USDC' : '/JupUSD'}`,
    observations: a.length,
    notLive: L.live.filter((v) => !v).length,
    frozenDays: L.frozenDays.length,
    firstFrozen: L.frozenDays[0] ?? null,
    lastFrozen: L.frozenDays.at(-1) ?? null,
    liveFrom: L.liveFrom === null ? null : new Date(L.liveFrom * 1000).toISOString(),
  });
}
liveness.sort((a, b) => a.oracle.localeCompare(b.oracle));
const neverLive = liveness.filter((l) => l.liveFrom === null);
checks.push({
  check: 'P-1 every stock oracle prices the stock (moves within US trading days)',
  status: liveness.every((l) => l.frozenDays === 0) ? 'pass' : 'finding',
  note: liveness
    .filter((l) => l.frozenDays > 0)
    .map(
      (l) => `${l.oracle}: ${l.frozenDays} frozen trading days ${l.firstFrozen} → ${l.lastFrozen}`,
    )
    .concat(neverLive.map((l) => `${l.oracle}: never live`))
    .join('; '),
});

// coverage under the standard's rule: a stock oracle is judged on market time, anything else on wall clock
const clockFrom = (kLog[0] as StoredObservation).t - 86400;
const clockTo = Math.floor(Date.now() / 1000) + 86400;
const clocks = {
  kamino_scope: buildSessionClock(clockFrom, clockTo, RP, 'us_market_hours'),
  jupiter_lend_oracle: buildSessionClock(clockFrom, clockTo, RP, 'us_weekdays'),
};
function coverage(obs: StoredObservation[], clock: SessionClock) {
  const out = [];
  for (const [mint, a] of groupBy(obs, (o) => o.mint)) {
    const session = stocks.has(mint);
    const grid = session ? P.openAgeGridSec : P.ageGridSec;
    const first = (a[0] as StoredObservation).t;
    const last = (a.at(-1) as StoredObservation).t;
    const gaps: number[] = [];
    for (let i = 1; i < a.length; i++)
      gaps.push((a[i] as StoredObservation).t - (a[i - 1] as StoredObservation).t);
    const cov = Object.fromEntries(grid.map((x) => [x, { all: 0, open: 0 }]));
    let hours = 0;
    let openHours = 0;
    let notLive = 0;
    for (let h = Math.ceil(first / 3600) * 3600; h <= last; h += 3600) {
      const o = latestAt(a, h);
      if (!o) continue;
      hours++;
      const open = regimeOf(h) === 'us_market_hours';
      if (open) openHours++;
      if (o.live === false) {
        notLive++;
        continue;
      }
      const age = h - o.t;
      const openAge = session ? openSecondsBetween(clock, o.t, h) : null;
      for (const x of grid)
        if (openAge === null ? age <= x : openAge <= x && age <= P.maxClosedAgeSec) {
          (cov[x] as { all: number; open: number }).all++;
          if (open) (cov[x] as { all: number; open: number }).open++;
        }
    }
    out.push({
      asset: sym(mint),
      mint,
      rule: session ? `session:${clock.session}` : 'wall_clock',
      observations: a.length,
      first: new Date(first * 1000).toISOString(),
      last: new Date(last * 1000).toISOString(),
      perDayMedian: q(
        [...groupBy(a, (o) => String(Math.floor(o.t / 86400))).values()].map((x) => x.length),
        0.5,
      ),
      gapSec: { p50: q(gaps, 0.5), p90: q(gaps, 0.9), p99: q(gaps, 0.99), max: q(gaps, 1) },
      hours,
      openHours,
      notLiveHours: notLive,
      hourCoverage: Object.fromEntries(
        grid.map((x) => {
          const c = cov[x] as { all: number; open: number };
          return [
            x,
            {
              all: r6(hours ? c.all / hours : null),
              open: r6(openHours ? c.open / openHours : null),
            },
          ];
        }),
      ),
    });
  }
  return out.sort((a, b) => a.asset.localeCompare(b.asset));
}
const p1 = {
  kamino_scope: coverage(kLog, clocks.kamino_scope),
  jupiter_lend_oracle: coverage(jLog, clocks.jupiter_lend_oracle),
};

// ------------------------------------------------------------------------------------------------- P-2
// (a) klend log = the reserve's stored price at the same refresh slot, as the collector read it later
const cutSlot = (
  JSON.parse(readFileSync(join(LENDING_HISTORY_DIR, 'hourly', 'summary.json'), 'utf8')) as {
    window: { cutSlot: number };
  }
).window.cutSlot;
const kByRefSlot = new Map<string, number[]>();
for (const o of kLog) {
  const k = `${o.ref}|${o.slot}`;
  const a = kByRefSlot.get(k);
  if (a) a.push(o.price);
  else kByRefSlot.set(k, [o.price]);
}
const liveDir = join(RISK_HOME, 'lending');
const stored = new Map<string, { price: number; symbol: string }>();
for (const f of readdirSync(liveDir)
  .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
  .sort())
  for (const r of readJsonl<Record<string, unknown>>(join(liveDir, f))) {
    if (r.kind !== 'kamino_reserve') continue;
    const slot = Number(r.lastUpdateSlot);
    const price = Number(r.oraclePriceUsd);
    if (!(slot > 0) || slot > cutSlot || !(price > 0)) continue;
    stored.set(`${r.account}|${slot}`, { price, symbol: String(r.symbol) });
  }
const p2a = {
  refreshes: stored.size,
  found: 0,
  equal: 0,
  notInHistory: 0,
  mismatches: [] as unknown[],
};
for (const [k, s] of stored) {
  const logged = kByRefSlot.get(k);
  if (!logged) {
    p2a.notInHistory++;
    continue;
  }
  p2a.found++;
  if (logged.some((x) => Math.abs(x - s.price) <= P.logDecimalsTol)) p2a.equal++;
  else p2a.mismatches.push({ reserveSlot: k, symbol: s.symbol, stored: s.price, logged });
}
checks.push({
  check: 'P-2a klend log = reserve price at the refresh slot',
  status: p2a.found > 0 && p2a.equal === p2a.found ? 'pass' : 'finding',
  note: `${p2a.equal}/${p2a.found} equal within ${P.logDecimalsTol}; ${p2a.notInHistory} of ${p2a.refreshes} refresh slots are not in the fetched history (a refresh alone touches no vault)`,
});

// (b) Jupiter Lend return vs the protocol API's oracle price in the hourly market rows
const jByVault = groupBy(jLog, (o) => o.ref);
const marketsDir = join(RISK_HOME, 'markets');
const apiDiffs: number[] = [];
let apiRows = 0;
for (const f of readdirSync(marketsDir)
  .filter((n) => n.endsWith('.jsonl'))
  .sort())
  for (const r of readJsonl<{
    venue: string;
    account: string;
    fetchedAt: string;
    api?: { oraclePriceOperate?: string | number };
  }>(join(marketsDir, f))) {
    if (r.venue !== 'jupiter_lend' || !r.api?.oraclePriceOperate) continue;
    apiRows++;
    const a = jByVault.get(r.account);
    if (!a) continue;
    const t = Math.floor(Date.parse(r.fetchedAt) / 1000);
    let best: StoredObservation | null = null;
    for (const o of a)
      if (Math.abs(o.t - t) <= P.apiMatchSec && (!best || Math.abs(o.t - t) < Math.abs(best.t - t)))
        best = o;
    if (best) apiDiffs.push(best.price / (Number(r.api.oraclePriceOperate) / 1e15) - 1);
  }
const p2b = {
  apiRows,
  compared: apiDiffs.length,
  medianAbs: r6(q(apiDiffs.map(Math.abs), 0.5)),
  maxAbs: r6(q(apiDiffs.map(Math.abs), 1)),
  matchSec: P.apiMatchSec,
};
checks.push({
  check: 'P-2b Jupiter Lend return vs API oracle price',
  status: p2b.compared > 0 && (p2b.maxAbs ?? 1) < 0.01 ? 'pass' : 'finding',
  note: `${p2b.compared} pairs within ${P.apiMatchSec}s: median |diff| ${p2b.medianAbs}, max ${p2b.maxAbs}`,
});

// (c) one asset, two Kamino markets, one slot: one price
const bySlotMint = groupBy(kLog, (o) => `${o.mint}|${o.slot}`);
const p2c = { slotsWithTwoMarkets: 0, differing: 0, maxRelDiff: 0 };
for (const a of bySlotMint.values()) {
  if (new Set(a.map((o) => o.market)).size < 2) continue;
  p2c.slotsWithTwoMarkets++;
  const lo = Math.min(...a.map((o) => o.price));
  const hi = Math.max(...a.map((o) => o.price));
  if (hi - lo > P.logDecimalsTol) {
    p2c.differing++;
    p2c.maxRelDiff = Math.max(p2c.maxRelDiff, hi / lo - 1);
  }
}
checks.push({
  check: 'P-2c one price per asset and slot across Kamino markets',
  status: p2c.differing === 0 ? 'pass' : 'finding',
  note: `${p2c.differing} of ${p2c.slotsWithTwoMarkets} shared slots differ (max ${r6(p2c.maxRelDiff)})`,
});

// ------------------------------------------------------------------------------------------------- P-3
const kByMint = groupBy(kLog, (o) => o.mint);
const jByMintQuote = groupBy(jLog, (o) => `${o.mint}|${o.quote}`);
type Cell = { gaps: number[]; ages: number[] };
const cells = new Map<string, Cell>();
const addGap = (label: string, regime: Regime, gap: number, age: number) => {
  const k = `${label}|${regime}`;
  const c = cells.get(k) ?? { gaps: [], ages: [] };
  c.gaps.push(gap);
  c.ages.push(age);
  cells.set(k, c);
};
for (const m of poolH) {
  const regime = regimeOf(m.t);
  const k = latestAt(kByMint.get(m.mint) ?? [], m.t);
  if (k && m.t - k.t <= P.overlapMaxAgeSec)
    addGap(`kamino_scope ${sym(m.mint)}`, regime, k.price / m.price - 1, m.t - k.t);
  for (const [key, a] of jByMintQuote) {
    const [mint, quote] = key.split('|') as [string, string];
    if (mint !== m.mint) continue;
    const j = latestAt(a, m.t);
    if (j && m.t - j.t <= P.overlapMaxAgeSec)
      addGap(
        `jupiter_lend_oracle ${sym(mint)}/${quote === USDC ? 'USDC' : 'JupUSD'}`,
        regime,
        j.price / m.price - 1,
        m.t - j.t,
      );
  }
}
const p3 = [...cells]
  .map(([k, c]) => {
    const [oracle, regime] = k.split('|') as [string, Regime];
    return {
      oracle,
      regime,
      n: c.gaps.length,
      median: r6(q(c.gaps, 0.5)),
      p05: r6(q(c.gaps, 0.05)),
      p95: r6(q(c.gaps, 0.95)),
      maxAbs: r6(q(c.gaps.map(Math.abs), 1)),
      medianAgeSec: q(c.ages, 0.5),
    };
  })
  .sort((a, b) => a.oracle.localeCompare(b.oracle) || a.regime.localeCompare(b.regime));

// ------------------------------------------------------------------------------------------------- P-4
const multiplier = new Map<string, number>();
for (const f of readdirSync(liveDir)
  .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
  .sort())
  for (const r of readJsonl<Record<string, unknown>>(join(liveDir, f)))
    if (r.kind === 'jl_vault' && Number(r.oracleMultiplier) > 0)
      multiplier.set(String(r.collateralMint), Number(r.oracleMultiplier));
const p4 = [];
for (const [mint, mult] of multiplier) {
  if (mult - 1 < 0.001) continue;
  for (const row of p3.filter(
    (r) => r.regime === 'us_market_hours' && r.oracle.includes(` ${sym(mint)}`),
  ))
    p4.push({
      oracle: row.oracle,
      multiplier: mult,
      n: row.n,
      medianGap: row.median,
      limit: r6(P.unitShareOfMultiplier * (mult - 1)),
      sameUnit: row.median !== null && Math.abs(row.median) < P.unitShareOfMultiplier * (mult - 1),
    });
}
checks.push({
  check: 'P-4 one unit across sources',
  status: p4.length > 0 && p4.every((r) => r.sameUnit) ? 'pass' : 'finding',
  note: `${p4.filter((r) => r.sameUnit).length}/${p4.length} oracle–asset pairs agree with the pool mid inside ${P.unitShareOfMultiplier} × (multiplier − 1) in US market hours`,
});

// ------------------------------------------------------------------------------------------------- P-5
const stockLog = kLog.filter((o) => stocks.has(o.mint));
const byEtDate = groupBy(stockLog, (o) => etParts(new Date(o.t * 1000)).date);
const firstDate = etParts(new Date((kLog[0] as StoredObservation).t * 1000)).date;
const lastDate = etParts(new Date((kLog.at(-1) as StoredObservation).t * 1000)).date;
const p5 = calendar.closed
  .filter((d) => d >= firstDate && d <= lastDate)
  .map((date) => {
    const rows = byEtDate.get(date) ?? [];
    const perMint = [...groupBy(rows, (o) => o.mint)].map(([mint, a]) => ({
      asset: sym(mint),
      observations: a.length,
      distinctPrices: new Set(a.map((o) => o.price)).size,
    }));
    return {
      date,
      observations: rows.length,
      assets: perMint.length,
      assetsWithOnePrice: perMint.filter((x) => x.distinctPrices === 1).length,
      moved: perMint.filter((x) => x.distinctPrices > 1),
    };
  });
checks.push({
  check: 'P-5 no Scope stock price changes on a closed date',
  status:
    p5.length > 0 && p5.every((d) => d.assets > 0 && d.moved.length === 0) ? 'pass' : 'finding',
  note: `${p5.filter((d) => d.assets > 0 && d.moved.length === 0).length}/${p5.length} closed dates with every stock at one price`,
});
// how alive each oracle is in each regime: share of consecutive observations of one reserve or vault whose price
// changed. This is what the sessions in the price parameters are read from.
const p5change: Array<{
  priceSource: string;
  regime: Regime;
  pairs: number;
  changedShare: number | null;
}> = [];
for (const [priceSource, rows] of [
  ['kamino_scope', stockLog],
  ['jupiter_lend_oracle', jLog],
] as const) {
  const change = new Map<Regime, { pairs: number; changed: number }>();
  for (const a of groupBy(rows, (o) => o.ref).values())
    for (let i = 1; i < a.length; i++) {
      const cur = a[i] as StoredObservation;
      const c = change.get(regimeOf(cur.t)) ?? { pairs: 0, changed: 0 };
      c.pairs++;
      if (cur.price !== (a[i - 1] as StoredObservation).price) c.changed++;
      change.set(regimeOf(cur.t), c);
    }
  for (const [regime, c] of change)
    p5change.push({ priceSource, regime, pairs: c.pairs, changedShare: r6(c.changed / c.pairs) });
}
p5change.sort(
  (a, b) => a.priceSource.localeCompare(b.priceSource) || a.regime.localeCompare(b.regime),
);

// ------------------------------------------------------------------------------------------------- output
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const out = {
  source: 'data/risk/prices/obs (Step 11 item 1) + collector files in ~/.colosseum/risk',
  fetched_at: new Date().toISOString(),
  method: METHOD,
  methodVersion: PRICES_METHOD_VERSION,
  provenance: 'live',
  params: P,
  observations: Object.fromEntries([...by].map(([k, a]) => [k, a.length])),
  checks,
  p1Liveness: liveness,
  p1Coverage: p1,
  p2: { klendLogVsReserve: p2a, jupiterLendVsApi: p2b, crossMarket: p2c },
  p3Overlap: p3,
  p4Unit: p4,
  p5Calendar: p5,
  p5ChangeShareByRegime: p5change,
};
const file = join(PRICES_DIR, `validate-${stamp}.json`);
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);

const pct = (x: number | null) => (x === null ? '—' : `${(100 * x).toFixed(2)}%`);
console.log('checks');
for (const c of checks) console.log(`  ${c.status.padEnd(8)} ${c.check}: ${c.note}`);
console.log('\nP-1 stock oracles that were not pricing the stock');
for (const l of liveness.filter((x) => x.notLive > 0))
  console.log(
    `  ${l.oracle.padEnd(34)} not live ${String(l.notLive).padStart(6)} of ${String(l.observations).padStart(6)}  frozen days ${String(l.frozenDays).padStart(3)}  live from ${l.liveFrom ?? 'never'}`,
  );
console.log(
  '\nP-1 Kamino logged prices: share of hours with a usable observation at each limit (all hours / US market hours)',
);
for (const r of p1.kamino_scope) {
  const grid = r.rule === 'wall_clock' ? P.ageGridSec : P.openAgeGridSec;
  console.log(
    `  ${r.asset.padEnd(7)} ${r.rule.padEnd(23)} obs ${String(r.observations).padStart(6)}  not-live hours ${String(r.notLiveHours).padStart(5)}/${String(r.hours).padEnd(5)} ${grid
      .map((x) => {
        const c = r.hourCoverage[x] as { all: number | null; open: number | null };
        return `${x}s ${((c.all ?? 0) * 100).toFixed(0)}/${((c.open ?? 0) * 100).toFixed(0)}`;
      })
      .join('  ')}`,
  );
}
console.log('\nP-3 oracle over pool mid − 1, by regime');
for (const r of p3)
  console.log(
    `  ${r.oracle.padEnd(34)} ${r.regime.padEnd(20)} n ${String(r.n).padStart(4)}  median ${pct(r.median).padStart(7)}  p05 ${pct(r.p05).padStart(7)}  p95 ${pct(r.p95).padStart(7)}  max ${pct(r.maxAbs).padStart(6)}`,
  );
console.log(
  '\nP-5 share of consecutive observations whose price changed, stocks, by oracle and regime',
);
for (const r of p5change)
  console.log(
    `  ${r.priceSource.padEnd(20)} ${r.regime.padEnd(20)} ${pct(r.changedShare).padStart(7)} of ${r.pairs}`,
  );
console.log(`\n→ ${file}`);
