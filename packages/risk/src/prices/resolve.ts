import { type Regime, type RegimeParams, regimeAt } from '../time';
import { type PriceObservation, type PriceSourceId, sourceKind } from './observation';
import {
  openSecondsBetween,
  type PriceSession,
  SESSION_REGIMES,
  type SessionClock,
  sessionStartsBetween,
} from './session';

/**
 * Step 11 item 3 — the resolver of the oracle standard. Pure: observations in, one answer out.
 *
 * One question: what is this asset's price at this time, for this purpose?
 *  - `valuation`: what the asset is worth. The sources in `valuationOrder` are tried in order, and a source
 *    counts when its latest observation is recent enough, live and expressible in USD. A price from a session
 *    that is open goes before a price an oracle is holding: at 03:00 ET on a weekday Jupiter Lend's oracle is
 *    moving and Kamino's is at yesterday's close.
 *  - `liquidation`: what a lending venue acts on. Only that venue's own oracle (`priceSource`), preferring the
 *    observations of the given market, and whatever the oracle says: a placeholder price is still the venue's
 *    price. The DEX is never used here.
 * Sources are never blended. Every other source's price at the same time is returned beside the answer
 * (`others`, with its gap to the answer), so the DEX price and the oracle price are both kept.
 *
 * Recent enough. An observation counts when it is at or before the time asked, and:
 *  - a source with a session (`sessionBySource`), for an asset tied to the US market: its session has not opened
 *    again since the observation, has been open for at most `maxOpenAgeSec` since it, and the observation is at
 *    most `maxClosedAgeSec` old. The oracle holds its last price while its session is closed, so Friday's last
 *    observation is still its price on Sunday; it is not on Monday at 10:00, and a 10:00 observation is not at
 *    13:00;
 *  - anything else (a pool mid, an external feed, an asset priced around the clock): at most `maxAgeSec[source]`
 *    old (`maxAgeSecByMint` overrides it for a single mint's oracles, never for a pool mid).
 * A price that failed a disqualifying check of the venue when it was logged (`failedChecks`, `disqualifyingChecks`)
 * is passed over for a valuation: the latest observation that passed is used instead. For a liquidation it is the
 * venue's price and is returned.
 *
 * A price quoted in another token (Jupiter Lend quotes the collateral in the vault's debt token) is converted with
 * that token's own valuation at the same time; when there is none the reason is `no_quote_price`.
 *
 * Quality tells a reader how to take the price:
 *   traded             a pool mid: the price the asset trades at, around the clock
 *   oracle_open        a lending oracle while its session is open
 *   oracle_closed      a lending oracle while its session is closed: the last price of the session, held
 *   oracle_continuous  a lending oracle for an asset priced around the clock (stablecoins, cbBTC)
 *   external           an external feed (D19)
 *   par                valued at one USD by assumption (`parMints`)
 */
export type PricePurpose = 'valuation' | 'liquidation';
export type PriceQuality =
  | 'traded'
  | 'oracle_open'
  | 'oracle_closed'
  | 'oracle_continuous'
  | 'external'
  | 'par';
export type PriceNullReason =
  | 'no_observation'
  | 'stale'
  | 'oracle_not_live'
  | 'oracle_check_failed'
  | 'no_quote_price';

export type PriceParams = {
  /** Sources tried in this order for a valuation. An external feed is plugged in by adding its id here. */
  valuationOrder: PriceSourceId[];
  /** The hours in which a source's stock prices move. A source not listed is judged on wall clock. */
  sessionBySource: Record<string, PriceSession>;
  /** Oldest observation accepted per source, seconds of wall clock; `default` covers a source not listed. */
  maxAgeSec: Record<string, number>;
  /** The same limit for single mints, overriding the source's (USD stablecoins that are refreshed rarely). */
  maxAgeSecByMint: Record<string, number>;
  /** A source with a session: most seconds of its session between the observation and the time asked. */
  maxOpenAgeSec: number;
  /** A source with a session: oldest observation accepted across a closure, seconds of wall clock. */
  maxClosedAgeSec: number;
  /** Checks of the venue whose failure keeps a logged price out of a valuation (klend's `twap`). */
  disqualifyingChecks: string[];
  /** Mints valued at one USD by assumption (USDC, as Step 5b does). */
  parMints: string[];
  /** Mints whose oracle prices around the clock, so no session changes what its price means. */
  continuousMints: string[];
};

/**
 * Set from Step 11 item 2. Sessions: Kamino's logged stock prices changed in 67% of consecutive observations in
 * US market hours and 1–3% outside; Jupiter Lend's in 65% on weekdays around the clock and 3–5% on weekends and
 * holidays. Limits: with two hours of session time a stock's logged Kamino price covers 98–100% of its hours; a
 * USD stablecoin's logged price moved by at most 0.5% between two observations less than a day apart. Checks: a
 * price that failed klend's TWAP check is passed over (AAPLx was logged at 0.0123 on 2026-02-12); one that failed
 * only the heuristic check is kept, because klend's fixed bounds lag the market for weeks (1,732 METAx prices, a
 * median 1.3% from the nearest price that passed). The mint lists come from the lending registry.
 */
export const defaultPriceParams = (mints: {
  parMints: string[];
  continuousMints: string[];
  usdStableMints: string[];
}): PriceParams => ({
  valuationOrder: ['pool_mid', 'kamino_scope', 'jupiter_lend_oracle'],
  sessionBySource: { kamino_scope: 'us_market_hours', jupiter_lend_oracle: 'us_weekdays' },
  maxAgeSec: { pool_mid: 3600, default: 7200 },
  maxAgeSecByMint: Object.fromEntries(mints.usdStableMints.map((m) => [m, 86400])),
  maxOpenAgeSec: 7200,
  maxClosedAgeSec: 4 * 86400,
  disqualifyingChecks: ['twap'],
  parMints: mints.parMints,
  continuousMints: mints.continuousMints,
});

export type PriceContext = {
  params: PriceParams;
  regime: RegimeParams;
  /** One clock per session named in `sessionBySource`, covering every time that will be asked. */
  clocks: Partial<Record<PriceSession, SessionClock>>;
};

export type PriceQuery = {
  mint: string;
  /** Unix seconds. */
  t: number;
  purpose: PricePurpose;
  /** `liquidation` only: the venue's oracle, and optionally the lending market or vault. */
  priceSource?: PriceSourceId;
  market?: string;
};

export type PriceCandidate = {
  priceSource: PriceSourceId;
  /** Price in `quote` as observed, and in USD when the quote can be converted. */
  price: number;
  quote: string;
  priceUsd: number | null;
  ref: string;
  market: string | null;
  method: string;
  obsT: number;
  ageSec: number;
  /** Seconds of the source's session since the observation; null when it is judged on wall clock alone. */
  openAgeSec: number | null;
  /** Whether the source's session is open at the time asked; null when it has none. */
  sessionOpen: boolean | null;
  stale: boolean;
  live: boolean;
  /** The venue's own checks the price failed when it was logged; a disqualifying one keeps it out of a valuation. */
  failedChecks: string[];
  /** This source's USD price over the answer's, minus one; null when either is missing. */
  gapToAnswer: number | null;
};

export type ResolvedPrice = {
  mint: string;
  t: number;
  purpose: PricePurpose;
  priceUsd: number | null;
  /** The price as the source quotes it, and the token it is quoted in (`'usd'` or a mint). */
  price: number | null;
  quote: string | null;
  priceSource: PriceSourceId | 'par' | null;
  ref: string | null;
  method: string | null;
  obsT: number | null;
  ageSec: number | null;
  regime: Regime;
  quality: PriceQuality | null;
  nullReason: PriceNullReason | null;
  /** `liquidation`: false when the oracle was not pricing the asset (a placeholder), so the price is the venue's only. */
  live: boolean | null;
  /** `liquidation`: the venue's own checks the price failed when it was logged (empty when none). */
  failedChecks: string[] | null;
  /** `liquidation` with a market: false when another market's observation of the same oracle was used. */
  marketMatched: boolean | null;
  others: PriceCandidate[];
};

/**
 * Observations in time order by `mint|priceSource|quote` and by `mint|priceSource|market`, with what each mint
 * has: its sources, the quotes each source uses, and its first observation.
 */
export type PriceIndex = {
  series: Map<string, PriceObservation[]>;
  sources: Map<string, PriceSourceId[]>;
  quotes: Map<string, string[]>;
  /** Time of each mint's first observation, from any source. */
  first: Map<string, number>;
  /** Time of the newest observation. */
  last: number;
};

export function buildPriceIndex(observations: Iterable<PriceObservation>): PriceIndex {
  const series = new Map<string, PriceObservation[]>();
  const sources = new Map<string, Set<PriceSourceId>>();
  const quotes = new Map<string, Set<string>>();
  const first = new Map<string, number>();
  let last = 0;
  const push = (k: string, o: PriceObservation) => {
    const a = series.get(k);
    if (a) a.push(o);
    else series.set(k, [o]);
  };
  const note = <T>(m: Map<string, Set<T>>, k: string, v: T) => {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  for (const o of observations) {
    push(`${o.mint}|${o.priceSource}|quote:${o.quote}`, o);
    if (o.market) push(`${o.mint}|${o.priceSource}|${o.market}`, o);
    note(sources, o.mint, o.priceSource);
    note(quotes, `${o.mint}|${o.priceSource}`, o.quote);
    const f = first.get(o.mint);
    if (f === undefined || o.t < f) first.set(o.mint, o.t);
    if (o.t > last) last = o.t;
  }
  for (const a of series.values())
    a.sort((x, y) => x.t - y.t || (x.slot ?? 0) - (y.slot ?? 0) || x.ref.localeCompare(y.ref));
  const sorted = <T>(m: Map<string, Set<T>>) =>
    new Map([...m].map(([k, s]) => [k, [...s].sort()] as [string, T[]]));
  return { series, sources: sorted(sources), quotes: sorted(quotes), first, last };
}

/**
 * The latest observation at or before `t` (the last one, when several share that time). With `rejected`, the
 * latest one it does not reject, when there is one.
 */
function latestAt(
  a: readonly PriceObservation[] | undefined,
  t: number,
  rejected?: (o: PriceObservation) => boolean,
): PriceObservation | null {
  if (!a?.length) return null;
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((a[m] as PriceObservation).t <= t) lo = m + 1;
    else hi = m;
  }
  const i = lo - 1;
  if (i < 0) return null;
  if (rejected) {
    let k = i;
    while (k >= 0 && rejected(a[k] as PriceObservation)) k--;
    // none passed: the latest one is returned, and its failed check keeps it out of a valuation
    if (k >= 0) return a[k] as PriceObservation;
  }
  return a[i] as PriceObservation;
}

export function resolvePrice(ix: PriceIndex, q: PriceQuery, ctx: PriceContext): ResolvedPrice {
  return resolve(ix, q, ctx, 0);
}

function resolve(ix: PriceIndex, q: PriceQuery, ctx: PriceContext, depth: number): ResolvedPrice {
  const p = ctx.params;
  const regime = regimeAt(new Date(q.t * 1000), ctx.regime);
  const base: ResolvedPrice = {
    mint: q.mint,
    t: q.t,
    purpose: q.purpose,
    priceUsd: null,
    price: null,
    quote: null,
    priceSource: null,
    ref: null,
    method: null,
    obsT: null,
    ageSec: null,
    regime,
    quality: null,
    nullReason: null,
    live: null,
    failedChecks: null,
    marketMatched: null,
    others: [],
  };
  const continuous = p.continuousMints.includes(q.mint);

  // USD value of one unit of a quote token at the same time: its own valuation, one level deep
  const quoteUsd = (quote: string): number | null => {
    if (quote === 'usd') return 1;
    if (depth > 0) return p.parMints.includes(quote) ? 1 : null;
    return resolve(ix, { mint: quote, t: q.t, purpose: 'valuation' }, ctx, depth + 1).priceUsd;
  };
  // a price that failed a disqualifying check of the venue is the venue's price and no valuation: only the
  // venue's oracle, asked for a liquidation price, keeps it
  const disqualified = (o: { failedChecks?: string[] }) =>
    o.failedChecks?.some((c) => p.disqualifyingChecks.includes(c)) ?? false;
  const rejectedFor = (s: PriceSourceId) =>
    q.purpose === 'liquidation' && s === q.priceSource ? undefined : disqualified;
  const toCandidate = (o: PriceObservation, s: PriceSourceId): PriceCandidate => {
    const usd = quoteUsd(o.quote);
    const ageSec = q.t - o.t;
    const session = continuous ? undefined : p.sessionBySource[s];
    let openAgeSec: number | null = null;
    let stale: boolean;
    if (session) {
      const clock = ctx.clocks[session];
      if (!clock) throw new Error(`no session clock for ${session}`);
      if (o.t < clock.from) stale = true;
      else {
        openAgeSec = openSecondsBetween(clock, o.t, q.t);
        // once the session has opened again the oracle has moved on: a price from before that open is out of date
        stale =
          sessionStartsBetween(clock, o.t, q.t) ||
          openAgeSec > p.maxOpenAgeSec ||
          ageSec > p.maxClosedAgeSec;
      }
    } else {
      const limit =
        (sourceKind(s) === 'dex' ? undefined : p.maxAgeSecByMint[q.mint]) ??
        p.maxAgeSec[s] ??
        (p.maxAgeSec.default as number);
      stale = ageSec > limit;
    }
    return {
      priceSource: s,
      price: o.price,
      quote: o.quote,
      priceUsd: usd === null ? null : o.price * usd,
      ref: o.ref,
      market: o.market,
      method: o.method,
      obsT: o.t,
      ageSec,
      openAgeSec,
      sessionOpen: session ? SESSION_REGIMES[session].includes(regime) : null,
      stale,
      live: o.live !== false,
      failedChecks: o.failedChecks ?? [],
      gapToAnswer: null,
    };
  };
  // a source that quotes one asset in several tokens (two Jupiter Lend vaults): a recent observation before an
  // old one, then one whose quote has a USD price, then the latest
  const rank = (c: PriceCandidate) => (c.stale ? 0 : 2) + (c.priceUsd === null ? 0 : 1);
  const candidate = (s: PriceSourceId, market?: string): PriceCandidate | null => {
    if (market) {
      const o = latestAt(ix.series.get(`${q.mint}|${s}|${market}`), q.t, rejectedFor(s));
      return o ? toCandidate(o, s) : null;
    }
    let best: PriceCandidate | null = null;
    for (const quote of ix.quotes.get(`${q.mint}|${s}`) ?? []) {
      const o = latestAt(ix.series.get(`${q.mint}|${s}|quote:${quote}`), q.t, rejectedFor(s));
      if (!o) continue;
      const c = toCandidate(o, s);
      if (!best || rank(c) > rank(best) || (rank(c) === rank(best) && c.obsT > best.obsT)) best = c;
    }
    return best;
  };
  const all = (ix.sources.get(q.mint) ?? [])
    .map((s) => candidate(s))
    .filter((c): c is PriceCandidate => c !== null);

  let chosen: PriceCandidate | null = null;
  let marketMatched: boolean | null = null;
  let tried: PriceCandidate[] = [];
  if (q.purpose === 'valuation') {
    if (p.parMints.includes(q.mint)) {
      const others = all.map((c) => ({
        ...c,
        gapToAnswer: c.priceUsd === null ? null : c.priceUsd - 1,
      }));
      return {
        ...base,
        priceUsd: 1,
        price: 1,
        quote: 'usd',
        priceSource: 'par',
        quality: 'par',
        others,
      };
    }
    tried = p.valuationOrder
      .map((s) => all.find((c) => c.priceSource === s))
      .filter((c): c is PriceCandidate => c !== undefined);
    const usable = tried.filter(
      (c) => !c.stale && c.live && !disqualified(c) && c.priceUsd !== null,
    );
    // a price from an open session (or a source with no session) before a price an oracle is holding
    chosen = usable.find((c) => c.sessionOpen !== false) ?? usable[0] ?? null;
  } else {
    if (!q.priceSource || sourceKind(q.priceSource) !== 'lending_oracle')
      throw new Error('a liquidation price needs the venue oracle (priceSource), never the DEX');
    const own = q.market ? candidate(q.priceSource, q.market) : null;
    const any = all.find((c) => c.priceSource === q.priceSource) ?? null;
    // the venue's own market first; another market of the same oracle only when it has no fresh observation
    const pick = own && !own.stale ? own : any && !any.stale ? any : (own ?? any);
    tried = pick ? [pick] : [];
    // the venue's own number: kept when it is a placeholder or cannot be put in USD, never when it is stale
    chosen = pick && !pick.stale ? pick : null;
    marketMatched = q.market ? pick !== null && pick.market === q.market : null;
  }

  const others = all
    .filter((c) => c.priceSource !== chosen?.priceSource)
    .map((c) => ({
      ...c,
      gapToAnswer:
        chosen?.priceUsd && c.priceUsd !== null ? c.priceUsd / chosen.priceUsd - 1 : null,
    }));
  if (!chosen) {
    // the reason of the first source in order that had anything to say
    const first = tried[0];
    const nullReason: PriceNullReason = !first
      ? 'no_observation'
      : first.stale
        ? 'stale'
        : !first.live
          ? 'oracle_not_live'
          : disqualified(first)
            ? 'oracle_check_failed'
            : 'no_quote_price';
    return { ...base, nullReason, marketMatched, others };
  }
  const kind = sourceKind(chosen.priceSource);
  const quality: PriceQuality =
    kind === 'dex'
      ? 'traded'
      : kind === 'external'
        ? 'external'
        : chosen.sessionOpen === null
          ? 'oracle_continuous'
          : chosen.sessionOpen
            ? 'oracle_open'
            : 'oracle_closed';
  return {
    ...base,
    priceUsd: chosen.priceUsd,
    price: chosen.price,
    quote: chosen.quote,
    priceSource: chosen.priceSource,
    ref: chosen.ref,
    method: chosen.method,
    obsT: chosen.obsT,
    ageSec: chosen.ageSec,
    quality,
    nullReason: chosen.priceUsd === null ? 'no_quote_price' : null,
    live: q.purpose === 'liquidation' ? chosen.live : null,
    failedChecks: q.purpose === 'liquidation' ? chosen.failedChecks : null,
    marketMatched,
    others,
  };
}
