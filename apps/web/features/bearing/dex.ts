import type { Res } from './data';
import { type Fact, has, maxT, mk, none, provenanceOf, sumFact } from './fact';
import { num, pct, type Regime, RW, short, usd1, venueW } from './format';
import type {
  AssetRow,
  AssetsBody,
  HistBody,
  LiqHistBody,
  LiquidityBody,
  Pool,
  PoolsBody,
  SheetBody,
} from './types';

// The stocks and commodities pages, worked out from the API's answers (analytics2.js, dexRender).
// Every derived figure is a fact whose method names its parts and its formula.

// Gold: the xStock on Solana, the stock token on Robinhood Chain.
export const COMMODITIES = ['GLDx', 'GLD'];
export const HOUR = 3600e3;
export const DAY = 864e5;
export const hourOf = (t: string | number) => Math.floor(new Date(t).getTime() / HOUR) * HOUR;

/** A point of a time chart. `show` is the readout text in place of the formatted value. */
export type TPoint = { t: number; v: number | null; show?: string | null };

/** The capacity of an asset at the tolerance in one regime, as a fact (the first view's rule). */
export function capFact(a: AssetRow | undefined, r: string, body: AssetsBody): Fact {
  const c = a?.capacityAtTau?.[r];
  if (!c) return none(a ? 'no_samples_in_regime' : 'not_collected');
  if (c.status !== 'ok' || c.capacityUsd == null)
    return none(
      c.status === 'insufficient_samples' ? 'insufficient_samples' : 'no_samples_in_regime',
    );
  return mk(c.capacityUsd, {
    quality: c.lowerBound ? 'lower_bound' : 'measured',
    source: 'risk_depth_curves (GET /risk/assets)',
    fetchedAt: c.to,
    dataFrom: c.from,
    samples: c.samples,
    regime: r,
    method: `largest sale at cost ≤ τ = ${pct(body.tau)} on the fitted sell curve`,
    methodVersion: body.methodVersion,
    provenance: a?.provenance,
  });
}

/** The newest 24 h of swap volume on an asset's sheet: Bearing's own, from the swap history. */
export function vol24(sheet: Res<SheetBody>): Fact {
  if (!sheet.ok) return none(sheet.reason);
  const w = (sheet.body.flow.byWindow ?? []).find((x) => x.window === '24h');
  return w ? w.volumeUsd : none('not_collected');
}

/** The source of the pools' outside volume figure, named on its pin (gate VOLUME-DEXSCREENER). */
export const DEXSCREENER_24H = 'DexScreener · 24 h';

/**
 * DexScreener's 24 h volume of the pools, summed: what DexScreener reported for each pair when the pool
 * was registered (`risk_pools.discovery_volume24h_usd`). It stands where Bearing's swap history is not
 * collected, under its own source, and is never Bearing's measure: no swap is counted here.
 */
export function dexVolume(pools: readonly Pool[]): Fact {
  const known = pools.filter((p) => typeof p.discoveryVolume24hUsd === 'number');
  if (!known.length) return none(pools.length ? 'not_collected' : 'nothing_selected');
  let at: string | null = null;
  for (const p of known) at = maxT(at, p.fetchedAt);
  return mk(
    known.reduce((s, p) => s + (p.discoveryVolume24hUsd as number), 0),
    {
      source: DEXSCREENER_24H,
      fetchedAt: at,
      quality: known.length < pools.length ? 'lower_bound' : 'measured',
      method: `sum of DexScreener's 24 h volume of ${known.length} pools (api.dexscreener.com, h24), as reported when each pool was registered; DexScreener's figure, not Bearing's swap history`,
      methodVersion: 'registry-0.1',
    },
  );
}

/** An asset's 24 h volume: Bearing's swap history where it is collected, else DexScreener's figure. */
export function assetVol(d: DexAsset | undefined): Fact {
  if (!d) return none('not_collected');
  const own = vol24(d.sheet);
  return has(own) || !poolsOf(d).length ? own : dexVolume(poolsOf(d));
}

export const dexIds = (body: AssetsBody, page: 'stocks' | 'commodities') =>
  body.assets
    .map((a) => a.symbol)
    .filter((s) => COMMODITIES.includes(s) === (page === 'commodities'));

export const poolLabel = (p: Pool, withAsset: boolean, unnamed = 'quote not named') =>
  `${withAsset ? `${p.assetSymbol} · ` : ''}${venueW(p.venue)} · ${p.quoteSymbol || unnamed} · ${short(p.address)}`;

/** "(2 of 3 assets)": a sum an asset short. */
export type PartialW = (k: number, n: number) => string;

export type DexAsset = { sheet: Res<SheetBody>; hist: Res<HistBody>; pools: Res<PoolsBody> };

export const poolsOf = (d: DexAsset | undefined): Pool[] =>
  d?.pools.ok ? (d.pools.body.pools ?? []) : [];

/** The five counters of a stocks or commodities page. */
export function dexCounters(
  body: AssetsBody,
  selIds: readonly string[],
  dd: Record<string, DexAsset>,
  pools: readonly Pool[],
  r: Regime,
  poolsChosen: boolean,
) {
  const byId = new Map(body.assets.map((a) => [a.symbol, a]));
  let poolT: string | null = null;
  for (const p of pools) poolT = maxT(poolT, p.fetchedAt);
  const noPools = selIds.some((id) => !dd[id]?.pools.ok);
  const tvl: Fact = pools.length
    ? mk(
        pools.reduce((s, p) => s + (p.tvlUsd || 0), 0),
        {
          source: 'risk_pools.tvl_usd (GET /risk/pools), read when each pool was registered',
          fetchedAt: poolT,
          quality: noPools ? 'lower_bound' : 'measured',
          method: `sum of the TVL of the selected pools (GET /risk/pools?asset= per asset)${
            noPools ? '; some assets’ pool lists did not load, so this is a lower bound' : ''
          }`,
          methodVersion: 'registry-0.1',
        },
      )
    : none(!selIds.length || poolsChosen ? 'nothing_selected' : 'not_collected');
  const cap = sumFact(
    selIds.map((id) => capFact(byId.get(id), r, body)),
    {
      regime: r,
      method: `sum over the selected assets of the largest sale at cost ≤ 1% in ${RW[r]}, each asset routed across all its pools`,
      methodVersion: body.methodVersion,
    },
  );
  const flow = sumFact(
    selIds.map((id) => (dd[id] ? vol24(dd[id].sheet) : none('not_collected'))),
    {
      method:
        'sum over the selected assets of the volume of successful swaps in the newest 24 h of the swap history',
    },
  );
  // Bearing's own measure where it is collected; DexScreener's, named as such, where it is not.
  // With no pool to sum (Robinhood Chain's are not in the registry), the missing figure keeps its reason.
  const vol = has(flow) || !pools.length ? flow : dexVolume(pools);
  let lpW = 0;
  let lpS = 0;
  let lpT: string | null | undefined = null;
  let lpN = 0;
  for (const id of selIds) {
    const s = dd[id]?.sheet;
    if (!s?.ok) continue;
    const f = s.body.liquidityStability.lpTop3Share;
    if (!has(f)) continue;
    const w = byId.get(id)?.poolTvlUsd || 0;
    lpW += w;
    lpS += w * f.value;
    lpT = maxT(lpT, f.fetchedAt);
    lpN++;
  }
  const lp: Fact = lpW
    ? mk(lpS / lpW, {
        quality: 'lower_bound',
        source:
          'risk_lp_concentration (GET /risk/facts/assets/:id, liquidityStability.lpTop3Share)',
        fetchedAt: lpT,
        method: `TVL-weighted mean over ${lpN} assets of the top-3 positions’ share of each asset’s largest pool; by position, not by owner`,
        methodVersion: 'facts-0.1',
      })
    : none(selIds.length ? 'not_collected' : 'nothing_selected');
  let volTo: string | null = null;
  for (const id of selIds) {
    const s = dd[id]?.sheet;
    if (!s?.ok) continue;
    const w = (s.body.flow.byWindow ?? []).find((x) => x.window === '24h');
    if (w?.to) volTo = maxT(volTo, w.to);
  }
  return { tvl, cap, vol, lp, volTo: has(flow) ? volTo : null };
}

/** Exit capacity hour by hour, summed over the selected assets; an hour short of an asset says so. */
export function capacitySeries(
  selIds: readonly string[],
  dd: Record<string, DexAsset>,
  partial: PartialW = (k, n) => `(${k} of ${n} assets)`,
  money: (v: number) => string = usd1,
) {
  type B = { t: number; s: number; b: number; ns: number; nb: number; lb?: boolean };
  const bucket = new Map<number, B>();
  const n = selIds.length;
  let last: string | null = null;
  let src: HistBody | null = null;
  for (const id of selIds) {
    const h = dd[id]?.hist;
    if (!h?.ok) continue;
    src ??= h.body;
    for (const p of h.body.points ?? []) {
      const k = hourOf(p.t);
      let o = bucket.get(k);
      if (!o) {
        o = { t: k, s: 0, b: 0, ns: 0, nb: 0 };
        bucket.set(k, o);
      }
      if (p.sellCapacityUsd != null) {
        o.s += p.sellCapacityUsd;
        o.ns++;
        if (p.sellLowerBound) o.lb = true;
      }
      if (p.buyCapacityUsd != null) {
        o.b += p.buyCapacityUsd;
        o.nb++;
      }
      last = maxT(last, p.t);
    }
  }
  const pts = [...bucket.values()].sort((x, y) => x.t - y.t);
  const part = (v: number, k: number) => (k < n ? `${money(v)} ${partial(k, n)}` : money(v));
  const lastP = pts.filter((q) => q.ns).pop();
  const fact: Fact =
    src && lastP
      ? mk(lastP.s, {
          source: src.source,
          fetchedAt: last,
          method: `${src.method}; summed over the selected assets per UTC hour`,
          methodVersion: src.methodVersion,
          provenance: src.provenance,
          quality: lastP.ns < n || lastP.lb ? 'lower_bound' : 'measured',
        })
      : none('not_collected');
  const sell: TPoint[] = pts.map((q) => ({
    t: q.t,
    v: q.ns ? q.s : null,
    show: q.ns ? part(q.s, q.ns) : null,
  }));
  const buy: TPoint[] = pts.map((q) => ({
    t: q.t,
    v: q.nb ? q.b : null,
    show: q.nb ? part(q.b, q.nb) : null,
  }));
  return { fact, sell, buy, from: src?.from ?? null };
}

/**
 * The dollars one pool's liquidity holds, both sides, as its answer gives them. An answer with no
 * dollar figure (its quote token has no price in dollars) is that reason, never a measured $0.
 */
export function liquidityTotal(d: LiquidityBody): Fact {
  if (d.totalAssetUsd == null || d.totalQuoteUsd == null)
    return none(d.usdNullReason ?? 'not_served');
  return mk(d.totalAssetUsd + d.totalQuoteUsd, {
    source: d.source,
    fetchedAt: d.fetchedAt,
    method: d.method,
    methodVersion: d.methodVersion,
    provenance: d.provenance,
  });
}

/** Each distinct text once, in the order met. */
const each = (texts: ReadonlyArray<string | null | undefined>) => [
  ...new Set(texts.filter((s): s is string => !!s)),
];

/** The sources of a sum: each distinct one, and one that another already names is not named twice. */
export function sourcesOf(texts: ReadonlyArray<string | null | undefined>): string {
  const all = each(texts);
  return all.filter((s) => !all.some((o) => o !== s && o.includes(s))).join('; ');
}

/** The API's reason for a recording with no dollar value: its quote token has no price in dollars. */
const NO_QUOTE_PRICE = 'no_quote_price';

/**
 * The value held by the recorded pools, hour by hour. A pool not recorded in an hour keeps its last
 * value for up to 6 h, so the sum does not jump with the set recorded that hour; an hour still short
 * of a pool is a lower bound. A recording with no dollar value (its quote token has no price) adds
 * nothing and counts as a pool short, never as $0. The sum's source and method are those of every
 * history that adds to it in any hour, each distinct one named: the pools need not have been
 * recorded by the same job. Its provenance is theirs too: live only when every one of them is.
 *
 * `n` is every recorded pool of the selection. `unpriced` of them have no history here: the registry
 * says their quote token has no way to dollars, so no recording of theirs can add a dollar and none
 * was read. While the others are still being read `hs` holds those that have come: the sum is then
 * theirs alone, a lower bound like any sum a pool short.
 *
 * `inSum` says, history by history, which are counted in the hour the figure is taken from, the
 * newest with a value: a history whose newest recording is more than 6 h behind that hour is drawn
 * where it has recordings and is not in the figure. `noUsd` counts the recorded pools with no price
 * in dollars, those left unread and those whose every recording read says so. `failed` counts the
 * histories that did not load, and `failedWhy` is the first one's reason. `behind` counts the histories
 * read that are neither in the figure nor without a price: no recording of theirs counts in the figure's
 * hour (the newest is more than 6 h before it, or the window holds none). With `inSum`, `noUsd` and
 * `failed`, every recorded pool of the selection is in exactly one count.
 */
export function tvlSeries(
  hs: ReadonlyArray<Res<LiqHistBody>>,
  n: number,
  partial: PartialW = (k, of) => `(${k} of ${of} pools)`,
  money: (v: number) => string = usd1,
  unpriced = 0,
) {
  const CARRY = 6 * HOUR;
  type P = { t: number; v: number; a: number | null };
  const summed: LiqHistBody[] = [];
  // why a history read adds nothing: its newest recording's reason, null where it gives none
  const whys: Array<string | null> = [];
  let failed = 0;
  let failedWhy: string | null = null;
  let last: string | null | undefined = null;
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  // one series for each history, in their order: a read that failed is an empty one
  const series: P[][] = [];
  for (const h of hs) {
    if (!h.ok) {
      failed++;
      failedWhy ??= h.reason;
      series.push([]);
      continue;
    }
    const all = h.body.points ?? [];
    const ps: P[] = all
      .filter((q) => q.valueUsd != null)
      .map((q) => ({ t: hourOf(q.t), v: q.valueUsd as number, a: q.assetUsd ?? null }));
    for (const q of ps) {
      t0 = Math.min(t0, q.t);
      t1 = Math.max(t1, q.t);
    }
    if (ps.length) {
      last = maxT(last, h.body.to);
      summed.push(h.body);
    } else whys.push(all[all.length - 1]?.usdNullReason ?? null);
    series.push(ps);
  }
  // With nothing in the sum, why. A read that failed is its own reason: what that pool holds is not
  // known, so no other pool's reason speaks for the selection. The recordings' reason stands only
  // when every history read gives the same one, and the pools left unread have that one too.
  const reasons = new Set(whys);
  if (unpriced) reasons.add(NO_QUOTE_PRICE);
  const why = failedWhy ?? (reasons.size === 1 ? [...reasons][0] : null) ?? 'not_collected';
  const pts: Array<{ t: number; v: number; a: number; k: number; ka: number }> = [];
  // Each series is walked once, forward, as the hours go by (a history's points come oldest first):
  // `at` is its newest point at or before the hour, `counted` the last hour it was counted in.
  const at = series.map(() => -1);
  const counted = series.map(() => Number.NaN);
  for (let t = t0; t <= t1; t += HOUR) {
    const o = { t, v: 0, a: 0, k: 0, ka: 0 };
    for (let s = 0; s < series.length; s++) {
      const ps = series[s] as P[];
      let i = at[s] as number;
      while ((ps[i + 1]?.t ?? Number.POSITIVE_INFINITY) <= t) i++;
      at[s] = i;
      const q = ps[i];
      if (q && t - q.t <= CARRY) {
        o.v += q.v;
        o.k++;
        if (q.a != null) {
          o.a += q.a;
          o.ka++;
        }
        counted[s] = t;
      }
    }
    pts.push(o);
  }
  const lp = pts.filter((q) => q.k).pop();
  const methods = each(summed.map((s) => s.method));
  const fact: Fact =
    lp && summed.length
      ? mk(lp.v, {
          quality: lp.k < n ? 'lower_bound' : 'measured',
          source: sourcesOf(summed.map((s) => s.source)),
          fetchedAt: last,
          method: `summed over ${lp.k} of ${n} recorded pools in the selection, each at its newest recording within 6 h; ${
            methods.length > 1
              ? `each pool by its own history’s method: ${methods.join(' | ')}`
              : (methods[0] ?? '')
          }`,
          methodVersion: each(summed.map((s) => s.methodVersion)).join(', '),
          provenance: provenanceOf(summed),
        })
      : none(why);
  const value: TPoint[] = pts.map((q) => ({
    t: q.t,
    v: q.k ? q.v : null,
    show: q.k ? `${money(q.v)}${q.k < n ? ` ${partial(q.k, n)}` : ''}` : null,
  }));
  // the asset's part of an hour is known only when every pool counted in it gives one
  const held: TPoint[] = pts.map((q) => ({ t: q.t, v: q.k && q.ka === q.k ? q.a : null }));
  // in the figure: counted in the hour it is taken from
  const inSum = counted.map((t) => t === lp?.t);
  const noUsd = unpriced + whys.filter((w) => w === NO_QUOTE_PRICE).length;
  // read, and neither in the figure nor without a price: no recording of it counts in the hour the
  // figure is taken from (its newest is more than 6 h before, or the window holds none)
  const behind = hs.length - failed - inSum.filter(Boolean).length - (noUsd - unpriced);
  return { fact, value, held, inSum, noUsd, failed, failedWhy, behind };
}

export const countW = (n: number, one: string) => `${num(n)} ${one}${n === 1 ? '' : 's'}`;
