import { R, type Reader, type Res } from './data';
import { capFact, DAY, hourOf, type TPoint } from './dex';
import { type Fact, has, maxT, mk, none, sumFact } from './fact';
import { pct, type Regime, RW, short, usd1, venueW } from './format';
import type {
  AssetsBody,
  HistBody,
  LendBody,
  LendHistBody,
  LendMeta,
  LendPoint,
  SheetBody,
} from './types';

// The lending and stablecoin pages, worked out from the API's answers (analytics2.js, lendRender and
// stableRender). The rules a reviewer of Rodrigo's page held it to are kept, and tested
// (lending.test.ts): collateral is grouped by asset before an asset's capacity is applied, each Kamino
// market is counted once, a position with no collateral figure is kept as its reason and makes every
// total a lower bound, and the hourly window is cut against the page's clock.

export type LendRow = {
  meta: LendMeta;
  sheet: Res<LendBody>;
  h7: Res<LendHistBody>;
  h30: Res<LendHistBody>;
};
type SPoint = LendPoint & { ms: number };

const seriesCache = new WeakMap<LendRow, SPoint[]>();
/** One lending pool's history: daily points older than the hourly window, hourly points inside it. */
export function lendSeries(row: LendRow): SPoint[] {
  const hit = seriesCache.get(row);
  if (hit) return hit;
  const h7 = row.h7.ok ? (row.h7.body.points ?? []) : [];
  const h30 = row.h30.ok ? (row.h30.body.points ?? []) : [];
  const cut = h7.length ? new Date((h7[0] as LendPoint).t).getTime() : Number.POSITIVE_INFINITY;
  const out = h30
    .filter((p) => new Date(p.t).getTime() < cut)
    .concat(h7)
    .map((p) => ({ ...p, ms: new Date(p.t).getTime() }));
  seriesCache.set(row, out);
  return out;
}

export const lendSrc = (row: LendRow): LendHistBody | null =>
  (row.h7.ok && row.h7.body) || (row.h30.ok && row.h30.body) || null;

export type SumPoint = TPoint & { partial: boolean; k: number; of: number };

/** One field summed over pools per UTC hour (inside the hourly window) or per UTC day (older). */
export function summed(
  rows: readonly LendRow[],
  key: 'suppliedUsd' | 'borrowedUsd' | 'availableUsd',
  now: number,
) {
  const by = new Map<number, { t: number; v: number; n: number }>();
  const cut = now - 8 * DAY;
  const n = rows.length;
  for (const row of rows) {
    const seen = new Set<number>();
    for (const p of lendSeries(row).slice().reverse()) {
      const k = p.ms >= cut ? hourOf(p.ms) : Math.floor(p.ms / DAY) * DAY;
      if (seen.has(k)) continue;
      seen.add(k);
      let o = by.get(k);
      if (!o) {
        o = { t: k, v: 0, n: 0 };
        by.set(k, o);
      }
      const v = p[key];
      if (v != null) {
        o.v += v;
        o.n++;
      }
    }
  }
  return [...by.values()]
    .sort((x, y) => x.t - y.t)
    .map(
      (o): SumPoint => ({
        t: o.t,
        v: o.n ? o.v : null,
        partial: o.n < n,
        show: undefined,
        k: o.n,
        of: n,
      }),
    );
}

/** A summed point that is short of a pool says so in the readout. */
export function markPartial(
  pts: SumPoint[],
  partial: (k: number, n: number) => string = (k, n) => `(${k} of ${n} pools)`,
): SumPoint[] {
  for (const p of pts) if (p.v != null && p.partial) p.show = `${usd1(p.v)} ${partial(p.k, p.of)}`;
  return pts;
}

/** The newest summed point as a fact; a lower bound when some pools had no figure at that time. */
export function seriesFact(
  pts: readonly SumPoint[],
  src: LendHistBody | null,
  label: string,
): Fact {
  const lp = pts.filter((p) => p.v != null).pop();
  if (!lp || lp.v == null || !src) return none('not_collected');
  return mk(lp.v, {
    quality: lp.partial ? 'lower_bound' : 'measured',
    source: src.source,
    fetchedAt: new Date(lp.t).toISOString(),
    method: `${label}${
      lp.partial
        ? `; ${lp.k} of ${lp.of} pools have a figure at this time, so this is a lower bound`
        : ''
    }; ${src.method}`,
    methodVersion: src.methodVersion,
  });
}

/** A history field at the newest reading, or the reason it has none. */
export function histFact(
  row: LendRow,
  key: 'suppliedUsd' | 'borrowedUsd' | 'availableUsd',
  label: string,
): Fact {
  const s = lendSeries(row);
  const p = s[s.length - 1];
  const src = lendSrc(row);
  if (!p || p[key] == null || !src) {
    const why =
      p && key === 'availableUsd' && p.availableNullReason
        ? p.availableNullReason === 'not_applicable_vault'
          ? 'not_applicable'
          : p.availableNullReason
        : p?.usdNullReason || 'not_collected';
    return none(why);
  }
  return mk(p[key], {
    source: src.source,
    fetchedAt: p.t,
    method: `${label} at the newest reading; ${src.method}`,
    methodVersion: src.methodVersion,
  });
}

export function poolName(m: LendMeta, marketW = (id: string) => `market ${id}`): string {
  const market = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m.market)
    ? marketW(short(m.market))
    : m.market;
  return `${venueW(m.venue)} · ${m.venue === 'jupiter_lend' ? m.symbol : `${market} · ${m.symbol}`}`;
}

const isPosted = (c: { collateralUsd?: Fact }) =>
  c.collateralUsd != null && (c.collateralUsd.value == null || c.collateralUsd.value > 0);

/** The collateral assets posted anywhere in the lending pools. */
export function collateralAssets(rows: readonly LendRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows)
    if (row.sheet.ok) for (const c of row.sheet.body.collateral) if (isPosted(c)) set.add(c.asset);
  return [...set].sort();
}

export type Part = { key: string; asset: string; coll: Fact; cap: Fact };

/** One lending pool's collateral positions (a missing figure kept, with its reason) and each asset's capacity now. */
export function coverage(
  row: LendRow,
  body: AssetsBody,
  assetSel: readonly string[] | null,
  r: Regime,
): Part[] {
  if (!row.sheet.ok) return [];
  const byId = new Map(body.assets.map((a) => [a.symbol, a]));
  // Kamino reports collateral per market: its reserves repeat it.
  const mkey = row.meta.venue === 'kamino' ? `kamino:${row.meta.market}` : row.meta.account;
  return row.sheet.body.collateral
    .filter((c) => isPosted(c) && (!assetSel || assetSel.includes(c.asset)))
    .map((c) => ({
      key: `${mkey}|${c.asset}`,
      asset: c.asset,
      coll: c.collateralUsd as Fact,
      cap: capFact(byId.get(c.asset), r, body),
    }));
}

export type Group = {
  asset: string;
  cap: Fact;
  colls: Fact[];
  collV: number;
  missing: number;
  loss?: Fact;
};

/**
 * Collateral grouped by asset, each market's position counted once: every position in one asset is
 * sold into the same pools, so the asset's capacity and its sale loss apply to the sum, once.
 */
export function groupBy(parts: ReadonlyArray<readonly Part[]>): Group[] {
  const seen = new Set<string>();
  const by = new Map<string, Group>();
  for (const list of parts)
    for (const p of list) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      let g = by.get(p.asset);
      if (!g) {
        g = { asset: p.asset, cap: p.cap, colls: [], collV: 0, missing: 0 };
        by.set(p.asset, g);
      }
      g.colls.push(p.coll);
    }
  const out = [...by.values()];
  for (const g of out) {
    g.collV = g.colls.reduce((a, f) => a + (f.value || 0), 0);
    g.missing = g.colls.filter((f) => f.value == null).length;
  }
  return out;
}

/** Each asset's sheet at its total collateral: the loss if all of it is sold at once now. */
export async function priceGroups(groups: Group[], r: Regime, reader: Reader): Promise<void> {
  await Promise.all(
    groups.map(async (g) => {
      if (!(g.collV > 0)) {
        g.loss = none(g.colls[0]?.reason || 'not_collected');
        return;
      }
      const sh = await reader.get<SheetBody>(R.sheet(g.asset, g.collV));
      if (!sh.ok) {
        g.loss = none(sh.reason);
        return;
      }
      const c = sh.body.costs.find((x) => x.regime === r);
      g.loss = c ? c.exit.lossUsd : none('no_samples_in_regime');
    }),
  );
}

/** The coverage figures of a set of groups: collateral, covered share, largest sale within tolerance, loss. */
export function covFacts(groups: readonly Group[], r: Regime, body: AssetsBody) {
  const colls = groups.flatMap((g) => g.colls);
  const total = groups.reduce((a, g) => a + g.collV, 0);
  const missingColl = groups.some((g) => g.missing);
  const priced = groups.filter((g) => g.collV > 0);
  const have = priced.filter((g) => has(g.cap));
  let t: string | null | undefined = null;
  for (const g of groups) {
    t = maxT(t, g.cap.fetchedAt);
    for (const f of g.colls) t = maxT(t, f.fetchedAt);
  }
  const lb =
    missingColl || have.length < priced.length || have.some((g) => g.cap.quality === 'lower_bound');
  const note = `${have.length} of ${priced.length} assets with a capacity${
    missingColl ? '; some positions have no collateral figure' : ''
  }${lb ? ', so this is a lower bound' : ''}`;
  const base = {
    source:
      'collateral: risk_lending_positions (GET /risk/facts/lending/:account); capacity: risk_depth_curves (GET /risk/assets)',
    fetchedAt: t,
    regime: r,
    methodVersion: body.methodVersion,
    quality: lb ? 'lower_bound' : 'measured',
  };
  const covUsd = have.reduce((a, g) => a + Math.min(g.cap.value as number, g.collV), 0);
  const empty = none(
    !groups.length
      ? 'nothing_selected'
      : !priced.length
        ? colls[0]?.reason || 'not_collected'
        : 'no_samples_in_regime',
  );
  const maxF = have.length
    ? mk(covUsd, {
        ...base,
        method: `Σ over collateral assets of min(exit capacity at ≤ ${pct(body.tau)} cost in ${RW[r]}, the asset’s collateral summed over the selected pools, each market once); ${note}`,
      })
    : empty;
  const covF =
    have.length && total
      ? mk(covUsd / total, {
          ...base,
          method: `largest sale within the tolerance (≤ ${pct(body.tau)} cost) ÷ collateral posted (${usd1(total)}); ${note}`,
        })
      : empty;
  const losses = priced.map((g) => g.loss ?? none('not_served'));
  const lossHave = losses.filter(has);
  let lt: string | null | undefined = null;
  for (const f of lossHave) lt = maxT(lt, f.fetchedAt);
  const lossV = lossHave.reduce((a, f) => a + f.value, 0);
  const lossM = {
    source:
      'risk_asset_snapshots (GET /risk/facts/assets/:id?sizeUsd=<the asset’s collateral>, exit.lossUsd)',
    fetchedAt: lt,
    regime: r,
    methodVersion: 'facts-0.1',
    quality:
      missingColl ||
      lossHave.length < losses.length ||
      lossHave.some((f) => f.quality === 'lower_bound')
        ? 'lower_bound'
        : 'measured',
  };
  const lossF = lossHave.length
    ? mk(lossV, {
        ...lossM,
        method: `Σ over collateral assets of the loss selling all of the asset’s collateral at once, routed across its pools, in ${RW[r]}; ${lossHave.length} of ${losses.length} assets priced`,
      })
    : empty;
  const lossPF =
    lossHave.length && total
      ? mk(lossV / total, { ...lossM, method: 'that loss ÷ collateral posted' })
      : none(lossF.reason ?? 'not_collected');
  const collF = colls.length
    ? sumFact(colls, {
        method: 'sum of collateral posted in the selected pools, each market’s position once',
      })
    : none('nothing_selected');
  return { maxF, covF, lossF, lossPF, collF };
}

/**
 * The covered share hour by hour: today's collateral by asset against each hour's exit capacity at the
 * tolerance; an hour with any asset unmeasured is left out.
 */
export function coveredSeries(
  groups: readonly Group[],
  histBy: Record<string, Res<HistBody> | undefined>,
): Array<{ t: number; v: number | null; lb?: boolean }> {
  const missing = groups.some((g) => g.missing);
  const lbAt = new Set<number>();
  const priced = groups.filter((g) => g.collV > 0);
  if (!priced.length) return [];
  const byHour = new Map<number, Map<string, number>>();
  for (const g of priced) {
    const h = histBy[g.asset];
    if (!h?.ok) continue;
    for (const p of h.body.points ?? []) {
      if (p.sellCapacityUsd == null) continue;
      const k = hourOf(p.t);
      let row = byHour.get(k);
      if (!row) {
        row = new Map();
        byHour.set(k, row);
      }
      row.set(g.asset, p.sellCapacityUsd);
      if (p.sellLowerBound) lbAt.add(k);
    }
  }
  const total = priced.reduce((a, g) => a + g.collV, 0);
  return [...byHour.keys()]
    .sort((x, y) => x - y)
    .map((k) => {
      const row = byHour.get(k) as Map<string, number>;
      if (!priced.every((g) => row.get(g.asset) != null)) return { t: k, v: null };
      return {
        t: k,
        v: priced.reduce((a, g) => a + Math.min(row.get(g.asset) as number, g.collV), 0) / total,
        lb: missing || lbAt.has(k),
      };
    });
}

/** The stablecoins page reads the Kamino reserves that lend a dollar token. */
export const STABLE = /^(USDC|USDG|PYUSD|USDT|USDS|EURC|EUROP|JupUSD|USDe|USD1|FDUSD|DAI)$/;
/** Stablecoins the registry lists but the collectors do not measure yet: shown with their reason. */
export const STABLE_OTHER = ['USDY', 'syrupUSDC', 'USDT'];

/** Borrowed ÷ supplied over the reserves that have both figures. */
export function shareLentOut(rows: readonly LendRow[], supF: Fact): Fact {
  const both = rows
    .map(
      (row) =>
        [
          histFact(row, 'suppliedUsd', 'supplied'),
          histFact(row, 'borrowedUsd', 'borrowed'),
        ] as const,
    )
    .filter(([s, b]) => s.value != null && b.value != null);
  const sS = both.reduce((a, [s]) => a + (s.value as number), 0);
  const sB = both.reduce((a, [, b]) => a + (b.value as number), 0);
  return sS
    ? mk(sB / sS, {
        source: supF.source,
        fetchedAt: supF.fetchedAt,
        method: `borrowed ÷ supplied over the ${both.length} of ${rows.length} selected reserves with both figures`,
        methodVersion: supF.methodVersion,
      })
    : none(rows.length ? 'not_collected' : 'nothing_selected');
}

/** Available to withdraw (summed) and the share lent out, for the liquidity chart. */
export function availability(
  rows: readonly LendRow[],
  now: number,
  partial?: (k: number, n: number) => string,
) {
  const av = markPartial(summed(rows, 'availableUsd', now), partial);
  const s2 = summed(rows, 'suppliedUsd', now);
  const b2 = summed(rows, 'borrowedUsd', now);
  const src = rows.map(lendSrc).find(Boolean) ?? null;
  let fact = seriesFact(av, src, 'available to withdraw, summed over the selection');
  if (fact.value == null) fact = none('not_applicable');
  const lent: TPoint[] = s2.map((p, i) => {
    const b = b2[i];
    return {
      t: p.t,
      v: p.v && b && b.v != null && !p.partial && !b.partial ? b.v / p.v : null,
    };
  });
  return { av, lent, fact };
}
